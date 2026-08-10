// Garde-fou de publication : AUCUN extrait du poste de l'auteur ne doit se
// trouver dans un fichier publiable (repo public + .vsix).
//
// POURQUOI CE BANC EXISTE — deux fuites, deux fois repérées à l'œil, des mois
// après coup. (a) 2026-07-17 : des titres de conversations RÉELS partis sur la
// fiche Marketplace, découverts par l'user sur sa propre fiche. (b) 2026-08-09 :
// `test/test-supersede*.js` portaient encore « Implémenter lot 1 (repli auto des
// groupes terminés) » et le chemin d'un plan du monorepo privé, alors que
// l'anonymisation de 2.27.13 était réputée close — elle avait couvert cinq
// fichiers et manqué ceux-là. À chaque fois, le contrôle existait : sous forme
// d'une commande à penser à taper avant de publier. Une vérification qu'un
// humain doit se rappeler d'exécuter n'est pas un contrôle, c'est un vœu.
//
// CE QUE CE BANC N'INTERDIT PAS, DÉLIBÉRÉMENT :
//  - le français dans les commentaires : tout le code est commenté en français,
//    c'est assumé et ce n'est pas une fuite ;
//  - les fixtures en français manifestement inventées (« Conversation ambiguë »,
//    « Terminée jamais lue ») : elles ne viennent d'aucune vraie conversation ;
//  - les références à un plan interne DANS UN COMMENTAIRE (`PLAN_x.md`,
//    `Tools/ClaudeCodeQuotaBar/hooks/`) : c'est de la traçabilité de décision,
//    arbitré le 2026-08-09 avec l'user — le coût de la perdre dépasse le gain.
// La frontière retenue est donc : ce qui vit dans une CHAÎNE LITTÉRALE (donc
// une donnée, donc potentiellement un extrait) est contrôlé ; ce qui vit dans
// un commentaire ne l'est pas.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '\n       ' + detail : ''}`); }
}

// Miroir de la liste d'exclusion de PUBLISH.md §2 : ce qui ne part NI au repo
// public NI dans le .vsix n'a pas à être contrôlé (runbooks internes, plans,
// planches de validation — ils citent le poste de l'auteur par nature).
const NOT_PUBLISHED = /^(node_modules\/|PLAN_|PLANCHE_|MOCKUP_|NOTES_|mkt-|PUBLISH\.md$|CLAUDE\.md$|Publish\.ps1$)/;
// Le CHANGELOG et le README documentent des choix d'implémentation passés (le
// profil Brave dédié, par exemple) : ce sont des textes publics écrits POUR
// être lus, relus à chaque version — pas des données oubliées dans du code.
const DOCS = /^(CHANGELOG\.md|README\.md)$/;
// Ce fichier cite forcément tous les motifs qu'il interdit.
const SELF = 'test/test-no-private-residue.js';

// Chaque motif dit ce qu'il cherche À L'INTÉRIEUR d'une chaîne littérale.
const PATTERNS = [
  { name: 'un prompt de handoff réel (« Implémente le lot N … du plan … »)',
    re: /Impl[ée]ment(e|er)\s+(le\s+)?lot|du\s+plan\s+Tools\/|lis\s+le\s+plan/i },
  { name: 'un chemin du monorepo privé (Tools/<autre chose que le placeholder X>)',
    re: /Tools\/(?!X\/)[A-Za-z0-9_]+\// },
  { name: 'le nom d\'un autre projet du poste',
    re: /jeedom|planningtp|secr[ée]taire|lechineur|blausasc|sondagebbq|octopushub|maildailydigest|ntfyarchive|chargeve|medicalrecord/i },
  { name: 'une identité personnelle (utilisateur Windows, adresse mail)',
    re: /komega2|03dame|ad030187|@gmail\.com|@yahoo\.fr/i },
];

// Extrait les chaînes littérales d'une ligne de JS (simple, double, backtick),
// après avoir écarté les lignes qui ne sont QUE du commentaire. Volontairement
// naïf : un faux positif coûte une seconde de lecture, un faux négatif coûte
// une publication. C'est le sens dans lequel on veut se tromper.
function literalsOf(line) {
  const t = line.trim();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return [];
  const out = [];
  const re = /'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`\\]*(?:\\.[^`\\]*)*)`/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] || m[2] || m[3] || '');
  return out;
}

let files;
try {
  files = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' }).split('\n')
    .map((f) => f.trim()).filter(Boolean)
    .filter((f) => !NOT_PUBLISHED.test(f) && !DOCS.test(f) && f !== SELF);
} catch (e) {
  console.log('  SKIP  git indisponible :', e.message);
  process.exit(0);
}
check('la liste des fichiers publiables n\'est pas vide (sinon ce banc ne prouve rien)', files.length > 20, `${files.length} fichier(s)`);

// Le .md embarqué dans le paquet (commands/handoffs.md) est lu ligne à ligne
// sans extraction de littéral : tout son texte part au Marketplace.
const findings = [];
for (const rel of files) {
  const abs = path.join(ROOT, rel.replace(/\//g, path.sep));
  if (!/\.(js|mjs|json|md)$/.test(rel)) continue;
  let src;
  try { src = fs.readFileSync(abs, 'utf8'); } catch { continue; }
  const isJs = /\.(js|mjs)$/.test(rel);
  src.split('\n').forEach((line, i) => {
    const chunks = isJs ? literalsOf(line) : [line];
    for (const c of chunks) {
      for (const p of PATTERNS) {
        if (p.re.test(c)) findings.push({ rel, line: i + 1, pattern: p.name, text: c.slice(0, 90) });
      }
    }
  });
}

for (const p of PATTERNS) {
  const hits = findings.filter((f) => f.pattern === p.name);
  check(`aucun fichier publiable ne contient ${p.name}`,
    hits.length === 0,
    hits.slice(0, 6).map((h) => `${h.rel}:${h.line} → ${h.text}`).join('\n       '));
}

// LE DÉTECTEUR DÉTECTE-T-IL ? Un banc de ce genre passe au vert le jour où on
// l'écrit — et resterait vert si une expression était cassée par une coquille
// (c'est arrivé à l'écriture même de ce fichier). Chaque motif est donc éprouvé
// sur un exemple qu'il DOIT attraper, et sur un contre-exemple légitime qu'il
// NE DOIT PAS attraper. Sans ça, « 0 fuite trouvée » et « je ne sais rien
// chercher » rendent exactement le même résultat.
console.log('\nAuto-contrôle du détecteur');
const MUST_CATCH = [
  ['un prompt de handoff réel', "Implémente le lot 1 (repli auto) du plan Tools/QuelqueChose/PLAN_x.md"],
  ['un chemin du monorepo', 'Tools/ClaudeCodeQuotaBar/hooks/transcript.js'],
  ['le nom d\'un autre projet', 'Watchdog Jeedom Z-Wave'],
  ['une identité personnelle', 'C:\\Users\\Komega2\\Documents'],
];
for (const [label, sample] of MUST_CATCH) {
  check(`le détecteur attrape ${label}`, PATTERNS.some((p) => p.re.test(sample)), sample);
}
const MUST_PASS = [
  ['le placeholder fictif des exemples publics', 'Implement batch 1 (refunds table schema) from Tools/X/PLAN.md.'],
  ['une fixture inventée en français', 'Conversation ambiguë'],
  ['un titre de démonstration', 'Refactor auth middleware for session rotation'],
];
for (const [label, sample] of MUST_PASS) {
  check(`… et laisse passer ${label}`, !PATTERNS.some((p) => p.re.test(sample)), sample);
}
// La frontière commentaire/donnée est le cœur de l'arbitrage : si literalsOf()
// se mettait à lire les commentaires, le banc virerait au rouge sur du code
// parfaitement légitime et finirait désactivé — la pire des fins.
check('une référence de plan EN COMMENTAIRE reste hors du champ (sinon le banc devient inutilisable)',
  literalsOf('// Source canonique : Tools/ClaudeCodeQuotaBar/hooks/.').length === 0);
check('… mais la même chaîne dans une DONNÉE est bien vue',
  literalsOf("  const p = 'Tools/ClaudeCodeQuotaBar/hooks/';").length === 1);

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
