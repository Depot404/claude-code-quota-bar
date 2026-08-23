// Banc : marques « à relire » — persistance et publication dans le snapshot
// (lot 1 du plan PLAN_marque_a_relire_2026-08-22.md).
//
// Ce qui peut silencieusement mal tourner, et que ce banc verrouille :
//   1. la persistance (workspaceState) — ce qui est relu doit être ce qui a
//      été écrit, y compris un stockage antérieur hétéroclite ;
//   2. pose ⇄ retrait : une même conversation qu'on marque deux fois de suite
//      doit repasser NON marquée (bascule, pas accumulation) ;
//   3. un sessionId inconnu/absent est un no-op silencieux, jamais une
//      exception ;
//   4. le snapshot publié au webview porte bien `pinned` sur CHAQUE
//      conversation (et seulement sur celle marquée), sur le VRAI activate()
//      — pas un module mocké — via le message `togglePinConv` du webview.
const path = require('path');

const EXT = path.join(__dirname, '..');
const { createPinStore, sanitizePinned } = require(path.join(EXT, 'pins.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

// Faux workspaceState : un objet JSON qui survit d'un store à l'autre, comme
// le vrai survit à un reload de fenêtre.
function fakeStorage(initial = []) {
  let data = JSON.parse(JSON.stringify(initial));
  return {
    load: () => JSON.parse(JSON.stringify(data)),
    save: (ids) => { data = JSON.parse(JSON.stringify(ids)); },
    raw: () => data,
  };
}

function runUnit() {
  console.log('\n1. Pose, retrait, persistance');
  const st = fakeStorage();
  let store = createPinStore({ load: st.load, save: st.save });
  check('rien de marqué au départ', store.isPinned('s-A') === false);
  check('pose : toggle retourne true', store.toggle('s-A') === true);
  check('marquée après pose', store.isPinned('s-A') === true);
  check('écrite dans le stockage', JSON.stringify(st.raw()) === JSON.stringify(['s-A']));
  check('une 2e conv marquée s\'ajoute sans effacer la 1re', store.toggle('s-B') === true && store.isPinned('s-A') === true);
  check('list() porte les deux', store.list().sort().join() === 's-A,s-B');

  console.log('\n2. Reload de fenêtre : nouveau store, même stockage');
  store = createPinStore({ load: st.load, save: st.save });
  check('relu à l\'identique', store.isPinned('s-A') === true && store.isPinned('s-B') === true);

  console.log('\n3. Bascule : marquer deux fois de suite retire la marque (pas une pose idempotente)');
  check('2e toggle retourne false', store.toggle('s-A') === false);
  check('démarquée', store.isPinned('s-A') === false);
  check('s-B, non touchée, reste marquée', store.isPinned('s-B') === true);
  check('le stockage ne garde plus que s-B', JSON.stringify(st.raw()) === JSON.stringify(['s-B']));

  console.log('\n4. sessionId inconnu / absent : no-op silencieux');
  check('id inconnu → isPinned false, jamais une exception', store.isPinned('s-jamais-vue') === false);
  check('toggle(null) → false, rien persisté', store.toggle(null) === false && JSON.stringify(st.raw()) === JSON.stringify(['s-B']));
  check('toggle(undefined) → false', store.toggle(undefined) === false);
  check('toggle(\'\') → false', store.toggle('') === false);
  check('isPinned(undefined) → false', store.isPinned(undefined) === false);

  console.log('\n5. Stockage hétéroclite (version antérieure / JSON corrompu)');
  check('sanitizePinned jette les entrées qui ne sont pas des chaînes non vides',
    [...sanitizePinned(['s-A', '', 42, null, {}, 's-B'])].sort().join() === 's-A,s-B');
  check('sanitizePinned(null) → ensemble vide', sanitizePinned(null).size === 0);
  const stBroken = { load: () => { throw new Error('stockage corrompu'); }, save: () => {} };
  const storeBroken = createPinStore(stBroken);
  check('load() qui jette → store vide, pas d\'exception propagée', storeBroken.list().length === 0);
}

// ── 6. Snapshot : le VRAI activate() publie `pinned` sur chaque conversation,
// et togglePinConv (message du webview) le bascule sans rien casser d'autre. ─
const Module = require('module');
const fs = require('fs');
const os = require('os');

async function runIntegration() {
  const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-pins-'));
  os.homedir = () => SANDBOX;                       // AVANT tout require du module
  fs.mkdirSync(path.join(SANDBOX, '.claude'), { recursive: true });

  const netStub = { get: () => { throw new Error('network disabled in test'); } };
  const procStub = {
    spawn: () => { throw new Error('spawn disabled in test'); },
    execSync: () => { throw new Error('execSync disabled in test'); },
  };

  const commandCalls = [];
  const claude = (label) => ({ label, input: { viewType: 'mainThreadWebview-claudeVSCodePanel' } });
  const GROUPS = [{ viewColumn: 1, isActive: true, tabs: [claude('Conv A')] }];
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
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: 'C:\\Users\\Test\\Projets VSCODE\\DemoPins' } }],
      getConfiguration: () => ({ get: (_k, d) => d }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    commands: {
      registerCommand: () => ({ dispose() {} }),
      // Journalisées : le lot 3 rouvre une conversation fermée par
      // claude-vscode.editor.open(sessionId) — la seule commande de
      // l'extension officielle qui accepte un identifiant de session.
      executeCommand: async (...args) => { commandCalls.push(args); },
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

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Une conversation réelle pour que le snapshot ait quelque chose à porter.
  const WS = 'C:\\Users\\Test\\Projets VSCODE\\DemoPins';
  const { projectDirFor } = require(path.join(EXT, 'state.js'));
  const projectDir = projectDirFor(WS);
  fs.mkdirSync(projectDir, { recursive: true });
  const assistant = { type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 1000 } } };
  fs.writeFileSync(path.join(projectDir, 'conv-a.jsonl'), [
    { type: 'user', message: { content: [{ type: 'text', text: 'prompt' }] } },
    assistant,
    { type: 'ai-title', aiTitle: 'Conv A' },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const STATE_FILE = path.join(SANDBOX, '.claude', 'sessions-state.json');
  const now = Date.now();
  fs.writeFileSync(STATE_FILE, JSON.stringify({ version: 1, sessions: {
    'conv-a': { state: 'busy', since: now, updated_at: now, transcript: path.join(projectDir, 'conv-a.jsonl') },
  } }));

  function makeMemento() {
    const map = new Map();
    return {
      get: (k, d) => (map.has(k) ? map.get(k) : d),
      update: (k, v) => { map.set(k, v); return Promise.resolve(); },
      raw: () => Object.fromEntries(map),
    };
  }

  const ext = require(path.join(EXT, 'extension.js'));
  const workspaceState = makeMemento();
  const context = { subscriptions: [], extensionPath: EXT, workspaceState, globalState: makeMemento() };
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
  await sleep(200);

  function lastConvs() {
    for (let i = posted.length - 1; i >= 0; i--) {
      if (posted[i].state && Array.isArray(posted[i].state.conversations)) return posted[i].state.conversations;
    }
    return null;
  }

  console.log('\n6. Snapshot publié par le VRAI activate()');
  let convs = lastConvs();
  check('conv-a est bien dans le snapshot', !!convs && convs.some((c) => c.id === 'conv-a'), JSON.stringify(convs));
  let a = convs.find((c) => c.id === 'conv-a');
  check('pinned: false au départ (jamais absent — décision du lot : un drapeau explicite)', a.pinned === false);

  console.log('\n7. togglePinConv (message du webview) — pose');
  check('handler câblé', typeof receiveFromWebview === 'function');
  posted.length = 0;
  receiveFromWebview({ type: 'togglePinConv', id: 'conv-a' });
  await sleep(50);
  convs = lastConvs();
  a = convs && convs.find((c) => c.id === 'conv-a');
  check('le panneau republie pinned: true tout de suite après le clic', !!a && a.pinned === true, JSON.stringify(a));
  check('persisté dans workspaceState (survit à un reload)', JSON.stringify(workspaceState.raw().pinnedConversations) === JSON.stringify(['conv-a']));

  console.log('\n8. togglePinConv — retrait, et id qui ne correspond à AUCUNE conversation du snapshot');
  // Le store ne connaît que des sessionId, jamais le snapshot : un id qui ne
  // matche aucune conversation se marque quand même (c'est voulu — lot 3 : une
  // marque doit pouvoir survivre à un onglet déjà fermé), mais ne fait
  // apparaître aucune ligne fantôme dans le snapshot rendu.
  posted.length = 0;
  receiveFromWebview({ type: 'togglePinConv', id: 'conv-inconnue' });
  await sleep(50);
  check('aucune exception, aucune ligne fantôme dans le snapshot', lastConvs() === null || lastConvs().every((c) => c.id !== 'conv-inconnue'));
  check('mais la marque existe bien dans le stockage (id hors snapshot ≠ id invalide)',
    workspaceState.raw().pinnedConversations.includes('conv-inconnue'));

  posted.length = 0;
  receiveFromWebview({ type: 'togglePinConv', id: 'conv-a' });
  await sleep(50);
  convs = lastConvs();
  a = convs && convs.find((c) => c.id === 'conv-a');
  check('retrait : pinned repasse à false', !!a && a.pinned === false, JSON.stringify(a));
  check('conv-a a bien quitté le stockage (seule conv-inconnue y reste)',
    JSON.stringify(workspaceState.raw().pinnedConversations) === JSON.stringify(['conv-inconnue']),
    JSON.stringify(workspaceState.raw().pinnedConversations));

  // ── Lot 3 : la marque survit à la FERMETURE de l'onglet ────────────────
  // Le geste que toute la fonctionnalité vise : l'user ferme un onglet en
  // croyant le travail fini. Sans marque, la ligne part avec l'onglet (c'est
  // le filtre de présence, et il a raison) ; marquée, elle doit rester —
  // rendue « onglet fermé », et cliquable pour ROUVRIR.
  console.log('\n10. La marque survit à la fermeture de l\'onglet (bout-en-bout, vrai activate())');
  // Conversation TERMINÉE (une conv busy sans onglet reste listée de toute
  // façon — filet d'isGone) et son onglet refermé.
  fs.writeFileSync(STATE_FILE, JSON.stringify({ version: 1, sessions: {
    'conv-a': { state: 'done', since: Date.now(), updated_at: Date.now(), transcript: path.join(projectDir, 'conv-a.jsonl') },
  } }));
  GROUPS[0].tabs.length = 0;
  // Un recompute qui ne touche PAS conv-a (le toggle démarque conv-inconnue,
  // marquée au §8) : c'est le témoin — sans marque, la ligne s'en va.
  receiveFromWebview({ type: 'togglePinConv', id: 'conv-inconnue' });
  await sleep(80);
  check('témoin : onglet fermé + conv terminée + PAS de marque → la ligne quitte la liste',
    (lastConvs() || []).every((c) => c.id !== 'conv-a'), JSON.stringify(lastConvs()));

  receiveFromWebview({ type: 'togglePinConv', id: 'conv-a' });
  await sleep(80);
  convs = lastConvs();
  a = convs && convs.find((c) => c.id === 'conv-a');
  check('marquée alors que son onglet est fermé → la ligne REVIENT', !!a, JSON.stringify(convs));
  check('…publiée tabGone: true (le rendu la barre, le clic rouvrira)', !!a && a.tabGone === true, JSON.stringify(a));
  check('…tabOpen: false et pinned: true', !!a && a.tabOpen === false && a.pinned === true);

  console.log('\n11. reopenConv — le clic sur une ligne « onglet fermé » rouvre la conversation');
  commandCalls.length = 0;
  receiveFromWebview({ type: 'reopenConv', id: 'conv-a' });
  await sleep(80);
  const opens = commandCalls.filter((c) => c[0] === 'claude-vscode.editor.open');
  check('exactement UN claude-vscode.editor.open, avec le sessionId de la ligne',
    opens.length === 1 && opens[0][1] === 'conv-a', JSON.stringify(commandCalls));
  check('aucune autre commande d\'ouverture (jamais newConversation, qui perdrait la conversation)',
    !commandCalls.some((c) => String(c[0]).includes('newConversation')), JSON.stringify(commandCalls));

  console.log('\n12. Retrait de la marque : la ligne repart TOUT DE SUITE');
  // Le piège que ce cas verrouille : togglePinConv republiait le snapshot en
  // CACHE. La marque décidant désormais de la présence, il faut un recompute
  // avant le push — sinon la ligne resterait à l'écran jusqu'à un événement
  // sans rapport.
  receiveFromWebview({ type: 'togglePinConv', id: 'conv-a' });
  await sleep(80);
  check('marque retirée → la ligne disparaît dans le MÊME push (recompute avant push)',
    (lastConvs() || []).every((c) => c.id !== 'conv-a'), JSON.stringify(lastConvs()));

  console.log('\n13. Ménage');
  for (const s of context.subscriptions) { try { s.dispose(); } catch {} }
  ext.deactivate();
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
}

async function run() {
  runUnit();
  await runIntegration();
  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

run();
