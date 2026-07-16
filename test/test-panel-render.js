// Banc de rendu du panneau (lot 6b/6c) — le seul qui prouve ce que l'ŒIL voit.
//
// POURQUOI UN VRAI MOTEUR DE RENDU — les deux bugs du lot ne sont visibles
// qu'une fois le CSS appliqué : l'arc `busy` était figé par une règle
// @media (prefers-reduced-motion: reduce), et le re-rendu complet du DOM
// relançait l'animation à zéro. Aucun test Node ne peut voir ça.
//
// POURQUOI BRAVE ET PAS UN EXTENSION DEV HOST — le webview VS Code est un
// Chromium, offscreen chez Brave Octopus (port 9223, cf.
// Tools/BrowserAutomation/CLAUDE.md) : même moteur, même session Windows, donc
// même résolution de prefers-reduced-motion (mesuré : reduce = true sur ce
// poste, animations Windows sur OFF). Un Dev Host, lui, volerait le focus et
// exigerait un reload — donc le WIP des autres fenêtres.
//
// Brave est lancé éphémère et tué en sortie. Aucun onglet visible.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');
const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));

const stub = { window: {}, Uri: { parse: (s) => s } };
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

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}
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

// Miroir volontaire de extension.js:windowElapsedPct/burnRatePace/paceColor —
// le banc doit fabriquer des fenêtres avec le MÊME calcul que le code réel
// pour que les assertions de position (§6) vérifient quelque chose de vrai.
const BURN_RATE = { greenMax: 0.85, yellowMax: 1.0 };
function windowElapsedPct(resetsAt, windowMs) {
  if (!resetsAt) return null;
  const remainMs = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(remainMs) || remainMs <= 0 || remainMs >= windowMs) return null;
  return ((windowMs - remainMs) / windowMs) * 100;
}
function burnRatePace(pct, resetsAt, windowMs) {
  const e = windowElapsedPct(resetsAt, windowMs);
  if (e == null || e <= 1) return null;
  return pct / e;
}
function paceColor(pace) {
  if (pace == null) return null;
  if (pace <= BURN_RATE.greenMax) return 'green';
  if (pace <= BURN_RATE.yellowMax) return 'yellow';
  return 'red';
}
function mkWindow(label, pct, resetsAt, windowMs) {
  const elapsedPct = windowElapsedPct(resetsAt, windowMs);
  return {
    label, pct,
    resetsAt: resetsAt || null,
    resetLabel: resetsAt ? new Date(resetsAt).toISOString() : '?',
    windowMs,
    pace: paceColor(burnRatePace(pct, resetsAt, windowMs)),
    elapsedPct: elapsedPct == null ? null : Math.min(100, Math.max(0, elapsedPct)),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;

// Le contrat d'état, tel qu'extension.js le pousse (cf. tête de panel.js).
const STATE = {
  conversations: [
    { id: 'c1', title: 'Conv au travail', model: 'Opus 4.8', ctx: { pct: 34 }, state: 'busy', acked: true, active: true },
    { id: 'c2', title: 'Terminée jamais lue', model: 'Sonnet 5', ctx: { pct: 20 }, state: 'done', acked: false, active: false },
    { id: 'c3', title: 'Terminée déjà lue', model: 'Sonnet 5', ctx: { pct: 12 }, state: 'done', acked: true, active: false },
    { id: 'c4', title: 'Sans état hooks', model: null, ctx: null, state: 'idle', acked: true, active: false },
    { id: 'c5', title: 'Attend une réponse', model: 'Haiku 4.5', ctx: { pct: 8 }, state: 'waiting', acked: true, active: false },
  ],
  quota: {
    windows: [
      // Mi-fenêtre 5h → flèche à 50 %.
      mkWindow('5h window', 23, new Date(Date.now() + FIVE_HOUR_MS / 2).toISOString(), FIVE_HOUR_MS),
      // 24 h après un reset hebdo → flèche à 1/7 ≈ 14,3 %.
      mkWindow('7d window', 61, new Date(Date.now() + WEEK_MS - DAY_MS).toISOString(), WEEK_MS),
      // Barre scopée (ex. Fable) — pas de resetsAt → flèche masquée.
      mkWindow('Fable (7d)', 25, null, WEEK_MS),
      // resetsAt déjà passé → flèche masquée aussi.
      mkWindow('Reset passé', 90, new Date(Date.now() - 1000).toISOString(), WEEK_MS),
    ],
    burnRate: BURN_RATE,
    ageMin: 2, source: 'cookie',
  },
};

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
  // 1. Le HTML EXACT que le provider donne à VS Code.
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
  check('le provider rend bien un document', !!html && html.includes('<!DOCTYPE html>'));
  check('aucune règle prefers-reduced-motion ne subsiste (elle figeait l\'arc)',
    !/prefers-reduced-motion/.test(html.replace(/\/\*[\s\S]*?\*\//g, '')),
    'une @media reduced-motion est de retour hors commentaire');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-render-'));
  const file = path.join(dir, 'panel.html');
  fs.writeFileSync(file, html, 'utf8');

  // 2. Brave Octopus, offscreen, éphémère.
  const exe = BRAVE_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (!exe) { console.log('  SKIP  brave.exe introuvable'); return; }
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.unlinkSync(path.join(USER_DATA_DIR, f)); } catch {}
  }
  const child = spawn(exe, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA_DIR}`, '--profile-directory=Default',
    '--no-first-run', '--no-default-browser-check', '--disable-default-apps',
    '--window-position=-32000,-32000', '--window-size=420,900', 'about:blank',
  ], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();

  let cdp = null;
  try {
    let ver = null;
    for (let i = 0; i < 40 && !ver; i++) { try { ver = await getJson(`http://127.0.0.1:${PORT}/json/version`); } catch { await sleep(250); } }
    if (!ver) { console.log('  SKIP  Brave Octopus n\'a pas démarré'); return; }

    const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
    const page = targets.find((t) => t.type === 'page');
    cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // Artefact du banc, à ne pas confondre avec le bug qu'on teste : une fenêtre
    // posée hors écran (-32000) est « hidden » pour Chromium, qui GÈLE alors les
    // animations — currentTime resterait à 0 même avec un CSS parfait (mesuré :
    // hidden → 0 → 0 ; visible → 217 → 633). Le vrai panneau, lui, est à l'écran.
    // On rend donc la page visible pour le moteur, sans jamais la montrer.
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });

    // acquireVsCodeApi n'existe qu'à l'intérieur de VS Code : le webview
    // l'appelle à la première ligne. Injecté par le debugger, donc sans se faire
    // bloquer par la CSP stricte de la page.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.acquireVsCodeApi = () => ({ postMessage: (m) => { (window.__sent = window.__sent || []).push(m); } });`,
    });
    await cdp.send('Page.navigate', { url: 'file:///' + file.replace(/\\/g, '/') });
    await sleep(600);

    check('prefers-reduced-motion vaut bien « reduce » ici (le cas qui figeait tout)',
      await cdp.evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`) === true);
    // Sans ça, « l'animation ne tourne pas » ne prouverait rien : ce serait le
    // banc qui dort, pas le CSS qui est faux.
    check('la page est bien rendue par le moteur (sinon le test ne prouve rien)',
      await cdp.evaluate(`document.visibilityState`) === 'visible',
      await cdp.evaluate(`document.visibilityState`));

    // 3. L'état arrive comme en vrai : un message postMessage.
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: STATE })}, '*')`);
    await sleep(120);

    console.log('\n1. Rendu des états');
    check('une ligne par conversation', await cdp.evaluate(`document.querySelectorAll('.conv').length`) === 5);
    check('la conv au travail porte l\'arc animé',
      await cdp.evaluate(`document.querySelectorAll('.ico-busy').length`) === 1);
    check('plus AUCUNE pastille grise « idle » dans le panneau',
      await cdp.evaluate(`document.querySelectorAll('.ico-idle').length`) === 0);
    check('la conv sans état hooks affiche un ✓ atténué (et pas du gris)',
      await cdp.evaluate(`(() => { const i = document.querySelectorAll('.conv')[3].querySelector('.ico');
        return i.textContent === '✓' && i.classList.contains('ico-done') && i.classList.contains('read'); })()`) === true);
    console.log('\n1b. Icône « ? » pour waiting (lot 11)');
    const waitIco = await cdp.evaluate(`(() => {
      const i = document.querySelectorAll('.conv')[4].querySelector('.ico');
      const cs = getComputedStyle(i, '::before');
      return { content: cs.content, cls: i.className, anims: i.getAnimations().length };
    })()`);
    check('waiting rendu en « ? » (pas un cercle pointillé/plein)',
      waitIco.content.replace(/"/g, '') === '?' && waitIco.cls.includes('ico-waiting'), JSON.stringify(waitIco));
    check('pas d\'animation sur l\'icône waiting (contrairement au spinner busy)',
      waitIco.anims === 0, JSON.stringify(waitIco));

    console.log('\n2. Les deux teintes du ✓ (6b)');
    const tints = await cdp.evaluate(`(() => {
      const ico = (n) => document.querySelectorAll('.conv')[n].querySelector('.ico');
      const cs = (n) => getComputedStyle(ico(n));
      return { unreadOpacity: +cs(1).opacity, readOpacity: +cs(2).opacity,
               unreadColor: cs(1).color, readColor: cs(2).color,
               unreadText: ico(1).textContent, readText: ico(2).textContent };
    })()`);
    check('terminée non lue → ✓ vif (opacité pleine)', tints.unreadOpacity === 1, JSON.stringify(tints));
    check('terminée déjà lue → ✓ atténué', tints.readOpacity > 0 && tints.readOpacity < 0.6, JSON.stringify(tints));
    check('les deux restent VERTS (atténué ≠ gris)', tints.unreadColor === tints.readColor, JSON.stringify(tints));
    check('les deux sont bien un ✓', tints.unreadText === '✓' && tints.readText === '✓', JSON.stringify(tints));

    console.log('\n3. L\'arc tourne vraiment (6c)');
    const anim = await cdp.evaluate(`(() => {
      const a = document.querySelector('.ico-busy').getAnimations();
      return { count: a.length, name: a[0] && a[0].animationName, state: a[0] && a[0].playState };
    })()`);
    check('une animation CSS est bien attachée à l\'arc', anim.count === 1, JSON.stringify(anim));
    check('… elle est en cours d\'exécution (et non « none » comme avant)',
      anim.state === 'running', JSON.stringify(anim));

    const t1 = await cdp.evaluate(`document.querySelector('.ico-busy').getAnimations()[0].currentTime`);
    const m1 = await cdp.evaluate(`getComputedStyle(document.querySelector('.ico-busy')).transform`);
    await sleep(300);
    const t2 = await cdp.evaluate(`document.querySelector('.ico-busy').getAnimations()[0].currentTime`);
    const m2 = await cdp.evaluate(`getComputedStyle(document.querySelector('.ico-busy')).transform`);
    check(`le temps d'animation avance (${Math.round(t1)} → ${Math.round(t2)} ms)`, t2 > t1, `${t1} → ${t2}`);
    check('la rotation appliquée à l\'écran change vraiment', m1 !== m2, `${m1} vs ${m2}`);

    console.log('\n4. Un nouvel état ne casse pas la rotation (rendu incrémental)');
    await cdp.evaluate(`document.querySelector('.ico-busy').dataset.probe = 'original'`);
    const before = await cdp.evaluate(`document.querySelector('.ico-busy').getAnimations()[0].currentTime`);
    // Même conv, ctx qui bouge : exactement ce qui arrive en cours de run.
    const next = JSON.parse(JSON.stringify(STATE));
    next.conversations[0].ctx.pct = 41;
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: next })}, '*')`);
    await sleep(120);
    check('le nœud de l\'arc a survécu au nouvel état (il n\'est pas recréé)',
      await cdp.evaluate(`document.querySelector('.ico-busy').dataset.probe`) === 'original');
    const after = await cdp.evaluate(`document.querySelector('.ico-busy').getAnimations()[0].currentTime`);
    check(`… et sa rotation n'est pas repartie de zéro (${Math.round(before)} → ${Math.round(after)} ms)`,
      after >= before, `${before} → ${after}`);
    check('le ctx% affiché a bien été mis à jour',
      (await cdp.evaluate(`document.querySelectorAll('.conv')[0].querySelector('.ctx').textContent`)) === 'ctx 41%');

    console.log('\n5. Une conv qui part / arrive');
    const shorter = { ...STATE, conversations: STATE.conversations.slice(0, 2) };
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: shorter })}, '*')`);
    await sleep(120);
    check('les conversations retirées quittent le DOM',
      await cdp.evaluate(`document.querySelectorAll('.conv').length`) === 2);
    check('l\'arc de la conv restante tourne toujours',
      await cdp.evaluate(`document.querySelector('.ico-busy').getAnimations()[0].playState`) === 'running');
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: { conversations: [], quota: STATE.quota } })}, '*')`);
    await sleep(120);
    check('plus aucune conv → message d\'attente, aucune ligne fantôme',
      await cdp.evaluate(`document.querySelectorAll('.conv').length === 0 && !!document.querySelector('.empty')`) === true);

    console.log('\n6. Flèche « où je devrais être » (lot 7)');
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: STATE })}, '*')`);
    await sleep(120);
    const arrowPos = await cdp.evaluate(`(() => {
      const tracks = Array.from(document.querySelectorAll('.arrow-track'));
      return tracks.map(t => {
        const a = t.querySelector('.arrow');
        return a ? parseFloat(a.style.left) : null;
      });
    })()`);
    check(`mi-fenêtre 5h → flèche ≈ 50 % (mesuré ${arrowPos[0]})`,
      arrowPos[0] != null && Math.abs(arrowPos[0] - 50) < 1, JSON.stringify(arrowPos));
    check(`24 h après reset hebdo → flèche ≈ 1/7 ≈ 14,3 % (mesuré ${arrowPos[1]})`,
      arrowPos[1] != null && Math.abs(arrowPos[1] - (100 / 7)) < 1, JSON.stringify(arrowPos));
    check('resetsAt absent (barre scopée sans deadline) → flèche masquée', arrowPos[2] == null, JSON.stringify(arrowPos));
    check('resetsAt déjà passé → flèche masquée', arrowPos[3] == null, JSON.stringify(arrowPos));
    check('4 barres de quota rendues (5h, 7d, scopée, reset-passé)',
      await cdp.evaluate(`document.querySelectorAll('.q').length`) === 4);
    const barIntact = await cdp.evaluate(`(() => {
      const fill = document.querySelector('.bar-q > i');
      return fill ? fill.style.width : null;
    })()`);
    check(`la flèche ne déforme pas la barre (largeur du remplissage = ${barIntact})`,
      barIntact === '23%');

    console.log('\n7. Flèche lisible dans les deux thèmes');
    for (const scheme of ['dark', 'light']) {
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await sleep(80);
      const arrowColor = await cdp.evaluate(`getComputedStyle(document.querySelector('.arrow')).borderBottomColor`);
      check(`thème ${scheme} : la flèche a une couleur résolue non transparente (${arrowColor})`,
        !!arrowColor && arrowColor !== 'rgba(0, 0, 0, 0)' && arrowColor !== 'transparent');
    }
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });

    console.log('\n8. Auto-actualisation sans interaction (tick 30 s, attente réelle ≥ 60 s)');
    // Fenêtre synthétique de 5 min, reset dans 4 min → 20 % écoulé maintenant ;
    // aucun autre postMessage n'arrivera pendant l'attente : si la position
    // bouge, c'est uniquement le tick local de panel.js qui l'a fait.
    const TICK_WINDOW_MS = 5 * 60 * 1000;
    const tickState = JSON.parse(JSON.stringify(STATE));
    tickState.quota.windows = [mkWindow('tick test', 10, new Date(Date.now() + 4 * 60 * 1000).toISOString(), TICK_WINDOW_MS)];
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: tickState })}, '*')`);
    await sleep(120);
    const posBefore = await cdp.evaluate(`parseFloat(document.querySelector('.arrow').style.left)`);
    await sleep(65000);
    const posAfter = await cdp.evaluate(`parseFloat(document.querySelector('.arrow').style.left)`);
    check(`la flèche avance seule entre deux polls (${posBefore.toFixed(1)}% → ${posAfter.toFixed(1)}%, aucun nouveau postMessage envoyé)`,
      posAfter > posBefore + 5, `${posBefore} → ${posAfter}`);

    // Capture pour l'œil : deux instants, l'arc doit être à des angles différents.
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: STATE })}, '*')`);
    await sleep(150);
    const shots = [];
    for (let i = 0; i < 2; i++) {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      shots.push(Buffer.from(r.data, 'base64'));
      await sleep(400);
    }
    const outDir = path.join(os.tmpdir(), 'qb-panel-shots');
    fs.mkdirSync(outDir, { recursive: true });
    shots.forEach((b, i) => fs.writeFileSync(path.join(outDir, `panel-${i}.png`), b));
    check('deux captures à 400 ms d\'écart diffèrent (l\'arc a bougé à l\'écran)',
      !shots[0].equals(shots[1]), `captures dans ${outDir}`);
    console.log(`       captures : ${outDir}`);
  } finally {
    if (cdp) cdp.close();
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore', timeout: 5000 }); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

run().then(() => {
  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('banc en erreur :', e && e.message);
  process.exit(1);
});
