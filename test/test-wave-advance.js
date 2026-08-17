// Bout-en-bout du lot 3 (plan bug-chip 2026-07-24) sur le VRAI activate()
// d'extension.js : l'auto-avance d'un groupe doit lancer la vague suivante
//   1. AU BOOT, quand la vague courante s'est terminée pendant que l'extension
//      était éteinte (reload) — aucun `onChange` n'a porté la transition, il
//      faut une réévaluation au premier snapshot post-boot ;
//   2. mais JAMAIS trop tôt : une vague courante encore `busy` au boot ne doit
//      rien déclencher — c'est seulement quand SA transition busy→done arrive
//      (via `onChange`) que la suivante part.
//
// C'est le seul test qui prouve le CÂBLAGE de bout en bout (workspaceState →
// member-truth → waves → launchWaveForGroup) plutôt que ses morceaux séparés :
// waves.js est déjà couvert par test-waves.js, mais lui ne voit pas qu'AUCUN
// chemin n'appelait maybeAdvanceWaves au boot (le bug réel).
//
// Bouchons identiques à test-close-e2e : `vscode` (aucune fenêtre), `http`/
// `https` (aucun octet), `child_process` (aucun process). HOME = bac à sable.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Verrou de stabilisation (incident 2026-08-17) : en prod la vague suivante ne
// part qu'après WAVE_STABLE_MS (15 s) de « prêt » ininterrompu — ce banc le
// raccourcit à 150 ms (surcharge réservée aux bancs, cf. waves.js) pour tester
// le VRAI chemin (armement → timer d'échéance → lancement) sans attendre 15 s.
process.env.CLAUDE_QUOTA_WAVE_STABLE_MS = '150';

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-wave-'));
os.homedir = () => SANDBOX;                       // AVANT tout require du module
fs.mkdirSync(path.join(SANDBOX, '.claude'), { recursive: true });
fs.mkdirSync(path.join(SANDBOX, '.claude', 'sessions'), { recursive: true });

// workspaceState persistant en mémoire — un groupe appartient au workspace,
// exactement comme en prod (extension.js le lit via context.workspaceState).
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
const clips = [];
const openedCmds = [];

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
    // Commande d'ouverture ABSENTE : launcher.js bascule sur le repli
    // presse-papier immédiatement (pas de polling réseau, banc déterministe).
    // Ce qui compte pour ce test n'est PAS l'ouverture réelle mais le fait que
    // launchWaveForGroup ait été atteint (markLaunched + tentative de lancement).
    getCommands: async () => [],
    executeCommand: async (cmd) => { openedCmds.push(cmd); },
  },
  env: {
    openExternal: async () => {},
    clipboard: { writeText: async (t) => { clips.push(t); } },
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
// DÉFAUT REFERMÉ (2026-08-10) — la section 1 échouait une fois sur trois, et
// le banc avait raison : dans ces cas-là l'avance n'avait JAMAIS lieu. La piste
// soupçonnée (un maybeAdvanceWaves() de boot tombant avant que l'état soit
// complet) était FAUSSE — instrumenté, le boot voit toujours un état complet.
// La cause était la SUPPLANTATION : les deux transcripts de ce banc ouvrent sur
// le même premier message (« prompt »), et supersede.js prenait cette égalité
// pour une identité alors qu'elle est plus COURTE que MIN_PREFIX. w1a (vague 1
// du groupe A, terminée) était donc redirigé sur w1b (vague 1 du groupe B,
// encore busy) : la vague de A n'était jamais complète, la suivante ne partait
// jamais. Le « une fois sur trois » ne tenait qu'au mtime des deux fichiers —
// écrits dans la même milliseconde, aucun n'est « plus ancien », donc pas de
// husk, donc pas de fold. Correctif : identifiesConversation (attach.js),
// appliqué au second signal de supersede.js ; cas ajoutés à test-supersede.js.
// Ne pas « stabiliser » ce banc en rallongeant une attente : s'il repart, c'est
// pour une bonne raison.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Attente de CONDITION, jamais de durée — et seulement pour ce qui est
// RÉELLEMENT asynchrone (le repli presse-papier du lancement). L'avance de boot,
// elle, ne s'attend plus : elle est synchrone par construction (markLaunched est
// posé dans launchWaveForGroup avant la moindre attente), et c'est exactement ce
// que la section 1 doit prouver.
async function waitFor(fn, capMs = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < capMs) {
    if (fn()) return true;
    await sleep(20);
  }
  return fn();
}

// ── Faux workspace ────────────────────────────────────────────────────────
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
// Groupe A : vague 1 finie PENDANT que l'extension était éteinte (session morte,
// entrée hooks encore `done`). Groupe B : vague 1 encore `busy` et VIVANTE.
writeTranscript('w1a', 'Groupe A vague une terminée');
writeTranscript('w1b', 'Groupe B vague une en cours');

const STATE_FILE = path.join(SANDBOX, '.claude', 'sessions-state.json');
const now = Date.now();
function writeSessionsState(obj) { fs.writeFileSync(STATE_FILE, JSON.stringify({ version: 1, sessions: obj })); }
writeSessionsState({
  w1a: { state: 'done', since: now, updated_at: now, transcript: path.join(projectDir, 'w1a.jsonl') },
  w1b: { state: 'busy', since: now, updated_at: now, transcript: path.join(projectDir, 'w1b.jsonl') },
});

// Registre des sessions VIVANTES (~/.claude/sessions/<pid>.json) : w1b tourne
// (pid vivant = celui de CE process), w1a non (aucun fichier).
const LIVE_W1B = path.join(SANDBOX, '.claude', 'sessions', 'w1b.json');
function markLiveW1b() { fs.writeFileSync(LIVE_W1B, JSON.stringify({ sessionId: 'w1b', pid: process.pid, cwd: WS, startedAt: now })); }
markLiveW1b();

// Deux groupes AUTO préchargés dans le workspaceState (comme au retour d'un
// reload), chacun avec une vague 2 encore `queued` (ajoutée pendant que la
// vague 1 tournait — sessionId/launchedAt nuls, cas normal du moteur).
function member(key, wave, prompt, sessionId, launchedAt) {
  return { key, prompt, model: null, effort: null, wave, sessionId: sessionId || null, launchedAt: launchedAt != null ? launchedAt : null };
}
WORKSPACE_STORE.set('batchGroups', [
  {
    id: 'gA', name: 'Groupe A', createdAt: now, collapsed: false,
    masterSessionId: null, masterTitle: '',
    members: [member('m1', 1, 'wave1a', 'w1a', now), member('m2', 2, 'PROMPT-A-WAVE2', null, null)],
  },
  {
    id: 'gB', name: 'Groupe B', createdAt: now, collapsed: false,
    masterSessionId: null, masterTitle: '',
    members: [member('m1', 1, 'wave1b', 'w1b', now), member('m2', 2, 'PROMPT-B-WAVE2', null, null)],
  },
]);

// Lit l'état FRAIS du groupe tel que persisté dans le workspaceState (c'est là
// que markLaunched écrit, synchronement, dès que launchWaveForGroup est atteint).
function memberOf(groupId, key) {
  const gs = WORKSPACE_STORE.get('batchGroups') || [];
  const g = gs.find((x) => x.id === groupId);
  return g && g.members.find((m) => m.key === key);
}
const launched = (groupId, key) => { const m = memberOf(groupId, key); return !!(m && m.launchedAt != null); };

async function run() {
  const ext = require(path.join(__dirname, '..', 'extension.js'));

  // w1b a un onglet ouvert (son vrai titre) — il doit apparaître dans le panneau
  // pour que sa transition busy→done y soit VISIBLE (donc porte un onChange).
  GROUPS = [group([claude('Groupe B vague une en cours')])];

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

  console.log('\n1. Avance AU BOOT : vague 1 finie extension éteinte → vague 2 lancée sans autre événement');
  // Depuis le verrou de stabilisation (2026-08-17), le lancement n'est PLUS
  // synchrone : le boot ARME (première lecture « prêt »), et c'est le timer
  // d'échéance qui lance quand la vague est restée prête WAVE_STABLE_MS
  // d'affilée — sans qu'aucun onChange n'ait à tirer, ce qui reste la chose
  // que cette section prouve. On vérifie donc les DEUX moitiés du contrat :
  // pas de lancement instantané (c'était le bug : une fenêtre de quelques
  // secondes où un `done` de fin de tour, aussitôt relancé par un hook Stop à
  // feedback, ouvrait la vague suivante), puis lancement à l'échéance.
  check('groupe A : PAS de lancement instantané au boot (verrou de stabilisation armé)',
    !launched('gA', 'm2'), JSON.stringify(memberOf('gA', 'm2')));
  await waitFor(() => launched('gA', 'm2'));
  check('groupe A : vague 2 lancée à l\'échéance du verrou (timer, aucun onChange n\'a tiré)',
    launched('gA', 'm2'), JSON.stringify(memberOf('gA', 'm2')));

  console.log('\n2. Pas d\'avance prématurée : vague 1 encore `busy` au boot → vague 2 en attente');
  check('groupe B : vague 2 TOUJOURS en file au boot (vague 1 busy)',
    !launched('gB', 'm2'), JSON.stringify(memberOf('gB', 'm2')));

  // Le repli presse-papier du lancement de gA/m2 est asynchrone : on attend
  // qu'il ait écrit (condition, pas durée), puis on vérifie qu'un lancement a
  // bien été TENTÉ (et pas seulement le flag posé).
  await waitFor(() => clips.includes('PROMPT-A-WAVE2'));
  check('groupe A : le lancement de la vague 2 a bien été tenté (prompt au presse-papier)',
    clips.includes('PROMPT-A-WAVE2'), JSON.stringify(clips));
  check('groupe B : aucun lancement tenté tant que la vague 1 tourne',
    !clips.includes('PROMPT-B-WAVE2'), JSON.stringify(clips));

  console.log('\n3. La transition busy→done de la vague 1 (groupe B) lance la vague 2');
  // Vague 1 du groupe B se termine MAINTENANT (extension allumée) : session
  // morte + hooks `done`. L'onglet reste ouvert (la conv finie garde son onglet).
  fs.rmSync(LIVE_W1B, { force: true });
  writeSessionsState({
    w1a: { state: 'done', since: now, updated_at: now, transcript: path.join(projectDir, 'w1a.jsonl') },
    w1b: { state: 'done', since: now, updated_at: now, transcript: path.join(projectDir, 'w1b.jsonl') },
  });
  // Un événement d'onglet (bénin) force un recompute ; la transition d'état
  // change le renderKey → onChange tire → maybeAdvanceWaves.
  emitTabs({ closed: [], opened: [], changed: [claude('Groupe B vague une en cours')] });

  let gbLaunched = false;
  for (let i = 0; i < 100; i++) {
    if (launched('gB', 'm2')) { gbLaunched = true; break; }
    await sleep(10);
  }
  check('groupe B : vague 2 lancée au `done` de la vague 1 (chemin onChange)',
    gbLaunched, JSON.stringify(memberOf('gB', 'm2')));
  await sleep(60);
  check('groupe B : lancement de la vague 2 bien tenté (prompt au presse-papier)',
    clips.includes('PROMPT-B-WAVE2'), JSON.stringify(clips));

  console.log('\n4. Aucun résidu');
  for (const s of context.subscriptions) { try { s.dispose(); } catch {} }
  ext.deactivate();

  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
