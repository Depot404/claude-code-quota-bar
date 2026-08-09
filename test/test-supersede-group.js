// Bout-en-bout du durcissement du détecteur de supplantation (plan repli-auto,
// étape 8) sur le VRAI activate() d'extension.js : reproduit l'incident du
// 2026-08-05 tel que constaté — un membre de groupe DÉJÀ `done` (husk mort
// proprement, jamais un reload) dont la session est resumée sous un NOUVEAU
// sessionId, sous LE MÊME onglet, avec un ai-title qui DÉRIVE D'UN MOT
// (« …repli auto groupes terminés » vs « …repli auto DES groupes terminés »).
// Avant le durcissement de supersede.js (computeSupersededBy groupait par
// titre EXACT seulement), la même conversation se rendait DEUX FOIS : une fois
// comme membre de groupe (résolu contre le husk mort, via member-truth qui ne
// dépend pas de la vue), une fois comme ligne PLATE (le successeur, `groupId`
// jamais résolu faute de redirection publiée). C'est le seul test qui prouve
// le CÂBLAGE de bout en bout (state.js → supersede.js → groupIdFor/
// redirectMember → buildPanelState) plutôt que la règle pure, déjà couverte
// cas par cas par test-supersede.js.
//
// Bouchons identiques à test-wave-advance : `vscode` (aucune fenêtre), `http`/
// `https` (aucun octet), `child_process` (aucun process). HOME = bac à sable.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-supersede-group-'));
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

// Premier prompt réel du batch (repris du plan) : c'est lui, pas l'ai-title
// dérivé, que le resume rejoue à l'identique.
const REAL_PROMPT = 'Implémente le lot 1 (repli auto des groupes terminés) du plan Tools/ClaudeCodeQuotaBar/PLAN_repli_auto_groupe_done_2026-08-04.md — lis le plan en entier avant de commencer.';
const now = Date.now();
// Husk : tour fini proprement (`done`), 90 min avant le successeur, jamais un
// reload. Ai-title SANS « des ».
writeTranscript('husk', 'Implémenter lot 1 (repli auto groupes terminés)', REAL_PROMPT, now - 90 * 60 * 1000);
// Successeur : né SANS reload (aucun événement de fenêtre avant son écriture),
// ai-title divergent d'un mot, MÊME premier message, sous LE MÊME onglet.
writeTranscript('succ', 'Implémenter lot 1 (repli auto des groupes terminés)', REAL_PROMPT, now - 60 * 1000);

const STATE_FILE = path.join(SANDBOX, '.claude', 'sessions-state.json');
function writeSessionsState(obj) { fs.writeFileSync(STATE_FILE, JSON.stringify({ version: 1, sessions: obj })); }
writeSessionsState({
  husk: { state: 'done', since: now - 90 * 60 * 1000, updated_at: now - 90 * 60 * 1000, transcript: path.join(projectDir, 'husk.jsonl') },
  succ: { state: 'done', since: now - 60 * 1000, updated_at: now - 60 * 1000, transcript: path.join(projectDir, 'succ.jsonl') },
});
// Ni l'un ni l'autre process n'est vivant (les deux CLI ont rendu la main) —
// exactement le cas « husk mort proprement » de l'incident, pas un crash.

// Un seul groupe, un seul membre (vague 2), déjà lié à `husk` — comme après
// que l'étage 1/2 du rattachement l'a posé la veille.
function member(key, wave, prompt, sessionId, launchedAt) {
  return { key, prompt, model: null, effort: null, wave, sessionId: sessionId || null, launchedAt: launchedAt != null ? launchedAt : null };
}
WORKSPACE_STORE.set('batchGroups', [
  {
    id: 'gRepli', name: 'repli-auto-groupes-done', createdAt: now - 2 * 60 * 60 * 1000, collapsed: false,
    masterSessionId: null, masterTitle: '',
    members: [member('m1', 1, 'wave1', 'w1-done', now - 3 * 60 * 60 * 1000), member('m2', 2, REAL_PROMPT, 'husk', now - 91 * 60 * 1000)],
  },
]);
// m1 : membre de vague 1, déjà fini AVANT ce test (conv distincte, hors sujet
// de la supplantation) — sa session n'a même pas de transcript ici, ce qui la
// résout `unsent-lost` (mort sans avoir envoyé) : neutre pour les assertions,
// juste là pour vérifier que le groupe reste cohérent avec plus d'un membre.

async function run() {
  const ext = require(path.join(__dirname, '..', 'extension.js'));

  // Un SEUL onglet Claude ouvert, portant le titre du SUCCESSEUR — même onglet
  // que celui qui montrait le husk avant le respawn, cf. l'incident réel
  // (« même onglet pour les deux lignes »). Aucun tab ne porte plus le titre
  // du husk : c'est exactement ce qui, via isGone (state.js), le masque de la
  // vue AVANT même que la supplantation ait pu jouer sur le seul titre.
  GROUPS = [group([claude('Implémenter lot 1 (repli auto des groupes terminés)')])];

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

  // `pushPanelState()` posé pendant `activate()` (avant `resolveWebviewView`)
  // n'a rien pu envoyer (`this._view` pas encore posé) : un événement d'onglet
  // bénin force un recompute → onChange → pushPanelState, comme dans
  // test-wave-advance.js.
  emitTabs({ closed: [], opened: [], changed: [claude('Implémenter lot 1 (repli auto des groupes terminés)')] });

  let state = null;
  for (let i = 0; i < 100 && !state; i++) {
    const last = [...pushed].reverse().find((m) => m && m.type === 'state');
    if (last) state = last.state;
    else await sleep(10);
  }
  check('un état de panneau a bien été poussé', !!state, JSON.stringify(pushed.map((m) => m && m.type)));

  console.log('\n1. Le successeur n\'est PLUS une ligne plate orpheline : il est rattaché au groupe');
  const convs = (state && state.conversations) || [];
  const succConv = convs.find((c) => c.id === 'succ');
  check('le successeur (nouveau sessionId) est bien dans la vue', !!succConv, JSON.stringify(convs.map((c) => c.id)));
  check('le husk (titre sans « des ») n\'est PAS rendu tel quel dans la vue',
    !convs.some((c) => c.id === 'husk'), JSON.stringify(convs.map((c) => c.id)));
  check('le successeur porte le groupId du groupe (exclu de la liste plate côté webview)',
    succConv && succConv.groupId === 'gRepli', JSON.stringify(succConv));

  console.log('\n2. Le membre de groupe pointe la conversation VIVANTE, pas le husk mort');
  const grp = (state.groups || []).find((g) => g.id === 'gRepli');
  check('le groupe est bien présent dans l\'état poussé', !!grp, JSON.stringify(state.groups));
  const m2 = grp && grp.members.find((m) => m.key === 'm2');
  check('le membre m2 est redirigé vers le successeur (convId === "succ")',
    m2 && m2.convId === 'succ', JSON.stringify(m2));
  check('… et résolu contre une conv LISTÉE (note vide — pas le repli hors-vue du husk mort)',
    m2 && m2.note === '', JSON.stringify(m2));
  check('groupe : une seule vérité de statut pour m2 (waveStatus dérivé de la conv vivante)',
    m2 && (m2.waveStatus === 'done' || m2.waveStatus === 'launched'), JSON.stringify(m2));

  console.log('\n3. Aucun résidu');
  for (const s of context.subscriptions) { try { s.dispose(); } catch {} }
  ext.deactivate();

  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
