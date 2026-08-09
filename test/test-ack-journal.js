// Banc de l'étape 18 phase 1 (PLAN_repli_auto_groupe_done_2026-08-04.md) :
// journal d'instrumentation du chemin d'accusé de lecture.
//
// CE QU'IL DOIT PROUVER — l'instrumentation ne sert à rien si elle n'écrit pas
// LÀ où l'incident se produit. Ce banc va donc jusqu'au bout-en-bout sur le
// VRAI `activate()` d'extension.js (§4) : une conversation terminée acquittée
// par le dwell doit laisser une ligne `ack-post` portant tout le contexte de la
// décision, et une conversation refusée par la garde du lot 10 doit laisser sa
// ligne `stay-before-busy`. Sans ça, la phase 2 chercherait encore à deviner.
//
// Ce banc vérifie AUSSI l'invariant qui rend l'instrumentation acceptable en
// permanence : elle n'influence rien (aucun verdict ne change), elle ne casse
// jamais rien (disque absent → silence), et elle ne bavarde pas (une ligne par
// changement de verdict, pas une par recompute).
//
// Bouchons : `vscode` (aucune fenêtre), `http`/`https` (aucun octet),
// `child_process` (aucun process). HOME = bac à sable.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-ack-journal-'));
os.homedir = () => SANDBOX;                       // AVANT tout require du module
fs.mkdirSync(path.join(SANDBOX, '.claude'), { recursive: true });

// ── Bouchon vscode : onglets + focus pilotables (même forme que test-ack.js) ─
let ACTIVE_TAB = null;
let OPEN_TABS = [];
let FOCUSED = true;
const listeners = { tabs: [], groups: [], window: [] };
const emit = (k, e) => listeners[k].slice().forEach((cb) => cb(e || {}));
const sub = (k) => (cb) => { listeners[k].push(cb); return { dispose() {} }; };

const WORKSPACE_STORE = new Map();
const GLOBAL_STORE = new Map();
let provider = null;
const pushed = [];

const vscodeStub = {
  window: {
    get state() { return { focused: FOCUSED }; },
    onDidChangeWindowState: sub('window'),
    tabGroups: {
      get all() { return [{ viewColumn: 1, isActive: true, tabs: OPEN_TABS }]; },
      get activeTabGroup() { return { viewColumn: 1, isActive: true, tabs: OPEN_TABS, activeTab: ACTIVE_TAB }; },
      onDidChangeTabs: sub('tabs'),
      onDidChangeTabGroups: sub('groups'),
    },
    registerWebviewViewProvider: (_t, p) => { provider = p; return { dispose() {} }; },
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
  env: { openExternal: async () => {}, clipboard: { writeText: async () => {} } },
  Uri: { parse: (s) => s },
  l10n: { t: (m, ...a) => (a.length ? m.replace(/\{(\d+)\}/g, (_, i) => (a[i] !== undefined ? a[i] : '')) : m) },
};
const netStub = { get: () => { throw new Error('network disabled in test'); } };
const procStub = {
  spawn: () => { throw new Error('spawn disabled in test'); },
  execSync: () => { throw new Error('execSync disabled in test'); },
  execFile: () => { throw new Error('execFile disabled in test'); },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'vscode') return vscodeStub;
  if (req === 'http' || req === 'https') return netStub;
  if (req === 'child_process') return procStub;
  return origLoad.call(this, req, ...rest);
};

const journal = require(path.join(__dirname, '..', 'ack-journal.js'));
const { createAckTracker } = require(path.join(__dirname, '..', 'ack.js'));
const { updateSession } = require(path.join(__dirname, '..', 'hooks', 'sessions-state.js'));
const state = require(path.join(__dirname, '..', 'state.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const claudeTab = (label) => ({ label, input: { viewType: 'mainThreadWebview-claudeVSCodePanel' } });
const fileTab = (label) => ({ label, input: { viewType: 'default' } });

const DEFAULT_JOURNAL = path.join(SANDBOX, '.claude', 'quotabar-ack-journal.jsonl');
const lines = (file) => journal.readJournal(file || DEFAULT_JOURNAL);
const eventsOf = (name, file) => lines(file).filter((l) => l.event === name);
function resetJournal() { try { fs.rmSync(DEFAULT_JOURNAL, { force: true }); } catch {} }

// ── 1. Le fichier : format, emplacement, robustesse ───────────────────────
console.log('\n1. Fichier journal : JSONL append, heure locale, jamais fatal');
{
  resetJournal();
  check('chemin par défaut = ~/.claude/quotabar-ack-journal.jsonl',
    journal.journalPath() === DEFAULT_JOURNAL, journal.journalPath());

  journal.logEvent('essai', { sessionId: 'abc', verdict: 'wait' });
  journal.logEvent('essai2', { n: 2 });
  const l = lines();
  check('une ligne JSON par événement, dans l\'ordre',
    l.length === 2 && l[0].event === 'essai' && l[1].event === 'essai2', JSON.stringify(l));
  check('chaque ligne porte ts, at, pid — et ses champs métier',
    typeof l[0].ts === 'number' && typeof l[0].at === 'string'
    && l[0].pid === process.pid && l[0].sessionId === 'abc' && l[0].verdict === 'wait',
    JSON.stringify(l[0]));
  check('`at` est l\'heure LOCALE, relisible sans perte (même instant que ts)',
    new Date(l[0].at).getTime() === l[0].ts, `${l[0].at} vs ${l[0].ts}`);
  check('… et porte bien un décalage de fuseau explicite (jamais un Z brut)',
    /[+-]\d{2}:\d{2}$/.test(l[0].at), l[0].at);

  // Deux fenêtres VS Code écrivent le même fichier : une ligne abîmée ne doit
  // pas emporter la lecture des autres (cf. note de concurrence du module).
  fs.appendFileSync(DEFAULT_JOURNAL, '{ceci n\'est pas du JSON\n');
  journal.logEvent('apres-corruption', {});
  const after = lines();
  check('ligne illisible ignorée, les suivantes restent lues',
    after.length === 3 && after[2].event === 'apres-corruption', JSON.stringify(after.map((x) => x.event)));

  // Un journal qui casse le panneau serait pire que pas de journal.
  const before = process.env.QUOTABAR_ACK_JOURNAL;
  process.env.QUOTABAR_ACK_JOURNAL = path.join(SANDBOX, 'dossier-absent', 'x', 'j.jsonl');
  let threw = false;
  try { journal.logEvent('impossible', {}); } catch { threw = true; }
  check('écriture impossible (dossier inexistant) → aucune exception remontée', threw === false);
  check('… et la lecture d\'un journal absent rend une liste vide', journal.readJournal().length === 0);

  process.env.QUOTABAR_ACK_JOURNAL = 'off';
  check('QUOTABAR_ACK_JOURNAL=off → journal désactivé (aucun chemin)', journal.journalPath() === null);
  journal.logEvent('ne-doit-pas-etre-ecrit', {});
  process.env.QUOTABAR_ACK_JOURNAL = before === undefined ? '' : before;
  if (before === undefined) delete process.env.QUOTABAR_ACK_JOURNAL;
  check('… et rien n\'a été ajouté au fichier réel', lines().length === 3, String(lines().length));
}

// ── 2. Rotation : le journal ne grossit pas sans fin, sans perdre l'incident ─
console.log('\n2. Rotation au-delà de 1 Mo : la génération précédente est gardée');
{
  resetJournal();
  try { fs.rmSync(DEFAULT_JOURNAL + '.1', { force: true }); } catch {}
  fs.writeFileSync(DEFAULT_JOURNAL, JSON.stringify({ ts: 1, at: 'x', pid: 0, event: 'vieux' }) + '\n'
    + 'x'.repeat(journal.MAX_BYTES) + '\n');
  journal.logEvent('apres-rotation', {});
  check('le fichier courant repart à zéro (une seule ligne, la neuve)',
    lines().length === 1 && lines()[0].event === 'apres-rotation', JSON.stringify(lines()));
  check('… et le mégaoctet précédent est conservé en .1 (la preuve n\'est pas perdue)',
    fs.existsSync(DEFAULT_JOURNAL + '.1')
    && journal.readJournal(DEFAULT_JOURNAL + '.1')[0].event === 'vieux');
  try { fs.rmSync(DEFAULT_JOURNAL + '.1', { force: true }); } catch {}
}

// ── 3. Anti-bavardage : une ligne par CHANGEMENT de verdict ───────────────
console.log('\n3. Filtre de verdicts : le journal reste lisible sans rien perdre');
{
  const f = journal.createVerdictFilter();
  check('premier verdict d\'une clé → écrit, 0 répétition tue',
    JSON.stringify(f.take('s1', 'wait')) === JSON.stringify({ repeatsSkipped: 0 }));
  check('même verdict répété → rien à écrire', f.take('s1', 'wait') === null && f.take('s1', 'wait') === null);
  check('verdict qui change → écrit, en disant combien de répétitions ont été tues',
    JSON.stringify(f.take('s1', 'post')) === JSON.stringify({ repeatsSkipped: 2 }));
  check('deux conversations ne se masquent pas l\'une l\'autre',
    JSON.stringify(f.take('s2', 'wait')) === JSON.stringify({ repeatsSkipped: 0 }));
  f.forget('s1');
  check('après forget (ack posé, conv partie) → la prochaine ligne est réécrite',
    JSON.stringify(f.take('s1', 'post')) === JSON.stringify({ repeatsSkipped: 0 }));
}

// ── 4. Le tracker instrumenté : vie du séjour + marque programmatique ─────
// C'est la moitié du chemin d'ack que le journal doit rendre lisible : QUEL
// séjour existait, né de quoi, et si la marque du lanceur l'a couvert.
console.log('\n4. ack.js : naissance/re-titrage/mort d\'un séjour et cycle de la marque');
async function trackerTests() {
  resetJournal();
  ACTIVE_TAB = null; FOCUSED = true;
  const tracker = createAckTracker({ dwellMs: 60, onDwell: () => {} });

  ACTIVE_TAB = claudeTab('Tâche du batch'); emit('tabs');
  const start = eventsOf('stay-start');
  check('arrivée sur un onglet Claude → ligne stay-start (label, identité, focus)',
    start.length === 1 && start[0].label === 'Tâche du batch' && start[0].focused === true
    && start[0].programmatic === false, JSON.stringify(start));

  await sleep(120);
  const fired = eventsOf('dwell-fired');
  check('seuil atteint → ligne dwell-fired avec la durée réelle du séjour',
    fired.length === 1 && fired[0].stayMs >= 60 && fired[0].dwellMs === 60, JSON.stringify(fired));

  // Le `rename_tab` de fin de tour de l'extension officielle : MÊME onglet.
  ACTIVE_TAB.label = 'Tâche du batch (fini)'; emit('tabs');
  const ren = eventsOf('stay-rename');
  check('re-titrage de l\'onglet actif → ligne stay-rename (from/to), sans nouveau séjour',
    ren.length === 1 && ren[0].from === 'Tâche du batch' && ren[0].to === 'Tâche du batch (fini)'
    && eventsOf('stay-start').length === 1, JSON.stringify(ren));

  // Un rappel qui ne change RIEN ne doit pas produire de ligne : un journal
  // noyé dans le bruit est un journal qu'on ne lira pas le jour de l'incident.
  const before = lines().length;
  emit('tabs'); emit('window'); emit('groups');
  check('événements sans changement → aucune ligne ajoutée', lines().length === before, String(lines().length - before));

  // Ouverture programmatique (moteur de vagues) : marque posée puis consommée.
  tracker.markProgrammaticOpen();
  ACTIVE_TAB = claudeTab('Tâche suivante du batch'); emit('tabs');
  const consumed = eventsOf('mark-consume');
  const start2 = eventsOf('stay-start');
  check('markProgrammaticOpen() → ligne mark-set',
    eventsOf('mark-set').length === 1 && eventsOf('mark-set')[0].replacedPendingAgeMs === null);
  check('marque consommée fraîche → mark-consume { fresh: true } + son âge',
    consumed.length === 1 && consumed[0].fresh === true && typeof consumed[0].ageMs === 'number',
    JSON.stringify(consumed));
  check('le séjour né de cette ouverture est marqué programmatique, et dit d\'où il vient',
    start2.length === 2 && start2[1].programmatic === true
    && start2[1].previousLabel === 'Tâche du batch (fini)', JSON.stringify(start2[1]));

  // PISTE N°1 DU PLAN (non prouvée) : la marque de 15 s expire avant que
  // l'onglet n'apparaisse → le séjour naît SANS protection. Le journal doit
  // rendre ce cas visible en tant que tel, pas le confondre avec un vrai clic.
  const { PROGRAMMATIC_MARK_TTL_MS } = require(path.join(__dirname, '..', 'ack.js'));
  const realNow = Date.now;
  tracker.markProgrammaticOpen();
  Date.now = () => realNow() + PROGRAMMATIC_MARK_TTL_MS + 1000;
  ACTIVE_TAB = claudeTab('Tâche ouverte trop tard'); emit('tabs');
  Date.now = realNow;
  const stale = eventsOf('mark-consume').filter((l) => l.fresh === false);
  check('marque PÉRIMÉE (TTL dépassé) → mark-consume { fresh: false } + ttlMs, séjour non protégé',
    stale.length === 1 && stale[0].ageMs > stale[0].ttlMs
    && eventsOf('stay-start').slice(-1)[0].programmatic === false, JSON.stringify(stale));

  // Fin de séjour : bascule vers un onglet non-Claude.
  ACTIVE_TAB = fileTab('README.md'); emit('tabs');
  const end = eventsOf('stay-end');
  check('sortie de l\'onglet Claude → ligne stay-end avec la durée du séjour',
    end.length === 1 && end[0].label === 'Tâche ouverte trop tard' && typeof end[0].stayMs === 'number',
    JSON.stringify(end));

  // Photo pour l'appelant : lecture seule, jamais un effet de bord.
  ACTIVE_TAB = claudeTab('Encore une'); emit('tabs');
  const ctxA = tracker.journalContext();
  const ctxB = tracker.journalContext();
  check('journalContext() décrit le séjour en cours (label, début, focus, marque)',
    ctxA.stayLabel === 'Encore une' && typeof ctxA.staySince === 'number'
    && ctxA.focused === true && ctxA.programmatic === false && ctxA.pendingMarkTtlLeftMs === null,
    JSON.stringify(ctxA));
  check('… et ne consomme rien : deux appels de suite décrivent le même séjour',
    ctxA.staySince === ctxB.staySince && tracker.dwellSince() === ctxA.staySince);

  tracker.markProgrammaticOpen();
  const ctxC = tracker.journalContext();
  check('… marque en vol → son âge et le TTL restant sont lisibles par l\'appelant',
    ctxC.pendingMarkAgeMs >= 0 && ctxC.pendingMarkTtlLeftMs > 0
    && ctxC.pendingMarkTtlLeftMs <= PROGRAMMATIC_MARK_TTL_MS, JSON.stringify(ctxC));

  tracker.dispose();
  ACTIVE_TAB = null;
}

// ── 5. Bout-en-bout sur le VRAI activate() ───────────────────────────────
// Depuis le 2026-08-06, ce banc ne prouve plus que le journal TRACE la décision
// d'ack — il prouve qu'il n'y a plus de décision du tout : le dwell tourne (le
// tracker observe, `dwell-fired` le montre) et n'acquitte RIEN. C'est le garde-
// fou de la décision user après 8 signalements : si un jour un chemin
// automatique revient, la première assertion ci-dessous tombe.
console.log('\n5. Bout-en-bout : le dwell observe, seul le CLIC acquitte');
async function e2eTests() {
  resetJournal();
  const WS = 'C:\\Users\\Test\\Projets VSCODE\\Demo';
  const dir = state.projectDirFor(WS);
  fs.mkdirSync(dir, { recursive: true });
  const line = (o) => JSON.stringify(o) + '\n';
  function transcript(id, title) {
    const file = path.join(dir, id + '.jsonl');
    fs.writeFileSync(file, line({ type: 'user', message: { content: 'go' } })
      + line({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000 } } })
      + line({ type: 'ai-title', aiTitle: title }));
    return file;
  }
  const fileLu = transcript('lu', 'Conversation regardee longuement');
  transcript('garde', 'Conversation cliquee dans le panneau');

  updateSession('lu', { state: 'done', transcript: fileLu });

  OPEN_TABS = [claudeTab('Conversation regardee lo…'), claudeTab('Conversation cliquee dan…')];
  ACTIVE_TAB = null;
  FOCUSED = true;

  const ext = require(path.join(__dirname, '..', 'extension.js'));
  const context = {
    subscriptions: [],
    workspaceState: { get: (k, d) => (WORKSPACE_STORE.has(k) ? WORKSPACE_STORE.get(k) : d), update: (k, v) => { WORKSPACE_STORE.set(k, v); return Promise.resolve(); } },
    globalState: { get: (k, d) => (GLOBAL_STORE.has(k) ? GLOBAL_STORE.get(k) : d), update: (k, v) => { GLOBAL_STORE.set(k, v); return Promise.resolve(); } },
    extension: { packageJSON: { version: '0.0.0-test' } },
  };
  ext.activate(context);
  let receiveMessage = () => {};
  provider.resolveWebviewView({
    webview: {
      options: {}, cspSource: 'vscode-resource:', html: '',
      postMessage: (m) => { pushed.push(m); },
      onDidReceiveMessage: (cb) => { receiveMessage = cb; return { dispose() {} }; },
    },
    onDidDispose: () => ({ dispose() {} }),
  });

  const win = eventsOf('window-start');
  check('activation → ligne window-start (workspace + version), pour rattacher les lignes à leur fenêtre',
    win.length === 1 && win[0].workspace === WS && win[0].version === '0.0.0-test', JSON.stringify(win));

  const readState = () => JSON.parse(fs.readFileSync(path.join(SANDBOX, '.claude', 'sessions-state.json'), 'utf8'));
  const listed = () => {
    const last = [...pushed].reverse().find((m) => m && m.type === 'state');
    return last && (last.state.conversations || []).some((c) => c.id === 'lu');
  };
  // La présence dans la VUE va et vient au gré des recomputes du démarrage (la
  // tolérance de resolveTabOpen fait entrer/sortir une conv le temps que les
  // onglets se stabilisent) : on ATTEND l'instant où elle y est, on ne le
  // suppose pas — sinon ce banc échoue une fois sur deux sans rien prouver.
  // Le tout premier push peut légitimement ne pas la contenir (stabilisation du
  // démarrage, cf. warmup.js) ; sans nouvel événement, aucun push ne suit et le
  // banc échouait une fois sur deux. On pousse donc une VRAIE écriture de
  // transcript — ce que ferait la conversation elle-même — pour provoquer un
  // recompute, au lieu d'attendre un événement qui ne viendra pas.
  const waitListed = async () => {
    for (let i = 0; i < 80 && !listed(); i++) {
      if (i && i % 10 === 0) {
        fs.appendFileSync(fileLu, line({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000 + i } } }));
      }
      await sleep(50);
    }
    return listed();
  };
  check('la conversation terminée entre bien dans la vue du panneau', await waitListed());

  // On s'installe sur l'onglet BIEN au-delà du seuil du produit (2 s).
  ACTIVE_TAB = OPEN_TABS[0]; emit('tabs');
  for (let i = 0; i < 60 && !eventsOf('dwell-fired').length; i++) await sleep(100);
  check('le dwell du produit a bien tiré (le tracker observe toujours)',
    eventsOf('dwell-fired').length >= 1, JSON.stringify(eventsOf('dwell-fired')));
  await sleep(1500);                       // large marge après le dwell

  check('L\'INVARIANT : séjour prolongé sur l\'onglet → AUCUN ack posé',
    !readState().sessions.lu.ack_ts, JSON.stringify(readState().sessions.lu));
  check('… et aucune ligne ack-post dans le journal (plus personne n\'acquitte tout seul)',
    eventsOf('ack-post').length === 0, JSON.stringify(eventsOf('ack-post')));

  // CLIC EXPLICITE : la seule porte de sortie, via le message `focusConv` du
  // webview. Il laisse une ligne `ack-click` — donc tout ✓ éteint est traçable
  // jusqu'à un acte de l'utilisateur, et rien d'autre.
  await waitListed();                      // la vue doit la contenir pour que le clic ait une cible
  receiveMessage({ type: 'focusConv', id: 'lu', title: 'Conversation regardee longuement' });
  for (let i = 0; i < 30; i++) {
    if (readState().sessions.lu.ack_ts) break;
    await sleep(50);
  }
  check('clic sur la ligne → ack posé', !!readState().sessions.lu.ack_ts, JSON.stringify(readState().sessions.lu));
  const click = eventsOf('ack-click');
  check('… avec sa ligne ack-click et le contexte du séjour',
    click.length === 1 && click[0].sessionId === 'lu'
    && typeof click[0].convSince === 'number' && 'stayLabel' in click[0], JSON.stringify(click));
  check('… et toujours aucun ack-post', eventsOf('ack-post').length === 0,
    JSON.stringify(eventsOf('ack-post')));

  for (const s of context.subscriptions) { try { s.dispose(); } catch {} }
  ext.deactivate();
}

(async () => {
  await trackerTests();
  await e2eTests();
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
