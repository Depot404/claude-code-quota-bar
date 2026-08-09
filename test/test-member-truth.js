// Banc de la TABLE DE VÉRITÉ du statut d'un membre (lot 10 du plan
// PLAN_creation_groupes_2026-07-22.md).
//
// La table du plan, ligne à ligne — c'est le contrat, et c'est le seul endroit
// où il est écrit deux fois (ici et dans member-truth.js). Les quatre bugs qui
// ont motivé le lot ont chacun leur cas nommé : ils échouent si la déduction
// repart de la VUE (« la conversation est-elle dans la liste affichée ? »).
//
// Node pur, aucune dépendance : les sources sont injectées.
const path = require('path');
const { memberTruth } = require(path.join(__dirname, '..', 'member-truth.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

// Fabrique de sources : `live` = ids vivants, `transcripts` = ids ayant envoyé,
// `hooks` = état des hooks par id, `view` = ce que le panneau affiche.
function sources({ live = [], transcripts = [], hooks = {}, view = {}, closed = [] } = {}) {
  return {
    isLive: (id) => live.indexOf(id) !== -1,
    hasTranscript: (id) => transcripts.indexOf(id) !== -1,
    hookState: (id) => hooks[id] || null,
    getConv: (id) => view[id] || null,
    tabClosed: (id) => closed.indexOf(id) !== -1,
  };
}
const linked = { sessionId: 's1', launchedAt: 1000 };

console.log('1. La table du plan, ligne à ligne');

// | null, pas lancé | — | — | — | queued |
let t = memberTruth({ sessionId: null, launchedAt: null }, sources());
check('convId null + jamais lancé → queued', t.status === 'queued', t.status);
check('… waveStatus queued (le moteur ne l\'attend pas encore)', t.waveStatus === 'queued');
check('… ni Link… ni close (rien à lier, rien à fermer)', !t.canLink && !t.canClose);

// | null, lancé, rattachement raté | — | — | — | not linked |
t = memberTruth({ sessionId: null, launchedAt: 1000 }, sources());
check('convId null + lancé → not-linked', t.status === 'not-linked', t.status);
check('… Link… proposé (seul cas où c\'est vrai)', t.canLink === true);
check('… waveStatus launched (la vague l\'attend)', t.waveStatus === 'launched');
check('… note « not linked yet »', t.note === 'not linked yet', t.note);

// | présent | vivante | absent | — | inserted — press Enter |   ← BUG 3 et 4
t = memberTruth(linked, sources({ live: ['s1'] }));
check('BUG 3/4 — lié + session vivante + AUCUN transcript → inserted (l\'état du Create)',
  t.status === 'inserted', t.status);
check('… surtout PAS done·closed', t.status !== 'done-closed');
check('… surtout PAS stale : la vague reste ouverte, l\'auto ne se suspend pas',
  t.waveStatus === 'launched', t.waveStatus);
check('… Link… masqué (le membre EST lié)', t.canLink === false);
check('… note « press Enter in the tab »', t.note === 'press Enter in the tab', t.note);

// | présent | vivante | présent | busy/waiting | busy / waiting |
for (const st of ['busy', 'waiting', 'interrupted', 'idle']) {
  t = memberTruth(linked, sources({ live: ['s1'], transcripts: ['s1'], view: { s1: { state: st } } }));
  check(`lié + vivante + transcript + hooks ${st} → ${st}`, t.status === st, t.status);
  check(`… waveStatus launched (${st} n'est pas une fin)`, t.waveStatus === 'launched');
  check(`… note vide : la ligne de conversation parle déjà (${st})`, t.note === '');
}

// | présent | vivante | présent | done | done (onglet ouvert → chip ⨯) |
t = memberTruth(linked, sources({ live: ['s1'], transcripts: ['s1'], view: { s1: { state: 'done', tabOpen: true } } }));
check('lié + vivante + transcript + done + onglet ouvert → done', t.status === 'done', t.status);
check('… chip « close ⨯ » proposé', t.canClose === true);
t = memberTruth(linked, sources({ live: ['s1'], transcripts: ['s1'], view: { s1: { state: 'done', tabOpen: false } } }));
check('… même conv sans onglet connu → pas de chip (on ne ferme pas ce qu\'on ne voit pas)',
  t.status === 'done' && t.canClose === false);

// | présent | morte | présent | done | done · closed (terminal) |   ← BUG 1
t = memberTruth(linked, sources({ transcripts: ['s1'], hooks: { s1: 'done' } }));
check('BUG 1 — lié + session morte + transcript + done → done·closed', t.status === 'done-closed', t.status);
check('… Link… JAMAIS réaffiché (pas de rebranchement d\'une tâche finie)', t.canLink === false);
check('… compte comme DONE pour la vague suivante', t.waveStatus === 'done', t.waveStatus);
check('… note « ✓ done · closed »', t.note === '✓ done · closed', t.note);

// | présent | morte | présent | pas done | stale (vrai stale) |
t = memberTruth(linked, sources({ transcripts: ['s1'], hooks: { s1: 'busy' } }));
check('lié + morte + transcript + hooks busy → stale (interrompue pour de vrai)',
  t.status === 'stale', t.status);
check('… et LÀ le moteur se suspend', t.waveStatus === 'stale');

// | présent | morte | présent | idle (vue) + ONGLET OUVERT | done (chip ⨯) | ← reload 2026-07-24
// Recharger la fenêtre VS Code tue les CLI assez proprement pour que SessionEnd
// PURGE les entrées hooks ; state.js retombe alors sur `idle` (son repli « pas
// d'entrée », affiché ✓ atténué) pour des convs encore listées. `idle` n'est
// jamais écrit par un hook — c'est « les hooks ne savent rien », même verdict
// que null : TERMINÉE. Le compteur reste `done` (correctif « 0/N done »).
// MAIS l'onglet, lui, est TOUJOURS ouvert : la mort du CLI n'est pas la
// fermeture de l'onglet. C'est `tabOpen` qui décide `done` (chip de fermeture)
// vs `done-closed` — sinon tout membre terminé perdait son chip après un reload
// (bug 2, 2026-07-24). Les deux comptent `done` pour la vague.
t = memberTruth(linked, sources({ transcripts: ['s1'], view: { s1: { state: 'idle', tabOpen: true } } }));
check('BUG 2 (reload) — morte + listée `idle` + onglet OUVERT → done (chip proposé), pas done·closed',
  t.status === 'done' && t.canClose === true, t.status + '/' + t.canClose);
check('… compte quand même comme DONE (le compteur s\'accorde avec le ✓ de la ligne)', t.waveStatus === 'done', t.waveStatus);
// Même conv, mais l'onglet a bel et bien été fermé → done·closed, rien à fermer.
t = memberTruth(linked, sources({ transcripts: ['s1'], view: { s1: { state: 'idle', tabOpen: false } } }));
check('… onglet fermé → done·closed, pas de chip', t.status === 'done-closed' && t.canClose === false, t.status);
check('… et toujours DONE pour la vague', t.waveStatus === 'done', t.waveStatus);
// Terminée pour de bon (hooks `done`), CLI mort, onglet resté ouvert : chip AUSSI.
t = memberTruth(linked, sources({ transcripts: ['s1'], hooks: { s1: 'done' }, view: { s1: { state: 'done', tabOpen: true } } }));
check('BUG 2 — morte + hooks done + onglet ouvert → done (chip proposé)',
  t.status === 'done' && t.canClose === true, t.status + '/' + t.canClose);
// Le verdict ne déborde pas : une interruption PROUVÉE (transcript) reste stale.
t = memberTruth(linked, sources({ transcripts: ['s1'], view: { s1: { state: 'interrupted' } } }));
check('… mais morte + vue « interrupted » reste stale (interruption prouvée)', t.status === 'stale', t.status);

// | présent | morte | absent | — | link lost before sending |   ← BUG 2, puis
// BUG 5 (2026-08-04) : ce statut s'appelait `unsent-closed` et affirmait « fermée
// avant envoi » — un fait sur l'ONGLET, déduit de la seule vivacité du PROCESS.
// L'incident : premier CLI mort dans les secondes suivant l'ouverture, respawné
// par l'extension officielle SOUS LE MÊME ONGLET, membre resté collé au mort.
t = memberTruth(linked, sources({}));
check('BUG 2 — lié + morte + aucun transcript → unsent-lost', t.status === 'unsent-lost', t.status);
check('… note « link lost before sending » (plus aucune affirmation sur l\'onglet)',
  t.note === 'link lost before sending', t.note);
check('… waveStatus stale : elle ne finira jamais seule, ▶ reste la sortie', t.waveStatus === 'stale');
check('BUG 5 — lien MORT-NÉ : le membre redevient rattachable (rien n\'a commencé sous cet id)',
  t.canLink === true, String(t.canLink));
check('… et « Relancer » est proposé (le remède quand l\'onglet, lui, est parti)',
  t.canRelaunch === true, String(t.canRelaunch));

// Contre-cas : le vrai `stale` (morte AVEC transcript) ne devient JAMAIS
// rattachable — là, un travail a commencé, le lien le protège (lot 8 entier).
t = memberTruth(linked, sources({ transcripts: ['s1'], hooks: { s1: 'busy' } }));
check('vrai stale (morte + transcript) : jamais re-liable, jamais relançable',
  t.status === 'stale' && t.canLink === false && t.canRelaunch === false,
  `${t.status}/${t.canLink}/${t.canRelaunch}`);
// Ni les statuts vivants, ni les terminaux.
for (const [name, s] of [
  ['inserted', sources({ live: ['s1'] })],
  ['busy', sources({ live: ['s1'], transcripts: ['s1'], view: { s1: { state: 'busy' } } })],
  ['done-closed', sources({ transcripts: ['s1'], hooks: { s1: 'done' } })],
]) {
  const x = memberTruth(linked, s);
  check(`… ni ${name} (canRelaunch faux partout ailleurs)`, x.canRelaunch === false, `${x.status}/${x.canRelaunch}`);
}
check('… ni un membre jamais lancé', memberTruth({ sessionId: null, launchedAt: null }, sources()).canRelaunch === false);

console.log('\n2. La VUE ne décide plus rien de durable');

// Le cœur du lot : mêmes faits, présence dans la vue en plus ou en moins.
const deadDone = sources({ transcripts: ['s1'], hooks: { s1: 'done' } });
const deadDoneListed = sources({ transcripts: ['s1'], hooks: { s1: 'done' }, view: { s1: { state: 'done', tabOpen: false } } });
check('terminée+fermée : même statut qu\'on la liste ou non',
  memberTruth(linked, deadDone).status === memberTruth(linked, deadDoneListed).status);
check('… seule la NOTE change (la ligne de conv la porte quand elle est visible)',
  memberTruth(linked, deadDone).note === '✓ done · closed' && memberTruth(linked, deadDoneListed).note === '');

// Une vague entière tout juste ouverte : rien n'est listé, tout est vivant.
const fresh = sources({ live: ['s1', 's2', 's3'] });
const wave = [{ sessionId: 's1', launchedAt: 1 }, { sessionId: 's2', launchedAt: 1 }, { sessionId: 's3', launchedAt: 1 }]
  .map((m) => memberTruth(m, fresh));
check('vague fraîchement ouverte : aucun membre `stale`, aucun `done`',
  wave.every((x) => x.waveStatus === 'launched'), JSON.stringify(wave.map((x) => x.status)));
check('… donc aucun bandeau rouge et aucune vague suivante ouverte par erreur',
  wave.every((x) => x.status === 'inserted'));

console.log('\n3. Dégradation silencieuse (sources absentes ou muettes)');

t = memberTruth(linked, {});
check('aucune source → lié, mort, jamais envoyé = link lost before sending (jamais une exception)',
  t.status === 'unsent-lost', t.status);
t = memberTruth(null, sources());
check('membre null → queued, pas de crash', t.status === 'queued');
t = memberTruth({ convId: 's1', launchedAt: 1 }, sources({ live: ['s1'] }));
check('alias `convId` (membre déjà sérialisé vers le webview) accepté', t.status === 'inserted', t.status);

// Hooks muets sur une session morte : entrée purgée après 24 h, ou hooks
// jamais installés. Choix documenté — TERMINÉE, jamais un `stale` éternel.
t = memberTruth(linked, sources({ transcripts: ['s1'] }));
check('morte + transcript + hooks muets → done·closed (jamais un stale qui gèle la vague)',
  t.status === 'done-closed', t.status);

// État inconnu d'une version future du CLI : on ne relaie pas n'importe quoi.
t = memberTruth(linked, sources({ live: ['s1'], transcripts: ['s1'], hooks: { s1: 'zorglub' } }));
check('état hooks inconnu sur une session vivante → idle, pas le mot brut', t.status === 'idle', t.status);

console.log('\n4. Le statut de la vue reste prioritaire sur celui des hooks');
// state.js affine l'état (interruption manuelle, outil interactif) ; les hooks,
// eux, restent sur `busy` — c'est la vue qui a raison quand elle est là.
t = memberTruth(linked, sources({ live: ['s1'], transcripts: ['s1'], hooks: { s1: 'busy' }, view: { s1: { state: 'interrupted' } } }));
check('vue « interrupted » + hooks « busy » → interrupted', t.status === 'interrupted', t.status);

console.log('\n5. Onglet PROUVÉ fermé (étape 17, bug n°6 — course hooks/registre)');

// Séquence rejouée source par source : à l'instant de la fermeture, `hooks`
// et `isLive` (registre) peuvent chacun avoir déjà purgé leur trace, ou pas
// encore — les quatre combinaisons doivent produire le MÊME verdict dès lors
// que `tabClosed` dit vrai, jamais un `idle`/`inserted` qui présume un onglet.

// Membre TERMINÉ avant la fermeture (hooks « done » pas encore purgés,
// registre pas encore purgé non plus) → done·closed dès CE rendu, pas
// d'attente que la course se résolve.
t = memberTruth(linked, sources({ live: ['s1'], transcripts: ['s1'], hooks: { s1: 'done' }, closed: ['s1'] }));
check('terminé, hooks ET registre pas encore purgés + onglet prouvé fermé → done-closed immédiat',
  t.status === 'done-closed', t.status);
check('… jamais « open »/idle', t.note !== 'open' && t.status !== 'idle', t.status + '/' + t.note);

// Hooks déjà purgés (repli sur rien), registre PAS ENCORE purgé — c'est
// exactement la fenêtre repérée par l'user (capture 2026-08-05).
t = memberTruth(linked, sources({ live: ['s1'], transcripts: ['s1'], closed: ['s1'] }));
check('hooks purgés avant le registre + onglet prouvé fermé → done-closed, jamais idle',
  t.status === 'done-closed', t.status);
check('… note jamais « open »', t.note !== 'open', t.note);

// Registre déjà purgé (isLive faux), hooks pas encore — sens inverse de la
// course : doit aboutir au même verdict, le fix ne dépend pas de l'ordre.
t = memberTruth(linked, sources({ transcripts: ['s1'], hooks: { s1: 'done' }, closed: ['s1'] }));
check('registre purgé avant les hooks + onglet prouvé fermé → done-closed',
  t.status === 'done-closed', t.status);

// Ni l'un ni l'autre encore purgé : sans le fix, `live` resterait vrai →
// `inserted`/`idle`. Avec le fix, l'onglet prouvé fermé prime sur les deux.
t = memberTruth(linked, sources({ live: ['s1'], transcripts: ['s1'], hooks: { s1: 'busy' }, closed: ['s1'] }));
check('rien purgé encore, mais onglet PROUVÉ fermé + hooks busy → stale (reste à faire), jamais idle',
  t.status === 'stale', t.status);

// Membre NON terminé (encore busy/waiting) dont l'onglet ferme : bascule
// visible sur son statut de vérité, jamais masqué.
for (const st of ['busy', 'waiting']) {
  t = memberTruth(linked, sources({ live: ['s1'], transcripts: ['s1'], hooks: { s1: st }, closed: ['s1'] }));
  check(`membre ${st} dont l'onglet ferme → stale (visible, pas masqué)`, t.status === 'stale', t.status);
}

// Membre `inserted` (prompt inséré, rien envoyé) dont l'onglet ferme AVANT
// tout envoi : sans conv listée ni transcript, c'est un lien mort-né.
t = memberTruth(linked, sources({ live: ['s1'], closed: ['s1'] }));
check('inserted + onglet fermé avant tout envoi → unsent-lost (jamais « press Enter »)',
  t.status === 'unsent-lost', t.status);
check('… donc rattachable/relançable (rien n\'a commencé sous cet id)',
  t.canLink === true && t.canRelaunch === true);

// Sans la source (dégradation silencieuse) : comportement d'avant l'étape 17,
// `live` seul décide — même faits, verdict `idle` comme avant le fix.
t = memberTruth(linked, sources({ live: ['s1'], transcripts: ['s1'] }));
check('sans tabClosed (source absente) : comportement inchangé (idle, comme avant)',
  t.status === 'idle', t.status);

console.log('\n2. Lot B (plan « master conv isolée » 2026-08-09) — un membre au prompt VIDE mais déjà lié');
// `linkConvToActiveMaster` (extension.js) crée son unique membre avec
// `prompt: ''` (rien à demander, la conv existe déjà) — memberTruth ne lit
// JAMAIS `m.prompt` (seul `sessionId`/`launchedAt` entrent dans la table) :
// ce membre doit se rendre EXACTEMENT comme n'importe quel autre membre lié,
// jamais comme une ligne « en attente » (qui n'existe que pour convId null).
const emptyPromptMember = { sessionId: 's1', prompt: '', launchedAt: 1000 };
for (const st of ['busy', 'waiting', 'idle']) {
  t = memberTruth(emptyPromptMember, sources({ live: ['s1'], transcripts: ['s1'], view: { s1: { state: st } } }));
  check(`prompt vide + lié + ${st} → ${st} (une conv normale, pas "en attente")`, t.status === st, t.status);
  check(`… listed=true (${st}) : sa ligne existe, aucun prompt à montrer en pied`, t.listed === true);
}
t = memberTruth(emptyPromptMember, sources({ live: ['s1'], transcripts: ['s1'], view: { s1: { state: 'done', tabOpen: true } } }));
check('prompt vide + lié + done → done, comme un membre normal', t.status === 'done', t.status);

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
