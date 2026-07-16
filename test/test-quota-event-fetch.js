// Lot 9 — bout-en-bout sur le VRAI activate() : une conv qui bascule vers
// `done`/`waiting` doit déclencher un fetch quota, throttlé, sauf recompute
// sans transition (ctx% seul) ni panneau caché. Même bouchons que
// test-close-e2e.js (aucune fenêtre, aucun octet réseau réel, aucun process).
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-event-fetch-'));
os.homedir = () => SANDBOX;                       // AVANT tout require du module
fs.mkdirSync(path.join(SANDBOX, '.claude'), { recursive: true });

// Throttle raccourci pour le banc (couture de test, cf. extension.js).
process.env.CLAUDE_QUOTA_EVENT_FETCH_THROTTLE_MS = '1000';

// Compte les tentatives de fetch quota sans jamais laisser une promesse en
// suspens (sinon fetchAndUpdate() ne complète jamais et pollue les appels
// suivants) : chaque `.get()` émet une erreur asynchrone, comme un réseau
// indisponible.
let netGetCalls = 0;
function fakeReq() {
  const handlers = {};
  const req = {
    on(evt, cb) { handlers[evt] = cb; return req; },
    destroy() {},
  };
  process.nextTick(() => { if (handlers.error) handlers.error(new Error('network disabled in test')); });
  return req;
}
const netStub = { get: () => { netGetCalls++; return fakeReq(); } };
const procStub = {
  spawn: () => { throw new Error('spawn disabled in test'); },
  execSync: () => { throw new Error('execSync disabled in test'); },
};

// Onglets ouverts pour les deux convs : nécessaire pour que le filtre de
// présence du lot 5 (isGone) ne les masque pas dès qu'elles passent
// `done`/`waiting` sans onglet correspondant connu (sinon elles disparaissent
// du snapshot au lieu de transitionner sous nos yeux — pas le comportement
// visé par CE test, qui porte sur le fetch événementiel, pas sur la présence).
const claude = (label) => ({ label, input: { viewType: 'mainThreadWebview-claudeVSCodePanel' } });
let GROUPS = [{
  viewColumn: 1, isActive: true,
  tabs: [claude('Conversation A busy puis done'), claude('Conversation B busy puis waiting')],
}];

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
    workspaceFolders: [{ uri: { fsPath: 'C:\\Users\\Test\\Projets VSCODE\\Demo9' } }],
    getConfiguration: () => ({ get: (_k, d) => d }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  commands: {
    registerCommand: () => ({ dispose() {} }),
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

// ── Faux workspace : deux convs busy ──────────────────────────────────────
const WS = 'C:\\Users\\Test\\Projets VSCODE\\Demo9';
const { projectDirFor } = require(path.join(__dirname, '..', 'state.js'));
const projectDir = projectDirFor(WS);
fs.mkdirSync(projectDir, { recursive: true });

const assistant = { type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 1000 } } };
function writeTranscript(id, title, extraAssistants = 0) {
  const lines = [
    { type: 'user', message: { content: [{ type: 'text', text: 'prompt' }] } },
    assistant,
    { type: 'ai-title', aiTitle: title },
  ];
  for (let i = 0; i < extraAssistants; i++) lines.push(assistant);
  fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}
writeTranscript('conv-a', 'Conversation A busy puis done');
writeTranscript('conv-b', 'Conversation B busy puis waiting');

const STATE_FILE = path.join(SANDBOX, '.claude', 'sessions-state.json');
function writeSessions(sessions) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ version: 1, sessions }));
}
const now = () => Date.now();
writeSessions({
  'conv-a': { state: 'busy', since: now(), updated_at: now(), transcript: path.join(projectDir, 'conv-a.jsonl') },
  'conv-b': { state: 'busy', since: now(), updated_at: now(), transcript: path.join(projectDir, 'conv-b.jsonl') },
});

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

  provider.resolveWebviewView({
    webview: {
      options: {}, cspSource: 'vscode-resource:', html: '',
      postMessage: () => {},
      onDidReceiveMessage: () => ({ dispose() {} }),
    },
    visible: true,
    onDidDispose: () => ({ dispose() {} }),
  });
  provider._view.visible = true;

  await sleep(200);
  const baseline = netGetCalls;
  console.log(`\n0. Baseline après activation : ${baseline} appel(s) réseau (fetch d'activation)`);

  console.log('\n1. Recompute SANS transition (ctx% seul) → 0 fetch');
  writeTranscript('conv-a', 'Conversation A busy puis done', 1); // usage bouge, état inchangé
  await sleep(400);
  check('aucun fetch supplémentaire sur un recompute sans transition d\'état',
    netGetCalls === baseline, `netGetCalls=${netGetCalls} baseline=${baseline}`);

  console.log('\n2. Transition busy → done (conv A) → fetch observé');
  writeSessions({
    'conv-a': { state: 'done', since: now(), updated_at: now(), transcript: path.join(projectDir, 'conv-a.jsonl') },
    'conv-b': { state: 'busy', since: now(), updated_at: now(), transcript: path.join(projectDir, 'conv-b.jsonl') },
  });
  const ms1 = await waitUntil(() => netGetCalls > baseline, 2000);
  check(`fetch déclenché en ${ms1} ms (exigence : ~2 s)`, ms1 >= 0 && ms1 < 2000, `netGetCalls=${netGetCalls}`);
  const afterFirst = netGetCalls;

  console.log('\n3. Rafale : transition busy → waiting (conv B) juste après → throttlé, 0 fetch de plus');
  writeSessions({
    'conv-a': { state: 'done', since: now(), updated_at: now(), transcript: path.join(projectDir, 'conv-a.jsonl') },
    'conv-b': { state: 'waiting', since: now(), updated_at: now(), transcript: path.join(projectDir, 'conv-b.jsonl'), message: 'permission?' },
  });
  await sleep(400);
  check('la 2e transition dans la fenêtre de throttle ne déclenche pas de nouveau fetch',
    netGetCalls === afterFirst, `netGetCalls=${netGetCalls} afterFirst=${afterFirst}`);

  console.log('\n4. Après expiration du throttle → une nouvelle transition refetch');
  // Repasser par `busy` d'abord (recompute isolé, > debounceMs plus tard) pour
  // que la transition FINALE vers `done` soit une vraie transition observée,
  // pas une réécriture coalescée par le debounce qui laisserait l'état final
  // identique à celui déjà connu (piège rencontré : deux writeSessions à 50 ms
  // d'écart se retrouvaient fusionnés en un seul recompute par le debounce de
  // state.js, donc AUCUNE transition n'était détectable).
  writeSessions({
    'conv-a': { state: 'busy', since: now(), updated_at: now(), transcript: path.join(projectDir, 'conv-a.jsonl') },
    'conv-b': { state: 'waiting', since: now(), updated_at: now(), transcript: path.join(projectDir, 'conv-b.jsonl'), message: 'permission?' },
  });
  await sleep(400);
  await sleep(700); // dépasse le throttle raccourci (1000 ms) depuis le fetch de l'étape 2
  writeSessions({
    'conv-a': { state: 'done', since: now(), updated_at: now(), transcript: path.join(projectDir, 'conv-a.jsonl') },
    'conv-b': { state: 'waiting', since: now(), updated_at: now(), transcript: path.join(projectDir, 'conv-b.jsonl'), message: 'permission?' },
  });
  const ms2 = await waitUntil(() => netGetCalls > afterFirst, 2000);
  check(`nouveau fetch après expiration du throttle (${ms2} ms)`, ms2 >= 0, `netGetCalls=${netGetCalls}`);

  console.log('\n5. Panneau caché → pas de fetch même sur transition réelle');
  provider._view.visible = false;
  const beforeHidden = netGetCalls;
  writeSessions({
    'conv-a': { state: 'busy', since: now(), updated_at: now(), transcript: path.join(projectDir, 'conv-a.jsonl') },
    'conv-b': { state: 'done', since: now(), updated_at: now(), transcript: path.join(projectDir, 'conv-b.jsonl') },
  });
  await sleep(600);
  check('aucun fetch déclenché quand le panneau est caché',
    netGetCalls === beforeHidden, `netGetCalls=${netGetCalls} beforeHidden=${beforeHidden}`);

  console.log('\n6. Ménage');
  for (const s of context.subscriptions) { try { s.dispose(); } catch {} }
  ext.deactivate();
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}

  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

run();
