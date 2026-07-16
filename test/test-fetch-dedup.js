// Lot 13 §2 — N fenêtres VS Code sur le même workspace faisaient chacune leur
// poll 5 min + leurs fetchs événementiels (lot 9) sur les MÊMES transitions
// (elles lisent le même sessions-state.json) : N fenêtres = N× les appels
// claude.ai pour la même info. `usage-cache.json` est partagé entre fenêtres —
// si une AUTRE fenêtre vient de le rafraîchir il y a moins de
// CLAUDE_QUOTA_FETCH_DEDUP_MS, cette instance doit consommer ce cache au lieu
// de refaire l'appel réseau, SAUF sur une action explicite de l'user (commande
// Refresh / bouton panneau) qui doit toujours forcer un vrai appel. Bout-en-
// bout sur le vrai activate() (mêmes bouchons vscode/http/https/child_process
// que test-close-e2e.js), aucun octet réseau réel, aucun process ne naît.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-fetch-dedup-'));
os.homedir = () => SANDBOX;                       // AVANT tout require du module
fs.mkdirSync(path.join(SANDBOX, '.claude'), { recursive: true });
// Sans sessionKey cookie ni braveUserDataDir configuré, le chemin cookie
// échoue AVANT tout appel réseau (readSessionKey() null → throw synchrone) et
// ne passe jamais par notre bouchon http/https — il faut un token OAuth pour
// que fetchAndUpdate() atteigne réellement `https.get`, ce que ce banc compte.
fs.writeFileSync(path.join(SANDBOX, '.claude', '.credentials.json'),
  JSON.stringify({ claudeAiOauth: { accessToken: 'fake-token-for-test' } }));

// Fenêtres raccourcies pour le banc (couture de test, cf. extension.js).
process.env.CLAUDE_QUOTA_FETCH_DEDUP_MS = '600';
process.env.CLAUDE_QUOTA_EVENT_FETCH_THROTTLE_MS = '10'; // pas le throttle qu'on teste ici

// Compte les tentatives de fetch quota sans jamais laisser une promesse en
// suspens (sinon fetchAndUpdate() ne complète jamais) : chaque `.get()` émet
// une erreur asynchrone, comme un réseau indisponible — le dédup se prouve sur
// le NOMBRE de tentatives, pas sur leur succès.
let netGetCalls = 0;
function fakeReq() {
  const handlers = {};
  const req = { on(evt, cb) { handlers[evt] = cb; return req; }, destroy() {} };
  process.nextTick(() => { if (handlers.error) handlers.error(new Error('network disabled in test')); });
  return req;
}
const netStub = { get: () => { netGetCalls++; return fakeReq(); } };
const procStub = {
  spawn: () => { throw new Error('spawn disabled in test'); },
  execSync: () => { throw new Error('execSync disabled in test'); },
};

const claude = (label) => ({ label, input: { viewType: 'mainThreadWebview-claudeVSCodePanel' } });
let GROUPS = [{ viewColumn: 1, isActive: true, tabs: [claude('Conv A busy puis done')] }];

let provider = null;
let refreshCommandHandler = null;
const vscodeStub = {
  window: {
    state: { focused: true },
    onDidChangeWindowState: () => ({ dispose() {} }),
    tabGroups: {
      get all() { return GROUPS; },
      get activeTabGroup() { return GROUPS[0] || { activeTab: null }; },
      onDidChangeTabs: () => ({ dispose() {} }),
      onDidChangeTabGroups: () => ({ dispose() {} }),
    },
    registerWebviewViewProvider: (_type, p) => { provider = p; return { dispose() {} }; },
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: 'C:\\Users\\Test\\Projets VSCODE\\DemoDedup' } }],
    getConfiguration: () => ({ get: (_k, d) => d }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  commands: {
    registerCommand: (name, fn) => {
      if (name === 'claude-code-quota-bar.refresh') refreshCommandHandler = fn;
      return { dispose() {} };
    },
    executeCommand: async () => {},
  },
  env: { openExternal: async () => {} },
  Uri: { parse: (s) => s },
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

// ── Faux workspace : une conv busy → done pour déclencher le fetch événementiel ──
const WS = 'C:\\Users\\Test\\Projets VSCODE\\DemoDedup';
const { projectDirFor } = require(path.join(__dirname, '..', 'state.js'));
const projectDir = projectDirFor(WS);
fs.mkdirSync(projectDir, { recursive: true });

const assistant = { type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 1000 } } };
function writeTranscript(id, title) {
  const lines = [
    { type: 'user', message: { content: [{ type: 'text', text: 'prompt' }] } },
    assistant,
    { type: 'ai-title', aiTitle: title },
  ];
  fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}
writeTranscript('conv-a', 'Conv A busy puis done');

const STATE_FILE = path.join(SANDBOX, '.claude', 'sessions-state.json');
function writeSessions(sessions) { fs.writeFileSync(STATE_FILE, JSON.stringify({ version: 1, sessions })); }
const now = () => Date.now();
writeSessions({ 'conv-a': { state: 'busy', since: now(), updated_at: now(), transcript: path.join(projectDir, 'conv-a.jsonl') } });

const CACHE_FILE = path.join(SANDBOX, '.claude', 'usage-cache.json');
function writeCache(ageMs) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify({
    timestamp: Date.now() - ageMs,
    data: { five_hour: { utilization: 42, resets_at: null }, seven_day: { utilization: 10, resets_at: null } },
  }));
}

async function waitUntil(pred, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return Date.now() - t0;
    await sleep(10);
  }
  return -1;
}

async function run() {
  const ext = require(path.join(__dirname, '..', 'extension.js'));
  const context = { subscriptions: [] };
  ext.activate(context);

  const posted = [];
  provider.resolveWebviewView({
    webview: {
      options: {}, cspSource: 'vscode-resource:', html: '',
      postMessage: (msg) => posted.push(msg),
      onDidReceiveMessage: () => ({ dispose() {} }),
    },
    visible: true,
    onDidDispose: () => ({ dispose() {} }),
  });
  provider._view.visible = true;

  await sleep(150);
  const baseline = netGetCalls;
  console.log(`\n0. Baseline après activation (pas de cache) : ${baseline} appel(s) réseau`);
  check('un fetch réel a bien été tenté à l\'activation (pas de cache à dédupliquer)', baseline > 0, `netGetCalls=${baseline}`);

  console.log('\n1. Cache partagé frais (< dédup window) écrit par une "autre fenêtre" → transition busy→done ne refetch PAS');
  writeCache(50); // 50 ms d'âge, très en dessous des 600 ms du banc
  posted.length = 0;
  writeSessions({ 'conv-a': { state: 'done', since: now(), updated_at: now(), transcript: path.join(projectDir, 'conv-a.jsonl') } });
  await sleep(300);
  check('aucun appel réseau supplémentaire tant que le cache partagé est frais',
    netGetCalls === baseline, `netGetCalls=${netGetCalls} baseline=${baseline}`);
  check('le panneau reçoit quand même l\'état à jour, lu depuis le cache',
    posted.some((m) => m.state && m.state.quota && m.state.quota.ageMin != null),
    `posted=${JSON.stringify(posted.map((m) => m.state && m.state.quota))}`);

  console.log('\n2. Dédup expirée → une nouvelle transition retente un vrai appel réseau');
  await sleep(700); // dépasse les 600 ms du banc depuis l'écriture du cache
  writeSessions({ 'conv-a': { state: 'busy', since: now(), updated_at: now(), transcript: path.join(projectDir, 'conv-a.jsonl') } });
  await sleep(100);
  writeSessions({ 'conv-a': { state: 'waiting', since: now(), updated_at: now(), transcript: path.join(projectDir, 'conv-a.jsonl'), message: 'permission?' } });
  const ms = await waitUntil(() => netGetCalls > baseline, 2000);
  check(`nouvel appel réseau tenté une fois le cache trop vieux (${ms} ms)`, ms >= 0, `netGetCalls=${netGetCalls}`);

  console.log('\n3. Action explicite user (commande Refresh) → toujours un vrai appel, même cache tout frais');
  writeCache(10);
  const before = netGetCalls;
  check('le handler de la commande refresh a bien été capturé', typeof refreshCommandHandler === 'function');
  refreshCommandHandler();
  const ms2 = await waitUntil(() => netGetCalls > before, 1000);
  check(`la commande Refresh force un appel réseau malgré un cache de 10 ms (${ms2} ms)`, ms2 >= 0, `netGetCalls=${netGetCalls}`);

  console.log('\n4. Repli cache-seul intact : les deux chemins réseau échouent, le panneau affiche quand même le dernier cache');
  const lastPosted = posted[posted.length - 1];
  check('quota.windows non vide malgré l\'échec réseau (lu depuis usage-cache.json)',
    lastPosted && lastPosted.state && lastPosted.state.quota && lastPosted.state.quota.windows && lastPosted.state.quota.windows.length > 0,
    `lastPosted.quota=${JSON.stringify(lastPosted && lastPosted.state && lastPosted.state.quota)}`);

  console.log('\n5. Ménage');
  for (const s of context.subscriptions) { try { s.dispose(); } catch {} }
  ext.deactivate();
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}

  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

run();
