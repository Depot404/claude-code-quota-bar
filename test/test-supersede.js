// Banc de la SUPPLANTATION husk→successeur (supersede.js) + son intégration
// dans buildSnapshot (state.js) : après un reload, l'extension officielle
// relance une conv restaurée sous un NOUVEAU sessionId (nouveau transcript, même
// titre) ; l'ancien reste en HUSK mort. La liste dédoublait (bug 3, 2026-07-24).
//
// Deux niveaux : la règle pure (computeSupersededBy), puis un snapshot complet
// sur de vrais transcripts fabriqués (os.homedir monkeypatché → rien de réel).
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-supersede-'));
os.homedir = () => SANDBOX;                       // AVANT le require de state.js
fs.mkdirSync(path.join(SANDBOX, '.claude'), { recursive: true });

const { computeSupersededBy } = require(path.join(__dirname, '..', 'supersede.js'));
const state = require(path.join(__dirname, '..', 'state.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

const c = (o) => ({ titleSource: 'ai-title', mtime: 1000, live: false, tabOpen: false, ...o });

console.log('1. Règle pure (computeSupersededBy)');

// Le cas de l'incident : husk mort (02:01) + successeur resumé plus frais dont
// l'onglet porte encore le titre.
let map = computeSupersededBy([
  c({ sessionId: 'husk', title: 'Implement batch 1', mtime: 100, live: false, tabOpen: false }),
  c({ sessionId: 'succ', title: 'Implement batch 1', mtime: 200, live: false, tabOpen: true }),
]);
check('husk mort + successeur plus frais à onglet ouvert → husk supplanté',
  map.husk === 'succ' && Object.keys(map).length === 1, JSON.stringify(map));

// Successeur VIVANT (CLI resumé qui tourne) : même verdict, même si le husk a un
// onglet lui aussi (les deux matchent le même libellé).
map = computeSupersededBy([
  c({ sessionId: 'husk', title: 'Lot 2', mtime: 100, tabOpen: true }),
  c({ sessionId: 'succ', title: 'Lot 2', mtime: 300, live: true, tabOpen: true }),
]);
check('successeur vivant → husk supplanté', map.husk === 'succ', JSON.stringify(map));

// Deux vivants homonymes = deux vrais onglets concurrents → on ne fold rien.
map = computeSupersededBy([
  c({ sessionId: 'a', title: 'Même titre', mtime: 100, live: true, tabOpen: true }),
  c({ sessionId: 'b', title: 'Même titre', mtime: 200, live: true, tabOpen: true }),
]);
check('deux vivants homonymes → aucune supplantation (onglets réels distincts)',
  Object.keys(map).length === 0, JSON.stringify(map));

// Deux morts homonymes ayant CHACUN un onglet (2026-08-10) : `tabOpen` vient
// d'un matching par libellé — deux homonymes matchent le même onglet aussi bien
// que le leur, donc un successeur prouvé par le SEUL onglet ne prouve rien face
// à un husk qui en revendique un aussi. Découvert en rejouant
// test-group-master-focus.js, rouge une fois sur deux avant ce correctif : la
// conversation la plus ancienne des deux homonymes disparaissait de la liste,
// et le ⌂ ne voyait plus d'ambiguïté là où il y en a une.
map = computeSupersededBy([
  c({ sessionId: 'a', title: 'Conversation ambiguë', mtime: 100, tabOpen: true, tabMatches: 2 }),
  c({ sessionId: 'b', title: 'Conversation ambiguë', mtime: 200, tabOpen: true, tabMatches: 2 }),
]);
check('deux morts homonymes, DEUX onglets ouverts → aucune supplantation (rien n\'a été repris)',
  Object.keys(map).length === 0, JSON.stringify(map));

// UN SEUL onglet pour deux homonymes : là, quelqu'un a bien repris l'onglet de
// l'autre — c'est la forme exacte de l'incident 2026-07-24, le fold doit rester.
map = computeSupersededBy([
  c({ sessionId: 'husk', title: 'Conversation ambiguë', mtime: 100, tabOpen: true, tabMatches: 1 }),
  c({ sessionId: 'succ', title: 'Conversation ambiguë', mtime: 200, tabOpen: true, tabMatches: 1 }),
]);
check('… un seul onglet pour deux homonymes → husk supplanté (onglet repris)',
  map.husk === 'succ' && Object.keys(map).length === 1, JSON.stringify(map));

// … et un successeur VIVANT tranche de toute façon, quel que soit le compte
// d'onglets : son process prouve la continuité à lui seul.
map = computeSupersededBy([
  c({ sessionId: 'husk', title: 'Conversation ambiguë', mtime: 100, tabOpen: true, tabMatches: 2 }),
  c({ sessionId: 'succ', title: 'Conversation ambiguë', mtime: 200, tabOpen: true, tabMatches: 2, live: true }),
]);
check('… successeur VIVANT → husk supplanté même avec un onglet chacun',
  map.husk === 'succ' && Object.keys(map).length === 1, JSON.stringify(map));

// `tabMatches` absent (appelant qui ne le fournit pas) → garde neutralisée,
// comportement d'avant ce durcissement : c'est ce que fait tout le reste de ce
// banc, on le pose une fois explicitement.
map = computeSupersededBy([
  c({ sessionId: 'husk', title: 'Conversation ambiguë', mtime: 100, tabOpen: true }),
  c({ sessionId: 'succ', title: 'Conversation ambiguë', mtime: 200, tabOpen: true }),
]);
check('compte d\'onglets non fourni → dégradation silencieuse (fold comme avant)',
  map.husk === 'succ', JSON.stringify(map));

// Deux morts homonymes SANS onglet ni vie → pas de preuve de reload, rien fold.
map = computeSupersededBy([
  c({ sessionId: 'a', title: 'X', mtime: 100 }),
  c({ sessionId: 'b', title: 'X', mtime: 200 }),
]);
check('deux morts homonymes sans onglet → aucune supplantation (pas de preuve de continuité)',
  Object.keys(map).length === 0, JSON.stringify(map));

// Titre de repli (pas une identité fiable) → jamais fold, même dupliqué.
map = computeSupersededBy([
  c({ sessionId: 'a', title: 'Conversation', titleSource: 'first-user', mtime: 100 }),
  c({ sessionId: 'b', title: 'Conversation', titleSource: 'first-user', mtime: 200, tabOpen: true }),
]);
check('titre de repli homonyme → jamais supplanté', Object.keys(map).length === 0, JSON.stringify(map));

// Trois transcripts homonymes : les deux husks morts folds sur le seul vivant.
map = computeSupersededBy([
  c({ sessionId: 'h1', title: 'Trio', mtime: 100 }),
  c({ sessionId: 'h2', title: 'Trio', mtime: 150 }),
  c({ sessionId: 'succ', title: 'Trio', mtime: 300, live: true, tabOpen: true }),
]);
check('deux husks + un successeur vivant → les deux husks supplantés',
  map.h1 === 'succ' && map.h2 === 'succ' && !map.succ, JSON.stringify(map));

// Titre différent → jamais confondus.
map = computeSupersededBy([
  c({ sessionId: 'a', title: 'Lot 1', mtime: 100 }),
  c({ sessionId: 'b', title: 'Lot 2', mtime: 200, tabOpen: true }),
]);
check('titres différents → aucune supplantation', Object.keys(map).length === 0, JSON.stringify(map));

check('liste vide / null → objet vide, jamais d\'exception',
  Object.keys(computeSupersededBy([])).length === 0 && Object.keys(computeSupersededBy(null)).length === 0);

console.log('\n1bis. Second signal (durci 2026-08-05) : premier message user rejoué');

// L'incident réel du 2026-08-05 : titres qui divergent d'UN mot (ici « of »,
// présent d'un côté, absent de l'autre — les fixtures sont anonymisées, la
// forme du cas ne l'est pas), husk mort proprement (`done`, jamais un reload), successeur
// né sans qu'aucune fenêtre ne recharge. Le titre seul ne fold rien (vérifié
// ci-dessus, cas « titres différents ») — le premier message, lui, est rejoué
// à l'identique par le resume : c'est ce second signal qui doit trancher.
const PROMPT = 'Implement batch 1 (auto-collapse of finished groups) from Tools/X/PLAN.md';
map = computeSupersededBy([
  c({ sessionId: 'husk', title: 'Implement batch 1 (auto-collapse finished groups)', mtime: 100, firstUser: PROMPT }),
  c({ sessionId: 'succ', title: 'Implement batch 1 (auto-collapse of finished groups)', mtime: 200, tabOpen: true, firstUser: PROMPT }),
]);
check('ai-titles divergents d\'un mot + même premier message → husk supplanté par prompt',
  map.husk === 'succ' && Object.keys(map).length === 1, JSON.stringify(map));

// Même scénario mais successeur VIVANT (pas d'onglet à consulter) : même verdict.
map = computeSupersededBy([
  c({ sessionId: 'husk', title: 'Implement batch 1 (auto-collapse finished groups)', mtime: 100, firstUser: PROMPT }),
  c({ sessionId: 'succ', title: 'Implement batch 1 (auto-collapse of finished groups)', mtime: 300, live: true, firstUser: PROMPT }),
]);
check('… successeur vivant sans onglet matché → husk supplanté quand même',
  map.husk === 'succ', JSON.stringify(map));

// Le groupement par titre, quand il matche, reste prioritaire et n'est jamais
// perturbé par la présence d'un firstUser en plus (pas de double calcul).
map = computeSupersededBy([
  c({ sessionId: 'husk', title: 'Même titre', mtime: 100, firstUser: PROMPT }),
  c({ sessionId: 'succ', title: 'Même titre', mtime: 200, tabOpen: true, firstUser: PROMPT }),
]);
check('titre déjà identique + firstUser identique → un seul fold (pas de conflit)',
  map.husk === 'succ' && Object.keys(map).length === 1, JSON.stringify(map));

// Ambiguïté : le même premier message se retrouve sur DEUX transcripts distincts
// (deux conversations relancées la même nuit avec un prompt copié-collé) → même
// principe que matchPending, on ne tranche pas.
map = computeSupersededBy([
  c({ sessionId: 'husk', title: 'Titre A', mtime: 100, firstUser: PROMPT }),
  c({ sessionId: 'succ1', title: 'Titre B', mtime: 200, tabOpen: true, firstUser: PROMPT }),
  c({ sessionId: 'succ2', title: 'Titre C', mtime: 250, tabOpen: true, firstUser: PROMPT }),
]);
check('premier message dupliqué sur PLUS de deux convs → ambiguïté, aucune supplantation',
  Object.keys(map).length === 0, JSON.stringify(map));

// Prompt trop court (< MIN_PREFIX d'attach.js) : un « ok » ou un « go » ne doit
// identifier personne, même répété.
map = computeSupersededBy([
  c({ sessionId: 'husk', title: 'Titre A', mtime: 100, firstUser: 'ok' }),
  c({ sessionId: 'succ', title: 'Titre B', mtime: 200, tabOpen: true, firstUser: 'ok, allons-y' }),
]);
check('premier message trop court → jamais un signal d\'identité',
  Object.keys(map).length === 0, JSON.stringify(map));

// LE CAS QUI MANQUAIT (2026-08-10) : deux messages courts et STRICTEMENT
// ÉGAUX. Le check ci-dessus passait pour la mauvaise raison — ses deux chaînes
// diffèrent, donc rien ne matchait de toute façon. Sous MIN_PREFIX,
// looksLikeSamePrompt retombe sur l'égalité stricte (légitime côté attach.js,
// qui compare le prompt qu'il vient d'insérer) : « ok » == « ok » fondait deux
// conversations réelles. Symptôme mesuré : test-wave-advance.js en échec une
// fois sur trois, la vague d'un lot bloquée pour toujours.
map = computeSupersededBy([
  c({ sessionId: 'husk', title: 'Groupe A vague une terminée', mtime: 100, firstUser: 'prompt' }),
  c({ sessionId: 'succ', title: 'Groupe B vague une en cours', mtime: 200, live: true, tabOpen: true, firstUser: 'prompt' }),
]);
check('deux premiers messages courts IDENTIQUES → toujours aucune supplantation',
  Object.keys(map).length === 0, JSON.stringify(map));

// Même paire, message assez long pour identifier : le second signal reprend son
// office — la correction ci-dessus est un SEUIL, pas une désactivation.
map = computeSupersededBy([
  c({ sessionId: 'husk', title: 'Titre A', mtime: 100, firstUser: 'Reprends le chantier des vagues' }),
  c({ sessionId: 'succ', title: 'Titre B', mtime: 200, live: true, tabOpen: true, firstUser: 'Reprends le chantier des vagues' }),
]);
check('… mais un premier message assez long identifie toujours (seuil, pas désactivation)',
  map.husk === 'succ' && Object.keys(map).length === 1, JSON.stringify(map));

// Titres différents ET premiers messages différents → deux vraies conversations,
// jamais confondues.
map = computeSupersededBy([
  c({ sessionId: 'a', title: 'Titre A', mtime: 100, firstUser: 'Corrige le bug de pagination dans la liste des factures' }),
  c({ sessionId: 'b', title: 'Titre B', mtime: 200, tabOpen: true, firstUser: 'Ajoute un export CSV au tableau de bord des ventes' }),
]);
check('titres et premiers messages différents → aucune supplantation',
  Object.keys(map).length === 0, JSON.stringify(map));

// firstUser absent partout (bancs existants, appelants qui ne le fournissent
// pas) → repli exact sur le comportement d'avant, déjà couvert par le §1, mais
// on le revérifie explicitement avec des titres divergents pour marquer la
// non-régression : sans le second signal, on ne fold RIEN.
map = computeSupersededBy([
  c({ sessionId: 'husk', title: 'Implement batch 1 (auto-collapse finished groups)', mtime: 100 }),
  c({ sessionId: 'succ', title: 'Implement batch 1 (auto-collapse of finished groups)', mtime: 200, tabOpen: true }),
]);
check('titres divergents SANS firstUser fourni → aucune supplantation (dégradation silencieuse)',
  Object.keys(map).length === 0, JSON.stringify(map));

console.log('\n2. buildSnapshot : le husk sort de la liste, la redirection est publiée');

const WS = 'C:\\Users\\Test\\Projets VSCODE\\Reload';
const projectDir = state.projectDirFor(WS);
fs.mkdirSync(projectDir, { recursive: true });

const assistant = { type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000 } } };
const userMsg = (t) => ({ type: 'user', message: { content: [{ type: 'text', text: t }] } });
function writeTranscript(sessionId, aiTitle, mtimeMs) {
  const p = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(p, [userMsg('peu importe'), assistant, { type: 'ai-title', aiTitle }]
    .map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (mtimeMs) fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
  return p;
}

// husk = plus ancien, successeur = plus récent, MÊME ai-title. Une seule conv
// « seule » à titre distinct pour le témoin.
const now = Date.now();
writeTranscript('husk', 'Implement batch 1 slimmer wave panel', now - 90 * 60 * 1000);
writeTranscript('succ', 'Implement batch 1 slimmer wave panel', now - 60 * 1000);
writeTranscript('solo', 'Une conversation unique', now - 30 * 1000);

const tabs = (...labels) => ({ known: true, labels });
function snapshot(tabProvider, live = new Set()) {
  const reader = state.createTranscriptReader();
  return state.buildSnapshot({
    workspacePath: WS, recentMs: 4 * 3600 * 1000, maxItems: 12, tabs: tabProvider,
    liveSessions: () => live, sessionTitles: () => new Map(),
  }, reader);
}

// L'onglet « allègement panneau vagues » est ouvert (il matche husk ET succ) :
// le successeur (plus frais) reste, le husk sort, la redirection est publiée.
let snap = snapshot(() => tabs('Implement batch 1 slimmer wave panel', 'Une conversation unique'));
let ids = snap.conversations.map((c2) => c2.sessionId);
check('le successeur reste dans la liste', ids.includes('succ'), ids.join(' | '));
check('le husk (doublon) sort de la liste', !ids.includes('husk'), ids.join(' | '));
check('la conv unique reste', ids.includes('solo'), ids.join(' | '));
check('supersededBy publie husk→succ', snap.supersededBy && snap.supersededBy.husk === 'succ',
  JSON.stringify(snap.supersededBy));
check('… et rien d\'autre', snap.supersededBy && Object.keys(snap.supersededBy).length === 1,
  JSON.stringify(snap.supersededBy));

// Sans onglet ouvert pour ce titre : isGone masque déjà les deux (idle, ai-title
// matchable, pas de session vivante) → pas de doublon, pas de supplantation à
// signaler (les deux ont disparu de la vue). On vérifie juste l'absence de crash
// et une carte vide.
snap = snapshot(() => tabs('Une conversation unique'));
check('sans onglet pour le titre dupliqué : husk et succ masqués, carte vide',
  Object.keys(snap.supersededBy).length === 0
  && !snap.conversations.some((c2) => c2.sessionId === 'husk' || c2.sessionId === 'succ'),
  JSON.stringify(snap.conversations.map((c2) => c2.sessionId)));

console.log('\n3. buildSnapshot : respawn SANS reload, titres divergents d\'un mot — scénario réel 2026-08-05');

const WS2 = 'C:\\Users\\Test\\Projets VSCODE\\ReloadMoins';
const projectDir2 = state.projectDirFor(WS2);
fs.mkdirSync(projectDir2, { recursive: true });

function writeTranscriptWithPrompt(dir, sessionId, aiTitle, promptText, mtimeMs) {
  const p = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(p, [userMsg(promptText), assistant, { type: 'ai-title', aiTitle }]
    .map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (mtimeMs) fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
  return p;
}

// Premier prompt réel du batch (repris du plan) : c'est lui, pas l'ai-title
// dérivé, que le resume rejoue à l'identique.
const REAL_PROMPT = 'Implement batch 1 (auto-collapse of finished groups) from Tools/X/PLAN.md — read the whole plan before you start.';
const now2 = Date.now();
// Husk : tour fini proprement en `done` (jamais un reload), ai-title SANS « des ».
writeTranscriptWithPrompt(projectDir2, 'husk2', 'Implement batch 1 (auto-collapse finished groups)', REAL_PROMPT, now2 - 60 * 60 * 1000);
// Successeur : né sans reload, ai-title divergent d'un mot, MÊME premier message.
writeTranscriptWithPrompt(projectDir2, 'succ2', 'Implement batch 1 (auto-collapse of finished groups)', REAL_PROMPT, now2 - 60 * 1000);

// Seul l'onglet du successeur est ouvert — comme dans l'incident réel, le husk
// n'a plus aucun onglet à son nom (titre différent).
const openSuccTab = () => tabs('Implement batch 1 (auto-collapse of finished groups)');

function snapshot2(withSecondSignal) {
  const reader = state.createTranscriptReader();
  const args = [
    { workspacePath: WS2, recentMs: 4 * 3600 * 1000, maxItems: 12, tabs: openSuccTab,
      liveSessions: () => new Set(), sessionTitles: () => new Map() },
    reader,
  ];
  if (withSecondSignal) args.push(state.createFirstUserReader());
  return state.buildSnapshot(...args);
}

const snapFixed = snapshot2(true);
check('avec le second signal (premier message) : redirection husk2→succ2 publiée malgré la divergence de titre',
  snapFixed.supersededBy && snapFixed.supersededBy.husk2 === 'succ2', JSON.stringify(snapFixed.supersededBy));

const snapOld = snapshot2(false);
check('sans le second signal (comportement d\'avant le durcissement) : aucune redirection — régression reproduite',
  Object.keys(snapOld.supersededBy).length === 0, JSON.stringify(snapOld.supersededBy));

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
