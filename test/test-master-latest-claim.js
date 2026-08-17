// Bout-en-bout de « LA MAÎTRESSE N'ENGAGE QUE SON DERNIER LOT »
// (plan PLAN_maitresse_dernier_lot_2026-08-15.md) sur le VRAI activate()
// d'extension.js, reproduisant le cas constaté sur ce poste :
//
//   une même conversation de cadrage a lancé DEUX lots à des heures
//   différentes (03:01 puis 14:34) → `masterSessionId` identique sur les deux
//   groupes. Deux effets, tous deux vérifiés à l'époque sur les données réelles :
//     1. VOL DE NŒUD — il n'y a qu'UN nœud de conversation (rowFor, panel.js) ;
//        les deux capsules le réclament, le dernier rendu gagne, et le groupe
//        ANCIEN affiche une capsule VIDE (pas même son repli dégradé, puisque
//        sa maîtresse est bel et bien listée) ;
//     2. IMMORTALITÉ — `groupDone` exige que la maîtresse soit `done-closed` ;
//        tant qu'elle vit (elle pilote le lot suivant), le vieux lot reste
//        affiché « 3/3 done » pour toujours.
//
// Ce banc prouve le CÂBLAGE de bout en bout (groupStore → groupsState →
// masterState/memberTruth → computeNesting → état poussé au webview) ; la règle
// pure, cas par cas, est dans test-nesting.js §13-19, et le stampage dans
// test-group-store.js.
//
// Fixtures en ANGLAIS et fictives : le dossier test/ part au dépôt public.
// Bouchons identiques à test-nesting-e2e.js : `vscode` (aucune fenêtre),
// `http`/`https` (aucun octet), `child_process` (aucun process). HOME = bac à
// sable.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-latest-claim-'));
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

const TITLE_MASTER = 'Automating the assistant with AI';
const tabMaster = claude(TITLE_MASTER);
// SEULE la conv de cadrage a un onglet : les membres des deux lots sont
// terminés, onglets fermés (`done-closed`) — c'est ce qui rend le lot ancien
// candidat à s'effacer, et donc l'immortalité observable.
let GROUPS = [{ viewColumn: 1, isActive: true, tabs: [tabMaster], activeTab: tabMaster }];

let provider = null;
let receiveHandler = null;
const vscodeStub = {
  window: {
    state: { focused: true },
    onDidChangeWindowState: () => ({ dispose() {} }),
    tabGroups: {
      get all() { return GROUPS; },
      get activeTabGroup() { return GROUPS[0] || { activeTab: null }; },
      onDidChangeTabs: (cb) => { tabListeners.push(cb); return { dispose() {} }; },
      onDidChangeTabGroups: () => ({ dispose() {} }),
      close: async () => {},
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
async function waitFor(pred, label) {
  for (let i = 0; i < 200; i++) {
    if (pred()) return true;
    await sleep(10);
  }
  console.log(`  (timeout waiting for: ${label})`);
  return false;
}

// ── Faux workspace ────────────────────────────────────────────────────────
const WS = 'C:\\Users\\Test\\Projets VSCODE\\Demo';
const { projectDirFor } = require(path.join(__dirname, '..', 'state.js'));
const projectDir = projectDirFor(WS);
fs.mkdirSync(projectDir, { recursive: true });

const assistant = { type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000 } } };
function writeTranscript(id, title, mtimeMs) {
  const p = path.join(projectDir, `${id}.jsonl`);
  fs.writeFileSync(p, [
    { type: 'user', message: { content: [{ type: 'text', text: `first prompt of ${id}` }] } },
    assistant,
    { type: 'ai-title', aiTitle: title },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
}

const now = Date.now();
const AT_0301 = now - 11 * 60 * 60 * 1000;
const AT_1434 = now - 30 * 60 * 1000;
writeTranscript('cadrage', TITLE_MASTER, now - 60 * 1000);
writeTranscript('a1', 'Batch of 03:01 — its only task', AT_0301);
writeTranscript('b1', 'Batch of 14:34 — its only task', AT_1434);

const STATE_FILE = path.join(SANDBOX, '.claude', 'sessions-state.json');
const sess = (id, at) => ({ state: 'done', since: at, updated_at: at, transcript: path.join(projectDir, `${id}.jsonl`) });
fs.writeFileSync(STATE_FILE, JSON.stringify({
  version: 1,
  sessions: { cadrage: sess('cadrage', now - 60 * 1000), a1: sess('a1', AT_0301), b1: sess('b1', AT_1434) },
}));

function member(key, prompt, sessionId, launchedAt) {
  return { key, prompt, model: null, effort: null, wave: 1, sessionId, launchedAt };
}
// Les deux lots portent la MÊME maîtresse, et AUCUN `masterLinkedAt` : c'est
// littéralement le stockage réel, écrit avant ce plan — le repli de sanitize
// (createdAt du groupe) est donc lui aussi sous test.
// ORDRE VOLONTAIRE : le lot RÉCENT est le premier du store. Si la résolution
// suivait l'ordre du store (le « dernier rendu gagne » d'avant), c'est le vieux
// qui garderait la tête — le banc verrouille que c'est bien la DATE qui tranche.
WORKSPACE_STORE.set('batchGroups', [
  {
    id: 'gRecent', name: 'batch-1434', createdAt: AT_1434, collapsed: false,
    masterSessionId: 'cadrage', masterTitle: TITLE_MASTER,
    members: [member('n1', 'task of the 14:34 batch', 'b1', AT_1434)],
  },
  {
    id: 'gOld', name: 'batch-0301', createdAt: AT_0301, collapsed: false,
    masterSessionId: 'cadrage', masterTitle: TITLE_MASTER,
    members: [member('m1', 'task of the 03:01 batch', 'a1', AT_0301)],
  },
]);

function lastState() {
  const last = [...pushed].reverse().find((m) => m && m.type === 'state');
  return last && last.state;
}
const grp = (id) => ((lastState() || {}).groups || []).find((g) => g.id === id);

async function run() {
  const ext = require(path.join(__dirname, '..', 'extension.js'));
  const context = { subscriptions: [], workspaceState, globalState };
  ext.activate(context);

  provider.resolveWebviewView({
    webview: {
      options: {}, cspSource: 'vscode-resource:', html: '',
      postMessage: (m) => { pushed.push(m); },
      onDidReceiveMessage: (cb) => { receiveHandler = cb; return { dispose() {} }; },
    },
    onDidDispose: () => ({ dispose() {} }),
  });
  emitTabs({ closed: [], opened: [], changed: [tabMaster] });
  await waitFor(() => !!lastState() && !!grp('gOld') && !!grp('gRecent'), 'les deux lots dans un état poussé');

  console.log('\n1. Le décor est bien celui du bug constaté');
  const convs = (lastState() || {}).conversations || [];
  check('la conv de cadrage est dans la vue (son onglet est ouvert)',
    convs.some((c) => c.id === 'cadrage'), JSON.stringify(convs.map((c) => c.id)));
  check('elle n\'est membre d\'aucun lot (donc aucune filiation ne peut la sauver)',
    (convs.find((c) => c.id === 'cadrage') || {}).groupId == null && !grp('gOld').nestedUnder && !grp('gRecent').nestedUnder,
    JSON.stringify([grp('gOld').nestedUnder, grp('gRecent').nestedUnder]));
  check('les deux lots ont leur unique membre terminé, onglet fermé',
    grp('gOld').members[0].status === 'done-closed' && grp('gRecent').members[0].status === 'done-closed',
    JSON.stringify([grp('gOld').members[0].status, grp('gRecent').members[0].status]));

  console.log('\n2. Le lien le plus RÉCENT garde la conversation en tête');
  check('le lot de 14:34 rend sa maîtresse, listée',
    !!grp('gRecent').master && grp('gRecent').master.convId === 'cadrage' && grp('gRecent').master.listed === true,
    JSON.stringify(grp('gRecent').master));
  check('le lot de 03:01 la CÈDE : master null, donc plus de capsule vide à l\'écran',
    grp('gOld').master === null, JSON.stringify(grp('gOld').master));

  console.log('\n3. Fin de l\'immortalité — un vieux lot fini s\'efface de lui-même');
  check('le lot de 03:01 est « terminé » (ses membres seuls décident)',
    grp('gOld').done === true, JSON.stringify(grp('gOld').done));
  check('… alors que le lot de 14:34, lui, reste retenu par sa maîtresse vivante',
    grp('gRecent').done === false, JSON.stringify(grp('gRecent').done));
  check('le store n\'a RIEN perdu : les deux liens sont intacts (relation dérivée)',
    (WORKSPACE_STORE.get('batchGroups') || []).every((g) => g.masterSessionId === 'cadrage'),
    JSON.stringify((WORKSPACE_STORE.get('batchGroups') || []).map((g) => [g.id, g.masterSessionId])));

  console.log('\n4. Re-lier À LA MAIN vers le vieux lot fait BASCULER la tête (geste visible)');
  // Sans `masterLinkedAt`, ce geste serait muet : jugé sur `createdAt`, le lot
  // de 03:01 resterait le plus ancien pour l'éternité.
  receiveHandler({ type: 'unlinkGroupMaster', id: 'gOld' });
  await waitFor(() => !grp('gOld') || grp('gOld').done === true, 'lot de 03:01 délié');
  receiveHandler({ type: 'setGroupMaster', id: 'gOld' });   // onglet actif = la conv de cadrage
  await waitFor(() => !!grp('gOld').master, 'lot de 03:01 relié');
  check('la tête est passée au lot re-lié', grp('gOld').master.convId === 'cadrage', JSON.stringify(grp('gOld').master));
  check('… et le lot de 14:34 a cédé la sienne à son tour', grp('gRecent').master === null, JSON.stringify(grp('gRecent').master));
  check('les rôles de « terminé » ont suivi, dans le même mouvement',
    grp('gOld').done === false && grp('gRecent').done === true,
    JSON.stringify([grp('gOld').done, grp('gRecent').done]));

  console.log('\n5. Aucun résidu');
  for (const s of context.subscriptions) { try { s.dispose(); } catch {} }
  ext.deactivate();

  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
