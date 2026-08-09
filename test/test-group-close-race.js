// Bout-en-bout de l'étape 17 (plan repli-auto, PLAN_repli_auto_groupe_done_
// 2026-08-04.md) sur le VRAI activate() d'extension.js : ferme l'onglet d'un
// membre de groupe et vérifie qu'AUCUN rendu intermédiaire n'affiche « ouverte »
// sur un onglet fermé — quel que soit l'ordre dans lequel les hooks
// (sessions-state.json) et le registre des sessions vivantes (~/.claude/
// sessions/<pid>.json) finissent par purger leur propre trace.
//
// Reproduit la course réelle : `closeConversations()` (extension.js) pose
// `markClosed` PUIS `removeSession` dans la MÊME fonction — les deux purges ne
// sont donc JAMAIS simultanées. Le registre, lui, appartient au CLI et n'est
// jamais nettoyé par nous (cf. live-sessions.js) : on le laisse en place tout
// le test pour simuler le cas le plus dur, celui qui a produit le bug observé
// (constat user 2026-08-05 soir).
//
// Bouchons identiques à test-close-e2e.js : `vscode` (aucune fenêtre), `http`/
// `https` (aucun octet), `child_process` (aucun process). HOME = bac à sable.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-group-close-race-'));
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

let GROUPS = [];
const tabListeners = [];
const emitTabs = (e) => tabListeners.forEach((cb) => cb(e));
const pushed = [];

const claude = (label) => ({ label, input: { viewType: 'mainThreadWebview-claudeVSCodePanel' } });
const group = (tabs) => ({ viewColumn: 1, isActive: true, tabs });

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
  env: { openExternal: async () => {}, clipboard: { writeText: async () => {} } },
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

// ── Faux workspace : un groupe, deux membres — l'un `done`, l'autre `busy` ──
const WS = 'C:\\Users\\Test\\Projets VSCODE\\Demo';
const { projectDirFor } = require(path.join(__dirname, '..', 'state.js'));
const projectDir = projectDirFor(WS);
fs.mkdirSync(projectDir, { recursive: true });

const assistant = { type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000 } } };
function writeTranscript(id, title) {
  fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), [
    { type: 'user', message: { content: [{ type: 'text', text: 'prompt' }] } },
    assistant,
    { type: 'ai-title', aiTitle: title },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
}
writeTranscript('mdone', 'Membre déjà terminé du groupe');
writeTranscript('mbusy', 'Membre encore au travail du groupe');

const STATE_FILE = path.join(SANDBOX, '.claude', 'sessions-state.json');
const now = Date.now();
fs.writeFileSync(STATE_FILE, JSON.stringify({
  version: 1,
  sessions: {
    mdone: { state: 'done', since: now, updated_at: now, transcript: path.join(projectDir, 'mdone.jsonl') },
    mbusy: { state: 'busy', since: now, updated_at: now, transcript: path.join(projectDir, 'mbusy.jsonl') },
  },
}));

// Registre des sessions vivantes : jamais purgé par nous (propriété du CLI,
// cf. live-sessions.js) — on le laisse tel quel APRÈS la fermeture de l'onglet
// pour reproduire le cas le plus dur : le process paraît encore vivant
// (pid = celui du test, donc `pidAlive` vrai) longtemps après que le panneau,
// lui, sait déjà que l'onglet est parti.
const SESSIONS_DIR = path.join(SANDBOX, '.claude', 'sessions');
function writeLiveEntry(sessionId) {
  fs.writeFileSync(path.join(SESSIONS_DIR, `${sessionId}.json`), JSON.stringify({
    sessionId, pid: process.pid, cwd: WS, startedAt: now,
  }));
}
writeLiveEntry('mdone');
writeLiveEntry('mbusy');

WORKSPACE_STORE.set('batchGroups', [{
  id: 'g1', name: 'groupe de test', createdAt: now, collapsed: false,
  masterSessionId: null, masterTitle: '',
  members: [
    { key: 'm1', prompt: 'Membre déjà terminé du groupe', model: null, effort: null, wave: 1, sessionId: 'mdone', launchedAt: now - 1000 },
    { key: 'm2', prompt: 'Membre encore au travail du groupe', model: null, effort: null, wave: 1, sessionId: 'mbusy', launchedAt: now - 1000 },
  ],
}]);

function lastState() {
  const last = [...pushed].reverse().find((m) => m && m.type === 'state');
  return last ? last.state : null;
}
function memberOf(key, st) {
  const g = st && (st.groups || []).find((x) => x.id === 'g1');
  return g && g.members.find((m) => m.key === key);
}

async function run() {
  const ext = require(path.join(__dirname, '..', 'extension.js'));

  GROUPS = [group([claude('Membre déjà terminé du gro…'), claude('Membre encore au travail du…')])];

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
  await sleep(150);

  console.log('\n1. État initial — les deux onglets sont ouverts');
  let m1 = memberOf('m1', lastState());
  let m2 = memberOf('m2', lastState());
  check('membre terminé : status done, chip de fermeture proposé',
    m1 && m1.status === 'done' && m1.canClose === true, JSON.stringify(m1));
  check('membre au travail : status busy', m2 && m2.status === 'busy', JSON.stringify(m2));

  console.log('\n2. Fermeture des DEUX onglets — le registre reste vivant (course la plus dure)');
  GROUPS = [group([])];
  const beforeCount = pushed.length;
  const t0 = Date.now();
  emitTabs({
    closed: [claude('Membre déjà terminé du gro…'), claude('Membre encore au travail du…')],
    opened: [], changed: [],
  });

  // On observe TOUS les rendus poussés depuis la fermeture — pas seulement le
  // dernier — pour prouver qu'AUCUN d'entre eux, même transitoire, n'affiche
  // « ouverte » (idle/inserted) sur un onglet prouvé fermé.
  let sawLie = null;
  let maskedAt = 0;
  for (let i = 0; i < 150; i++) {
    for (const p of pushed.slice(beforeCount)) {
      if (p.type !== 'state') continue;
      const a = memberOf('m1', p.state);
      const b = memberOf('m2', p.state);
      if (a && (a.status === 'idle' || a.status === 'inserted')) sawLie = sawLie || { key: 'm1', status: a.status, note: a.note };
      if (b && (b.status === 'idle' || b.status === 'inserted')) sawLie = sawLie || { key: 'm2', status: b.status, note: b.note };
      if (!maskedAt && a && a.status === 'done-closed') maskedAt = Date.now() - t0;
    }
    m1 = memberOf('m1', lastState());
    m2 = memberOf('m2', lastState());
    if (m1 && m1.status === 'done-closed' && m2 && m2.status === 'stale') break;
    await sleep(10);
  }

  check('AUCUN rendu transitoire n\'a affiché idle/inserted (onglet prouvé fermé) sur un membre',
    sawLie === null, JSON.stringify(sawLie));
  check(`membre terminé → done-closed dès le premier rendu post-fermeture (${maskedAt || '>1500'} ms, exigence < 1 s)`,
    maskedAt > 0 && maskedAt < 1000, `${maskedAt} ms`);
  check('… donc masqué côté webview (status !== done-closed y est filtré, étape 11)',
    m1 && m1.status === 'done-closed', JSON.stringify(m1));
  check('membre encore au travail dont l\'onglet ferme → stale (reste à faire, jamais masqué)',
    m2 && m2.status === 'stale', JSON.stringify(m2));
  check('… jamais done-closed pour le membre busy (rien n\'est terminé)',
    m2 && m2.status !== 'done-closed', JSON.stringify(m2));

  console.log('\n3. Aucun résidu');
  for (const s of context.subscriptions) { try { s.dispose(); } catch {} }
  ext.deactivate();

  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
