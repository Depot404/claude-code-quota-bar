// Bout-en-bout du bouton « rattacher » d'une ligne PLATE (lot B, plan
// « master conv isolée » 2026-08-09) sur le VRAI activate() d'extension.js —
// `linkConvToActiveMaster(id)`, symétrique de `setGroupMaster` (déjà couvert
// par test-group-master-focus.js, dont ce banc reprend le bouchon) : ici
// c'est `id` (la conv CLIQUÉE) qui devient membre, et l'onglet VS Code ACTIF
// qui désigne la maîtresse d'un groupe qui n'existe pas encore. Les 4 refus
// du plan (onglet non-Claude, ambigu, soi-même, déjà revendiquée) doivent
// tous faire un no-op + message, jamais un groupe deviné — et la dissolution
// du groupe qui en résulte ne doit rien fermer.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-link-master-'));
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

const tabTarget = claude('Conversation cible');
const tabAmb1 = claude('Conversation ambiguë');
const tabAmb2 = claude('Conversation ambiguë');
const tabClaimedMember = claude('Déjà membre d’un groupe');
const tabClaimedMaster = claude('Déjà maîtresse d’un autre groupe');
const tabSuccessTarget = claude('Cible du succès');
const tabSuccessMaster = claude('Maîtresse du succès');
const tabFile = { label: 'panel.js', input: { viewType: 'default' } };
const ALL_TABS = [
  tabTarget, tabAmb1, tabAmb2, tabClaimedMember, tabClaimedMaster,
  tabSuccessTarget, tabSuccessMaster, tabFile,
];

let GROUPS = [{ viewColumn: 1, isActive: true, tabs: ALL_TABS, activeTab: tabTarget }];
function setActiveTab(tab) { GROUPS[0].activeTab = tab; }

let provider = null;
let receiveHandler = null;
const infoCalls = [];

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
    // dissolveGroup (test 6) demande confirmation (modale native) — l10n stub
    // = identité, donc le texte source EST le libellé du bouton (même bouchon
    // que test-group-master-focus.js).
    showWarningMessage: async () => 'Dissolve',
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
writeTranscript('target', 'Conversation cible');
writeTranscript('ambOne', 'Conversation ambiguë');
writeTranscript('ambTwo', 'Conversation ambiguë');
writeTranscript('claimedMember', 'Déjà membre d’un groupe');
writeTranscript('claimedMaster', 'Déjà maîtresse d’un autre groupe');
writeTranscript('successTarget', 'Cible du succès');
writeTranscript('successMaster', 'Maîtresse du succès');

const STATE_FILE = path.join(SANDBOX, '.claude', 'sessions-state.json');
const now = Date.now();
function sess(state) { return { state, since: now, updated_at: now }; }
fs.writeFileSync(STATE_FILE, JSON.stringify({
  version: 1,
  sessions: {
    target: sess('done'), ambOne: sess('done'), ambTwo: sess('done'),
    claimedMember: sess('done'), claimedMaster: sess('done'),
    successTarget: sess('done'), successMaster: sess('done'),
  },
}));

// `ambOne`/`ambTwo` partagent EXACTEMENT le même titre (c'est le point du
// test d'ambiguïté) — sans ceci, supersede.js (computeSupersededBy) les
// groupe par titre fiable et fold le plus ancien des deux comme un HUSK de
// l'autre (départage par mtime, résolveGroup : « mort + strictement plus
// ancien » suffit), un artefact de reload que rien ici ne représente : deux
// vraies conversations concurrentes, homonymes par construction. Le garde-fou
// de resolveGroup est `!c.live` — deux entrées VIVANTES ne sont JAMAIS
// foldées (commentaire du fichier : « deux vrais onglets concurrents »), donc
// les inscrire au registre `~/.claude/sessions/<pid>.json` (live-sessions.js)
// rend le test déterministe au lieu de dépendre de la granularité de mtime
// Windows (~15 ms, source du flake observé sans ce fixup).
const SESSIONS_DIR = path.join(SANDBOX, '.claude', 'sessions');
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
for (const id of ['ambOne', 'ambTwo']) {
  fs.writeFileSync(path.join(SESSIONS_DIR, `${id}.json`), JSON.stringify({
    sessionId: id, pid: process.pid, cwd: WS, startedAt: now,
  }));
}

function member(key, wave, prompt, sessionId, launchedAt) {
  return { key, prompt, model: null, effort: null, wave, sessionId: sessionId || null, launchedAt: launchedAt != null ? launchedAt : null };
}
// gOther : `claimedMember` est déjà membre — teste le refus « cible déjà
// revendiquée ». gOtherMaster : `claimedMaster` est déjà maîtresse d'un
// AUTRE groupe — teste le refus « maîtresse déjà revendiquée ».
WORKSPACE_STORE.set('batchGroups', [
  { id: 'gOther', name: 'Other', createdAt: now, collapsed: false, masterSessionId: null, masterTitle: '', members: [member('m1', 1, 'x', 'claimedMember', now)] },
  // `createdAt` reculé d'une minute : c'est le repli de `masterLinkedAt` pour
  // un stockage antérieur au plan « dernier lot » (groups.js), donc la date que
  // §4b compare au lien posé pendant le test — elle doit être strictement plus
  // ancienne pour que le verdict soit un fait, pas une course d'horloge.
  { id: 'gOtherMaster', name: 'OtherMaster', createdAt: now - 60 * 1000, collapsed: false, masterSessionId: 'claimedMaster', masterTitle: 'Déjà maîtresse d’un autre groupe', members: [member('m1', 1, 'x', null, null)] },
]);

async function waitFor(pred, label) {
  for (let i = 0; i < 100; i++) {
    if (pred()) return true;
    await sleep(10);
  }
  console.log(`  (timeout waiting for: ${label})`);
  return false;
}
// Le scan du workspace (state.js) peut pousser plusieurs états intermédiaires
// avant de se stabiliser (warmup.js) : `waitFor` seul peut donc capter un
// instant où le compte est déjà à 7 par coïncidence, juste avant qu'un
// nouveau cycle ne le fasse fluctuer. `waitStable` re-vérifie le prédicat
// après une courte grâce, et reprend l'attente s'il a bougé entre-temps.
async function waitStable(pred, label, graceMs = 150) {
  for (let round = 0; round < 20; round++) {
    if (!(await waitFor(pred, label))) return false;
    await sleep(graceMs);
    if (pred()) return true;
  }
  return false;
}
function lastState() {
  const last = [...pushed].reverse().find((m) => m && m.type === 'state');
  return last && last.state;
}
function groupWithMaster(state, convId) {
  return (state && state.groups || []).find((g) => g.master && g.master.convId === convId);
}
function groupCount(state) { return (state && state.groups || []).length; }

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
  // Le tout premier état poussé peut ne refléter qu'un scan PARTIEL du
  // workspace (warmup.js) : sans cette attente, le test d'ambiguïté (§2) peut
  // tourner avant que `ambTwo` n'apparaisse dans le snapshot — un seul
  // candidat matcherait alors, résolvant à tort une ambiguïté en lien direct.
  // Les 7 transcripts fabriqués plus haut sont l'attendu complet.
  await waitStable(() => (lastState().conversations || []).length >= 7, 'les 7 conversations du banc listées, stabilisées');
  const groupsAtStart = groupCount(lastState());

  console.log('\n1. Refus — onglet actif non-Claude → no-op + message, aucun groupe créé');
  setActiveTab(tabFile);
  infoCalls.length = 0;
  receiveHandler({ type: 'linkConvToActiveMaster', id: 'target' });
  await waitFor(() => infoCalls.length > 0, 'message onglet non-Claude');
  check('aucun groupe créé', groupCount(lastState()) === groupsAtStart, groupCount(lastState()));
  check('message affiché', infoCalls.length === 1, JSON.stringify(infoCalls));

  console.log('\n2. Refus — libellé ambigu (deux conversations au même titre) → no-op + message');
  setActiveTab(tabAmb1);
  infoCalls.length = 0;
  receiveHandler({ type: 'linkConvToActiveMaster', id: 'target' });
  await waitFor(() => infoCalls.length > 0, 'message ambiguïté');
  check('aucun groupe créé', groupCount(lastState()) === groupsAtStart, groupCount(lastState()));
  check('message affiché', infoCalls.length === 1, JSON.stringify(infoCalls));

  console.log('\n3. Refus — l’onglet actif EST la cible (une conversation ne peut pas être sa propre maîtresse)');
  setActiveTab(tabTarget);
  infoCalls.length = 0;
  receiveHandler({ type: 'linkConvToActiveMaster', id: 'target' });
  await waitFor(() => infoCalls.length > 0, 'message soi-même');
  check('aucun groupe créé', groupCount(lastState()) === groupsAtStart, groupCount(lastState()));
  check('message affiché', infoCalls.length === 1, JSON.stringify(infoCalls));

  console.log('\n4a. Refus — la CIBLE cliquée est déjà membre d’un autre groupe → no-op + message');
  // Onglet actif quelconque, valide et non-ambigu : seule la CIBLE (déjà
  // membre de gOther) est sous test ici.
  setActiveTab(tabTarget);
  const gOtherMembersBefore = (lastState().groups.find((g) => g.id === 'gOther') || {}).members;
  infoCalls.length = 0;
  receiveHandler({ type: 'linkConvToActiveMaster', id: 'claimedMember' });
  await waitFor(() => infoCalls.length > 0, 'message déjà revendiquée (cible)');
  check('aucun nouveau groupe créé', groupCount(lastState()) === groupsAtStart, groupCount(lastState()));
  check('gOther inchangé (toujours son seul membre d’origine)',
    JSON.stringify((lastState().groups.find((g) => g.id === 'gOther') || {}).members) === JSON.stringify(gOtherMembersBefore));
  check('message affiché', infoCalls.length === 1, JSON.stringify(infoCalls));

  console.log('\n4b. ACCEPTÉ — l’onglet actif est déjà maîtresse d’un AUTRE groupe (plan « dernier lot »)');
  // C'était un refus jusqu'au 2026-08-15. Une conv de cadrage qui enchaîne les
  // lots est revendiquée par plusieurs groupes : c'est légitime, et la règle
  // donne la tête au lien le PLUS RÉCENT — ici celui qu'on vient de poser. Le
  // lot précédent ne perd pas son lien (rien n'est réécrit dans le store), il
  // cède sa ligne de tête AU RENDU. Refuser ici privait le geste de son seul
  // usage : re-pointer une maîtresse.
  setActiveTab(tabClaimedMaster);
  infoCalls.length = 0;
  receiveHandler({ type: 'linkConvToActiveMaster', id: 'target' });
  await waitFor(() => groupCount(lastState()) === groupsAtStart + 1, 'groupe créé malgré la maîtresse déjà revendiquée');
  const gClaim = groupWithMaster(lastState(), 'claimedMaster');
  check('un groupe est né, avec cette conv pour maîtresse', !!gClaim && gClaim.id !== 'gOtherMaster', JSON.stringify(lastState().groups.map((x) => [x.id, x.master && x.master.convId])));
  check('la cible en est l’unique membre',
    !!gClaim && gClaim.members.length === 1 && gClaim.members[0].convId === 'target', JSON.stringify(gClaim && gClaim.members));
  check('le lot précédent a CÉDÉ sa tête (master null au rendu, jamais deux capsules pour une conv)',
    (lastState().groups.find((x) => x.id === 'gOtherMaster') || {}).master === null,
    JSON.stringify((lastState().groups.find((x) => x.id === 'gOtherMaster') || {}).master));
  check('… mais il est toujours là, rien n’a été délié ni dissous',
    !!lastState().groups.find((x) => x.id === 'gOtherMaster'));
  check('aucun message d’erreur', infoCalls.length === 0, JSON.stringify(infoCalls));

  console.log('\n5. Succès — résolution unique, ni onglet ni cible déjà revendiqués → groupe créé, master posée');
  setActiveTab(tabSuccessMaster);
  infoCalls.length = 0;
  receiveHandler({ type: 'linkConvToActiveMaster', id: 'successTarget' });
  await waitFor(() => !!groupWithMaster(lastState(), 'successMaster'), 'groupe créé avec master');
  const g = groupWithMaster(lastState(), 'successMaster');
  check('groupe créé avec la bonne maîtresse', !!g, JSON.stringify(lastState().groups));
  check('la cible est l’unique membre', g && g.members && g.members.length === 1 && g.members[0].convId === 'successTarget', JSON.stringify(g && g.members));
  check('aucun message d’erreur', infoCalls.length === 0, JSON.stringify(infoCalls));
  const newGroupId = g.id;

  console.log('\n6. Dissolution du groupe créé — rien ne ferme, les deux convs redeviennent des lignes plates');
  receiveHandler({ type: 'dissolveGroup', id: newGroupId });
  await waitFor(() => !(lastState().groups || []).find((x) => x.id === newGroupId), 'groupe dissous');
  check('le groupe a disparu', !(lastState().groups || []).find((x) => x.id === newGroupId));
  check('les deux conversations sont toujours listées (rien fermé)',
    (lastState().conversations || []).some((c) => c.id === 'successTarget') && (lastState().conversations || []).some((c) => c.id === 'successMaster'),
    JSON.stringify((lastState().conversations || []).map((c) => c.id)));

  console.log('\n7. Aucun résidu');
  for (const s of context.subscriptions) { try { s.dispose(); } catch {} }
  ext.deactivate();

  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
