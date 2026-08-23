// Bancs du bandeau d'onboarding (lot 2026-08-19) — côté hôte d'extension.
//
// Le constat qui motive le lot : un poste installé depuis le Marketplace ne
// déploie RIEN dans ~/.claude/ tout seul, et jusqu'ici rien à l'écran ne le
// disait (hooksAppearInstalled() n'était consulté que si l'user allumait les
// sons). Ce banc couvre le côté hôte de la réparation, sur le VRAI activate()
// (mêmes bouchons que test-canary.js) :
//   1. rien installé → les deux signaux `setup` sont false, ET les clés
//      setContext (CTX_HOOKS_INSTALLED / CTX_HANDOFFS_INSTALLED) le portent ;
//   2. les deux manques sont INDÉPENDANTS — un poste qui n'a que les hooks
//      (une install antérieure à l'ajout de /handoffs, ou un handoffs.md
//      supprimé à la main) ne doit dire "true" QUE pour hooksInstalled ;
//   3. setContext n'est réémis QUE sur un changement réel (pas à chaque push) ;
//   4. cliquer le bouton du bandeau (message `installHooksNow`) suit
//      EXACTEMENT le chemin de la commande Palette (même modale, même
//      installClaudeHooks()) et le panneau annonce le setup réparé tout de
//      suite après — SANS attendre le reload proposé, qui n'est qu'une
//      invite pour l'état runtime, pas une condition du bandeau.
//
// Le rendu du bandeau lui-même (DOM/CSS, absence de tout mécanisme de
// fermeture, dégradation quand `setup` est absent du message) est couvert
// séparément dans test-panel-render.js §24, qui prouve par les PIXELS — ce
// banc-ci ne mesure que ce que l'hôte d'extension PUBLIE.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-onboarding-'));
os.homedir = () => SANDBOX;                       // AVANT tout require du module
fs.mkdirSync(path.join(SANDBOX, '.claude'), { recursive: true });

const EXT = path.join(__dirname, '..');

const netStub = { get: () => { throw new Error('network disabled in test'); } };
const procStub = {
  spawn: () => { throw new Error('spawn disabled in test'); },
  execSync: () => { throw new Error('execSync disabled in test'); },
};

function makeMemento() {
  const map = new Map();
  return {
    get: (k, d) => (map.has(k) ? map.get(k) : d),
    update: (k, v) => { map.set(k, v); return Promise.resolve(); },
  };
}

const setContextCalls = [];
const commandHandlers = {};
let provider = null;
const vscodeStub = {
  window: {
    state: { focused: true },
    onDidChangeWindowState: () => ({ dispose() {} }),
    tabGroups: {
      get all() { return []; },
      get activeTabGroup() { return { activeTab: null }; },
      onDidChangeTabs: () => ({ dispose() {} }),
      onDidChangeTabGroups: () => ({ dispose() {} }),
    },
    registerWebviewViewProvider: (_type, p) => { provider = p; return { dispose() {} }; },
    createStatusBarItem: () => ({ show() {}, dispose() {} }),
    // Modale d'installHooks() : accepte toujours (retourne le libellé du
    // bouton, comme un clic réel — vscode.l10n.t() ci-dessous est l'identité).
    showWarningMessage: async (_msg, _opts, ...items) => items[0],
    showInformationMessage: async () => undefined,
    withProgress: async (_opts, task) => task(),
  },
  ProgressLocation: { Notification: 1 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: 'C:\\Users\\Test\\Projets VSCODE\\DemoOnboarding' } }],
    getConfiguration: () => ({ get: (_k, d) => d }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  commands: {
    registerCommand: (id, fn) => { commandHandlers[id] = fn; return { dispose() {} }; },
    executeCommand: async (cmd, ...args) => { if (cmd === 'setContext') setContextCalls.push(args); },
  },
  env: { openExternal: async () => {} },
  Uri: { parse: (s) => s },
  l10n: { t: (message, ...args) => (args.length ? message.replace(/\{(\d+)\}/g, (_, i) => (args[i] !== undefined ? args[i] : '')) : message) },
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

function lastSetupOf(posted) {
  for (let i = posted.length - 1; i >= 0; i--) {
    if (posted[i].state && posted[i].state.setup) return posted[i].state.setup;
  }
  return null;
}
function ctxCallsFor(key) {
  return setContextCalls.filter((args) => args[0] === key).map((args) => args[1]);
}

async function run() {
  const ext = require(path.join(EXT, 'extension.js'));
  const context = {
    subscriptions: [],
    extensionPath: EXT,
    workspaceState: makeMemento(),
    globalState: makeMemento(),
  };
  ext.activate(context);

  const posted = [];
  let receiveFromWebview = null;
  provider.resolveWebviewView({
    webview: {
      options: {}, cspSource: 'vscode-resource:', html: '',
      postMessage: (msg) => posted.push(msg),
      onDidReceiveMessage: (cb) => { receiveFromWebview = cb; return { dispose() {} }; },
    },
    visible: true,
    onDidDispose: () => ({ dispose() {} }),
  });
  provider._view.visible = true;

  console.log('\n1. Poste fraîchement installé — rien dans ~/.claude/scripts ni ~/.claude/commands');
  await sleep(200); // fetchAndUpdate() de l'activation échoue en réseau (attendu) puis pushPanelState()
  let setup = lastSetupOf(posted);
  check('un état a bien été poussé', !!setup, JSON.stringify(posted.map((m) => Object.keys(m))));
  check('hooksInstalled=false', setup && setup.hooksInstalled === false);
  check('handoffsInstalled=false', setup && setup.handoffsInstalled === false);
  check('setContext(hooksInstalled) appelé une fois avec false', JSON.stringify(ctxCallsFor('claudeCodeQuotaBar.hooksInstalled')) === JSON.stringify([false]));
  check('setContext(handoffsInstalled) appelé une fois avec false', JSON.stringify(ctxCallsFor('claudeCodeQuotaBar.handoffsInstalled')) === JSON.stringify([false]));

  console.log('\n2. Les deux manques sont INDÉPENDANTS — seul le marqueur des hooks apparaît (install antérieure à /handoffs)');
  fs.mkdirSync(path.join(SANDBOX, '.claude', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(SANDBOX, '.claude', 'scripts', 'hook-session-state.js'), '// marker only, not a real hook for this banc\n');
  posted.length = 0;
  await commandHandlers['claude-code-quota-bar.refresh']();
  await sleep(50);
  setup = lastSetupOf(posted);
  check('hooksInstalled=true, handoffsInstalled TOUJOURS false', setup && setup.hooksInstalled === true && setup.handoffsInstalled === false, JSON.stringify(setup));
  check('setContext(hooksInstalled) reçoit maintenant true (changement)', ctxCallsFor('claudeCodeQuotaBar.hooksInstalled').slice(-1)[0] === true);
  check('setContext(handoffsInstalled) n\'a PAS été réémis (toujours false, pas de changement)', ctxCallsFor('claudeCodeQuotaBar.handoffsInstalled').length === 1);
  const hooksCtxCallsAfterStep2 = ctxCallsFor('claudeCodeQuotaBar.hooksInstalled').length;

  console.log('\n3. handoffs.md ajouté à son tour — le second signal bascule à son tour, séparément');
  fs.mkdirSync(path.join(SANDBOX, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(SANDBOX, '.claude', 'commands', 'handoffs.md'), '# marker only\n');
  posted.length = 0;
  await commandHandlers['claude-code-quota-bar.refresh']();
  await sleep(50);
  setup = lastSetupOf(posted);
  check('les deux signaux sont maintenant true', setup && setup.hooksInstalled === true && setup.handoffsInstalled === true, JSON.stringify(setup));
  check('setContext(handoffsInstalled) reçoit true (changement)', ctxCallsFor('claudeCodeQuotaBar.handoffsInstalled').slice(-1)[0] === true);
  check('setContext(hooksInstalled) toujours pas réémis depuis l\'étape 2 (pas de changement)', ctxCallsFor('claudeCodeQuotaBar.hooksInstalled').length === hooksCtxCallsAfterStep2);

  console.log('\n4. Régression (fichiers supprimés) puis clic du bouton — réparation visible SANS reload (test principal de la maquette)');
  fs.rmSync(path.join(SANDBOX, '.claude', 'scripts', 'hook-session-state.js'), { force: true });
  fs.rmSync(path.join(SANDBOX, '.claude', 'commands', 'handoffs.md'), { force: true });
  posted.length = 0;
  await commandHandlers['claude-code-quota-bar.refresh']();
  await sleep(50);
  setup = lastSetupOf(posted);
  check('après suppression, les deux signaux repassent à false', setup && setup.hooksInstalled === false && setup.handoffsInstalled === false, JSON.stringify(setup));

  check('handler installHooksNow câblé (message posté par le bouton du bandeau)', typeof receiveFromWebview === 'function');
  posted.length = 0;
  receiveFromWebview({ type: 'installHooksNow' });
  // installHooks() est async (modale → withProgress → installClaudeHooks() →
  // pushPanelState()) : laisser le micro-tasking dérouler.
  await sleep(150);
  setup = lastSetupOf(posted);
  check('le panneau republie déjà setup={true,true} après le clic, sans attendre un reload', setup && setup.hooksInstalled === true && setup.handoffsInstalled === true, JSON.stringify(setup));
  check('même chemin que la commande Palette : les VRAIS fichiers du repo (hooks/ + commands/handoffs.md) sont sur disque, pas de simples marqueurs',
    fs.existsSync(path.join(SANDBOX, '.claude', 'scripts', 'hook-session-state.js'))
    && fs.readFileSync(path.join(SANDBOX, '.claude', 'scripts', 'hook-session-state.js'), 'utf8') === fs.readFileSync(path.join(EXT, 'hooks', 'hook-session-state.js'), 'utf8')
    && fs.existsSync(path.join(SANDBOX, '.claude', 'commands', 'handoffs.md'))
    && fs.readFileSync(path.join(SANDBOX, '.claude', 'commands', 'handoffs.md'), 'utf8') === fs.readFileSync(path.join(EXT, 'commands', 'handoffs.md'), 'utf8'));

  console.log('\n5. Ménage');
  for (const s of context.subscriptions) { try { s.dispose(); } catch {} }
  ext.deactivate();
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}

  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

run();
