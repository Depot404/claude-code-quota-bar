// Bout-en-bout de la FILIATION DES LOTS (plan PLAN_arbre_filiation_2026-08-15.md,
// lot 1) sur le VRAI activate() d'extension.js : le cas nominal d'un chantier en
// lots, tel qu'il se produit sur ce poste.
//
//   • le batch A a un membre m1 = la conversation du lot 1 ;
//   • c'est DEPUIS cette conv qu'a été collé le bloc qui a créé le batch B —
//     donc `masterSessionId` de B = la conv membre de A.
//
// Sans filiation, les deux blocs revendiquent le même nœud de conversation : A
// pour son emplacement de membre, B pour sa ligne de tête. Ce banc prouve le
// CÂBLAGE (groupStore → groupsState → masterState/memberTruth → computeNesting →
// état poussé au webview) plutôt que la règle pure, déjà couverte cas par cas
// par test-nesting.js. Le RENDU, lui, est le lot 2 (test-panel-render.js).
//
// Bouchons identiques à test-supersede-group.js : `vscode` (aucune fenêtre),
// `http`/`https` (aucun octet), `child_process` (aucun process). HOME = bac à
// sable.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-nesting-'));
os.homedir = () => SANDBOX;                       // AVANT tout require du module
fs.mkdirSync(path.join(SANDBOX, '.claude'), { recursive: true });
fs.mkdirSync(path.join(SANDBOX, '.claude', 'sessions'), { recursive: true });

const WORKSPACE_STORE = new Map();
const GLOBAL_STORE = new Map();
const workspaceState = {
  get: (k, d) => (WORKSPACE_STORE.has(k) ? WORKSPACE_STORE.get(k) : d),
  update: (k, v) => { WORKSPACE_STORE.set(k, v); return Promise.resolve(); },
};
const globalState = {
  get: (k, d) => (GLOBAL_STORE.has(k) ? GLOBAL_STORE.get(k) : d),
  update: (k, v) => { GLOBAL_STORE.set(k, v); return Promise.resolve(); },
};

const tabListeners = [];
const emitTabs = (e) => tabListeners.forEach((cb) => cb(e));
const pushed = [];

const claude = (label) => ({ label, input: { viewType: 'mainThreadWebview-claudeVSCodePanel' } });
const group = (tabs) => ({ viewColumn: 1, isActive: true, tabs });

let GROUPS = [];
let provider = null;
const vscodeStub = {
  window: {
    state: { focused: true },
    onDidChangeWindowState: () => ({ dispose() {} }),
    tabGroups: {
      get all() { return GROUPS; },
      get activeTabGroup() { return GROUPS[0] || { activeTab: null }; },
      onDidChangeTabs: (cb) => { tabListeners.push(cb); return { dispose() {} }; },
      onDidChangeTabGroups: () => ({ dispose() {} }),
    },
    registerWebviewViewProvider: (_type, p) => { provider = p; return { dispose() {} }; },
    createStatusBarItem: () => ({ show() {}, dispose() {} }),
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1 },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: 'C:\\Users\\Test\\Projets VSCODE\\Demo' } }],
    getConfiguration: () => ({ get: (_k, d) => d }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  commands: {
    registerCommand: () => ({ dispose() {} }),
    getCommands: async () => [],
    executeCommand: async () => {},
  },
  env: {
    openExternal: async () => {},
    clipboard: { writeText: async () => {} },
  },
  Uri: { parse: (s) => s },
  l10n: { t: (message, ...args) => (args.length ? message.replace(/\{(\d+)\}/g, (_, i) => (args[i] !== undefined ? args[i] : '')) : message) },
};
const netStub = { get: () => { throw new Error('network disabled in test'); } };
const procStub = {
  spawn: () => { throw new Error('spawn disabled in test'); },
  execSync: () => { throw new Error('execSync disabled in test'); },
};

const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'vscode') return vscodeStub;
  if (req === 'http' || req === 'https') return netStub;
  if (req === 'child_process') return procStub;
  return origLoad.call(this, req, ...rest);
};

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Faux workspace ────────────────────────────────────────────────────────
const WS = 'C:\\Users\\Test\\Projets VSCODE\\Demo';
const { projectDirFor } = require(path.join(__dirname, '..', 'state.js'));
const projectDir = projectDirFor(WS);
fs.mkdirSync(projectDir, { recursive: true });

const assistant = { type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000 } } };
function writeTranscript(id, title, promptText, mtimeMs) {
  const p = path.join(projectDir, `${id}.jsonl`);
  fs.writeFileSync(p, [
    { type: 'user', message: { content: [{ type: 'text', text: promptText }] } },
    assistant,
    { type: 'ai-title', aiTitle: title },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
}

const now = Date.now();
const TITLE_LOT1 = 'Nested batches, core — batch 1';
const TITLE_LOT2 = 'Nested panel rendering — batch 2';
writeTranscript('c1', TITLE_LOT1, 'Nested batches, core — batch 1 of plan Tools/X/PLAN.md …', now - 30 * 60 * 1000);
writeTranscript('d1', TITLE_LOT2, 'Nested panel rendering — batch 2 of plan Tools/X/PLAN.md …', now - 60 * 1000);

const STATE_FILE = path.join(SANDBOX, '.claude', 'sessions-state.json');
fs.writeFileSync(STATE_FILE, JSON.stringify({
  version: 1,
  sessions: {
    c1: { state: 'done', since: now - 30 * 60 * 1000, updated_at: now - 30 * 60 * 1000, transcript: path.join(projectDir, 'c1.jsonl') },
    d1: { state: 'done', since: now - 60 * 1000, updated_at: now - 60 * 1000, transcript: path.join(projectDir, 'd1.jsonl') },
  },
}));

function member(key, wave, prompt, sessionId, launchedAt) {
  return { key, prompt, model: null, effort: null, wave, sessionId: sessionId || null, launchedAt: launchedAt != null ? launchedAt : null };
}
WORKSPACE_STORE.set('batchGroups', [
  // Le lot précédent : la conv du lot 1 est un de ses MEMBRES.
  {
    id: 'gA', name: 'nesting-demo', createdAt: now - 3 * 60 * 60 * 1000, collapsed: false,
    masterSessionId: null, masterTitle: '',
    members: [member('m1', 1, 'batch 1', 'c1', now - 3 * 60 * 60 * 1000)],
  },
  // Le lot suivant, créé DEPUIS cette conv : elle en est la MAÎTRESSE.
  {
    id: 'gB', name: 'nesting-demo-next', createdAt: now - 30 * 60 * 1000, collapsed: false,
    masterSessionId: 'c1', masterTitle: TITLE_LOT1,
    members: [member('n1', 1, 'batch 2', 'd1', now - 30 * 60 * 1000)],
  },
]);

async function run() {
  const ext = require(path.join(__dirname, '..', 'extension.js'));

  // Les deux conversations ont un onglet ouvert : elles sont donc toutes deux
  // dans la fenêtre du panneau (`listed`), condition de la filiation.
  GROUPS = [group([claude(TITLE_LOT1), claude(TITLE_LOT2)])];

  const context = { subscriptions: [], workspaceState, globalState };
  ext.activate(context);

  provider.resolveWebviewView({
    webview: {
      options: {}, cspSource: 'vscode-resource:', html: '',
      postMessage: (m) => { pushed.push(m); },
      onDidReceiveMessage: () => ({ dispose() {} }),
    },
    onDidDispose: () => ({ dispose() {} }),
  });
  emitTabs({ closed: [], opened: [], changed: [claude(TITLE_LOT1)] });

  let state = null;
  for (let i = 0; i < 100 && !state; i++) {
    const last = [...pushed].reverse().find((m) => m && m.type === 'state');
    if (last) state = last.state;
    else await sleep(10);
  }
  check('un état de panneau a bien été poussé', !!state, JSON.stringify(pushed.map((m) => m && m.type)));

  const groups = (state && state.groups) || [];
  const A = groups.find((g) => g.id === 'gA');
  const B = groups.find((g) => g.id === 'gB');
  const convs = (state && state.conversations) || [];

  console.log('\n1. Le décor est bien celui du cas nominal');
  check('les deux conversations sont dans la vue',
    convs.some((c) => c.id === 'c1') && convs.some((c) => c.id === 'd1'), JSON.stringify(convs.map((c) => c.id)));
  check('la conv du lot 1 est rendue comme MEMBRE de A (elle porte son groupId)',
    (convs.find((c) => c.id === 'c1') || {}).groupId === 'gA', JSON.stringify(convs.find((c) => c.id === 'c1')));
  check('… et elle est la maîtresse LISTÉE de B',
    !!B && !!B.master && B.master.convId === 'c1' && B.master.listed === true, JSON.stringify(B && B.master));
  check('le membre hôte est encore rendu (statut ≠ done-closed)',
    !!A && A.members[0].status !== 'done-closed', JSON.stringify(A && A.members));

  console.log('\n2. La filiation est publiée dans l\'état poussé');
  check('B se rend sous le membre m1 de A',
    !!B && !!B.nestedUnder && B.nestedUnder.groupId === 'gA' && B.nestedUnder.memberKey === 'm1',
    JSON.stringify(B && B.nestedUnder));
  check('A reste une racine (champ présent et null, jamais absent)',
    !!A && Object.prototype.hasOwnProperty.call(A, 'nestedUnder') && A.nestedUnder === null,
    JSON.stringify(A && A.nestedUnder));

  console.log('\n3. Le parent qui accueille un enfant ne peut pas être masqué');
  // Par construction (nesting.js) : accueillir exige un membre non
  // done-closed, or `done` exige que TOUS le soient. Aucune suspension à
  // écrire — mais on le vérifie sur le vrai calcul, pas seulement en théorie.
  check('A n\'est pas « done » (donc rendu, donc son enfant a une tête)',
    !!A && A.done === false, JSON.stringify(A && A.done));

  console.log('\n4. Aucun résidu');
  for (const s of context.subscriptions) { try { s.dispose(); } catch {} }
  ext.deactivate();

  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
