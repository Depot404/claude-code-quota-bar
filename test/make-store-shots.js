// Marketplace screenshot generator — renders the REAL panel (panel.js) in an
// offscreen Chromium with entirely FICTIONAL, English data, and saves the
// PNGs the store listing (README.md) embeds.
//
// Not a test. Run it whenever the panel's look or features change enough that
// the listing lies by omission:
//
//   node test/make-store-shots.js            → writes into images/
//   node test/make-store-shots.js <outDir>   → writes elsewhere (review pass)
//
// Ground rules (they are the point of this file, keep them):
//   - Every title, prompt, group name and number below is INVENTED. Nothing
//     from a real workspace, transcript or screen may enter this file.
//   - English only — the listing is English.
//   - Same rendering pipeline as test-panel-render.js: the html the provider
//     hands VS Code, loaded in Brave Octopus offscreen (port 9223), VS Code
//     theme variables injected by hand (no VS Code host here to provide them).
//     If a Brave already listens on 9223 it is REUSED via a new tab (closed on
//     exit); otherwise an ephemeral instance is spawned and killed.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');
const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));

const stub = {
  window: {}, Uri: { parse: (s) => s },
  l10n: { bundle: {}, t: (message, ...args) => (args.length ? message.replace(/\{(\d+)\}/g, (_, i) => (args[i] !== undefined ? args[i] : '')) : message) },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'vscode') return stub;
  return origLoad.call(this, req, ...rest);
};
const { ClaudePanelProvider } = require(path.join(__dirname, '..', 'panel.js'));

const BRAVE_CANDIDATES = [
  process.env.BRAVE_EXE,
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
].filter(Boolean);
const USER_DATA_DIR = 'C:\\OctopusData\\BraveOctopus';
const PORT = 9223;
const OUT_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'images');

// Panel width in CSS px (a typical secondary-sidebar width), captured at 2×.
const WIDTH = 400;
const SCALE = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url, timeout = 2000) {
  return new Promise((res, rej) => {
    const r = http.get(url, { timeout }, (x) => {
      let b = ''; x.on('data', (c) => b += c);
      x.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    });
    r.on('error', rej);
    r.on('timeout', () => { r.destroy(); rej(new Error('timeout')); });
  });
}
function httpPut(url, timeout = 2000) {
  return new Promise((res, rej) => {
    const r = http.request(url, { method: 'PUT', timeout }, (x) => {
      let b = ''; x.on('data', (c) => b += c);
      x.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res(b); } });
    });
    r.on('error', rej);
    r.on('timeout', () => { r.destroy(); rej(new Error('timeout')); });
    r.end();
  });
}

// ── VS Code Dark Modern variables ──────────────────────────────────────────
// panel.js styles itself exclusively through --vscode-* variables that only a
// real VS Code host injects. These are the Dark Modern defaults for every
// variable the stylesheet references (grep 'var(--vscode-' panel.js).
const THEME_DARK = {
  '--vscode-font-family': "'Segoe WPC','Segoe UI',sans-serif",
  '--vscode-font-size': '13px',
  '--vscode-editor-font-family': "'Cascadia Mono',Consolas,'Courier New',monospace",
  '--vscode-foreground': '#cccccc',
  '--vscode-descriptionForeground': '#9d9d9d',
  '--vscode-errorForeground': '#f14c4c',
  '--vscode-focusBorder': '#0078d4',
  '--vscode-sideBar-background': '#181818',
  '--vscode-editor-background': '#1f1f1f',
  '--vscode-panel-border': '#2b2b2b',
  '--vscode-textLink-foreground': '#4daafc',
  '--vscode-textLink-activeForeground': '#4daafc',
  '--vscode-button-background': '#0078d4',
  '--vscode-button-foreground': '#ffffff',
  '--vscode-button-hoverBackground': '#026ec1',
  '--vscode-button-secondaryBackground': '#313131',
  '--vscode-button-secondaryForeground': '#cccccc',
  '--vscode-input-background': '#313131',
  '--vscode-input-foreground': '#cccccc',
  '--vscode-input-border': '#3c3c3c',
  '--vscode-dropdown-background': '#313131',
  '--vscode-dropdown-foreground': '#cccccc',
  '--vscode-dropdown-border': '#3c3c3c',
  '--vscode-badge-background': '#616161',
  '--vscode-badge-foreground': '#f8f8f8',
  '--vscode-progressBar-background': '#0078d4',
  '--vscode-charts-green': '#89d185',
  '--vscode-charts-yellow': '#cca700',
  '--vscode-charts-red': '#f14c4c',
  '--vscode-charts-purple': '#b180d7',
  '--vscode-charts-orange': '#ff9800',
  '--vscode-charts-blue': '#03a9f4',
  '--vscode-list-inactiveSelectionBackground': '#37373d',
  '--vscode-list-hoverBackground': '#2a2d2e',
};

// ── Fictional data ─────────────────────────────────────────────────────────
// Quota windows arrive pre-resolved (pace/elapsedPct are computed by
// extension.js in the real flow) — hand-written here, same as the DEMO set.
const QUOTA = {
  windows: [
    { label: '5h window', pct: 34, resetsAt: null, resetLabel: '19:00', windowMs: 5 * 3600e3, pace: 'green', elapsedPct: 52 },
    { label: '7d window', pct: 61, resetsAt: null, resetLabel: 'Wed 13:00', windowMs: 7 * 86400e3, pace: 'yellow', elapsedPct: 63 },
    { label: 'Fable (7d)', pct: 74, resetsAt: null, resetLabel: 'Wed 13:00', windowMs: 7 * 86400e3, pace: 'red', elapsedPct: 41 },
  ],
  burnRate: { greenMax: 0.85, yellowMax: 1.0 },
  ageMin: 2,
  source: 'cookie',
};

const BATCH = {
  envConflict: [], busy: false, notice: null, noticeHint: null,
  inherit: { model: 'sonnet', effort: 'medium' },
  lastModel: null, lastEffort: null,
  tipDismissed: true,
};

const UI = { collapsedConversations: false, collapsedQuota: false, sortOrder: 'tabOrder' };

// Flat conversations — one of each state the panel can show.
const FLAT_CONVS = [
  { id: 'c1', title: 'Refactor auth middleware for session rotation', model: 'Opus 4.8', effort: 'high', ctx: { pct: 41, tokens: 410000, denom: 1000000 }, state: 'busy', acked: true, active: true, tabOpen: true },
  { id: 'c2', title: 'Add pagination to the orders API', model: 'Sonnet 5', effort: 'medium', ctx: { pct: 63, tokens: 126000, denom: 200000 }, state: 'waiting', acked: true, active: false, tabOpen: true },
  { id: 'c3', title: 'Fix flaky checkout integration test', model: 'Sonnet 5', effort: 'medium', ctx: { pct: 22, tokens: 44000, denom: 200000 }, state: 'done', acked: false, active: false, tabOpen: true },
  { id: 'c4', title: 'Write onboarding docs for the CLI', model: 'Haiku 4.5', effort: null, ctx: { pct: 8, tokens: 16000, denom: 200000 }, state: 'done', acked: true, active: false, tabOpen: true },
  { id: 'c5', title: 'Investigate memory leak in worker pool', model: 'Opus 4.8', effort: 'high', ctx: { pct: 77, tokens: 770000, denom: 1000000 }, state: 'interrupted', acked: true, active: false, tabOpen: true },
];

// The group a pasted claude-convs block creates: master capsule on top, wave 1
// running, wave 2 queued.
const GROUP_CONVS = [
  { id: 'm0', title: 'Plan the payment refactor', model: 'Opus 4.8', effort: 'high', ctx: { pct: 52, tokens: 520000, denom: 1000000 }, state: 'done', acked: true, active: false, tabOpen: true },
  { id: 'g1a', title: 'Extract the billing client into packages/billing', model: 'Sonnet 5', effort: 'medium', ctx: { pct: 34, tokens: 68000, denom: 200000 }, state: 'busy', acked: true, active: false, tabOpen: true, groupId: 'g1' },
  { id: 'g1b', title: 'Add a PDF export button to the invoice page', model: 'Haiku 4.5', effort: null, ctx: { pct: 12, tokens: 24000, denom: 200000 }, state: 'done', acked: false, active: false, tabOpen: true, groupId: 'g1' },
];

const GROUPS = [{
  id: 'g1',
  name: 'Payment refactor',
  hue: 262,
  collapsed: false,
  launchedWave: 1,
  nextWave: 2,
  waveNotice: null,
  master: { convId: 'm0', title: 'Plan the payment refactor', tabTitle: null, listed: true, status: 'done', hint: '' },
  members: [
    { key: 'w1a', prompt: 'Extract the billing client into packages/billing', wave: 1, asked: { model: 'sonnet', effort: 'medium' }, convId: 'g1a', status: 'busy', waveStatus: 'launched', canLink: false, canClose: false, canRelaunch: false, note: '', hint: '' },
    { key: 'w1b', prompt: 'Add a PDF export button to the invoice page', wave: 1, asked: { model: 'haiku', effort: null }, convId: 'g1b', status: 'done', waveStatus: 'done', canLink: false, canClose: true, canRelaunch: false, note: '', hint: '' },
    { key: 'w2a', prompt: 'Wire the new billing client into checkout', wave: 2, asked: { model: 'opus', effort: 'high' }, convId: null, status: 'queued', waveStatus: 'queued', canLink: false, canClose: false, canRelaunch: false, note: '', hint: 'Queued — opens when this wave starts.' },
  ],
}];

// The block pasted into the "New conversation" form (scene 2) — the format the
// /handoffs skill emits. 3 prompts, 2 waves, per-task model and effort.
const CONVS_BLOCK = [
  '```claude-convs',
  'group: Payment refactor',
  'model: sonnet',
  'effort: medium',
  'stage: 1',
  'Extract the billing client into packages/billing. Keep the public API identical.',
  '[---]',
  'model: haiku',
  'stage: 1',
  'Add a PDF export button to the invoice page. Reuse the existing report renderer.',
  '[---]',
  'model: opus',
  'effort: high',
  'stage: 2',
  'Wire the new billing client into checkout behind a feature flag.',
  '```',
].join('\n');

function state(overrides) {
  return Object.assign({
    conversations: [], groups: [], quota: QUOTA, sounds: { enabled: false },
    ui: UI, canary: false, batch: BATCH,
  }, overrides);
}

const SCENES = [
  {
    file: 'screenshot.png',
    // Hero: group + every conversation state + quota, the whole panel.
    state: state({ conversations: [...GROUP_CONVS, ...FLAT_CONVS], groups: GROUPS }),
    clip: 'body',
  },
  {
    file: 'screenshot-new-conversation.png',
    // The "New conversation" form after pasting a claude-convs block: tasks
    // prefilled, waves, per-task model/effort, group name.
    state: state({}),
    paste: CONVS_BLOCK,
    clip: '#batch',
  },
  {
    file: 'screenshot-group.png',
    // Group zoom: master capsule, wave running, wave queued, counters.
    // Only grouped conversations in this scene: #flow holds the group block
    // alone, so clipping it frames exactly the capsule (since 2026-08-07 the
    // panel renders groups and flat rows as siblings in a single container).
    state: state({ conversations: GROUP_CONVS, groups: GROUPS }),
    clip: '#flow',
  },
  {
    file: 'screenshot-quota.png',
    // Quota zoom: pace colours + the ▲ "where you should be" marker.
    state: state({}),
    clip: 'quota-section',
  },
];

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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception && r.exceptionDetails.exception.description);
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

async function run() {
  // 1. The exact html the provider hands VS Code.
  let html = null;
  const provider = new ClaudePanelProvider({}, {});
  provider.resolveWebviewView({
    webview: {
      options: {}, cspSource: 'vscode-resource:',
      set html(v) { html = v; }, get html() { return html; },
      postMessage: () => {},
      onDidReceiveMessage: () => ({ dispose() {} }),
    },
    onDidDispose: () => ({ dispose() {} }),
  });
  if (!html) throw new Error('provider produced no html');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-shots-'));
  const file = path.join(dir, 'panel.html');
  fs.writeFileSync(file, html, 'utf8');
  const fileUrl = 'file:///' + file.replace(/\\/g, '/');

  // 2. Brave: reuse a live 9223 (new tab, closed on exit), else spawn ephemeral.
  let child = null;
  let alive = null;
  try { alive = await getJson(`http://127.0.0.1:${PORT}/json/version`, 800); } catch {}
  if (!alive) {
    const exe = BRAVE_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
    if (!exe) throw new Error('brave.exe not found');
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try { fs.unlinkSync(path.join(USER_DATA_DIR, f)); } catch {}
    }
    child = spawn(exe, [
      `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`, '--profile-directory=Default',
      '--no-first-run', '--no-default-browser-check', '--disable-default-apps',
      '--window-position=-32000,-32000', '--window-size=440,1200', 'about:blank',
    ], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    let ver = null;
    for (let i = 0; i < 40 && !ver; i++) { try { ver = await getJson(`http://127.0.0.1:${PORT}/json/version`); } catch { await sleep(250); } }
    if (!ver) throw new Error('Brave did not come up on ' + PORT);
  }

  let cdp = null;
  let tabId = null;
  try {
    let page;
    if (child) {
      const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
      page = targets.find((t) => t.type === 'page');
    } else {
      page = await httpPut(`http://127.0.0.1:${PORT}/json/new?about:blank`);
      tabId = page.id;
    }
    cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // Offscreen/background pages are "hidden" for Chromium, which freezes CSS
    // animations — make it consider itself visible without showing anything.
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: 1200, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.acquireVsCodeApi = () => ({ postMessage: (m) => { (window.__sent = window.__sent || []).push(m); } });`,
    });
    await cdp.send('Page.navigate', { url: fileUrl });
    await sleep(600);

    // 3. Theme — the variables only a real VS Code host would inject.
    const setVars = Object.entries(THEME_DARK)
      .map(([k, v]) => `document.documentElement.style.setProperty('${k}',${JSON.stringify(v)})`).join(';');
    await cdp.evaluate(`(() => { ${setVars}; document.body.style.margin = '0'; })()`);

    fs.mkdirSync(OUT_DIR, { recursive: true });

    for (const scene of SCENES) {
      await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: scene.state })}, '*')`);
      await sleep(250);

      if (scene.paste) {
        await cdp.evaluate(`(() => {
          const ta = document.querySelector('#batchForm .task-top textarea');
          ta.value = ${JSON.stringify(scene.paste)};
          ta.dispatchEvent(new Event('change'));
        })()`);
        await sleep(250);
      }

      const clip = await cdp.evaluate(`(() => {
        const pad = 8;
        let el;
        if (${JSON.stringify(scene.clip)} === 'body') {
          return { x: 0, y: 0, width: document.body.clientWidth, height: document.body.scrollHeight };
        } else if (${JSON.stringify(scene.clip)} === 'quota-section') {
          el = document.getElementById('quotaHead').parentElement;
        } else {
          el = document.querySelector(${JSON.stringify(scene.clip)});
        }
        const r = el.getBoundingClientRect();
        // Top padding stays tight (2px): the section above would bleed in.
        return { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - 2), width: Math.min(document.body.clientWidth, r.width + 2 * pad), height: r.height + 2 + pad };
      })()`);

      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'png', fromSurface: true, captureBeyondViewport: true,
        clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: SCALE },
      });
      const out = path.join(OUT_DIR, scene.file);
      fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
      console.log(`  wrote ${out}  (${Math.round(clip.width)}x${Math.round(clip.height)} css px @${SCALE}x)`);
    }
  } finally {
    if (cdp) cdp.close();
    if (child) { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore', timeout: 5000 }); } catch {} }
    else if (tabId) { try { await httpPut(`http://127.0.0.1:${PORT}/json/close/${tabId}`); } catch {} }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

run().then(() => console.log('done')).catch((e) => {
  console.error('failed:', e && e.message);
  process.exit(1);
});
