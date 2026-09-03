// ============================================================================
// HARNAIS DE BANC EN BOUCLE FERMÉE (2026-09-02)
//
// POURQUOI CE MODULE — les bancs du panneau s'arrêtaient au message posté par
// le webview (`window.__sent`) : ils prouvaient qu'un clic ÉMET quelque chose,
// jamais ce que le store en fait ni ce qui se réaffiche ensuite. Or les trois
// régressions des 2026-09-01 et 02 vivent très exactement là :
//   • un dépôt de tâches refusé EN SILENCE par groups.js (vague déjà lancée) ;
//   • plus AUCUNE surface à l'écran après un « Create » (le lot qui la portait
//     ne naît plus) ;
//   • un aperçu construit puis attaché nulle part.
// Toutes trois passaient sous des bancs VERTS, et c'est l'user qui les a vues.
//
// CE QUE LE HARNAIS FERME — le cycle complet, sans aucune réimplémentation :
//   1. le VRAI webview (`renderHtml` de panel.js) rendu offscreen dans Brave
//      Octopus, même montage que test-panel-render.js ;
//   2. le message que le webview poste est intercepté (`acquireVsCodeApi`) ;
//   3. il est livré au VRAI routeur de messages (celui que panel.js branche sur
//      les handlers d'extension.js) — donc au vrai store groups.js, en mémoire ;
//   4. le snapshot est reconstruit par extension.js lui-même (`buildPanelState`
//      → groupsState / memberSources / member-truth.js / nesting.js) : le
//      harnais n'en connaît pas une ligne ;
//   5. l'état repart au webview par le chemin normal (`provider.update`) ;
//   6. `settle()` rend la main quand plus rien ne bouge des deux côtés, pour
//      que le banc assertionne sur le DOM FINAL.
//
// RÈGLE TENUE — le harnais ne DEVINE aucun métier. Tout ce qu'il fabrique est
// de l'ENVIRONNEMENT (un bac à sable HOME, un registre de sessions CLI, des
// transcripts, des onglets VS Code, un navigateur) ; toute décision — créer un
// lot ou non, accepter un dépôt, quoi rendre — est prise par le code de
// production. C'est la condition posée par le CLAUDE.md du dossier : « un banc
// qui fabrique ses données avec la fonction testée ne teste rien ».
//
// UTILISATION (cf. test-harness-loop.js) :
//   const H = require('./harness-loop.js');        // ← pose le bac à sable
//   H.writeTranscript(id, { title, assistant });   // ← décor AVANT start()
//   H.setGroups([...]); H.setTabs([...]);
//   const h = await H.start();  if (!h) return;    // Brave absent ⇒ null ⇒ SKIP
//   await h.settle();
//   await h.paste('.task-top textarea.inp', block); await h.settle();
//   await h.click('.btn.pri');                     // Create
//   await h.settle();
//   h.state(); await h.eval('…DOM…');              // assertions
//   await h.dispose();
//
// ⚠️ REQUIS AU CHARGEMENT : ce module patche `os.homedir` et intercepte
// `require('vscode' | 'http' | 'https' | 'child_process')` DÈS SON REQUIRE. Il
// doit donc être le PREMIER require du banc — aucun module de l'extension ne
// doit avoir été chargé avant lui.
// ============================================================================
'use strict';

const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Capturés AVANT l'interception : le harnais, lui, a besoin des vrais (CDP
// parle http, Brave se lance par spawn). Ce sont les modules de l'extension
// qu'on veut priver de réseau et de process, pas nous.
const httpReal = require('http');
const { spawn: spawnReal, execSync: execSyncReal } = require('child_process');

const EXT = path.join(__dirname, '..');
const WebSocket = require(path.join(EXT, 'node_modules', 'ws'));

// ── Bac à sable (HOME) ──────────────────────────────────────────────────────
// Posé avant tout require de l'extension : live-sessions.js et state.js
// résolvent leurs chemins À LA CHARGE du module.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-loop-'));
os.homedir = () => SANDBOX;
const CLAUDE_DIR = path.join(SANDBOX, '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const WORKSPACE_PATH = 'C:\\Users\\Test\\Projets VSCODE\\Demo';

// ── Stubs d'hôte ────────────────────────────────────────────────────────────
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

const OPEN_COMMAND = 'claude-vscode.editor.open';

const tabListeners = [];
let GROUPS = [];
let provider = null;
// Ce que « le CLI » fait quand l'extension demande l'ouverture d'un onglet :
// remplacé par start() une fois le harnais construit (il doit journaliser les
// ouvertures et faire naître la session dans le registre).
let onOpenConversation = () => {};

const claudeTab = (label) => ({ label, input: { viewType: 'mainThreadWebview-claudeVSCodePanel' } });

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
    workspaceFolders: [{ uri: { fsPath: WORKSPACE_PATH } }],
    getConfiguration: () => ({ get: (_k, d) => d }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  commands: {
    registerCommand: () => ({ dispose() {} }),
    // La commande d'ouverture EXISTE : sans elle, launcher.js part sur son
    // repli presse-papier et aucune conversation ne naît (cf. son en-tête).
    getCommands: async () => [OPEN_COMMAND],
    executeCommand: async (cmd, ...args) => {
      if (cmd === OPEN_COMMAND) return onOpenConversation({ prompt: args[1] });
      return undefined;
    },
  },
  env: {
    openExternal: async () => {},
    clipboard: { writeText: async () => {} },
  },
  Uri: { parse: (s) => s },
  l10n: { t: (message, ...args) => (args.length ? message.replace(/\{(\d+)\}/g, (_, i) => (args[i] !== undefined ? args[i] : '')) : message) },
};

const netStub = { get: () => { throw new Error('network disabled in harness'); } };
const procStub = {
  spawn: () => { throw new Error('spawn disabled in harness'); },
  execSync: () => { throw new Error('execSync disabled in harness'); },
};

const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'vscode') return vscodeStub;
  if (req === 'http' || req === 'https') return netStub;
  if (req === 'child_process') return procStub;
  return origLoad.call(this, req, ...rest);
};

// Le dossier de transcripts du workspace, dérivé par le CODE DE PRODUCTION —
// jamais recalculé ici (règle « une valeur qui doit tomber d'accord avec un
// système extérieur », test-project-dir.js).
const { projectDirFor } = require(path.join(EXT, 'state.js'));
const PROJECT_DIR = projectDirFor(WORKSPACE_PATH);
fs.mkdirSync(PROJECT_DIR, { recursive: true });

// ── Décor : à poser AVANT start() ───────────────────────────────────────────

// Transcript d'une conversation. `assistant` est le texte de la réponse du
// modèle : c'est LUI que master.js fouille pour reconnaître un bloc collé,
// donc c'est par là qu'on fabrique une vraie conversation maîtresse.
function writeTranscript(id, opts = {}) {
  const {
    title = 'Conversation',
    firstUser = 'prompt',
    assistant = null,
    mtimeMs = Date.now(),
  } = opts;
  const lines = [
    { type: 'user', message: { content: [{ type: 'text', text: firstUser }] } },
    {
      type: 'assistant',
      message: {
        model: 'claude-opus-4-8',
        usage: { input_tokens: 1000 },
        content: assistant ? [{ type: 'text', text: assistant }] : [],
      },
    },
    { type: 'ai-title', aiTitle: title },
  ];
  const p = path.join(PROJECT_DIR, `${id}.jsonl`);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
  return p;
}

// Fiches de hooks (~/.claude/sessions-state.json) — `{ id: {state, since} }`.
function writeSessionsState(sessions) {
  const out = {};
  for (const [id, s] of Object.entries(sessions || {})) {
    const since = s.since != null ? s.since : Date.now();
    out[id] = {
      state: s.state || 'done',
      since,
      updated_at: s.updated_at != null ? s.updated_at : since,
      transcript: path.join(PROJECT_DIR, `${id}.jsonl`),
    };
  }
  fs.writeFileSync(path.join(CLAUDE_DIR, 'sessions-state.json'),
    JSON.stringify({ version: 1, sessions: out }));
}

// Registre des CLI vivants : ce que le CLI écrit à l'OUVERTURE d'un onglet,
// avant tout transcript (cf. launcher.js). `pid` = le nôtre, seul pid dont
// live-sessions.js peut prouver qu'il est vivant.
let sessionSeq = 0;
function spawnSession(sessionId, opts = {}) {
  const file = path.join(SESSIONS_DIR, `harness-${++sessionSeq}.json`);
  fs.writeFileSync(file, JSON.stringify({
    sessionId,
    pid: process.pid,
    cwd: opts.cwd || WORKSPACE_PATH,
    startedAt: opts.startedAt != null ? opts.startedAt : Date.now(),
  }));
  return sessionId;
}

// Contenu du store de lots (workspaceState), tel qu'extension.js le relira.
function setGroups(groups) { WORKSPACE_STORE.set('batchGroups', groups || []); }

// Les onglets Claude ouverts dans la fenêtre, par leur libellé.
function setTabs(labels) {
  GROUPS = [{ viewColumn: 1, isActive: true, tabs: (labels || []).map(claudeTab) }];
}
function emitTabs(evt) {
  tabListeners.forEach((cb) => cb(Object.assign({ closed: [], opened: [], changed: [] }, evt)));
}

let uuidSeq = 0;
// Identifiants au format que master.js exige d'un jeton `session:` (UUID).
function uuid() {
  const n = (++uuidSeq).toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${n}`;
}

// ── Brave Octopus, offscreen (même montage que test-panel-render.js) ─────────
const BRAVE_CANDIDATES = [
  process.env.BRAVE_EXE,
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
].filter(Boolean);
const USER_DATA_DIR = 'C:\\OctopusData\\BraveOctopus';
const PORT = 9223;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url, timeout = 2000) {
  return new Promise((res, rej) => {
    const r = httpReal.get(url, { timeout }, (x) => {
      let b = ''; x.on('data', (c) => b += c);
      x.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    });
    r.on('error', rej);
    r.on('timeout', () => { r.destroy(); rej(new Error('timeout')); });
  });
}

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.url, { perMessageDeflate: false });
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('cdp connect timeout')), 5000);
      this.ws.on('open', () => { clearTimeout(t); res(); });
      this.ws.on('error', rej);
    });
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception && r.exceptionDetails.exception.description);
    }
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

// ── Le harnais ──────────────────────────────────────────────────────────────

async function start(opts = {}) {
  const exe = BRAVE_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (!exe) return null;

  const ext = require(path.join(EXT, 'extension.js'));
  const context = { subscriptions: [], workspaceState, globalState };

  const opened = [];
  // Ce que fait « le CLI » à l'ouverture d'un onglet : une session apparaît au
  // registre (avec son horodatage de naissance, la seule preuve d'identité
  // dont dispose launcher.js). Surchargeable par un banc qui veut jouer une
  // ouverture muette (CLI trop ancien, session jamais écrite).
  onOpenConversation = opts.onOpenConversation || (({ prompt }) => {
    const id = uuid();
    opened.push({ prompt, sessionId: id });
    spawnSession(id);
    return undefined;
  });

  ext.activate(context);
  if (!provider) throw new Error('le provider de panneau ne s\'est pas enregistré');

  // Le pont : un webview qui parle CDP. Tout ce qui part de l'extension est
  // relayé À LA PAGE, dans l'ordre, par le chemin normal (postMessage).
  let html = null;
  let onMsg = null;
  let cdp = null;
  const pushed = [];
  const sent = [];
  let relayChain = Promise.resolve();
  let pageReady = null;
  const readyGate = new Promise((res) => { pageReady = res; });

  const relay = (m) => {
    pushed.push(m);
    relayChain = relayChain
      .then(() => readyGate)
      .then(() => cdp.evaluate(`window.postMessage(${JSON.stringify(m)}, '*')`))
      .catch(() => {});
  };

  provider.resolveWebviewView({
    webview: {
      options: {}, cspSource: 'vscode-resource:',
      set html(v) { html = v; }, get html() { return html; },
      postMessage: (m) => { relay(m); return Promise.resolve(true); },
      onDidReceiveMessage: (cb) => { onMsg = cb; return { dispose() {} }; },
    },
    visible: true,
    onDidDispose: () => ({ dispose() {} }),
  });
  if (!html) throw new Error('le provider n\'a pas rendu de document');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-loop-page-'));
  const file = path.join(dir, 'panel.html');
  fs.writeFileSync(file, html, 'utf8');

  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.unlinkSync(path.join(USER_DATA_DIR, f)); } catch {}
  }
  const child = spawnReal(exe, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`, '--profile-directory=Default',
    '--no-first-run', '--no-default-browser-check', '--disable-default-apps',
    '--window-position=-32000,-32000', '--window-size=420,900', 'about:blank',
  ], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();

  const killBrave = () => { try { execSyncReal(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore', timeout: 5000 }); } catch {} };

  let ver = null;
  for (let i = 0; i < 40 && !ver; i++) {
    try { ver = await getJson(`http://127.0.0.1:${PORT}/json/version`); } catch { await sleep(250); }
  }
  if (!ver) { killBrave(); return null; }

  const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = targets.find((t) => t.type === 'page');
  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // Fenêtre hors écran = « hidden » pour Chromium, qui gèle alors animations et
  // rAF : on rend la page visible pour le moteur sans jamais la montrer (même
  // artefact et même parade que test-panel-render.js).
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  // `acquireVsCodeApi` n'existe qu'à l'intérieur de VS Code. C'est notre point
  // d'interception : chaque message posté par le webview atterrit dans __sent,
  // que settle() draine. Le heartbeat de fraîcheur est neutralisé — ses `ready`
  // spontanés rendraient toute mesure de messages non déterministe.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.acquireVsCodeApi = () => ({ postMessage: (m) => { (window.__sent = window.__sent || []).push(m); } });
window.QUOTABAR_STALE_TUNING = { pullAfterMs: 1e9, frozenAfterMs: 1e9 };`,
  });
  await cdp.send('Page.navigate', { url: 'file:///' + file.replace(/\\/g, '/') });
  await sleep(400);
  pageReady();

  const drain = async () => {
    const batch = await cdp.evaluate('JSON.stringify((window.__sent || []).splice(0))');
    return batch ? JSON.parse(batch) : [];
  };
  const deliver = async (m) => {
    if (!onMsg) return;
    try { const r = onMsg(m); if (r && typeof r.then === 'function') await r; } catch {}
  };

  // Le cœur de la boucle. On alterne : livrer ce que le webview a posté au
  // routeur réel, puis laisser l'extension pousser ses états, jusqu'à ce que
  // plus rien ne bouge des DEUX côtés. Le plafond ne masque rien — il évite
  // seulement qu'un ping-pong involontaire fasse tourner un banc sans fin.
  async function settle({ quietMs = 150, maxMs = 12000 } = {}) {
    const t0 = Date.now();
    for (;;) {
      await relayChain;
      const batch = await drain();
      if (batch.length) {
        for (const m of batch) { sent.push(m); await deliver(m); }
        if (Date.now() - t0 > maxMs) return;
        continue;
      }
      const before = pushed.length;
      await sleep(quietMs);
      await relayChain;
      const again = await drain();
      if (again.length) {
        for (const m of again) { sent.push(m); await deliver(m); }
        if (Date.now() - t0 > maxMs) return;
        continue;
      }
      if (pushed.length === before) { await sleep(60); return; }
      if (Date.now() - t0 > maxMs) return;
    }
  }

  const lastState = () => {
    for (let i = pushed.length - 1; i >= 0; i--) if (pushed[i] && pushed[i].type === 'state') return pushed[i].state;
    return null;
  };

  return {
    // Environnement (le décor reste modifiable en cours de banc).
    sandbox: SANDBOX, projectDir: PROJECT_DIR, workspacePath: WORKSPACE_PATH,
    writeTranscript, writeSessionsState, spawnSession, setGroups, setTabs, emitTabs, uuid,

    // Journaux du cycle.
    pushed,          // extension → webview
    sent,            // webview → extension (dans l'ordre de livraison)
    opened,          // conversations que le lancement a réellement ouvertes
    sentOfType: (type) => sent.filter((m) => m && m.type === type),

    // Boucle et lecture.
    settle,
    state: lastState,
    groups: () => (lastState() || {}).groups || [],
    eval: (expr) => cdp.evaluate(expr),

    // Gestes dans le VRAI DOM.
    click: (sel) => cdp.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(sel)});
      if (!n) throw new Error('sélecteur introuvable : ' + ${JSON.stringify(sel)});
      n.click(); return true; })()`),
    // Saisie puis collage : `input` met à jour le prompt, `paste` déclenche la
    // reconnaissance du bloc claude-convs (panel.js écoute les deux, et lit la
    // valeur du champ — jamais le presse-papier).
    paste: (sel, text) => cdp.evaluate(`(() => { const n = document.querySelector(${JSON.stringify(sel)});
      if (!n) throw new Error('sélecteur introuvable : ' + ${JSON.stringify(sel)});
      n.value = ${JSON.stringify(text)};
      n.dispatchEvent(new Event('input', { bubbles: true }));
      n.dispatchEvent(new Event('paste', { bubbles: true }));
      return true; })()`),

    async dispose() {
      try { cdp.close(); } catch {}
      killBrave();
      for (const s of context.subscriptions) { try { s.dispose(); } catch {} }
      try { ext.deactivate(); } catch {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
    },
  };
}

module.exports = {
  start,
  // Décor, utilisable dès le require (donc AVANT start()).
  writeTranscript, writeSessionsState, spawnSession, setGroups, setTabs, uuid,
  SANDBOX, PROJECT_DIR, WORKSPACE_PATH,
};
