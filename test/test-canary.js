// Lot 13 §1 — tout le matching onglet↔conv (clic-focus, retrait à la
// fermeture, ack) dépend de `viewType.includes('claudeVSCodePanel')`
// (labels.js). Si l'extension officielle le renomme, ces chemins dégradent
// SANS erreur : le panneau se contente de ne plus jamais matcher un onglet.
// Le canari détecte le symptôme (conv busy/waiting + zéro onglet Claude
// pendant > CLAUDE_QUOTA_CANARY_MS) et l'expose (warning console + indicateur
// panneau), sans jamais masquer/toucher aux conversations elles-mêmes.
// Bout-en-bout sur le vrai activate() (mêmes bouchons que test-close-e2e.js).
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-canary-'));
os.homedir = () => SANDBOX;                       // AVANT tout require du module
fs.mkdirSync(path.join(SANDBOX, '.claude'), { recursive: true });

// Fenêtre + cadence de canari raccourcies pour le banc (couture de test, cf. extension.js).
process.env.CLAUDE_QUOTA_CANARY_MS = '300';
process.env.CLAUDE_QUOTA_CANARY_TICK_MS = '80';

const netStub = { get: () => { throw new Error('network disabled in test'); } };
const procStub = {
  spawn: () => { throw new Error('spawn disabled in test'); },
  execSync: () => { throw new Error('execSync disabled in test'); },
};

const claude = (label) => ({ label, input: { viewType: 'mainThreadWebview-claudeVSCodePanel' } });
// Onglet Claude présent au démarrage (workspace « sain »), retiré au test 2
// pour simuler la dérive (renommage du viewType côté extension officielle :
// l'onglet cesse d'être reconnu comme onglet Claude, exactement comme si
// `isClaudeTab` ne matchait plus jamais).
let GROUPS = [{ viewColumn: 1, isActive: true, tabs: [claude('Conv A')] }];

let provider = null;
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
    workspaceFolders: [{ uri: { fsPath: 'C:\\Users\\Test\\Projets VSCODE\\DemoCanary' } }],
    getConfiguration: () => ({ get: (_k, d) => d }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
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

// ── Faux workspace : une conv qui reste busy tout du long ─────────────────
const WS = 'C:\\Users\\Test\\Projets VSCODE\\DemoCanary';
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
writeTranscript('conv-a', 'Conv A');

const STATE_FILE = path.join(SANDBOX, '.claude', 'sessions-state.json');
function writeSessions(sessions) { fs.writeFileSync(STATE_FILE, JSON.stringify({ version: 1, sessions })); }
const now = () => Date.now();
writeSessions({ 'conv-a': { state: 'busy', since: now(), updated_at: now(), transcript: path.join(projectDir, 'conv-a.jsonl') } });

async function waitUntil(pred, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return Date.now() - t0;
    await sleep(10);
  }
  return -1;
}

async function run() {
  const origLog = console.log;
  const logs = [];
  console.log = (...args) => { logs.push(args.join(' ')); origLog.apply(console, args); };

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

  console.log('\n1. Conv busy + onglet Claude présent → pas de canari, même après > CANARY_MS');
  await sleep(500);
  check('aucune ligne canary dans les états poussés au panneau',
    !posted.some((m) => m.state && m.state.canary === true));

  console.log('\n2. Onglet Claude retiré (dérive simulée du viewType) → canari après CANARY_MS, pas avant');
  GROUPS = [{ viewColumn: 1, isActive: true, tabs: [] }];
  posted.length = 0;
  await sleep(150); // < CANARY_MS (300 ms) : pas encore de canari
  check('pas de canari avant l\'expiration de la fenêtre',
    !posted.some((m) => m.state && m.state.canary === true));

  const ms = await waitUntil(
    () => posted.some((m) => m.state && m.state.canary === true),
    3000
  );
  // Seuil ≥ 250 ms (pas 300 pile) : le canari se pose au premier TICK qui suit
  // l'expiration de CANARY_MS, jamais avant — sa cadence (80 ms ici) introduit
  // donc une marge, pas une garantie au ms près.
  check(`canari déclenché après ~${ms} ms (fenêtre 300 ms + jitter du tick 80 ms)`, ms >= 250, `posted count=${posted.length}`);
  check('un warning explicite est bien loggé',
    logs.some((l) => l.includes('[QuotaBar] canary')));

  console.log('\n3. Onglet Claude détecté à nouveau → canari résorbé');
  GROUPS = [{ viewColumn: 1, isActive: true, tabs: [claude('Conv A')] }];
  posted.length = 0;
  const ms2 = await waitUntil(
    () => posted.some((m) => m.state && m.state.canary === false),
    2000
  );
  check(`canari résorbé dès qu'un onglet Claude est de nouveau détecté (${ms2} ms)`, ms2 >= 0, `posted count=${posted.length}`);

  console.log('\n4. Ménage');
  console.log = origLog;
  for (const s of context.subscriptions) { try { s.dispose(); } catch {} }
  ext.deactivate();
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}

  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

run();
