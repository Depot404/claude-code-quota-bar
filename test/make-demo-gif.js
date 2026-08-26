// Marketplace demo animation — renders the REAL panel (panel.js) through the
// same offscreen-Chromium pipeline as make-store-shots.js, but captures a
// SEQUENCE of frames (paste a claude-convs block → waves launch → group
// completes) and assembles each theme into a small looping GIF.
//
// Not a test. Run it whenever the "paste a block, see waves launch" gesture
// changes enough that the listing's animation lies about the panel:
//
//   node test/make-demo-gif.js            → writes images/demo-dark.gif + demo-light.gif
//   node test/make-demo-gif.js <outDir>   → writes elsewhere (review pass)
//
// Ground rules (same as make-store-shots.js, keep them):
//   - Every title, prompt, group name and number below is INVENTED. Nothing
//     from a real workspace, transcript or screen may enter this file.
//   - English only — the listing is English.
//   - GIF encoding uses `pngjs` + `gif-encoder-2`, installed GLOBALLY
//     (`npm install -g pngjs gif-encoder-2`) so this repo's package.json
//     stays untouched — resolved below via the global node_modules root.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');
const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));

const GLOBAL_ROOT = execSync('npm root -g', { encoding: 'utf8' }).trim();
const { PNG } = require(path.join(GLOBAL_ROOT, 'pngjs'));
const GIFEncoder = require(path.join(GLOBAL_ROOT, 'gif-encoder-2'));

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
const OUT_ARG = process.argv.slice(2).find((a) => !a.startsWith('--'));
const OUT_DIR = OUT_ARG ? path.resolve(OUT_ARG) : path.join(__dirname, '..', 'images');

const WIDTH = 400; // CSS px — same secondary-sidebar width as make-store-shots.js
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

// ── Themes ──────────────────────────────────────────────────────────────
// Dark = VS Code "Dark Modern" defaults (copied from make-store-shots.js).
// Light = VS Code "Light Modern" defaults, hand-approximated (this is a
// cosmetic demo asset, not a spec claim) — same variable set panel.js reads.
const FONTS = {
  '--vscode-font-family': "'Segoe WPC','Segoe UI',sans-serif",
  '--vscode-font-size': '13px',
  '--vscode-editor-font-family': "'Cascadia Mono',Consolas,'Courier New',monospace",
};
const THEME_DARK = Object.assign({}, FONTS, {
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
});
const THEME_LIGHT = Object.assign({}, FONTS, {
  '--vscode-foreground': '#3b3b3b',
  '--vscode-descriptionForeground': '#717171',
  '--vscode-errorForeground': '#a1260d',
  '--vscode-focusBorder': '#005fb8',
  '--vscode-sideBar-background': '#f8f8f8',
  '--vscode-editor-background': '#ffffff',
  '--vscode-panel-border': '#e5e5e5',
  '--vscode-textLink-foreground': '#005fb8',
  '--vscode-textLink-activeForeground': '#005fb8',
  '--vscode-button-background': '#005fb8',
  '--vscode-button-foreground': '#ffffff',
  '--vscode-button-hoverBackground': '#0258a8',
  '--vscode-button-secondaryBackground': '#e5e5e5',
  '--vscode-button-secondaryForeground': '#3b3b3b',
  '--vscode-input-background': '#ffffff',
  '--vscode-input-foreground': '#3b3b3b',
  '--vscode-input-border': '#cecece',
  '--vscode-dropdown-background': '#ffffff',
  '--vscode-dropdown-foreground': '#3b3b3b',
  '--vscode-dropdown-border': '#cecece',
  '--vscode-badge-background': '#005fb8',
  '--vscode-badge-foreground': '#ffffff',
  '--vscode-progressBar-background': '#0078d4',
  '--vscode-charts-green': '#388a34',
  '--vscode-charts-yellow': '#c19c00',
  '--vscode-charts-red': '#cc6633',
  '--vscode-charts-purple': '#652d90',
  '--vscode-charts-orange': '#d18616',
  '--vscode-charts-blue': '#4e94ce',
  '--vscode-list-inactiveSelectionBackground': '#e4e6f1',
  '--vscode-list-hoverBackground': '#f0f0f0',
});
const BG = { dark: '#1f1f1f', light: '#ffffff' };

// ── Fictional data (English, invented — see ground rules above) ───────────
const QUOTA = {
  windows: [
    { label: '5h window', pct: 21, cost: 6.1, resetsAt: null, resetLabel: '19:00', windowMs: 5 * 3600e3, pace: 'green', elapsedPct: 30 },
    { label: '7d window', pct: 47, cost: 512, resetsAt: null, resetLabel: 'Wed 13:00', windowMs: 7 * 86400e3, pace: 'green', elapsedPct: 44 },
  ],
  burnRate: { greenMax: 0.85, yellowMax: 1.0 },
  ageMin: 1,
  source: 'cookie',
};
const BATCH = {
  envConflict: [], busy: false, notice: null, noticeHint: null,
  inherit: { model: 'sonnet', effort: 'medium' },
  lastModel: null, lastEffort: null,
};
const UI_OPEN = { collapsedConversations: false, collapsedQuota: false, collapsedNewConversation: false, sortOrder: 'tabOrder' };
// Composer tucked away once waves are running — keeps frame heights close
// enough that the GIF canvas isn't mostly dead background on the early beats.
const UI_COLLAPSED = Object.assign({}, UI_OPEN, { collapsedNewConversation: true });

const cost = (total) => ({
  total,
  input: +(total * 0.06).toFixed(4),
  cacheRead: +(total * 0.4).toFixed(4),
  cacheWrite: +(total * 0.15).toFixed(4),
  output: +(total * 0.39).toFixed(4),
  tools: 0,
  messages: 14,
});

const MASTER = { id: 'm0', title: 'Plan the notifications revamp', model: 'Opus 4.8', effort: 'high', ctx: { pct: 29, tokens: 290000, denom: 1000000 }, cost: cost(0.95), state: 'done', acked: true, active: false, tabOpen: true };
const T1_TITLE = 'Move toast rendering into a shared component';
const T2_TITLE = 'Add a mute-hours setting to the notification panel';
const T3_TITLE = 'Wire the shared component into the mobile webview';
const T1 = (state) => ({ id: 'g1a', title: T1_TITLE, model: 'Sonnet 5', effort: 'medium', ctx: { pct: 18, tokens: 36000, denom: 200000 }, cost: cost(0.31), state, acked: state !== 'done', active: false, tabOpen: true });
const T2 = (state) => ({ id: 'g1b', title: T2_TITLE, model: 'Haiku 4.5', effort: null, ctx: { pct: 9, tokens: 18000, denom: 200000 }, cost: cost(0.07), state, acked: state !== 'done', active: false, tabOpen: true });
const T3 = (state) => ({ id: 'g2a', title: T3_TITLE, model: 'Opus 4.8', effort: 'high', ctx: { pct: 24, tokens: 240000, denom: 1000000 }, cost: cost(0.88), state, acked: state !== 'done', active: false, tabOpen: true });

function member(key, prompt, wave, asked, convId, status) {
  return {
    key, prompt, wave, asked, convId, status,
    waveStatus: status === 'queued' ? 'queued' : (status === 'done' ? 'done' : 'launched'),
    canLink: false, canClose: status === 'done', canRelaunch: false, note: '',
    hint: status === 'queued' ? 'Queued — opens when this wave starts.' : '',
  };
}
function group(launchedWave, nextWave, w1a, w1b, w2a) {
  return [{
    id: 'g1', name: 'Notifications revamp', stamp: '09:41', hue: 262, collapsed: false,
    launchedWave, nextWave, waveNotice: null,
    master: { convId: 'm0', title: MASTER.title, tabTitle: null, listed: true, status: 'done', hint: '' },
    members: [
      member('w1a', T1_TITLE, 1, { model: 'sonnet', effort: 'medium' }, 'g1a', w1a),
      member('w1b', T2_TITLE, 1, { model: 'haiku', effort: null }, 'g1b', w1b),
      member('w2a', T3_TITLE, 2, { model: 'opus', effort: 'high' }, w2a === 'queued' ? null : 'g2a', w2a),
    ],
  }];
}

// The block pasted into the "New conversation" form — the format the
// /handoffs skill emits. Kept to a single wave / 2 tasks here so the
// composer's post-paste height stays close to the other beats (the group
// frames further down carry the full 2-wave story, decoupled from this text).
const CONVS_BLOCK = [
  '```claude-convs',
  'group: Notifications revamp',
  'model: sonnet',
  'effort: medium',
  T1_TITLE + '. Keep the public API identical.',
  '[---]',
  'model: haiku',
  T2_TITLE + '.',
  '```',
].join('\n');

function state(ui, overrides) {
  return Object.assign({
    conversations: [], groups: [], quota: QUOTA, sounds: { enabled: false },
    ui, canary: false, batch: BATCH,
  }, overrides);
}

// Six beats: idle composer → pasted block → wave 1 launches (composer tucks
// away) → wave 1 progresses → wave 2 launches → group complete (held for the
// loop's breath).
const FRAMES = [
  { state: state(UI_OPEN, {}), delayMs: 1100 },
  { state: state(UI_OPEN, {}), paste: CONVS_BLOCK, delayMs: 1700 },
  { reload: true, state: state(UI_COLLAPSED, { conversations: [MASTER, T1('busy'), T2('busy')], groups: group(1, 2, 'busy', 'busy', 'queued') }), delayMs: 1100 },
  { state: state(UI_COLLAPSED, { conversations: [MASTER, T1('done'), T2('busy')], groups: group(1, 2, 'done', 'busy', 'queued') }), delayMs: 1000 },
  { state: state(UI_COLLAPSED, { conversations: [MASTER, T1('done'), T2('done'), T3('busy')], groups: group(2, null, 'done', 'done', 'busy') }), delayMs: 1100 },
  { state: state(UI_COLLAPSED, { conversations: [MASTER, T1('done'), T2('done'), T3('done')], groups: group(2, null, 'done', 'done', 'done') }), delayMs: 2600 },
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

async function captureTheme(cdp, fileUrl, themeName, themeVars) {
  await cdp.send('Page.navigate', { url: fileUrl });
  await sleep(500);
  const setVars = Object.entries(themeVars)
    .map(([k, v]) => `document.documentElement.style.setProperty('${k}',${JSON.stringify(v)})`).join(';');
  await cdp.evaluate(`(() => { ${setVars}; document.body.style.margin = '0'; })()`);

  const pngFrames = [];
  for (const frame of FRAMES) {
    if (frame.reload) {
      await cdp.send('Page.navigate', { url: fileUrl });
      await sleep(500);
      await cdp.evaluate(`(() => { ${setVars}; document.body.style.margin = '0'; })()`);
    }
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: frame.state })}, '*')`);
    await sleep(220);
    if (frame.paste) {
      await cdp.evaluate(`(() => {
        const ta = document.querySelector('#batchForm .task-top textarea');
        ta.value = ${JSON.stringify(frame.paste)};
        ta.dispatchEvent(new Event('change'));
      })()`);
      await sleep(220);
    }

    const clip = await cdp.evaluate(`(() => {
      const pad = 8;
      const el = document.getElementById('convBody');
      const r = el.getBoundingClientRect();
      return { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - 2), width: Math.min(document.body.clientWidth, r.width + 2 * pad), height: r.height + 2 + pad };
    })()`);
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: true,
      clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: SCALE },
    });
    const png = PNG.sync.read(Buffer.from(shot.data, 'base64'));
    pngFrames.push({ width: png.width, height: png.height, data: png.data, delayMs: frame.delayMs });
    console.log(`  [${themeName}] frame ${pngFrames.length}/${FRAMES.length}  ${png.width}x${png.height}`);
  }
  return pngFrames;
}

function bgRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

// The composer's post-paste height (frame 2) runs well past the group
// frames' — capped here so the loop isn't mostly dead background for the
// other five beats; the cut-off just hides the "+ Add task / Create" footer,
// which isn't the point of that beat anyway.
const MAX_CANVAS_H = 600;

function assembleGif(pngFrames, backgroundHex, outFile) {
  const maxW = Math.max(...pngFrames.map((f) => f.width));
  const maxH = Math.min(Math.max(...pngFrames.map((f) => f.height)), MAX_CANVAS_H);
  const [br, bgc, bb] = bgRgb(backgroundHex);

  const encoder = new GIFEncoder(maxW, maxH, 'octree', true, pngFrames.length);
  encoder.start();
  encoder.setRepeat(0);
  encoder.setQuality(10);
  for (const f of pngFrames) {
    const canvas = Buffer.alloc(maxW * maxH * 4);
    for (let i = 0; i < maxW * maxH; i++) {
      canvas[i * 4] = br; canvas[i * 4 + 1] = bgc; canvas[i * 4 + 2] = bb; canvas[i * 4 + 3] = 255;
    }
    const copyH = Math.min(f.height, maxH);
    for (let y = 0; y < copyH; y++) {
      f.data.copy(canvas, (y * maxW) * 4, y * f.width * 4, y * f.width * 4 + f.width * 4);
    }
    encoder.setDelay(f.delayMs);
    encoder.addFrame(canvas);
    // `DEBUG_FRAMES=1` dumps each composited canvas as a PNG next to the GIF —
    // a Read tool only shows a GIF's first frame, so this is how every beat
    // actually got looked at before this file was committed.
    if (process.env.DEBUG_FRAMES) {
      const png = new PNG({ width: maxW, height: maxH });
      canvas.copy(png.data);
      fs.writeFileSync(outFile.replace('.gif', `.frame${pngFrames.indexOf(f)}.png`), PNG.sync.write(png));
    }
  }
  encoder.finish();
  const buf = encoder.out.getData();
  fs.writeFileSync(outFile, buf);
  console.log(`  wrote ${outFile}  (${maxW}x${maxH}, ${pngFrames.length} frames, ${(buf.length / 1024).toFixed(0)} KiB)`);
}

async function run() {
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

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-demo-'));
  const file = path.join(dir, 'panel.html');
  fs.writeFileSync(file, html, 'utf8');
  const fileUrl = 'file:///' + file.replace(/\\/g, '/');

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
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: 1400, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.acquireVsCodeApi = () => ({ postMessage: (m) => { (window.__sent = window.__sent || []).push(m); } });`,
    });

    fs.mkdirSync(OUT_DIR, { recursive: true });

    const darkFrames = await captureTheme(cdp, fileUrl, 'dark', THEME_DARK);
    assembleGif(darkFrames, BG.dark, path.join(OUT_DIR, 'demo-dark.gif'));

    const lightFrames = await captureTheme(cdp, fileUrl, 'light', THEME_LIGHT);
    assembleGif(lightFrames, BG.light, path.join(OUT_DIR, 'demo-light.gif'));
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
