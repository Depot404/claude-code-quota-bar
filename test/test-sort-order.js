// Banc du tri d'affichage des conversations (claudeCodeQuotaBar.conversationSortOrder).
// 3 modes indépendants du tri mtime interne (qui ne sert qu'à borner la lecture
// des transcripts, cf. state.js SCAN_LIMIT) : lastActivity (déjà l'ordre obtenu),
// tabOrder (ordre des onglets VS Code), statusFirst (busy/waiting en tête).
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-sort-'));
os.homedir = () => SANDBOX;                       // AVANT le require de state.js
fs.mkdirSync(path.join(SANDBOX, '.claude'), { recursive: true });

const state = require(path.join(__dirname, '..', 'state.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

const WS = 'C:\\Users\\Test\\Projets VSCODE\\DemoSort';
const projectDir = state.projectDirFor(WS);
fs.mkdirSync(projectDir, { recursive: true });

const assistant = { type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000 } } };
const userMsg = (t) => ({ type: 'user', message: { content: [{ type: 'text', text: t }] } });

function writeTranscript(sessionId, title, mtimeOffsetSec) {
  const p = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(p, [userMsg('peu importe'), assistant, { type: 'ai-title', aiTitle: title }]
    .map((l) => JSON.stringify(l)).join('\n') + '\n');
  const when = (Date.now() - mtimeOffsetSec * 1000) / 1000;
  fs.utimesSync(p, when, when);
  return p;
}

// Écriture la plus récente en premier : A (30s), B (20s), C (10s) → lastActivity
// attendu = C, B, A.
writeTranscript('a', 'Conv A', 30);
writeTranscript('b', 'Conv B', 20);
writeTranscript('c', 'Conv C', 10);

fs.writeFileSync(path.join(SANDBOX, '.claude', 'sessions-state.json'), JSON.stringify({
  version: 1,
  sessions: {
    // B seule busy : statusFirst doit la faire remonter malgré son ancienneté
    // relative à C.
    b: { state: 'busy', since: Date.now(), updated_at: Date.now(), transcript: path.join(projectDir, 'b.jsonl') },
  },
}));

function snapshot(sortOrder, tabsProvider) {
  const reader = state.createTranscriptReader();
  return state.buildSnapshot({
    workspacePath: WS, recentMs: 4 * 3600 * 1000, maxItems: 12,
    tabs: tabsProvider, sortOrder,
  }, reader);
}

// known:false (aucune info d'onglets) pour les tests 1/4/5 : le filtre de
// présence (isGone, state.js) ne masque RIEN dans ce cas — on isole le tri
// sans interférence avec la présence d'onglet, hors du test 2/3 qui la teste
// exprès.
const noTabInfo = () => ({ known: false, labels: [] });

console.log('\n1. lastActivity (défaut historique, ordre déjà mtime desc)');
let titles = snapshot('lastActivity', noTabInfo).conversations.map((c) => c.title);
check('C, B, A (plus récemment actif en tête)',
  titles.join(',') === 'Conv C,Conv B,Conv A', titles.join(','));

console.log('\n2. tabOrder (ordre des onglets VS Code, gauche → droite)');
titles = snapshot('tabOrder', () => ({ known: true, labels: ['Conv B', 'Conv A', 'Conv C'] })).conversations.map((c) => c.title);
check('B, A, C (ordre des onglets, PAS mtime)',
  titles.join(',') === 'Conv B,Conv A,Conv C', titles.join(','));

console.log('\n3. tabOrder : conv busy sans onglet matché (session CLI, isGone la garde quand même) part en fin');
// C et A n'ont pas d'entrée sessions-state (idle) : sans onglet matché, le
// filtre de présence (isGone) les masquerait — seule B (busy, cf. fixture
// globale plus haut) survit sans tab. Avec tabs=['Conv A'] seule A a un onglet ;
// B doit donc apparaître APRÈS A (position Infinity), pas avant.
titles = snapshot('tabOrder', () => ({ known: true, labels: ['Conv A'] })).conversations.map((c) => c.title);
check('A en tête (onglet ouvert), puis B (busy, sans onglet)',
  titles.join(',') === 'Conv A,Conv B', titles.join(','));

console.log('\n4. statusFirst (busy/waiting en tête, peu importe l\'ancienneté)');
titles = snapshot('statusFirst', noTabInfo).conversations.map((c) => c.title);
check('B (busy) en tête, puis C, A dans leur ordre mtime d\'origine',
  titles.join(',') === 'Conv B,Conv C,Conv A', titles.join(','));

console.log('\n5. Valeur inconnue/absente → repli sur lastActivity (compat)');
titles = snapshot(undefined, noTabInfo).conversations.map((c) => c.title);
check('repli lastActivity quand sortOrder est absent',
  titles.join(',') === 'Conv C,Conv B,Conv A', titles.join(','));

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
