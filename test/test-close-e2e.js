// Bout-en-bout du lot 5 sur le VRAI activate() d'extension.js : on ferme un
// onglet, la conversation doit quitter le panneau et son entrée sortir de
// sessions-state.json. C'est le seul test qui prouve le CÂBLAGE (tabs.js →
// state.js → panel.js → purge) plutôt que ses morceaux pris séparément.
//
// Bouchons : `vscode` (aucune fenêtre réelle), `http`/`https` (aucun octet ne
// part : sans ça activate() irait chercher le quota, donc réveillerait Brave
// Octopus et lirait les cookies de l'user) et `child_process` (ceinture et
// bretelles : aucun process ne doit naître d'un test). HOME est un bac à sable.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-e2e-'));
os.homedir = () => SANDBOX;                       // AVANT tout require du module
fs.mkdirSync(path.join(SANDBOX, '.claude'), { recursive: true });

let GROUPS = [];
// PLUSIEURS modules s'abonnent à onDidChangeTabs (tabs.js pour la fermeture,
// ack.js pour la consultation) : le bouchon doit les diffuser à tous, comme le
// fait VS Code. N'en garder qu'un seul revient à tester un câblage imaginaire —
// c'est ce qui a fait passer ce banc à côté de la fermeture au lot 6.
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
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: 'C:\\Users\\Test\\Projets VSCODE\\Demo' } }],
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

// ── Faux workspace : deux convs, l'une sera fermée ────────────────────────
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
writeTranscript('close-me', 'Conversation à fermer maintenant');
writeTranscript('keep-me', 'Conversation qui doit rester');

const STATE_FILE = path.join(SANDBOX, '.claude', 'sessions-state.json');
const now = Date.now();
fs.writeFileSync(STATE_FILE, JSON.stringify({
  version: 1,
  sessions: {
    // busy : la règle user veut qu'une conv fermée EN PLEIN TRAVAIL disparaisse.
    'close-me': { state: 'busy', since: now, updated_at: now, transcript: path.join(projectDir, 'close-me.jsonl') },
    'keep-me': { state: 'busy', since: now, updated_at: now, transcript: path.join(projectDir, 'keep-me.jsonl') },
  },
}));

const titlesOf = () => {
  const last = pushed[pushed.length - 1];
  return ((last && last.state && last.state.conversations) || []).map((c) => c.title);
};

async function run() {
  const ext = require(path.join(__dirname, '..', 'extension.js'));

  // Les deux onglets sont ouverts, avec le libellé TRONQUÉ comme le fait la
  // vraie extension Claude (24 car. + « … »).
  GROUPS = [group([claude('Conversation à fermer …'), claude('Conversation qui doit …')])];

  const context = { subscriptions: [] };
  ext.activate(context);

  // Le webview se résout et capture les push d'état.
  provider.resolveWebviewView({
    webview: {
      options: {}, cspSource: 'vscode-resource:', html: '',
      postMessage: (m) => { pushed.push(m); },
      onDidReceiveMessage: () => ({ dispose() {} }),
    },
    onDidDispose: () => ({ dispose() {} }),
  });
  await sleep(150);

  console.log('\n1. État initial');
  check('les deux conversations sont affichées',
    titlesOf().includes('Conversation à fermer maintenant') && titlesOf().includes('Conversation qui doit rester'),
    titlesOf().join(' | '));

  console.log('\n2. Fermeture de l\'onglet (conv `busy`)');
  GROUPS = [group([claude('Conversation qui doit …')])];
  const t0 = Date.now();
  emitTabs({ closed: [claude('Conversation à fermer …')], opened: [], changed: [] });

  // Attente de l'effet réel, pas d'un délai fixe : on mesure la latence vécue.
  let gone = 0;
  for (let i = 0; i < 100; i++) {
    if (!titlesOf().includes('Conversation à fermer maintenant')) { gone = Date.now() - t0; break; }
    await sleep(10);
  }
  check(`la conv fermée quitte le panneau en ${gone || '>1000'} ms (exigence : < 1 s)`,
    gone > 0 && gone < 1000, `${gone} ms`);
  check('elle disparaît alors qu\'elle était `busy` (règle user)',
    !titlesOf().includes('Conversation à fermer maintenant'), titlesOf().join(' | '));
  check('l\'autre conversation reste', titlesOf().includes('Conversation qui doit rester'),
    titlesOf().join(' | '));

  console.log('\n3. Purge de sessions-state.json (sinon elle ressuscite ailleurs)');
  await sleep(200);
  const sessions = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).sessions;
  check('l\'entrée de la conv fermée est purgée', !sessions['close-me'], JSON.stringify(Object.keys(sessions)));
  check('l\'entrée de l\'autre conv est intacte',
    sessions['keep-me'] && sessions['keep-me'].state === 'busy', JSON.stringify(sessions['keep-me']));

  console.log('\n4. Aucun résidu');
  for (const s of context.subscriptions) { try { s.dispose(); } catch {} }
  ext.deactivate();
  const tabsDir = path.join(SANDBOX, '.claude', 'panel-tabs');
  const left = fs.existsSync(tabsDir) ? fs.readdirSync(tabsDir) : [];
  check('le fichier d\'onglets de l\'instance est retiré au dispose',
    left.length === 0, JSON.stringify(left));

  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

run();
