// Banc du JUGE RENDERER — state.js buildSnapshot, aval du verdict par libellés.
//
// Ce que le juge fait depuis 2.106.0, et RIEN d'autre depuis 2.110.0 : il COMBLE
// un surlignage vide. Un miroir d'onglets honnête donne le bon LIBELLÉ, jamais
// une IDENTITÉ ; quand ce libellé ne correspond à aucune conversation listée
// (onglet renommé avec le début du prompt de sa tâche — mesuré le 2026-09-02,
// signalé par l'user), il ne reste rien et la ligne de l'onglet regardé ne
// s'allume plus. Le memento `workbench.parts.editor` du state.vscdb, écrit par
// le RENDERER, nomme la session affichée : c'est lui qui remplit ce vide.
//
// Ce qu'il ne fait PLUS (retiré en 2.110.0 avec le bug qui le motivait —
// microsoft/vscode#331914, corrigé dans VS Code 1.135) : ÉCRASER un choix déjà
// posé pour corriger un mensonge de la copie miroir. Avec cette branche sont
// partis la marge longue de 45 s, les épisodes `highlight-reconciled`, le
// bandeau du panneau et `reconcileMemory`.
//
//   §1 verdict par libellés MUET + memento frais → la ligne s'allume, marge
//      courte (3 s), rien à rétrograder ;
//   §2 un choix DÉJÀ posé n'est jamais écrasé, si vieux soit-il ;
//   §3 juge inutilisable (memento en retard, actif non-Claude, session hors
//      liste, tabs sans labelChangedAt) → il se tait ;
//   §4 onglet RENOMMÉ + positions du memento validées → la ligne s'allume TOUT
//      DE SUITE par identité, sans attendre aucun flush (2026-09-03).
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-renderer-truth-'));
os.homedir = () => SANDBOX;                       // AVANT le require de state.js
fs.mkdirSync(path.join(SANDBOX, '.claude'), { recursive: true });

const state = require(path.join(__dirname, '..', 'state.js'));
const journal = require(path.join(__dirname, '..', 'ack-journal.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

const WS = 'C:\\Users\\Test\\Projets VSCODE\\DemoRendererTruth';
const projectDir = state.projectDirFor(WS);
fs.mkdirSync(projectDir, { recursive: true });

const assistant = { type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000 } } };
const userMsg = (t) => ({ type: 'user', message: { content: [{ type: 'text', text: t }] } });
function writeTranscript(sessionId, title, mtimeOffsetSec) {
  const p = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(p, [userMsg(`premier message ${sessionId}`), assistant, { type: 'ai-title', aiTitle: title }]
    .map((l) => JSON.stringify(l)).join('\n') + '\n');
  const when = (Date.now() - mtimeOffsetSec * 1000) / 1000;
  fs.utimesSync(p, when, when);
}
writeTranscript('a', 'Conv A', 20);
writeTranscript('b', 'Conv B', 10);

const DEFAULT_JOURNAL = path.join(SANDBOX, '.claude', 'quotabar-ack-journal.jsonl');
const lines = () => journal.readJournal(DEFAULT_JOURNAL);
const verdicts = () => lines().filter((l) => l.event === 'highlight-verdict');

// La marge réelle reste en place — 3 s (QUOTABAR_TRUTH_FILL_MARGIN_MS) : les
// timestamps fabriqués ci-dessous l'encadrent largement des deux côtés.
const NOW = Date.now();
const reader = state.createTranscriptReader();
// `activeLabel` qui ne matche AUCUNE conversation listée : c'est LA condition
// d'entrée du juge — le verdict par libellés est muet, il n'y a aucun choix.
const NO_MATCH = 'Rétablis une surface visible pour une conv…';
function build(tabsPatch, rendererActive, extra) {
  return state.buildSnapshot(Object.assign({
    workspacePath: WS, recentMs: 4 * 3600 * 1000, maxItems: 12,
    tabs: () => Object.assign({
      known: true, labels: ['Conv A', 'Conv B'], activeLabel: NO_MATCH,
      source: 'fresh', windowFocused: true, sinceFocusMs: 42, labelChangedAt: NOW - 5000,
    }, tabsPatch),
    rendererActive: () => rendererActive,
  }, extra || {}), reader);
}
const activeOf = (snap) => snap.conversations.filter((c) => c.isActive).map((c) => c.sessionId);

console.log('\n1. Verdict par libellés MUET + memento frais → la ligne s\'allume (marge courte)');
{
  // Le cas signalé par l'user sur VS Code 1.135 : ses onglets ont été renommés
  // avec le début du PROMPT de leur tâche pendant que le panneau garde le titre
  // — donc `activeLabel` ne correspond à aucune ligne (matches:0, via:none) et
  // plus rien ne s'allume quand on focuse l'onglet. Combler n'écrase aucun
  // choix : la marge de 3 s suffit (ici, clic vieux de 5 s, flush de 0,4 s).
  const snap = build({}, { sessionId: 'b', claude: true, flushedAt: NOW - 400 });
  check('la ligne de l\'onglet réellement affiché s\'allume, alors qu\'aucun libellé ne matche',
    JSON.stringify(activeOf(snap)) === '["b"]', JSON.stringify(activeOf(snap)));
  const v = verdicts()[verdicts().length - 1];
  check('… et le journal dit d\'où vient ce verdict : via:renderer-truth, matches:0',
    v && v.via === 'renderer-truth' && v.matches === 0, JSON.stringify(v));
}

console.log('\n2. Un choix DÉJÀ posé n\'est JAMAIS écrasé (le juge ne corrige plus rien)');
{
  // Même memento frais qu'au §1, mais cette fois le libellé actif désigne bien
  // une conversation : le verdict par libellés a tranché, et il tient — même si
  // le memento nomme l'autre. C'est `judgeAllowed = !highlightSessionId`.
  const snap = build({ activeLabel: 'Conv A' }, { sessionId: 'b', claude: true, flushedAt: NOW - 400 });
  check('le verdict par libellés (Conv A) reste, le memento ne le contredit pas',
    JSON.stringify(activeOf(snap)) === '["a"]', JSON.stringify(activeOf(snap)));
  // Et même avec un avis de tracker très ancien : ce qui garde la main n'est
  // pas la fraîcheur, c'est le fait qu'une preuve a DÉJÀ désigné une ligne.
  const old = build({ activeLabel: 'Conv A', labelChangedAt: NOW - 10 * 60 * 1000 },
    { sessionId: 'b', claude: true, flushedAt: NOW - 400 });
  check('… y compris quand l\'avis du tracker date de 10 minutes',
    JSON.stringify(activeOf(old)) === '["a"]', JSON.stringify(activeOf(old)));
}

console.log('\n3. Juge inutilisable → il se tait, personne n\'est surligné au hasard');
{
  const late = build({}, { sessionId: 'b', claude: true, flushedAt: NOW - 4000 });
  check('memento PLUS VIEUX que le dernier avis du tracker → rien (il n\'apprend rien)',
    activeOf(late).length === 0, JSON.stringify(activeOf(late)));

  const onFile = build({}, { sessionId: null, claude: false, flushedAt: NOW - 400 });
  check('actif non-Claude (l\'utilisateur est sur un fichier) → rien',
    activeOf(onFile).length === 0, JSON.stringify(activeOf(onFile)));

  const unknown = build({}, { sessionId: 'zz-hors-liste', claude: true, flushedAt: NOW - 400 });
  check('session hors liste → rien (jamais de surlignage sur de l\'invisible)',
    activeOf(unknown).length === 0, JSON.stringify(activeOf(unknown)));

  const noClock = build({ labelChangedAt: undefined }, { sessionId: 'b', claude: true, flushedAt: NOW - 400 });
  check('tabs sans labelChangedAt (appelant d\'avant ce lot) → juge inactif',
    activeOf(noClock).length === 0, JSON.stringify(activeOf(noClock)));

  const noJudge = build({}, null);
  check('rendererActive absent (base illisible) → juge inactif, aucune erreur',
    activeOf(noJudge).length === 0, JSON.stringify(activeOf(noJudge)));
}

console.log('\n4. Onglet RENOMMÉ, positions du memento validées → la ligne s\'allume TOUT DE SUITE, par identité (2026-09-03)');
{
  // §1 comble par le juge — donc à la cadence des flushs du renderer (~5 s
  // mesurées le 2026-09-03, et à zéro à chaque changement d'onglet en
  // attendant le flush suivant). Or la TABLE des positions, validée en bloc,
  // nommait déjà la session à l'index actif ; elle était écartée parce que le
  // libellé trouvé là (« ok go », dernier prompt) ne matchait pas le titre.
  // Un libellé qui ne nomme PERSONNE ne contredit pas l'identité (labels.js
  // `labelNamesAnother`) : la position s'adopte, l'index actif désigne la ligne,
  // sans attendre aucun juge.
  const positions = () => ({
    byId: new Map([
      ['a', { viewColumn: 1, index: 0, flatIndex: 0 }],
      ['b', { viewColumn: 1, index: 1, flatIndex: 1 }],
    ]),
    activeFlatIndex: 1,
  });
  const snap = build(
    { labels: ['Conv A', 'ok go'], activeLabel: 'ok go', activeIndex: 1, labelChangedAt: NOW - 100 },
    { sessionId: null, claude: false, flushedAt: null },   // juge MUET : rien à combler
    { sessionTabLocations: positions });
  check('la conversation dont l\'onglet a été renommé « ok go » est surlignée sans aucun flush du renderer',
    JSON.stringify(activeOf(snap)) === '["b"]', JSON.stringify(activeOf(snap)));
  const v = verdicts()[verdicts().length - 1];
  check('… et le journal dit d\'où vient ce verdict : via:identity, matches:0',
    v && v.via === 'identity' && v.matches === 0, JSON.stringify(v));

  // L'autre monde : même photo, mais les onglets ont été RÉORDONNÉS depuis le
  // flush — à l'index 1 on trouve « Conv A », qui NOMME la conversation a. La
  // position de b est donc périmée : écartée, et c'est a (le libellé actif) qui
  // s'allume, par libellé comme avant.
  const snap2 = build(
    { labels: ['Conv B', 'Conv A'], activeLabel: 'Conv A', activeIndex: 1, labelChangedAt: NOW - 100 },
    { sessionId: null, claude: false, flushedAt: null },
    { sessionTabLocations: positions });
  check('onglets réordonnés : le libellé à la position nomme a → la position de b est écartée, a s\'allume',
    JSON.stringify(activeOf(snap2)) === '["a"]', JSON.stringify(activeOf(snap2)));
}

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
