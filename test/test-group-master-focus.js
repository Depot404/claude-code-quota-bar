// Bout-en-bout du ⌂-focus / ⨯ master / délier (plan repli-auto étape 9, capsule
// v2 ; ⨯ master révisé étape 15) sur le VRAI activate() d'extension.js — les
// trois handlers qui remplacent l'ancien QuickPick set/change/unlink :
// `setGroupMaster` (lie l'onglet VS Code ACTIF, jamais un choix dans une
// liste), `unlinkGroupMaster` (porte de sortie hover-only, sans confirmation),
// `dissolveGroup` (⨯ de la ligne master depuis l'étape 15 — DISSOLUTION seule,
// métadonnées uniquement, jamais de fermeture d'onglet ; sa confirmation
// historique est inconditionnelle, elle ne distingue plus busy/idle —
// `closeAndDissolveGroup`/`isGroupOrMasterBusy` ont été retirés). C'est le seul
// banc qui prouve le CÂBLAGE réel (tabs.js → convMatchesLabel → groupStore →
// pushPanelState) plutôt que chacune de ces briques prise séparément (déjà
// couvertes par test-tabs.js/test-group-store.js).
//
// Bouchons identiques à test-supersede-group.js : `vscode` (aucune fenêtre),
// `http`/`https` (aucun octet), `child_process` (aucun process). HOME = bac à
// sable.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-master-focus-'));
os.homedir = () => SANDBOX;                       // AVANT tout require du module
fs.mkdirSync(path.join(SANDBOX, '.claude'), { recursive: true });

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
const pushed = [];
const claude = (label) => ({ label, input: { viewType: 'mainThreadWebview-claudeVSCodePanel' } });

// Tous les onglets restent OUVERTS pendant tout le banc (seul `activeTab`
// bouge d'une phase à l'autre) : la présence (listée/onglet ouvert) de chaque
// conversation ne doit jamais changer en cours de route, sans quoi une
// résolution ambiguë ou « introuvable » ne prouverait rien.
const tabConvA = claude('Conversation A pour le focus');
const tabConvB = claude('Conversation B pour le focus');
const tabAmb1 = claude('Conversation ambiguë');
const tabAmb2 = claude('Conversation ambiguë');
const tabMember = claude('Déjà membre du groupe');
const tabBusyMaster = claude('Master occupée maintenant');
const tabIdleMaster = claude('Master tranquille');
const tabFile = { label: 'panel.js', input: { viewType: 'default' } };
const ALL_TABS = [tabConvA, tabConvB, tabAmb1, tabAmb2, tabMember, tabBusyMaster, tabIdleMaster, tabFile];

let GROUPS = [{ viewColumn: 1, isActive: true, tabs: ALL_TABS, activeTab: tabConvA }];
function setActiveTab(tab) { GROUPS[0].activeTab = tab; }

let provider = null;
let receiveHandler = null;
let warnResponse = undefined;
const warnCalls = [];
const infoCalls = [];
const closedTabs = [];

const vscodeStub = {
  window: {
    state: { focused: true },
    onDidChangeWindowState: () => ({ dispose() {} }),
    tabGroups: {
      get all() { return GROUPS; },
      get activeTabGroup() { return GROUPS[0] || { activeTab: null }; },
      onDidChangeTabs: (cb) => { tabListeners.push(cb); return { dispose() {} }; },
      onDidChangeTabGroups: () => ({ dispose() {} }),
      close: async (tab) => { closedTabs.push(tab); },
    },
    registerWebviewViewProvider: (_type, p) => { provider = p; return { dispose() {} }; },
    createStatusBarItem: () => ({ show() {}, dispose() {} }),
    showWarningMessage: async (...args) => { warnCalls.push(args); return warnResponse; },
    showInformationMessage: async (...args) => { infoCalls.push(args); return undefined; },
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

// ── Faux workspace : six conversations, dont deux au titre STRICTEMENT
// identique (le cas d'ambiguïté) ────────────────────────────────────────────
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
writeTranscript('convA', 'Conversation A pour le focus');
writeTranscript('convB', 'Conversation B pour le focus');
writeTranscript('ambOne', 'Conversation ambiguë');
writeTranscript('ambTwo', 'Conversation ambiguë');
writeTranscript('memberConv', 'Déjà membre du groupe');
writeTranscript('busyMaster', 'Master occupée maintenant');
writeTranscript('idleMaster', 'Master tranquille');

const STATE_FILE = path.join(SANDBOX, '.claude', 'sessions-state.json');
const now = Date.now();
function sess(state) { return { state, since: now, updated_at: now }; }
fs.writeFileSync(STATE_FILE, JSON.stringify({
  version: 1,
  sessions: {
    convA: sess('done'), convB: sess('done'), ambOne: sess('done'), ambTwo: sess('done'),
    memberConv: sess('done'), busyMaster: sess('busy'), idleMaster: sess('done'),
  },
}));

function member(key, wave, prompt, sessionId, launchedAt) {
  return { key, prompt, model: null, effort: null, wave, sessionId: sessionId || null, launchedAt: launchedAt != null ? launchedAt : null };
}
WORKSPACE_STORE.set('batchGroups', [
  { id: 'gFocus', name: 'Focus test', createdAt: now, collapsed: false, masterSessionId: null, masterTitle: '', members: [member('m1', 1, 'peu importe', null, null)] },
  { id: 'gSelf', name: 'Self test', createdAt: now, collapsed: false, masterSessionId: null, masterTitle: '', members: [member('m1', 1, 'peu importe', 'memberConv', now)] },
  { id: 'gUnlink', name: 'Unlink test', createdAt: now, collapsed: false, masterSessionId: 'convA', masterTitle: 'Conversation A pour le focus', members: [member('m1', 1, 'x', null, null)] },
  { id: 'gCloseIdle', name: 'Close idle', createdAt: now, collapsed: false, masterSessionId: 'idleMaster', masterTitle: 'Master tranquille', members: [member('m1', 1, 'x', null, null)] },
  { id: 'gCloseBusy', name: 'Close busy', createdAt: now, collapsed: false, masterSessionId: 'busyMaster', masterTitle: 'Master occupée maintenant', members: [member('m1', 1, 'x', null, null)] },
]);

async function waitFor(pred, label) {
  for (let i = 0; i < 100; i++) {
    if (pred()) return true;
    await sleep(10);
  }
  console.log(`  (timeout waiting for: ${label})`);
  return false;
}
function lastState() {
  const last = [...pushed].reverse().find((m) => m && m.type === 'state');
  return last && last.state;
}
function groupIn(state, id) { return (state && state.groups || []).find((g) => g.id === id); }

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
  await waitFor(() => !!lastState(), 'premier état poussé');

  console.log('\n1. ⌂-focus — onglet actif non-Claude → no-op + message, jamais un lien deviné');
  setActiveTab(tabFile);
  infoCalls.length = 0;
  receiveHandler({ type: 'setGroupMaster', id: 'gFocus' });
  await waitFor(() => infoCalls.length > 0, 'message onglet non-Claude');
  check('aucune master posée', !groupIn(lastState(), 'gFocus').master, JSON.stringify(groupIn(lastState(), 'gFocus').master));
  check('message affiché', infoCalls.length === 1, JSON.stringify(infoCalls));

  console.log('\n2. ⌂-focus — libellé ambigu (deux conversations au même titre) → no-op + message');
  setActiveTab(tabAmb1);
  infoCalls.length = 0;
  receiveHandler({ type: 'setGroupMaster', id: 'gFocus' });
  await waitFor(() => infoCalls.length > 0, 'message ambiguïté');
  check('aucune master posée (ambiguïté, jamais un lien deviné)',
    !groupIn(lastState(), 'gFocus').master, JSON.stringify(groupIn(lastState(), 'gFocus').master));
  check('message affiché', infoCalls.length === 1, JSON.stringify(infoCalls));

  console.log('\n3. ⌂-focus — refus du store (conv déjà membre de CE groupe) → relayé, pas avalé');
  setActiveTab(tabMember);
  infoCalls.length = 0;
  receiveHandler({ type: 'setGroupMaster', id: 'gSelf' });
  await waitFor(() => infoCalls.length > 0, 'message déjà membre');
  check('aucune master posée (déjà membre)', !groupIn(lastState(), 'gSelf').master, JSON.stringify(groupIn(lastState(), 'gSelf').master));
  check('message affiché', infoCalls.length === 1, JSON.stringify(infoCalls));

  console.log('\n4. ⌂-focus — résolution unique → lien direct, aucune saisie');
  setActiveTab(tabConvA);
  infoCalls.length = 0;
  receiveHandler({ type: 'setGroupMaster', id: 'gFocus' });
  await waitFor(() => !!(groupIn(lastState(), 'gFocus') || {}).master, 'master posée');
  const gFocus = groupIn(lastState(), 'gFocus');
  check('master liée à la conv de l\'onglet actif (convA)', gFocus.master && gFocus.master.convId === 'convA', JSON.stringify(gFocus.master));
  check('aucun message d\'erreur', infoCalls.length === 0, JSON.stringify(infoCalls));

  console.log('\n5. Délier au survol — sans confirmation, geste réversible');
  receiveHandler({ type: 'unlinkGroupMaster', id: 'gUnlink' });
  await waitFor(() => !(groupIn(lastState(), 'gUnlink') || {}).master, 'master dissociée');
  check('master dissociée', !groupIn(lastState(), 'gUnlink').master);
  check('le groupe lui-même n\'est pas dissous (métadonnées seules)', !!groupIn(lastState(), 'gUnlink'));

  console.log('\n6. ⨯ de la ligne master (groupe inactif) — plan repli-auto étape 15 : dissolveGroup historique, jamais closeAndDissolveGroup, confirmation demandée dans tous les cas, ANNULER → rien ne bouge');
  warnCalls.length = 0;
  closedTabs.length = 0;
  warnResponse = undefined; // l'user ferme la modale / clique ailleurs
  receiveHandler({ type: 'dissolveGroup', id: 'gCloseIdle' });
  await waitFor(() => warnCalls.length > 0, 'confirmation demandée (idle)');
  await sleep(80); // laisser le temps à un dissolve éventuel (qu'on ne veut PAS voir) de se produire
  check('confirmation demandée même groupe inactif (dissolveGroup ne distingue plus busy/idle depuis l\'étape 15)', warnCalls.length === 1, JSON.stringify(warnCalls));
  check('annulée → le groupe existe toujours', !!groupIn(lastState(), 'gCloseIdle'));
  check('… et son onglet n\'a jamais été touché (métadonnées seules)', !closedTabs.includes(tabIdleMaster), JSON.stringify(closedTabs.map((t) => t.label)));

  console.log('\n7. ⨯ de la ligne master (groupe inactif) — CONFIRMER → dissolution seule, onglet jamais fermé');
  warnResponse = 'Dissolve'; // l10n stub = identité : le texte source EST le libellé du bouton
  receiveHandler({ type: 'dissolveGroup', id: 'gCloseIdle' });
  await waitFor(() => !groupIn(lastState(), 'gCloseIdle'), 'groupe dissous (idle, confirmé)');
  check('groupe dissous après confirmation', !groupIn(lastState(), 'gCloseIdle'));
  check('l\'onglet de la master n\'a JAMAIS été fermé (étape 15 : le panneau n\'agit plus sur les onglets)',
    !closedTabs.includes(tabIdleMaster), JSON.stringify(closedTabs.map((t) => t.label)));

  console.log('\n8. ⨯ de la ligne master (groupe busy) — même dissolveGroup, même confirmation, onglet toujours intact');
  warnCalls.length = 0;
  closedTabs.length = 0;
  warnResponse = 'Dissolve';
  receiveHandler({ type: 'dissolveGroup', id: 'gCloseBusy' });
  await waitFor(() => !groupIn(lastState(), 'gCloseBusy'), 'groupe dissous (busy, confirmé)');
  check('groupe dissous malgré une conversation busy (dissoudre des métadonnées est inoffensif — plus de garde busy/waiting)',
    !groupIn(lastState(), 'gCloseBusy'));
  check('l\'onglet de la master busy n\'a jamais été fermé', !closedTabs.includes(tabBusyMaster), JSON.stringify(closedTabs.map((t) => t.label)));

  console.log('\n9. Aucun résidu');
  for (const s of context.subscriptions) { try { s.dispose(); } catch {} }
  ext.deactivate();

  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
