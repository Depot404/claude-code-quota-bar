// Banc : coût estimé ($) par conversation (cost.js).
//
// Ce que ce banc prouve, et que rien d'autre ne peut prouver :
//  1) le TARIF appliqué est celui du modèle DE CHAQUE MESSAGE (une conv qui
//     change de modèle en route mélange les tarifs), fast mode compris ;
//  2) les ratios de cache (read 0,1× / write 5 min 1,25× / write 1 h 2×) et le
//     coût des recherches web entrent bien dans le total, au centime ;
//  3) un message assistant écrit en PLUSIEURS lignes JSONL (thinking + texte +
//     appel d'outil, même message.id, même usage) n'est compté qu'UNE fois —
//     le piège vérifié sur transcript réel le 2026-08-17 (79 ids dupliqués sur
//     267 entrées), qui triplerait la facture des tours à outils ;
//  4) la lecture est INCRÉMENTALE : un append n'ajoute que son propre coût, la
//     relecture ne repasse jamais sur les octets déjà consommés (contrainte
//     dure : les transcripts font des dizaines de Mo et le moteur recalcule
//     toutes les 30 s) ;
//  5) une ligne finale INCOMPLÈTE (le CLI écrit pendant qu'on lit) n'est pas
//     consommée, et compte une fois qu'elle est terminée — jamais deux ;
//  6) une TRONCATURE (fichier remplacé, plus petit que l'offset) repart de
//     zéro au lieu de rendre des totaux fantômes ;
//  7) la TIMELINE globale (seaux de 5 min) resomme exactement ce qu'une
//     fenêtre de quota a coûté, filtre par famille de modèle sur le seul
//     `display_name` que l'API renseigne, et — le piège du lot — ne compte
//     JAMAIS deux fois un fichier oublié puis re-scanné.
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createCostReader, costOfUsage, priceFor, modelMatcher, isTurnBoundary, BUCKET_MS, TIMELINE_SPAN_MS } = require(path.join(__dirname, '..', 'cost.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}
// Comparaison au CENTIME : c'est la précision affichée par le panneau, et la
// seule qui ait un sens pour une estimation.
const cents = (v) => Math.round(v * 100);
function near(a, b, eps) { return Math.abs(a - b) < (eps === undefined ? 1e-9 : eps); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-cost-'));
const file = path.join(dir, 'session.jsonl');
function line(model, usage, id) {
  return JSON.stringify({ type: 'assistant', message: { id: id || ('msg_' + Math.random().toString(36).slice(2)), model, usage } }) + '\n';
}

console.log('\n1. Tarif par FAMILLE, match par sous-chaîne (jamais un id complet figé)');
check('opus 4.8 → 5/25', priceFor('claude-opus-4-8').input === 5 && priceFor('claude-opus-4-8').output === 25);
check('un opus futur (id inconnu de cette version) → même famille, même tarif',
  priceFor('claude-opus-9-super').input === 5);
check('fable → 10/50', priceFor('claude-fable-5').input === 10 && priceFor('claude-fable-5').output === 50);
check('sonnet → 3/15', priceFor('claude-sonnet-5').input === 3 && priceFor('claude-sonnet-5').output === 15);
check('haiku → 1/5', priceFor('claude-haiku-4-5').input === 1 && priceFor('claude-haiku-4-5').output === 5);
check('famille inconnue → tarif opus (médian), jamais zéro ni une exception',
  priceFor('gpt-quelque-chose').input === 5 && priceFor(null).input === 5 && priceFor(undefined).output === 25);
check('fast mode opus → tarif premium 10/50, message par message',
  priceFor('claude-opus-5', 'fast').input === 10 && priceFor('claude-opus-5', 'fast').output === 50
  && priceFor('claude-opus-5', 'standard').input === 5);
check('fast mode ne s\'applique pas aux familles qui ne l\'ont pas (sonnet reste 3/15)',
  priceFor('claude-sonnet-5', 'fast').input === 3);

console.log('\n2. Décomposition d\'un usage — les ratios de cache et le web search au centime');
// 1 Mtok d'entrée fraîche @5 = 5 $ ; 1 Mtok de cache lu @0,1 = 0,50 $ ;
// 1 Mtok écrit 5 min @1,25 = 6,25 $ ; 1 Mtok écrit 1 h @2 = 10 $ ;
// 1 Mtok de sortie @25 = 25 $ ; 3 recherches web = 0,03 $. Total = 46,78 $.
const u = {
  input_tokens: 1e6, cache_read_input_tokens: 1e6, output_tokens: 1e6,
  cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 1e6 },
  server_tool_use: { web_search_requests: 3 },
};
const c = costOfUsage(u, 'claude-opus-5');
check('input', near(c.input, 5));
check('cache lu (0,1×)', near(c.cacheRead, 0.5));
check('cache écrit 5 min (1,25×) + 1 h (2×)', near(c.cacheWrite, 6.25 + 10));
check('output', near(c.output, 25));
check('recherches web (0,01 $ pièce)', near(c.tools, 0.03));
check('total = somme des postes', cents(c.total) === cents(5 + 0.5 + 16.25 + 25 + 0.03), String(c.total));
// Transcript d'avant l'introduction de `cache_creation` : seul le total existe.
const old = costOfUsage({ input_tokens: 0, cache_creation_input_tokens: 1e6 }, 'claude-opus-5');
check('sans le détail des TTL, l\'écriture est comptée au ratio 5 min (le plus bas)',
  near(old.cacheWrite, 6.25), String(old.cacheWrite));
check('usage absent → null (rien à afficher, jamais un 0 supposé)', costOfUsage(null, 'claude-opus-5') === null);

console.log('\n3. Un transcript complet — multi-modèles, dédup des lignes d\'un même message');
// Trois entrées CONSÉCUTIVES du même message assistant (thinking, texte, outil) :
// même id, même usage. Le vrai coût de ce message ne doit être compté qu'une fois.
const dup = { input_tokens: 0, output_tokens: 1e6 };          // 25 $ chez opus
fs.writeFileSync(file,
  line('claude-opus-5', dup, 'msg_A') + line('claude-opus-5', dup, 'msg_A') + line('claude-opus-5', dup, 'msg_A')
  // Une ligne user énorme entre deux : elle ne porte pas d'usage, elle ne doit
  // rien coûter ni faire tomber le parseur.
  + JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(5000) } }) + '\n'
  + line('claude-haiku-4-5', { input_tokens: 0, output_tokens: 1e6 }, 'msg_B'),   // 5 $ chez haiku
  'utf8');
const read = createCostReader();
let got = read(file);
check('coût = opus une fois + haiku (dédup par message.id)', cents(got.total) === cents(30), JSON.stringify(got));
check('messages comptés = 2, pas 4', got.messages === 2, String(got.messages));
check('le tarif suit le modèle DE CHAQUE message (25 + 5, pas 2×25 ni 2×5)',
  cents(got.output) === cents(30));

console.log('\n4. Lecture incrémentale — un append n\'ajoute que son propre coût');
// Relire sans rien ajouter ne doit RIEN changer : c'est tout l'objet du module.
const again = read(file);
check('relecture sans append → totaux identiques (aucun double comptage)', cents(again.total) === cents(30), JSON.stringify(again));
fs.appendFileSync(file, line('claude-sonnet-5', { input_tokens: 0, output_tokens: 1e6 }, 'msg_C'));  // +15 $
got = read(file);
check('après append → 30 + 15', cents(got.total) === cents(45), JSON.stringify(got));
// Preuve que l'append seul a été lu : on fabrique un fichier témoin dont les
// premières lignes sont ILLISIBLES (JSON cassé). Un lecteur qui repartirait de
// zéro les rencontrerait ; l'incrémental, lui, ne les relit jamais.
const witness = path.join(dir, 'witness.jsonl');
fs.writeFileSync(witness, line('claude-opus-5', { output_tokens: 1e6 }, 'msg_W'), 'utf8');
const readW = createCostReader();
check('témoin — 1er passage', cents(readW(witness).total) === cents(25));
fs.appendFileSync(witness, line('claude-opus-5', { output_tokens: 1e6 }, 'msg_X'));
check('témoin — 2e passage n\'ajoute que le nouveau message', cents(readW(witness).total) === cents(50));

console.log('\n5. Ligne finale incomplète (le CLI écrit pendant qu\'on lit)');
const partial = path.join(dir, 'partial.jsonl');
const full = line('claude-opus-5', { output_tokens: 1e6 }, 'msg_P');   // 25 $
fs.writeFileSync(partial, full + full.slice(0, 40), 'utf8');           // 2e ligne coupée, sans \n
const readP = createCostReader();
check('la ligne tronquée n\'est pas consommée', cents(readP(partial).total) === cents(25), JSON.stringify(readP(partial)));
// Le CLI termine sa ligne : elle compte MAINTENANT, et une seule fois.
fs.writeFileSync(partial, full + line('claude-opus-5', { output_tokens: 1e6 }, 'msg_Q'), 'utf8');
check('une fois la ligne terminée, elle compte — une seule fois', cents(readP(partial).total) === cents(50), JSON.stringify(readP(partial)));

console.log('\n6. Troncature / remplacement du fichier → on repart de zéro');
fs.writeFileSync(file, line('claude-haiku-4-5', { output_tokens: 1e6 }, 'msg_Z'), 'utf8');   // 5 $, fichier bien plus court
got = read(file);
check('fichier plus petit que l\'offset → totaux recalculés, pas d\'addition fantôme',
  cents(got.total) === cents(5), JSON.stringify(got));

console.log('\n7. Absence de données → null, jamais « 0,00 $ »');
const empty = path.join(dir, 'empty.jsonl');
fs.writeFileSync(empty, JSON.stringify({ type: 'user', message: { role: 'user', content: 'bonjour' } }) + '\n', 'utf8');
check('transcript sans la moindre entrée usage → null', createCostReader()(empty) === null);
check('fichier inexistant → null (jamais une exception)', createCostReader()(path.join(dir, 'nope.jsonl')) === null);
check('chemin nul → null', createCostReader()(null) === null);

console.log('\n8. Purge des fichiers qui ne sont plus candidats — sauf ceux qu\'une fenêtre compte encore');
const readF = createCostReader();
readF(file); readF(witness);
check('deux fichiers suivis', readF.size() === 2, String(readF.size()));
readF.forget(new Set([file]));
// Le piège du lot « coût par fenêtre » : oublier un fichier RÉCENT le ferait
// repartir de l'octet 0 au prochain scan, donc ré-injecter toutes ses lignes
// dans les seaux — la fenêtre le compterait deux fois.
check('un fichier récent n\'est PAS oublié (il repartirait de zéro et compterait double)',
  readF.size() === 2, String(readF.size()));
// Même geste, mais le témoin est daté hors de la période couverte par la
// timeline : plus rien de lui ne peut entrer dans une fenêtre vivante.
const stale = (Date.now() - TIMELINE_SPAN_MS - 3600 * 1000) / 1000;
fs.utimesSync(witness, stale, stale);
readF(witness);                       // le lecteur reprend le mtime au passage
readF.forget(new Set([file]));
check('un fichier plus vieux que la plus longue fenêtre est bien lâché',
  readF.size() === 1, String(readF.size()));

console.log('\n9. UTF-8 multi-octets à cheval sur deux tranches de lecture');
// Le découpage se fait en OCTETS (jamais sur une chaîne décodée) : un caractère
// coupé par une tranche de 1 Mio doit se recoller intact, sinon la ligne JSON
// devient invalide et son message est perdu en silence.
const wide = path.join(dir, 'wide.jsonl');
const pad = '€'.repeat(400000);   // ~1,2 Mo d'UTF-8 : la tranche tombe dedans
fs.writeFileSync(wide,
  JSON.stringify({ type: 'user', message: { role: 'user', content: pad } }) + '\n'
  + line('claude-opus-5', { output_tokens: 1e6 }, 'msg_U'), 'utf8');
const gotW = createCostReader()(wide);
check('le message qui suit un gros bloc multi-octets est bien compté',
  gotW && cents(gotW.total) === cents(25), JSON.stringify(gotW));

console.log('\n10. Timeline globale — le coût d\'une FENÊTRE DE QUOTA');
// Aligné sur une borne de seau : les montants tombent alors à des instants
// exacts, et la borne de fenêtre testée plus bas ne dépend pas de l'heure à
// laquelle le banc tourne.
const T0 = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS;
const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const proj = path.join(dir, 'projects');
fs.mkdirSync(path.join(proj, 'ws-a'), { recursive: true });
fs.mkdirSync(path.join(proj, 'ws-b'), { recursive: true });
// 1 Mtok de sortie = 25 $ en opus, 50 $ en fable : des montants ronds, donc
// des sommes vérifiables de tête.
function dated(model, ts, id) {
  return JSON.stringify({
    type: 'assistant', timestamp: new Date(ts).toISOString(),
    message: { id, model, usage: { output_tokens: 1e6 } },
  }) + '\n';
}
const fa = path.join(proj, 'ws-a', 'a.jsonl');
const fb = path.join(proj, 'ws-b', 'b.jsonl');
fs.writeFileSync(fa,
  dated('claude-opus-5', T0 - 10 * MIN, 'msg_a1')
  + dated('claude-opus-5', T0 - 2 * HOUR, 'msg_a2')
  + dated('claude-fable-5', T0 - 3 * DAY, 'msg_a3'), 'utf8');
fs.writeFileSync(fb,
  dated('claude-fable-5', T0 - 30 * MIN, 'msg_b1')
  + dated('claude-opus-5', T0 - 10 * DAY, 'msg_b2'), 'utf8');

const tl = createCostReader({ projectsDir: proj, now: () => T0 });
check('avant tout scan global → aucun montant de fenêtre (jamais une fraction du compte)',
  tl.windowCost(T0 - 5 * HOUR) === null);
check('scanAll() rend true quand le dossier des projets existe', tl.scanAll() === true);
check('un dossier de projets absent → false, jamais une exception',
  createCostReader({ projectsDir: path.join(dir, 'nulle-part') }).scanAll() === false);

check('fenêtre 5 h : 25 + 25 + 50 = 100 $, tous workspaces confondus',
  cents(tl.windowCost(T0 - 5 * HOUR)) === cents(100), String(tl.windowCost(T0 - 5 * HOUR)));
check('fenêtre 7 j : la même chose plus les 50 $ d\'il y a trois jours',
  cents(tl.windowCost(T0 - 7 * DAY)) === cents(150), String(tl.windowCost(T0 - 7 * DAY)));
check('un message plus vieux que la plus longue fenêtre est purgé, jamais compté',
  cents(tl.windowCost(0)) === cents(150), String(tl.windowCost(0)));

// Fenêtre SCOPÉE : dans le cache réel, scope.model.id vaut null — seul le
// display_name existe, et c'est lui qui doit suffire.
check('fenêtre scopée « Fable » → seuls les messages fable, 50 + 50 = 100 $',
  cents(tl.windowCost(T0 - 7 * DAY, 'Fable')) === cents(100), String(tl.windowCost(T0 - 7 * DAY, 'Fable')));
check('la même scopée sur 5 h → 50 $',
  cents(tl.windowCost(T0 - 5 * HOUR, 'Fable')) === cents(50), String(tl.windowCost(T0 - 5 * HOUR, 'Fable')));
check('un display_name qui porte une version (« Opus 4.8 ») retombe sur sa famille',
  cents(tl.windowCost(T0 - 7 * DAY, 'Opus 4.8')) === cents(50), String(tl.windowCost(T0 - 7 * DAY, 'Opus 4.8')));
check('aucun message de cette famille → null, jamais un 0 trompeur',
  tl.windowCost(T0 - 7 * DAY, 'Sonnet') === null);
check('display_name vide → traité comme « toutes familles », pas comme un filtre mort',
  cents(tl.windowCost(T0 - 5 * HOUR, '')) === cents(100));
check('modelMatcher : « Fable » matche claude-fable-5 et rien d\'opus',
  modelMatcher('Fable')('claude-fable-5') === true && modelMatcher('Fable')('claude-opus-5') === false);

// Borne de fenêtre : on somme les seaux >= la borne, donc au plus 5 min
// d'imprécision — et JAMAIS un seau antérieur.
check('borne à -15 min : le message de -10 min compte',
  cents(tl.windowCost(T0 - 15 * MIN)) === cents(25), String(tl.windowCost(T0 - 15 * MIN)));
check('borne à -5 min : plus aucun seau, donc null (pas un 0)',
  tl.windowCost(T0 - 5 * MIN) === null, String(tl.windowCost(T0 - 5 * MIN)));

console.log('\n11. Ni le re-scan ni un oubli ne comptent deux fois');
tl.scanAll();
check('re-scanner sans rien changer ne bouge pas d\'un centime',
  cents(tl.windowCost(T0 - 5 * HOUR)) === cents(100), String(tl.windowCost(T0 - 5 * HOUR)));
fs.appendFileSync(fa, dated('claude-opus-5', T0 - MIN, 'msg_a4'), 'utf8');
tl.scanAll();
check('un append n\'ajoute que son propre coût (100 + 25)',
  cents(tl.windowCost(T0 - 5 * HOUR)) === cents(125), String(tl.windowCost(T0 - 5 * HOUR)));
// LE cas du lot : la vue laisse tomber un fichier, le scan global le reprend.
tl.forget(new Set());
tl.scanAll();
check('un fichier « oublié » puis re-scanné ne double AUCUN seau',
  cents(tl.windowCost(T0 - 5 * HOUR)) === cents(125), String(tl.windowCost(T0 - 5 * HOUR)));
check('le coût par conversation, lui, reste intact (25 + 25 + 50 + 25)',
  cents(tl(fa).total) === cents(125), String(tl(fa) && tl(fa).total));

console.log('\n12. Troncature d\'un transcript déjà compté → la timeline se refait, sans fantôme');
fs.writeFileSync(fb, dated('claude-fable-5', T0 - 30 * MIN, 'msg_b1'), 'utf8');
tl(fb);          // la lecture voit le fichier rétréci et marque la reconstruction
tl.scanAll();
check('après reconstruction, la fenêtre 5 h vaut 25 + 25 + 50 + 25 = 125 $',
  cents(tl.windowCost(T0 - 5 * HOUR)) === cents(125), String(tl.windowCost(T0 - 5 * HOUR)));
check('et les totaux par conversation sont revenus',
  cents(tl(fb).total) === cents(50), String(tl(fb) && tl(fb).total));

console.log('\n13. Le dernier TOUR complet (plan coût-fenêtre 2026-08-18, lot 2, B3)');
// Détecteur de borne — vérifié sur transcript réel le 2026-08-18 : un prompt
// utilisateur RÉEL est `type:"user"` sans `toolUseResult` ni `isMeta:true`.
function userLine(text) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
}
function toolResultLine() {
  return JSON.stringify({ type: 'user', toolUseResult: { stdout: 'ok' }, message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }) + '\n';
}
function metaLine() {
  return JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: '[Image: ...]' } }) + '\n';
}
check('borne : prompt utilisateur réel', isTurnBoundary(userLine('salut').trim()) === true);
check('PAS une borne : résultat d\'outil (toolUseResult présent)', isTurnBoundary(toolResultLine().trim()) === false);
check('PAS une borne : entrée système (isMeta:true)', isTurnBoundary(metaLine().trim()) === false);

const turnFile = path.join(dir, 'turns.jsonl');
// Tour 1 : deux messages assistant, un résultat d'outil AU MILIEU (ne doit rien
// couper), puis un troisième message assistant — 1 + 1 + 0,50 = 2,50 $.
fs.writeFileSync(turnFile,
  userLine('premier prompt')
  + line('claude-opus-5', { output_tokens: 40000 }, 'msg_t1a')   // 1,00 $
  + line('claude-opus-5', { output_tokens: 40000 }, 'msg_t1b')   // 1,00 $
  + toolResultLine()
  + line('claude-opus-5', { output_tokens: 20000 }, 'msg_t1c'),  // 0,50 $
  'utf8');
const readT = createCostReader();
let gotT = readT(turnFile);
check('tour en cours : aucun tour COMPLET tant que la borne suivante n\'est pas là',
  gotT.turns === 0 && cents(gotT.lastTurn) === 0, JSON.stringify(gotT));

// La borne suivante clôt le tour 1 : lastTurn le porte, jamais le tour 2 qui
// s'ouvre juste après (encore en cours).
fs.appendFileSync(turnFile,
  userLine('deuxième prompt')
  + line('claude-sonnet-5', { output_tokens: 100000 }, 'msg_t2a'));  // 1,50 $ (sonnet, encore en cours)
gotT = readT(turnFile);
check('tour 1 clos : lastTurn = 2,50 $, 1 tour complet — le tour 2 en cours ne compte pas encore',
  gotT.turns === 1 && cents(gotT.lastTurn) === cents(2.5), JSON.stringify(gotT));

// Une entrée système (isMeta) au milieu du tour 2 ne le clôt pas.
fs.appendFileSync(turnFile, metaLine());
gotT = readT(turnFile);
check('isMeta:true n\'est pas une borne : le tour 1 reste le dernier COMPLET',
  gotT.turns === 1 && cents(gotT.lastTurn) === cents(2.5), JSON.stringify(gotT));

// La borne suivante clôt le tour 2 (1,50 $ seul, le message isMeta ne coûte rien).
fs.appendFileSync(turnFile, userLine('troisième prompt'));
gotT = readT(turnFile);
check('tour 2 clos : lastTurn = 1,50 $, 2 tours complets',
  gotT.turns === 2 && cents(gotT.lastTurn) === cents(1.5), JSON.stringify(gotT));
check('le cumul, lui, porte tout : 2,50 + 1,50 = 4,00 $',
  cents(gotT.total) === cents(4), JSON.stringify(gotT));

try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
