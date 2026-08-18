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
function mkWindow(label, pct, resetsAt, windowMs, cost) {
  const elapsedPct = windowElapsedPct(resetsAt, windowMs);
  return {
    label, pct,
    resetsAt: resetsAt || null,
    resetLabel: resetsAt ? new Date(resetsAt).toISOString() : '?',
    windowMs,
    pace: paceColor(burnRatePace(pct, resetsAt, windowMs)),
    elapsedPct: elapsedPct == null ? null : Math.min(100, Math.max(0, elapsedPct)),
    cost: typeof cost === 'number' ? cost : null,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;

// Le contrat d'état, tel qu'extension.js le pousse (cf. tête de panel.js).
const STATE = {
  conversations: [
    { id: 'c1', title: 'Conv au travail', model: 'Opus 4.8', ctx: { pct: 34 }, state: 'busy', acked: true, active: true },
    { id: 'c2', title: 'Terminée jamais lue', model: 'Sonnet 5', ctx: { pct: 20 }, state: 'done', acked: false, active: false, tabOpen: true },
    { id: 'c3', title: 'Terminée déjà lue', model: 'Sonnet 5', ctx: { pct: 12 }, state: 'done', acked: true, active: false, tabOpen: true },
    { id: 'c4', title: 'Sans état hooks', model: null, ctx: null, state: 'idle', acked: true, active: false },
    { id: 'c5', title: 'Attend une réponse', model: 'Haiku 4.5', ctx: { pct: 8 }, state: 'waiting', acked: true, active: false },
    { id: 'c6', title: 'Coupée au clavier', model: 'Opus 4.8', ctx: { pct: 41 }, state: 'interrupted', acked: true, active: false },
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
    check('une ligne par conversation', await cdp.evaluate(`document.querySelectorAll('.conv').length`) === 6);
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

    // Une interruption ne doit RIEN partager avec le ✓ : ni le glyphe, ni la
    // couleur verte. Le carré creux muted est le seul état qui dit « inachevé ».
    console.log('\n1c. Carré « stop » pour interrupted');
    // 2026-08-09 : la forme vit dans le ::before, plus dans la bordure de
    // l'hôte — c'est ce qui lui permet de survivre à l'anneau d'un groupe (cf.
    // §9bis, « un seul jeu de symboles »). On mesure donc le pseudo.
    const intIco = await cdp.evaluate(`(() => {
      const i = document.querySelectorAll('.conv')[5].querySelector('.ico');
      const cs = getComputedStyle(i, '::before');
      return { text: i.textContent, cls: i.className, radius: cs.borderTopLeftRadius,
               style: cs.borderTopStyle, hostBorder: getComputedStyle(i).borderTopStyle,
               tip: document.querySelectorAll('.conv')[5].title };
    })()`);
    check('interrupted rendu en carré (classe dédiée, aucun ✓ dans la pastille)',
      intIco.cls.includes('ico-interrupted') && intIco.text === '', JSON.stringify(intIco));
    check('trait plein et angles droits — ni le ✓ done, ni le cercle pointillé stale',
      intIco.style === 'solid' && parseFloat(intIco.radius) <= 2, JSON.stringify(intIco));
    check('… et la forme n\'est PAS dans la bordure de l\'hôte (sinon l\'anneau d\'un groupe l\'avale)',
      intIco.hostBorder === 'none', JSON.stringify(intIco));
    check('infobulle explicite « unfinished »',
      /interrupted — unfinished/.test(intIco.tip), JSON.stringify(intIco.tip));

    console.log('\n2. Les deux teintes du ✓ (6b)');
    // Étape 13 : l'atténuation « déjà lue » passe par l'ALPHA DE LA COULEUR du
    // glyphe, plus par l'opacity de la boîte — une opacity s'applique aussi au
    // pseudo-élément ::after, l'anneau des lignes de groupe, qui devenait alors
    // translucide et laissait passer le rail. Le rendu du ✓ est identique (il
    // n'a ni fond ni bordure) ; c'est l'invariant « trou opaque » qui change.
    const tints = await cdp.evaluate(`(() => {
      const ico = (n) => document.querySelectorAll('.conv')[n].querySelector('.ico');
      const cs = (n) => getComputedStyle(ico(n));
      // color-mix() se calcule en color(srgb r g b / a), composantes en 0..1 —
      // là où une couleur simple sort en rgb(0..255). Ramené au même barème,
      // sinon on comparerait des pommes et des poires.
      const rgba = (c) => {
        const n = (c.match(/[\\d.]+/g) || []).map(Number);
        const k = /^color\\(/.test(c) ? 255 : 1;
        return [Math.round(n[0] * k), Math.round(n[1] * k), Math.round(n[2] * k)].concat(n.length > 3 ? [n[3]] : []);
      };
      return { unreadOpacity: +cs(1).opacity, readOpacity: +cs(2).opacity,
               unreadColor: rgba(cs(1).color), readColor: rgba(cs(2).color),
               unreadText: ico(1).textContent, readText: ico(2).textContent };
    })()`);
    const readAlpha = tints.readColor.length > 3 ? tints.readColor[3] : 1;
    check('terminée non lue → ✓ vif (couleur pleine, alpha 1)',
      tints.unreadColor.length === 3 || tints.unreadColor[3] === 1, JSON.stringify(tints));
    check('terminée déjà lue → ✓ atténué (alpha de la couleur, ~0.45)',
      readAlpha > 0 && readAlpha < 0.6, JSON.stringify(tints));
    check('les deux restent VERTS (atténué ≠ gris)',
      tints.unreadColor.slice(0, 3).join() === tints.readColor.slice(0, 3).join(), JSON.stringify(tints));
    check('… et AUCUN des deux ne joue sur opacity (sinon l\'anneau du rail devient translucide — étape 13)',
      tints.unreadOpacity === 1 && tints.readOpacity === 1, JSON.stringify(tints));
    check('les deux sont bien un ✓', tints.unreadText === '✓' && tints.readText === '✓', JSON.stringify(tints));

    console.log('\n3. L\'arc tourne vraiment (6c)');
    // 2026-08-06 : l'arc vit dans ::before (le disque opaque de l'anneau de
    // groupe avalait la bordure de l'hôte — ordre de peinture CSS). Les
    // animations d'un pseudo ne se lisent qu'avec {subtree:true}, et sa
    // rotation qu'en visant '::before' dans getComputedStyle.
    const anim = await cdp.evaluate(`(() => {
      const a = document.querySelector('.ico-busy').getAnimations({ subtree: true });
      return { count: a.length, name: a[0] && a[0].animationName, state: a[0] && a[0].playState };
    })()`);
    // Deux animations depuis 2.28.3 (respiration du serpentin) : spin
    // (rotation) + breathe (longueur du secteur) sur le même pseudo.
    check('les deux animations CSS sont bien attachées à l\'arc (spin + breathe)', anim.count === 2, JSON.stringify(anim));
    check('… elle est en cours d\'exécution (et non « none » comme avant)',
      anim.state === 'running', JSON.stringify(anim));

    const t1 = await cdp.evaluate(`document.querySelector('.ico-busy').getAnimations({ subtree: true })[0].currentTime`);
    const m1 = await cdp.evaluate(`getComputedStyle(document.querySelector('.ico-busy'), '::before').transform`);
    await sleep(300);
    const t2 = await cdp.evaluate(`document.querySelector('.ico-busy').getAnimations({ subtree: true })[0].currentTime`);
    const m2 = await cdp.evaluate(`getComputedStyle(document.querySelector('.ico-busy'), '::before').transform`);
    check(`le temps d'animation avance (${Math.round(t1)} → ${Math.round(t2)} ms)`, t2 > t1, `${t1} → ${t2}`);
    check('la rotation appliquée à l\'écran change vraiment', m1 !== m2, `${m1} vs ${m2}`);

    console.log('\n4. Un nouvel état ne casse pas la rotation (rendu incrémental)');
    await cdp.evaluate(`document.querySelector('.ico-busy').dataset.probe = 'original'`);
    const before = await cdp.evaluate(`document.querySelector('.ico-busy').getAnimations({ subtree: true })[0].currentTime`);
    // Même conv, ctx qui bouge : exactement ce qui arrive en cours de run.
    const next = JSON.parse(JSON.stringify(STATE));
    next.conversations[0].ctx.pct = 41;
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: next })}, '*')`);
    await sleep(120);
    check('le nœud de l\'arc a survécu au nouvel état (il n\'est pas recréé)',
      await cdp.evaluate(`document.querySelector('.ico-busy').dataset.probe`) === 'original');
    const after = await cdp.evaluate(`document.querySelector('.ico-busy').getAnimations({ subtree: true })[0].currentTime`);
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
      await cdp.evaluate(`document.querySelector('.ico-busy').getAnimations({ subtree: true })[0].playState`) === 'running');
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

    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: STATE })}, '*')`);
    await sleep(150);

    console.log('\n9. Groupes (lot 2) — la même ligne de conv, rendue DANS son groupe');
    // Marque fraîche : les sections précédentes ont vidé puis reconstruit la
    // liste (§5), donc la marque posée au §4 n'existe plus.
    await cdp.evaluate(`document.querySelector('.ico-busy').dataset.probe = 'grouped'`);
    // Un membre lié doit réutiliser le NŒUD de la conversation, pas en fabriquer
    // un second : c'est ce qui garantit qu'un groupe dit exactement la même
    // chose que la liste plate (état, modèle, ctx, spinner vivant).
    const grouped = JSON.parse(JSON.stringify(STATE));
    grouped.conversations[0].groupId = 'g1';                    // c1, busy
    grouped.conversations[1].groupId = 'g1';                    // c2, done…
    grouped.conversations[1].tabOpen = true;                    // … onglet encore ouvert
    grouped.groups = [{
      // Moteur de vagues (lot 4) : vague 1 en cours (m1 busy, m2 done), vague 2
      // encore en file — exactement le cas « unlocks when wave 1 is done ».
      id: 'g1', name: 'Refonte paiements', hue: 210, collapsed: false,
      launchedWave: 1, nextWave: 2, waveNotice: null,
      // Membres tels que les SÉRIALISE extension.js depuis la table de vérité
      // (lot 10) : le webview n'en déduit plus rien lui-même — status/note/
      // canLink/canClose arrivent résolus. La table elle-même est éprouvée cas
      // par cas dans test/test-member-truth.js ; ici on vérifie le RENDU.
      members: [
        { key: 'm1', prompt: 'Conv au travail', wave: 1, asked: { model: 'opus', effort: 'high' }, convId: 'c1', status: 'busy', waveStatus: 'launched', canLink: false, canClose: false, note: '', hint: '' },
        { key: 'm2', prompt: 'Terminée jamais lue', wave: 1, asked: { model: 'sonnet', effort: 'medium' }, convId: 'c2', status: 'done', waveStatus: 'done', canLink: false, canClose: true, note: '', hint: '' },
        { key: 'm3', prompt: 'Pas encore lancée', wave: 2, asked: { model: null, effort: null }, convId: null, status: 'queued', waveStatus: 'queued', canLink: false, canClose: false, note: '', hint: 'Queued — opens when this wave starts.' },
      ],
    }];
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: grouped })}, '*')`);
    await sleep(150);
    check('la section de groupe est rendue',
      await cdp.evaluate(`document.querySelectorAll('#flow .grp').length`) === 1);
    check('les convs groupées quittent la liste plate (aucune en double)',
      await cdp.evaluate(`document.querySelectorAll('#flow > .conv').length`) === 4
      && await cdp.evaluate(`document.querySelectorAll('.conv').length`) === 6,
      await cdp.evaluate(`document.querySelectorAll('#flow > .conv').length + '/' + document.querySelectorAll('.conv').length`));
    check('la ligne de la conv busy a MIGRÉ dans le groupe (nœud réutilisé, pas recréé)',
      await cdp.evaluate(`document.querySelector('#flow .ico-busy').dataset.probe`) === 'grouped');
    // Étape 16 (révoque l'amendement étape 5) : dans le rail d'un groupe,
    // busy reprend LA MÊME animation `spin` que les lignes plates — même nom
    // d'animation, aucune divergence de classe entre les deux contextes.
    const grpBusyAnim = await cdp.evaluate(`(() => {
      const anims = document.querySelector('#flow .ico-busy').getAnimations({ subtree: true });
      return { count: anims.length, name: anims[0] ? anims[0].animationName : null };
    })()`);
    check('… son arc tourne dans le rail du groupe, comme une ligne plate (étape 16)',
      grpBusyAnim.count === 2, JSON.stringify(grpBusyAnim));
    // 2026-08-06 (4e signalement « pas de loading », cause prouvée en CDP) :
    // l'animation ne suffit PAS — le disque opaque de l'anneau (::after
    // z-index:-1) se peignait PAR-DESSUS la bordure-arc de l'hôte (ordre de
    // peinture CSS : les z-négatifs passent après la bordure de l'élément qui
    // crée le contexte). L'arc vit désormais dans un ::before positionné,
    // peint APRÈS les z-négatifs. Preuve par les PIXELS, pas par le style :
    // l'INTÉRIEUR de l'anneau de groupe doit contenir l'encre de l'arc.
    const grpBusyInk = await cdp.evaluate(`(() => {
      const n = document.querySelector('#flow .ico-busy');
      const cs = getComputedStyle(n, '::before');
      return { border: cs.borderTopColor, pos: cs.position, content: cs.content };
    })()`);
    check('… l\'arc du membre busy est porté par le ::before positionné (peint au-dessus de l\'anneau)',
      grpBusyInk.pos === 'absolute' && grpBusyInk.content === '""', JSON.stringify(grpBusyInk));
    // Preuve par les PIXELS (même motif createImageBitmap que le §17g — la CSP
    // interdit img.src data: mais pas une image construite en mémoire) : on
    // échantillonne 24×24 autour de l'icône busy du groupe et on compte les
    // pixels de teinte bleue (l'arc, --busy #03a9f4). Avant le fix (2026-08-06):
    // 0 — l'arc était peint puis ENTIÈREMENT recouvert par le disque opaque.
    // Seuils SERRÉS (R<50, B>220) : le rail de CE groupe de test est LUI AUSSI
    // bleuté (hsl(210,45%,55%) ≈ 89,140,192, cf. hueBorder en JS) — un seuil
    // large confondrait l'encre de l'arc avec celle du rail voisin.
    const busyPng = (await cdp.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: false,
      clip: await cdp.evaluate(`(() => { const b = document.querySelector('#flow .ico-busy').getBoundingClientRect();
        return { x: b.left + b.width / 2 - 12, y: b.top + b.height / 2 - 12, width: 24, height: 24, scale: 6 }; })()`),
    })).data;
    await cdp.evaluate(`(() => {
      window.__busyInk = null;
      const bin = atob('` + busyPng + `');
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      createImageBitmap(new Blob([bytes], { type: 'image/png' })).then(function (img) {
        const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
        const g = cv.getContext('2d'); g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, cv.width, cv.height).data;
        let blue = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] < 50 && d[i + 2] > 220 && d[i + 1] > 100) blue++;
        }
        window.__busyInk = { blue };
      });
    })()`);
    let busyInk = null;
    for (let i = 0; i < 20 && !busyInk; i++) { await sleep(100); busyInk = await cdp.evaluate(`window.__busyInk`); }
    check('… et l\'arc bleu est VISIBLE dans l\'anneau du groupe (pixels, pas style calculé)',
      !!busyInk && busyInk.blue > 50, JSON.stringify(busyInk));
    // `anim.name` capturé section 3 sur une ligne PLATE (.ico-busy hors groupe) :
    // même nom d'animation ici ⇒ une seule définition CSS, aucune divergence.
    check('… même nom d\'animation que .ico-busy des lignes plates (une seule définition)',
      grpBusyAnim.name != null && grpBusyAnim.name === anim.name,
      JSON.stringify({ grp: grpBusyAnim.name, flat: anim.name }));
    check('membre non lié : son prompt s\'affiche, sans état emprunté',
      await cdp.evaluate(`(document.querySelector('.m-pending .m-prompt')||{}).textContent`) === 'Pas encore lancée');
    check('compteur « terminées » du groupe',
      await cdp.evaluate(`document.querySelector('.grp-count').textContent`) === '1/3 done');
    // Étape 11 : aucun membre n'est `done-closed` ici → chip masquée.
    check('groupe pas terminé : chip « ✓ done » absente',
      await cdp.evaluate(`getComputedStyle(document.querySelector('.grp-done')).display`) === 'none');

    console.log('\n9ter. « Ce qui reste à faire » (étape 11) — masquage au rendu, jamais le store');
    // Groupe à 3 vagues : vague 1 (m1, m2) ENTIÈREMENT done-closed → doit
    // disparaître, ligne ET en-tête « wave 1 » ; vague 2 mêle un `stale` et un
    // `unsent-lost`, qui restent visibles (il reste un remède : aller voir /
    // relier / relancer) ; vague 3 (m5, `queued`) force `multiWave` pour que
    // l'absence de l'en-tête « wave 1 » soit un fait mesuré, pas un effet de
    // bord d'une vague unique restante. Maîtresse ENCORE VIVANTE (`busy`) :
    // `g.done` (calculé côté extension.js, group-done.js) reste false — un
    // groupe ne disparaît ENTIER que maîtresse comprise (décision 90 du plan).
    const hidden = JSON.parse(JSON.stringify(grouped));
    hidden.groups[0] = {
      id: 'g1', name: 'Refonte paiements', hue: 210, collapsed: false,
      launchedWave: 2, nextWave: 3, waveNotice: null, done: false,
      master: { convId: 'c-master', title: 'Cadrage du chantier', listed: false, tabTitle: null, hint: 'Running.', status: 'busy' },
      members: [
        { key: 'm1', prompt: 'Tâche 1 finie', wave: 1, asked: { model: 'opus', effort: 'high' }, convId: null, status: 'done-closed', waveStatus: 'done', canLink: false, canClose: false, canRelaunch: false, note: '✓ done · closed', hint: '' },
        { key: 'm2', prompt: 'Tâche 2 finie', wave: 1, asked: { model: 'sonnet', effort: 'medium' }, convId: null, status: 'done-closed', waveStatus: 'done', canLink: false, canClose: false, canRelaunch: false, note: '✓ done · closed', hint: '' },
        { key: 'm3', prompt: 'Interrompue', wave: 2, asked: { model: null, effort: null }, convId: null, status: 'stale', waveStatus: 'stale', canLink: false, canClose: false, canRelaunch: false, note: 'interrupted — never finished', hint: '' },
        { key: 'm4', prompt: 'Lien mort-né', wave: 2, asked: { model: null, effort: null }, convId: null, status: 'unsent-lost', waveStatus: 'stale', canLink: true, canClose: false, canRelaunch: true, note: 'link lost before sending', hint: '' },
        { key: 'm5', prompt: 'Vague 3, pas encore lancée', wave: 3, asked: { model: null, effort: null }, convId: null, status: 'queued', waveStatus: 'queued', canLink: false, canClose: false, canRelaunch: false, note: '', hint: 'Queued — opens when this wave starts.' },
      ],
    };
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: hidden })}, '*')`);
    await sleep(150);
    const hiddenPrompts = await cdp.evaluate(`[...document.querySelectorAll('#flow .m-prompt')].map(e => e.textContent)`);
    check('les 2 membres done-closed (vague 1) n\'ont plus de ligne',
      !hiddenPrompts.includes('Tâche 1 finie') && !hiddenPrompts.includes('Tâche 2 finie'), JSON.stringify(hiddenPrompts));
    check('… mais stale et unsent-lost restent visibles (un remède existe encore)',
      hiddenPrompts.includes('Interrompue') && hiddenPrompts.includes('Lien mort-né'), JSON.stringify(hiddenPrompts));
    check('… et une vague en file (jamais done-closed) reste visible',
      hiddenPrompts.includes('Vague 3, pas encore lancée'), JSON.stringify(hiddenPrompts));
    const waveLabels = await cdp.evaluate(`[...document.querySelectorAll('#flow .wave-hdr-label')].map(e => e.textContent)`);
    check('en-tête « wave 1 » absent : plus aucun membre visible dessous',
      !waveLabels.includes('wave 1'), JSON.stringify(waveLabels));
    check('… en-têtes des vagues encore utiles présents (jamais toutes retirées d\'un coup)',
      waveLabels.includes('wave 2') && waveLabels.includes('▶ wave 3'), JSON.stringify(waveLabels));
    check('compteur « terminées » : calculé sur le store COMPLET (les cachés comptent)',
      await cdp.evaluate(`document.querySelector('.grp-count').textContent`) === '2/5 done');
    check('groupe pas ENTIÈREMENT terminé (maîtresse encore vivante) : toujours rendu',
      await cdp.evaluate(`document.querySelectorAll('#flow .grp').length`) === 1);

    // Onglet rouvert (extension.js relisterait la conv sous un id réel,
    // member-truth.js recalcule alors `done`, tabOpen vrai) : le membre repasse
    // le filtre et redevient une ligne normale, sans rien à réconcilier.
    const reopened = JSON.parse(JSON.stringify(hidden));
    reopened.groups[0].members[0] = {
      key: 'm1', prompt: 'Tâche 1 finie', wave: 1, asked: { model: 'opus', effort: 'high' }, convId: 'c2',
      status: 'done', waveStatus: 'done', canLink: false, canClose: true, canRelaunch: false, note: '', hint: 'Finished.',
    };
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: reopened })}, '*')`);
    await sleep(150);
    check('… réapparaît une fois l\'onglet rouvert (statut `done`, plus `done-closed`)',
      await cdp.evaluate(`[...document.querySelectorAll('#flow .conv .title')].some(e => e.textContent === 'Terminée jamais lue')`));

    // Maîtresse ENCORE VIVANTE, mais tous les membres finis : « capsule seule +
    // chip ✓ done » (cas dégradé de la décision 90 — rien à faire côté
    // membres, la maîtresse reste la seule chose à montrer).
    const allDoneMasterOpen = JSON.parse(JSON.stringify(hidden));
    allDoneMasterOpen.groups[0].members.forEach(function (m) {
      m.status = 'done-closed'; m.waveStatus = 'done';
      m.canLink = false; m.canClose = false; m.canRelaunch = false; m.note = '✓ done · closed';
    });
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: allDoneMasterOpen })}, '*')`);
    await sleep(150);
    check('capsule seule : le groupe reste rendu (maîtresse pas done-closed)',
      await cdp.evaluate(`document.querySelectorAll('#flow .grp').length`) === 1);
    check('… chip « ✓ done » visible (plus aucun membre à faire)',
      await cdp.evaluate(`getComputedStyle(document.querySelector('.grp-done')).display`) !== 'none'
      && await cdp.evaluate(`document.querySelector('.grp-done').textContent`) === '✓ done');
    check('… plus aucun membre ni en-tête de vague sous la capsule',
      await cdp.evaluate(`document.querySelectorAll('#flow .member').length`) === 0
      && await cdp.evaluate(`document.querySelectorAll('#flow .wave-hdr').length`) === 0);
    check('… la maîtresse (encore vivante) reste rendue',
      await cdp.evaluate(`!!document.querySelector('.grp-master-fallback')`));

    // Maîtresse AUSSI done-closed : `g.done` (group-done.js, côté extension)
    // devient vrai — le groupe entier disparaît du DOM. Le store, lui, n'est
    // jamais consulté par ce banc : seul le rendu est en cause ici.
    const fullyDone = JSON.parse(JSON.stringify(allDoneMasterOpen));
    fullyDone.groups[0].master.status = 'done-closed';
    fullyDone.groups[0].done = true;
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: fullyDone })}, '*')`);
    await sleep(150);
    check('groupe ENTIÈREMENT terminé (maîtresse comprise) : plus rendu du tout',
      await cdp.evaluate(`document.querySelectorAll('#flow .grp').length`) === 0);

    // Retour à l'état de base de la section 9 pour la suite du banc (9bis).
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: grouped })}, '*')`);
    await sleep(150);

    console.log('\n9bis. Vie des bulles en attente + glyphes de groupe (plan repli-auto étape 5)');
    // m3 (queued, pas de conv liée) → anneau statique atténué, jamais de pulse.
    const queuedRing = await cdp.evaluate(`(() => {
      const ico = document.querySelector('#flow .m-pending .ico-pending');
      const cs = getComputedStyle(ico, '::after');
      const alpha = (c) => { const m = c.match(/[\\d.]+/g) || []; return m.length > 3 ? +m[3] : 1; };
      return { cls: ico.className, anims: ico.getAnimations().length,
               opacity: cs.opacity, borderAlpha: alpha(cs.borderTopColor) };
    })()`);
    check('membre queued : classe atténuée, jamais "wait"',
      queuedRing.cls.includes('ico-pending-idle') && !queuedRing.cls.includes('ico-pending-wait'), JSON.stringify(queuedRing));
    check('… aucune animation sur son anneau', queuedRing.anims === 0, JSON.stringify(queuedRing));
    // Étape 13 : l'atténuation porte sur la BORDURE de l'anneau, jamais sur son
    // opacity — une opacity rendait aussi le FOND translucide et le rail
    // transparaissait dans la bulle (« bulles perçues transparentes »). Le trou
    // opaque est un invariant de tous les anneaux, atténués compris.
    check('… cerclage visiblement atténué (alpha de bordure ~0.4)',
      Math.abs(queuedRing.borderAlpha - 0.4) < 0.05, JSON.stringify(queuedRing));
    check('… mais l\'anneau reste OPAQUE (opacity 1 : il troue toujours le rail)',
      parseFloat(queuedRing.opacity) === 1, JSON.stringify(queuedRing));

    // Même membre, statut inserted (Entrée attendue de l'USER) → pulse.
    const insertedState = JSON.parse(JSON.stringify(grouped));
    insertedState.groups[0].members[2].status = 'inserted';
    insertedState.groups[0].members[2].waveStatus = 'launched';
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: insertedState })}, '*')`);
    await sleep(120);
    const insertedRing = await cdp.evaluate(`(() => {
      const ico = document.querySelector('#flow .m-pending .ico-pending');
      // L'animation cible ::after (l'anneau), pas l'élément lui-même —
      // getAnimations() de l'élément ne la voit pas ; on lit le style calculé
      // du pseudo-élément, même méthode que le glyphe « ? » de waiting plus haut.
      const cs = getComputedStyle(ico, '::after');
      return { cls: ico.className, animName: cs.animationName, playState: cs.animationPlayState, opacity: cs.opacity };
    })()`);
    check('membre inserted : classe "wait", jamais "idle"',
      insertedRing.cls.includes('ico-pending-wait') && !insertedRing.cls.includes('ico-pending-idle'), JSON.stringify(insertedRing));
    check('… pulse RUNNING sur son anneau (intensité, pas de déplacement)',
      insertedRing.animName === 'grp-wait-pulse' && insertedRing.playState === 'running', JSON.stringify(insertedRing));
    check('… et il pulse SANS percer le trou opaque (opacity 1 tout du long — étape 13)',
      parseFloat(insertedRing.opacity) === 1, JSON.stringify(insertedRing));
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: grouped })}, '*')`);
    await sleep(120);

    // Une ligne AVEC conversation rendue ne porte jamais de classe ico-pending
    // (structurel : pendingLine() n'est appelée que quand aucune conv n'est
    // trouvée — vérifié explicitement pour couvrir le banc du plan).
    check('ligne de conv rendue : aucune classe ico-pending-wait/idle qui traîne',
      await cdp.evaluate(`!document.querySelector('#flow .conv .ico-pending-wait, #flow .conv .ico-pending-idle')`) === true);

    // UN SEUL JEU DE SYMBOLES (2026-08-09) — la propriété qui remplace l'ancien
    // « chaque état porte un glyphe dans l'anneau » : ce n'est plus assez de
    // vérifier qu'il y a QUELQUE CHOSE dans l'anneau, il faut que ce soit LE
    // MÊME symbole que hors groupe. L'ancien banc validait précisément le bug
    // signalé par l'user (⚠ dans un lot vs carré hors lot, et ⚠ commun à
    // interrupted et stale) : il exigeait le glyphe de substitution.
    // La preuve porte sur la SIGNATURE de la forme (pseudo ::before + texte de
    // l'hôte), pas sur une capture : l'anneau du groupe se superpose au symbole
    // et rendrait toute comparaison de pixels bruts fausse par construction.
    // Le même état est rendu SIMULTANÉMENT dans le groupe (c1) et sur une ligne
    // plate (c6) — deux nœuds vivants au même instant, donc aucune dérive
    // possible entre deux mesures prises à des moments différents.
    const SYMBOL_SIG = `(function (ico) {
      const b = getComputedStyle(ico, '::before'), h = getComputedStyle(ico);
      return JSON.stringify({
        cls: ico.className, text: ico.textContent,
        content: b.content, position: b.position,
        borderStyle: b.borderTopStyle, borderWidth: b.borderTopWidth, borderColor: b.borderTopColor,
        radius: b.borderTopLeftRadius, pseudoColor: b.color, color: h.color,
        hostBorder: h.borderTopStyle,
        anims: ico.getAnimations({ subtree: true }).map(a => a.animationName).sort().join(','),
      });
    })`;
    let staleVsInterrupted = null;
    for (const state of ['busy', 'waiting', 'done', 'interrupted', 'stale']) {
      const s = JSON.parse(JSON.stringify(grouped));
      s.conversations[0].state = state;   // c1 — DANS le groupe
      s.conversations[5].state = state;   // c6 — ligne plate, même instant
      s.conversations[0].acked = true; s.conversations[5].acked = true;
      s.groups[0].members[0].status = state === 'done' ? 'done' : state;
      await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: s })}, '*')`);
      await sleep(120);
      const pair = await cdp.evaluate(`(() => {
        const sig = ${SYMBOL_SIG};
        const inGrp = document.querySelector('#flow .grp-body .member .conv .ico');
        const flat = Array.from(document.querySelectorAll('#flow > .conv'))
          .find(c => ((c.querySelector('.title') || {}).textContent || '').indexOf('Coupée au clavier') >= 0);
        return { grp: inGrp ? sig(inGrp) : null, flat: flat ? sig(flat.querySelector('.ico')) : null };
      })()`);
      check('état ' + state + ' : le symbole DANS un lot est le MÊME que hors lot (aucune substitution)',
        !!pair.grp && pair.grp === pair.flat,
        'groupe=' + pair.grp + ' / plate=' + pair.flat);
      // Corollaire du bug : deux états distincts ne doivent pas se retrouver
      // sous une même forme dans un lot (⚠ valait pour interrupted ET stale).
      if (state === 'stale') {
        check('… et « en sommeil » ne se confond pas avec « interrompue » dans un lot',
          pair.grp !== staleVsInterrupted, 'signature identique aux deux états : ' + pair.grp);
      }
      if (state === 'interrupted') staleVsInterrupted = pair.grp;
    }
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: grouped })}, '*')`);
    await sleep(120);

    check('en-tête de vague affiché (groupe multi-vagues)',
      await cdp.evaluate(`document.querySelectorAll('#flow .wave-hdr').length`) === 2);
    const waveHdrTexts = await cdp.evaluate(`Array.from(document.querySelectorAll('#flow .wave-hdr')).map(h => h.textContent).join('|')`);
    // Lot 4 §2 : la mention « — queued » ne reste que pour une vague plus loin
    // en file — la PROCHAINE à lancer (ici la vague 2) devient elle-même le
    // bouton ▶ (vérifié plus bas), elle ne porte donc plus « — queued ».
    check('avec 2 vagues, aucun séparateur ne porte encore « — queued » (la vague 2 est la prochaine à lancer)',
      waveHdrTexts.indexOf('queued') === -1, waveHdrTexts);
    check('membre en attente de sa vague : « queued » dans le titre, pas « pas encore lié »',
      await cdp.evaluate(`(document.querySelector('.m-pending')||{}).title`) === 'Queued — opens when this wave starts.');
    // Lot 4 §2 (2026-07-24) : plus de bouton ▶ dédié — le séparateur de la
    // PROCHAINE vague à ouvrir (g.nextWave) devient lui-même le bouton.
    check('aucun bouton ▶ dédié en bas de vague (supprimé, lot 4)',
      await cdp.evaluate(`!Array.from(document.querySelectorAll('#flow button')).some(b => b.textContent.includes('Launch wave'))`) === true);
    check('le séparateur de la vague 2 devient le bouton de lancement (▶ wave 2)',
      await cdp.evaluate(`(() => { const h = document.querySelector('#flow .wave-hdr.launch'); return h ? h.textContent.trim() : null; })()`) === '▶ wave 2');
    // Lot allègement 2026-07-24 — décision 3 amendée, portée par le lot 4 §2 sur
    // le séparateur : reste toujours cliquable mais atténué (classe dim) en
    // mode auto tant que rien n'est bloqué ; plus aucune bannière de succès.
    check('séparateur atténué (dim) en mode auto, vague non bloquée',
      await cdp.evaluate(`document.querySelector('#flow .wave-hdr.launch').classList.contains('dim')`) === true);
    check('… et pas "pri" (bleu) en même temps',
      await cdp.evaluate(`document.querySelector('#flow .wave-hdr.launch').classList.contains('pri')`) === false);
    check('aucune bannière de succès affichée', await cdp.evaluate(`!document.querySelector('#flow .banner.info')`) === true);
    // Clic sur le séparateur en mode auto/non bloqué → launchWave avec force:true
    // (même confirmation modale que l'ancien bouton, côté extension.js).
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`document.querySelector('#flow .wave-hdr.launch').click()`);
    const afterLaunchClick = await cdp.evaluate(`window.__sent`);
    check('clic séparateur (dim) → launchWave avec force: true',
      Array.isArray(afterLaunchClick) && afterLaunchClick.length === 1 && afterLaunchClick[0].type === 'launchWave'
      && afterLaunchClick[0].id === 'g1' && afterLaunchClick[0].wave === 2 && afterLaunchClick[0].force === true,
      JSON.stringify(afterLaunchClick));
    // Lot allègement v2 2026-07-24 : plus aucune ligne wave-sub, ni en mode
    // auto ni en mode manuel — l'info est déjà portée par les séparateurs de
    // vague, les icônes d'état et le bouton ▶.
    check('plus de ligne wave-sub (info déjà portée ailleurs)',
      await cdp.evaluate(`!document.querySelector('.wave-sub')`) === true);
    // Fix régression 2.20.0 : les gbtns (⌂ ✎ ⨯) ne doivent jamais rétrécir,
    // seul le titre du groupe (ellipsis) le peut.
    check('les gbtns (⌂ ✎ ⨯ +) ne rétrécissent jamais (flex: none)',
      await cdp.evaluate(`Array.from(document.querySelectorAll('.grp-head .gbtn')).every(b => getComputedStyle(b).flexShrink === '0')`) === true);
    const blockedWave = JSON.parse(JSON.stringify(grouped));
    blockedWave.groups[0].members[0].waveStatus = 'stale';
    blockedWave.groups[0].members[0].status = 'stale';
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: blockedWave })}, '*')`);
    await sleep(120);
    check('séparateur franc/bleu (pri) quand la vague est bloquée (chemin de secours)',
      await cdp.evaluate(`document.querySelector('#flow .wave-hdr.launch').classList.contains('pri')`) === true);
    // Bandeaux PROPORTIONNÉS (plan lien-mort-né 2026-08-04) : le rouge est
    // réservé à une conv vraiment interrompue à mi-travail.
    const bannerOf = `(() => {
      const b = document.querySelector('#flow .wave-ctrl .banner');
      return b ? { cls: b.className, text: b.textContent } : null;
    })()`;
    let banner = await cdp.evaluate(bannerOf);
    check('vrai stale (interrompue à mi-travail) → bandeau ROUGE',
      banner && banner.cls.indexOf('err') !== -1, JSON.stringify(banner));
    check('… et son texte ne prétend plus rien sur l\'onglet',
      banner && banner.text.indexOf('tab was closed') === -1, JSON.stringify(banner));
    // Étape 16 : la zone waveCtrl (bannières) ne recouvre pas l'axe du rail,
    // même règle que les séparateurs de vague (padding-left après l'axe). Le
    // padding est DANS la boîte de .wave-ctrl (sa propre rect ne bouge pas) —
    // c'est le CONTENU (la bannière) qu'il faut mesurer, comme wave-ghost/
    // wave-hdr mesurent déjà leur propre boîte décalée par marge/padding.
    const ctrlVsRail = await cdp.evaluate(`(() => {
      const railEl = document.querySelector('#flow .grp-rail');
      const rail = railEl.getBoundingClientRect();
      const banner = document.querySelector('#flow .wave-ctrl .banner').getBoundingClientRect();
      // Bord droit du TRAIT, pas de la boîte : depuis le crochet de fin de lot
      // (2026-08-17) la boîte s'étend jusqu'à la colonne de contenu, mais son
      // encre à hauteur des bannières se limite au border-left.
      return { railRight: rail.left + parseFloat(getComputedStyle(railEl).borderLeftWidth), bannerLeft: banner.left };
    })()`);
    check('waveCtrl (bannières) : commence après l\'axe du rail, ne le recouvre pas',
      ctrlVsRail.bannerLeft >= ctrlVsRail.railRight, JSON.stringify(ctrlVsRail));
    // Même vague, bloquée par un LIEN MORT-NÉ seulement : remède immédiat,
    // aucune perte — une info, pas une alerte.
    const lostWave = JSON.parse(JSON.stringify(blockedWave));
    lostWave.groups[0].members[0].status = 'unsent-lost';
    lostWave.groups[0].members[0].canRelaunch = true;
    lostWave.groups[0].members[0].canLink = true;
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: lostWave })}, '*')`);
    await sleep(120);
    banner = await cdp.evaluate(bannerOf);
    check('bloquée par le seul unsent-lost → bandeau INFO, jamais rouge',
      banner && banner.cls.indexOf('info') !== -1 && banner.cls.indexOf('err') === -1, JSON.stringify(banner));
    check('… avec le remède énoncé (Entrée dans l\'onglet, sinon Relaunch)',
      banner && /Enter/.test(banner.text) && /Relaunch/.test(banner.text), JSON.stringify(banner));
    check('… et l\'auto reste suspendu (le séparateur garde son chemin de secours)',
      await cdp.evaluate(`document.querySelector('#flow .wave-hdr.launch').classList.contains('pri')`) === true);
    // Mélange des deux dans la même vague : la conv interrompue prime.
    const mixedWave = JSON.parse(JSON.stringify(lostWave));
    mixedWave.groups[0].members[1].waveStatus = 'stale';
    mixedWave.groups[0].members[1].status = 'stale';
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: mixedWave })}, '*')`);
    await sleep(120);
    banner = await cdp.evaluate(bannerOf);
    check('stale + unsent-lost dans la même vague → rouge (la mauvaise nouvelle prime)',
      banner && banner.cls.indexOf('err') !== -1, JSON.stringify(banner));
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: blockedWave })}, '*')`);
    await sleep(120);
    const afterBlockedClick = await cdp.evaluate(`(() => {
      window.__sent = [];
      document.querySelector('#flow .wave-hdr.launch').click();
      return window.__sent;
    })()`);
    check('… clic sans force (pri, pas dim) → launchWave sans force',
      Array.isArray(afterBlockedClick) && afterBlockedClick.length === 1
      && afterBlockedClick[0].type === 'launchWave' && afterBlockedClick[0].force === undefined,
      JSON.stringify(afterBlockedClick));
    // Une vague PLUS LOIN en file que la prochaine à lancer garde bien
    // « — queued » — seule la prochaine (ici toujours la vague 2) devient ▶.
    const triWave = JSON.parse(JSON.stringify(grouped));
    triWave.groups[0].members.push({
      key: 'm4', prompt: 'Vague 3', wave: 3, asked: { model: null, effort: null },
      convId: null, status: 'queued', waveStatus: 'queued', canLink: false, canClose: false,
      note: '', hint: 'Queued — opens when this wave starts.',
    });
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: triWave })}, '*')`);
    await sleep(120);
    const triHdrTexts = await cdp.evaluate(`Array.from(document.querySelectorAll('#flow .wave-hdr')).map(h => h.textContent).join('|')`);
    check('3 vagues : la 2 (prochaine à lancer) devient ▶ wave 2, la 3 (plus loin) garde « — queued »',
      triHdrTexts.indexOf('▶ wave 2') !== -1 && triHdrTexts.indexOf('wave 3 — queued') !== -1, triHdrTexts);
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: grouped })}, '*')`);
    await sleep(120);
    // Lot 5 : la croix rouge (.m-out) est désormais l'UNIQUE action de sortie,
    // toujours visible, quel que soit le statut du membre — plus de chip vert
    // séparé ni de bascule sur canClose.
    check('la croix rouge (.m-out) est visible sur les 3 membres, quel que soit leur statut',
      await cdp.evaluate(`Array.from(document.querySelectorAll('.member')).every(m => m.querySelector('.m-out') && m.querySelector('.m-out').style.display !== 'none')`) === true,
      await cdp.evaluate(`Array.from(document.querySelectorAll('.member')).map(m => !!m.querySelector('.m-out') && m.querySelector('.m-out').style.display).join(',')`));
    check('replier le groupe masque ses membres',
      await cdp.evaluate(`(() => {
        const g = ${JSON.stringify(grouped)};
        g.groups[0].collapsed = true;
        window.postMessage({ type: 'state', state: g }, '*');
        return true;
      })()`) === true);
    await sleep(120);
    check('… body masqué et chevron retourné',
      await cdp.evaluate(`document.querySelector('.grp-body').classList.contains('collapsed') && document.querySelector('.grp .chevron').textContent === '▸'`) === true);
    // Dissolution : les conversations RESTENT, elles redeviennent des lignes plates.
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: STATE })}, '*')`);
    await sleep(150);
    check('groupe dissous → aucune conv perdue, aucune ligne fantôme',
      await cdp.evaluate(`document.querySelectorAll('#flow .grp').length`) === 0
      && await cdp.evaluate(`document.querySelectorAll('#flow > .conv').length`) === 6);
    check('… et l\'arc de la conv qui travaille a survécu au trajet groupe → liste plate',
      await cdp.evaluate(`document.querySelector('.ico-busy').getAnimations({ subtree: true })[0].playState`) === 'running');

    console.log('\n10. États de fin de vie d\'un membre — Link/croix rouge uniforme (lot 8, amendé lot 5)');
    // Un membre lié (convId) et un membre jamais lié (convId null), tous deux
    // encore DANS la vue (la conv liée est listée, onglet ouvert, terminée).
    const linkedInView = JSON.parse(JSON.stringify(STATE));
    linkedInView.conversations = [linkedInView.conversations[1]];   // c2, done
    linkedInView.conversations[0].tabOpen = true;
    linkedInView.groups = [{
      id: 'g8', name: 'Lot 8', hue: 90, collapsed: false,
      launchedWave: 1, nextWave: null, waveNotice: null,
      members: [
        { key: 'linked', prompt: 'Tâche liée à c2', wave: 1, asked: { model: 'sonnet', effort: 'medium' }, convId: 'c2', status: 'done', waveStatus: 'done', canLink: false, canClose: true, note: '', hint: '' },
        { key: 'fresh', prompt: 'Jamais liée', wave: 1, asked: { model: 'sonnet', effort: 'medium' }, convId: null, status: 'not-linked', waveStatus: 'launched', canLink: true, canClose: false, note: 'not linked yet', hint: 'Not linked to a conversation yet.' },
      ],
    }];
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: linkedInView })}, '*')`);
    await sleep(150);
    // Lot 5 : le chip vert « fermer & retirer » a disparu — le bouton de
    // retrait (.m-out) est désormais la SEULE action de sortie, présente quel
    // que soit le statut du membre. Depuis 2026-08-07 c'est une flèche en
    // overlay révélée au survol, jamais masquée par un display:none : ce que
    // ces checks vérifient est bien sa PRÉSENCE inconditionnelle.
    const memberInfo = `(() => {
      const members = Array.from(document.querySelectorAll('.member'));
      return members.map((m) => {
        const btns = Array.from(m.querySelectorAll('.m-foot button'));
        const find = (t) => btns.find((b) => b.textContent.trim() === t);
        const link = find('Link…');
        const relaunch = find('Relaunch');
        const remove = m.querySelector('.m-out');
        const note = m.querySelector('.m-note');
        return {
          linkDisplay: link ? link.style.display : 'ABSENT',
          relaunchDisplay: relaunch ? relaunch.style.display : 'ABSENT',
          removeDisplay: remove ? remove.style.display : 'ABSENT',
          noteText: note ? note.textContent : null,
        };
      });
    })()`;
    let info = await cdp.evaluate(memberInfo);
    check('membre lié et encore listé : Link… absent (convId prime sur la présence dans la vue)',
      info[0].linkDisplay === 'none', JSON.stringify(info[0]));
    check('… note vide (la ligne de conv réelle porte l\'info, pas de doublon)',
      info[0].noteText === '', JSON.stringify(info[0]));
    check('… onglet ouvert + terminé → le bouton de retrait (.m-out) est là',
      info[0].removeDisplay !== 'none', JSON.stringify(info[0]));
    check('membre jamais lié : Link… visible',
      info[1].linkDisplay !== 'none', JSON.stringify(info[1]));
    check('… note « not linked yet »', info[1].noteText === 'not linked yet', JSON.stringify(info[1]));
    check('membre jamais lié : bouton de retrait (.m-out) là aussi (action uniforme)',
      info[1].removeDisplay !== 'none', JSON.stringify(info[1]));
    check('« Relaunch » masqué partout tant qu\'aucun lien n\'est mort-né',
      info[0].relaunchDisplay === 'none' && info[1].relaunchDisplay === 'none',
      JSON.stringify(info.map((x) => x.relaunchDisplay)));

    // Clic sur le bouton de retrait d'un membre done + onglet ouvert → UN SEUL
    // message removeMember (étape 15 : métadonnées seules, plus jamais de
    // fermeture d'onglet — ni titre ni tabTitle à transporter).
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`document.querySelectorAll('.member')[0].querySelector('.m-out').click()`);
    const afterMergedClick = await cdp.evaluate(`window.__sent`);
    check('clic retrait (done + onglet ouvert) → removeMember (id du groupe + clé du membre)',
      Array.isArray(afterMergedClick) && afterMergedClick.length === 1
      && afterMergedClick[0].type === 'removeMember' && afterMergedClick[0].id === 'g8' && afterMergedClick[0].key === 'linked',
      JSON.stringify(afterMergedClick));

    // Même groupe, mais la conversation liée sort de la vue (onglet fermé via
    // « close ⨯ », ou simplement plus dans la fenêtre du panneau) : c'est
    // exactement le défaut constaté — Link… ne doit PAS réapparaître. Ce que
    // la table de vérité conclut alors (lot 10) : session morte + transcript +
    // done = état TERMINAL (`done-closed`). Depuis l'étape 11, ce statut n'a
    // même plus de ligne DU TOUT (filtrage au rendu) : la garantie « pas de
    // Link… » est donc totale — rien à cliquer, pas seulement un bouton masqué
    // sur une ligne encore visible.
    const linkedOutOfView = JSON.parse(JSON.stringify(linkedInView));
    linkedOutOfView.conversations = [];
    Object.assign(linkedOutOfView.groups[0].members[0], {
      status: 'done-closed', waveStatus: 'done', canLink: false, canClose: false,
      note: '✓ done · closed', hint: 'Finished — its tab has been closed.',
    });
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: linkedOutOfView })}, '*')`);
    await sleep(150);
    check('conv liée sortie de la vue ET terminée (done-closed) : sa ligne disparaît (étape 11)',
      await cdp.evaluate(`document.querySelectorAll('.member').length`) === 1);
    info = await cdp.evaluate(memberInfo);
    check('le membre jamais lié n\'est pas affecté par la sortie de vue d\'un autre membre',
      info[0].linkDisplay !== 'none' && info[0].noteText === 'not linked yet', JSON.stringify(info[0]));
    // Onglet jamais ouvert (membre jamais lancé, rien à fermer) → un clic sur
    // le retrait envoie toujours removeMember, sans jamais rien fermer. Le
    // membre done-closed d'à côté n'a plus de bouton à cliquer (ligne absente,
    // vérifié ci-dessus) : c'est le membre jamais lié qui porte ce cas.
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`document.querySelectorAll('.member')[0].querySelector('.m-out').click()`);
    const afterClosedClick = await cdp.evaluate(`window.__sent`);
    check('clic retrait (jamais lancée, rien à fermer) → removeMember',
      Array.isArray(afterClosedClick) && afterClosedClick.length === 1
      && afterClosedClick[0].type === 'removeMember' && afterClosedClick[0].title === undefined,
      JSON.stringify(afterClosedClick));

    console.log('\n10 (suite). Lien MORT-NÉ : « Relaunch » + re-lien manuel rouverts (plan 2026-08-04)');
    // Le membre est lié à un sessionId dont le process est mort SANS qu'un octet
    // soit parti : rien n'a jamais commencé sous cet id. member-truth.js rouvre
    // les deux sorties — Link… (étage 3) et Relaunch — sur ce SEUL statut.
    const lostLink = JSON.parse(JSON.stringify(linkedInView));
    lostLink.conversations = [];
    Object.assign(lostLink.groups[0].members[0], {
      status: 'unsent-lost', waveStatus: 'stale', canLink: true, canClose: false, canRelaunch: true,
      note: 'link lost before sending',
      hint: 'Its background process died before anything was sent. If the tab is still open, press Enter — it will link itself back. Otherwise use “Relaunch”.',
    });
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: lostLink })}, '*')`);
    await sleep(150);
    info = await cdp.evaluate(memberInfo);
    check('lien mort-né : « Relaunch » visible', info[0].relaunchDisplay !== 'none', JSON.stringify(info[0]));
    check('… et « Link… » revient (le seul membre lié qui redevient rattachable)',
      info[0].linkDisplay !== 'none', JSON.stringify(info[0]));
    check('… note honnête « link lost before sending » (plus rien d\'affirmé sur l\'onglet)',
      info[0].noteText === 'link lost before sending', JSON.stringify(info[0]));
    check('… le membre voisin, lui, n\'a pas de « Relaunch »',
      info[1].relaunchDisplay === 'none', JSON.stringify(info[1]));
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`(() => {
      const btns = Array.from(document.querySelectorAll('.member')[0].querySelectorAll('.m-foot button'));
      btns.find((b) => b.textContent.trim() === 'Relaunch').click();
    })()`);
    const afterRelaunch = await cdp.evaluate(`window.__sent`);
    check('clic « Relaunch » → relaunchMember (id du groupe + clé du membre)',
      Array.isArray(afterRelaunch) && afterRelaunch.length === 1
      && afterRelaunch[0].type === 'relaunchMember' && afterRelaunch[0].id === 'g8' && afterRelaunch[0].key === 'linked',
      JSON.stringify(afterRelaunch));

    console.log('\n10ter. Lot 4/5 — retirer inline uniforme, pied vide, intention, barré, débordement');
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: grouped })}, '*')`);
    await sleep(150);
    const footHeight = await cdp.evaluate(`(() => {
      const busyMember = Array.from(document.querySelectorAll('.member')).find(m => m.querySelector('.ico-busy'));
      return busyMember ? busyMember.querySelector('.m-foot').offsetHeight : null;
    })()`);
    check('pied sans action visible (membre busy, rien à proposer) : hauteur quasi nulle (plus de ligne pleine largeur)',
      footHeight !== null && footHeight <= 4, String(footHeight));
    // Clic sur le bouton de retrait d'une tâche jamais lancée → removeMember
    // (étape 15 : métadonnées seules, plus aucune fermeture d'onglet).
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`(() => {
      const m3 = Array.from(document.querySelectorAll('.member')).find(m => (m.querySelector('.m-prompt')||{}).textContent === 'Pas encore lancée');
      m3.querySelector('.m-out').click();
    })()`);
    const afterOutClick = await cdp.evaluate(`window.__sent`);
    check('clic « retirer » (tâche en file) → removeMember (id du groupe + clé du membre)',
      Array.isArray(afterOutClick) && afterOutClick.length === 1 && afterOutClick[0].type === 'removeMember'
      && afterOutClick[0].id === 'g1' && afterOutClick[0].key === 'm3', JSON.stringify(afterOutClick));
    // 2026-08-07 — RENVERSEMENT ASSUMÉ du lot 5 §2bis : le bouton de retrait
    // était un enfant du flux flex, précisément pour que l'ellipsis du titre
    // s'arrête avant lui. Mais un enfant de flux COÛTE sa largeur, y compris
    // quand il est invisible — c'est ce qui raccourcissait la barre de
    // contexte d'une ligne de groupe par rapport à une ligne plate (étape 13,
    // même diagnostic sur le chip « délier » de la master). L'exigence « 100 %
    // identiques » tranche : overlay, zéro emprise. Le recouvrement du texte
    // que le lot 5 fuyait est ramené à un survol, et masqué par un fond opaque.
    // Le fond du bouton se cale sur celui d'une ligne SURVOLÉE : c'est le seul
    // état où il se voit, et c'est ce qui lui permet de masquer proprement la
    // fin du titre qu'il recouvre. On pose la variable de thème (VS Code la
    // définit toujours ; une page nue, non) puis on vérifie que le fond calculé
    // vaut EXACTEMENT celui de la ligne survolée — pas juste « non transparent ».
    const outGeom = await cdp.evaluate(`(() => {
      document.documentElement.style.setProperty('--vscode-list-hoverBackground', '#2a2d2e');
      // Une ligne SÉLECTIONNÉE prend le fond de sélection, pas celui du survol
      // (règle :has plus bas dans la feuille) : on mesure donc sur un membre
      // qui n'est pas la conv active, sinon on testerait l'autre règle.
      const b = Array.from(document.querySelectorAll('.member'))
        .filter(function (m) { return !m.querySelector('.conv.active'); })[0].querySelector('.m-out');
      const s = getComputedStyle(b);
      // Lecture EAGER : getComputedStyle rend un objet VIVANT — lire ses
      // propriétés après avoir retiré la variable donnerait l'état d'après.
      const out = { position: s.position, opacity: s.opacity, bg: s.backgroundColor };
      const probe = document.createElement('span');
      probe.style.color = 'var(--vscode-list-hoverBackground)';
      document.body.appendChild(probe);
      out.hover = getComputedStyle(probe).color;
      probe.remove();
      document.documentElement.style.removeProperty('--vscode-list-hoverBackground');
      return out;
    })()`);
    check('.m-out est un OVERLAY (position: absolute) : zéro emprise sur la largeur de la ligne',
      outGeom.position === 'absolute', JSON.stringify(outGeom));
    check('… invisible au repos (opacity 0), fond calé sur celui d\'une ligne survolée (il masque la fin du titre)',
      outGeom.opacity === '0' && outGeom.bg === outGeom.hover, JSON.stringify(outGeom));
    // Plus aucune teinte d'ERREUR sur une ligne : ce geste ne ferme rien. On
    // compare à la couleur que --vscode-errorForeground prend RÉELLEMENT dans
    // ce rendu (posée puis relue), jamais à un littéral hexadécimal — le
    // navigateur ne rend jamais la chaîne source.
    const outPaint = await cdp.evaluate(`(() => {
      document.documentElement.style.setProperty('--vscode-errorForeground', '#f14c4c');
      const probe = document.createElement('span');
      probe.style.color = 'var(--vscode-errorForeground)';
      document.body.appendChild(probe);
      const err = getComputedStyle(probe).color;
      probe.remove();
      const btn = document.querySelector('.member .m-out');
      const s = getComputedStyle(btn);
      const out = { glyph: btn.textContent, err, color: s.color, border: s.borderTopColor };
      document.documentElement.style.removeProperty('--vscode-errorForeground');
      return out;
    })()`);
    check('… flèche de retrait et non plus une croix, et plus aucune teinte d\'erreur sur la ligne',
      outPaint.glyph === '⤴' && outPaint.color !== outPaint.err && outPaint.border !== outPaint.err,
      JSON.stringify(outPaint));

    console.log('\n10quater. Une tâche EN FILE n\'est pas plus épaisse qu\'une tâche lancée (2026-08-09)');
    // Signalé par l'user sur un groupe à 3 vagues : les lignes en file étaient
    // visiblement plus hautes que les lignes lancées. Cause — les mouveurs ◂/▸
    // étaient des enfants du flux du pied, affichés (à opacité 0) sur les SEULES
    // tâches en file : 15,2 px de pied pour un bouton qu'on ne voit pas. Même
    // leçon que le chip « délier » et la croix des membres, appliquée cette fois
    // à la HAUTEUR. L'état de ce check reproduit le cas signalé : il FAUT deux
    // vagues en file, sinon aucun mouveur n'est proposé et le bug ne se voit pas
    // (c'est très exactement pourquoi `grouped`, à vague 2 unique, le ratait).
    const threeWaves = JSON.parse(JSON.stringify(grouped));
    threeWaves.groups[0].members.push(
      { key: 'm4', prompt: 'Vague 3, en file elle aussi', wave: 3, asked: { model: 'opus', effort: 'high' }, convId: null, status: 'queued', waveStatus: 'queued', canLink: false, canClose: false, canRelaunch: false, note: '', hint: 'Queued — opens when this wave starts.' });
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: threeWaves })}, '*')`);
    await sleep(150);
    const rowH = await cdp.evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('#flow .member')).map(function (m) {
        const foot = m.querySelector('.m-foot');
        const mv = m.querySelector('.m-move');
        return {
          queued: !!m.querySelector('.m-pending'),
          h: Math.round(m.getBoundingClientRect().height * 10) / 10,
          foot: foot ? Math.round(foot.getBoundingClientRect().height * 10) / 10 : null,
          movers: mv ? Array.from(mv.querySelectorAll('.m-mv')).filter(function (b) { return getComputedStyle(b).display !== 'none'; }).length : 0,
          movePos: mv ? getComputedStyle(mv).position : null,
          movePE: mv ? getComputedStyle(mv).pointerEvents : null,
        };
      });
      return { rows: rows, launched: rows.filter(function (r) { return !r.queued; }), queued: rows.filter(function (r) { return r.queued; }) };
    })()`);
    check('au moins une tâche en file propose bien un mouveur ◂/▸ (sinon ce banc ne prouve rien)',
      rowH.queued.some(function (r) { return r.movers > 0; }), JSON.stringify(rowH.queued));
    check('… et elle n\'est JAMAIS plus haute qu\'une tâche lancée (le pied ne réserve plus rien)',
      rowH.queued.every(function (q) { return rowH.launched.every(function (l) { return q.h <= l.h; }); }),
      JSON.stringify(rowH.rows));
    check('… pied replié pour de bon (hauteur 0, pas seulement « petite »)',
      rowH.queued.every(function (q) { return q.foot === 0; }), JSON.stringify(rowH.queued));
    check('les mouveurs sont un OVERLAY, clics désarmés au repos (ils ne volent pas le clic de la ligne)',
      rowH.rows.every(function (r) { return r.movePos === 'absolute' && r.movePE === 'none'; }), JSON.stringify(rowH.rows));
    // Le survol ne doit RIEN pousser : même hauteur, mouveurs et ⤴ côte à côte
    // sans se recouvrir, tout à l'intérieur de la ligne.
    const hoverGeom = await cdp.evaluate(`(() => {
      const m = Array.from(document.querySelectorAll('#flow .member')).find(function (x) { return x.querySelector('.m-pending'); });
      const before = m.getBoundingClientRect().height;
      const ev = function (t) { m.dispatchEvent(new MouseEvent(t, { bubbles: true })); };
      ev('mouseover'); ev('mouseenter');
      const head = m.querySelector('.m-head').getBoundingClientRect();
      const mv = m.querySelector('.m-move').getBoundingClientRect();
      const out = m.querySelector('.m-out').getBoundingClientRect();
      return { before: Math.round(before * 10) / 10, after: Math.round(m.getBoundingClientRect().height * 10) / 10,
               overlap: Math.round(mv.right) > Math.round(out.left),
               inside: Math.round(mv.left) >= Math.round(head.left) && Math.round(mv.right) <= Math.round(head.right) };
    })()`);
    check('survol : la ligne ne grandit pas d\'un pixel',
      hoverGeom.before === hoverGeom.after, JSON.stringify(hoverGeom));
    check('… mouveurs et ⤴ côte à côte, dans les bords de la ligne',
      hoverGeom.overlap === false && hoverGeom.inside === true, JSON.stringify(hoverGeom));

    // Modèle · effort PRÉVUS grisés sur une tâche en file (m3, pas encore liée).
    const intentState = JSON.parse(JSON.stringify(grouped));
    intentState.groups[0].members[2].asked = { model: 'haiku', effort: null };
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: intentState })}, '*')`);
    await sleep(150);
    const intentInfo = await cdp.evaluate(`(() => {
      const el = document.querySelector('.m-pending .m-intent');
      return el ? { text: el.textContent, title: el.title } : null;
    })()`);
    check('modèle · effort d\'intention affichés en grisé/italique sur une tâche en file (haiku, sans effort)',
      intentInfo && intentInfo.text === 'haiku', JSON.stringify(intentInfo));
    check('… tooltip « intention de lancement »',
      !!intentInfo && intentInfo.title.indexOf('Launch intention') !== -1, JSON.stringify(intentInfo));

    // Terminée · onglet fermé : intitulé barré ; réouverture de l'onglet → barré effacé.
    const closedTabState = JSON.parse(JSON.stringify(STATE));
    closedTabState.conversations[1].tabOpen = false;   // c2, state 'done'
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: closedTabState })}, '*')`);
    await sleep(150);
    check('conv terminée avec l\'onglet fermé : intitulé barré',
      await cdp.evaluate(`getComputedStyle(document.querySelectorAll('#flow > .conv')[1].querySelector('.title')).textDecorationLine`) === 'line-through');
    closedTabState.conversations[1].tabOpen = true;
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: closedTabState })}, '*')`);
    await sleep(150);
    check('… réouverture de l\'onglet : le barré disparaît de lui-même (découle de tabOpen, aucune mémoire)',
      await cdp.evaluate(`getComputedStyle(document.querySelectorAll('#flow > .conv')[1].querySelector('.title')).textDecorationLine`) === 'none');
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: STATE })}, '*')`);
    await sleep(150);

    // Débordement horizontal : prompt de tâche en file très long, SANS espaces
    // (pire cas insécable — constat user ~06h45).
    const overflowState = JSON.parse(JSON.stringify(grouped));
    overflowState.groups[0].members[2].prompt = 'x'.repeat(400);
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: overflowState })}, '*')`);
    await sleep(150);
    const scrollCheck = await cdp.evaluate(`({ scrollWidth: document.body.scrollWidth, clientWidth: document.body.clientWidth })`);
    check('aucun débordement horizontal même avec un prompt de 400 caractères sans espaces',
      scrollCheck.scrollWidth <= scrollCheck.clientWidth, JSON.stringify(scrollCheck));
    // 10bis part du groupe g8 laissé par la section 10 (mono-vague, nextWave
    // null) — le restaurer avant d'y enchaîner.
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: linkedOutOfView })}, '*')`);
    await sleep(150);

    console.log('\n10bis. Ajout en file à un groupe existant (plan ajout-tache 2026-07-24)');
    check('ligne fantôme « + nouvelle vague » présente même sur un groupe fini (mono-vague, nextWave null)',
      await cdp.evaluate(`!!document.querySelector('#flow .wave-ghost')`) === true);

    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: grouped })}, '*')`);
    await sleep(150);
    // Restylage (lot chip fermeture 2026-07-24) : le petit « + » du séparateur
    // a disparu ; la ligne d'ajout pleine largeur (.wave-add-row) n'existe
    // dans le DOM QUE pour les vagues strictement en file — jamais masquée
    // par un style, absente pour de vrai sur les autres.
    const waveAddRowsCount = await cdp.evaluate(`document.querySelectorAll('#flow .wave-add-row').length`);
    check('« + ajouter à cette vague » absent sur la vague 1 (déjà lancée / en cours) et présent sur la vague 2 (en file) seulement',
      waveAddRowsCount === 1, String(waveAddRowsCount));
    check('ligne fantôme toujours présente (groupe multi-vagues)',
      await cdp.evaluate(`!!document.querySelector('#flow .wave-ghost')`) === true);

    // Masquage à vide (2026-08-15, constat user) : les deux fantômes existent
    // dans le DOM (queries ci-dessus) mais ne doivent RIEN peser tant qu'aucune
    // tâche active n'est prête à être déposée — sinon on n'économise rien et
    // on attire l'œil vers un bouton qui ne ferait que rendre le focus au champ.
    const ghostVisEmpty = await cdp.evaluate(`(() => {
      const ghostNew = document.querySelector('#flow .wave-ghost.wave-new');
      const addRow = document.querySelector('#flow .wave-add-row');
      return {
        ghostNewDisplay: ghostNew ? getComputedStyle(ghostNew).display : null,
        addRowDisplay: addRow ? getComputedStyle(addRow).display : null,
      };
    })()`);
    check('champ prompt vide : « + nouvelle vague » et « + cette vague » masqués (display:none), pas retirés du DOM',
      ghostVisEmpty.ghostNewDisplay === 'none' && ghostVisEmpty.addRowDisplay === 'none', JSON.stringify(ghostVisEmpty));

    // Lot B densité (2026-08-09) — les deux fantômes ne font plus qu'UNE
    // rangée. Un groupe se terminait par deux lignes pleine largeur empilées
    // (~52 px) pour deux actions voisines ; elles partagent maintenant la même
    // bande, chacune sur sa moitié. Ce qui est vérifié ici, c'est la
    // GÉOMÉTRIE (une seule rangée, deux boîtes disjointes) — les règles qui
    // les séparent, elles, sont testées juste en dessous et en 10ter, sur ces
    // mêmes nœuds : rien n'a bougé de leur logique, seulement de leur parent.
    // Depuis le masquage à vide (2026-08-15), les deux fantômes n'occupent de
    // la géométrie que si le champ prompt porte une tâche active — le poser
    // ici est la précondition de tout ce bloc, pas juste de ce test-ci.
    await cdp.evaluate(`(() => { const ta = document.querySelector('.task-top textarea.inp'); ta.value = 'Geometrie fantome'; ta.dispatchEvent(new Event('input')); })()`);
    const ghostVisFilled = await cdp.evaluate(`(() => {
      const ghostNew = document.querySelector('#flow .wave-ghost.wave-new');
      const addRow = document.querySelector('#flow .wave-add-row');
      return {
        ghostNewDisplay: ghostNew ? getComputedStyle(ghostNew).display : null,
        addRowDisplay: addRow ? getComputedStyle(addRow).display : null,
      };
    })()`);
    check('… et réapparaissent dès qu\'une tâche active existe dans le champ',
      ghostVisFilled.ghostNewDisplay !== 'none' && ghostVisFilled.addRowDisplay !== 'none', JSON.stringify(ghostVisFilled));
    const mergedGhost = await cdp.evaluate(`(() => {
      const line = document.querySelector('#flow .ghost-line');
      const addRow = line && line.querySelector('.wave-add-row');
      const ghostNew = line && line.querySelector('.wave-ghost:not(.wave-add-row)');
      if (!line || !addRow || !ghostNew) return { line: !!line, addRow: !!addRow, ghostNew: !!ghostNew };
      const l = line.getBoundingClientRect(), a = addRow.getBoundingClientRect(), n = ghostNew.getBoundingClientRect();
      const body = line.parentElement;
      // Le rail est un enfant du corps en position absolue, que place()
      // repousse en fin de liste au fil des insertions par index : il ne dit
      // rien de l'ordre VISUEL, on l'écarte avant de chercher le dernier.
      const flow = Array.from(body.children).filter((c) => !c.classList.contains('grp-rail'));
      return {
        line: true, addRow: true, ghostNew: true,
        distinct: addRow !== ghostNew,
        sameTop: Math.abs(a.top - n.top) < 0.5,
        sameBottom: Math.abs(a.bottom - n.bottom) < 0.5,
        disjoint: a.right <= n.left + 0.5,
        addFirst: a.left < n.left,
        lineHeight: l.height, cellHeight: a.height,
        addRowsInBody: document.querySelectorAll('#flow .grp-body > .wave-add-row').length,
        ghostLines: document.querySelectorAll('#flow .ghost-line').length,
        closesGroup: body.classList.contains('grp-body') && flow[flow.length - 1] === line,
      };
    })()`);
    check('les deux fantômes sont deux nœuds DISTINCTS sur la même rangée (mêmes haut et bas)',
      mergedGhost.distinct === true && mergedGhost.sameTop === true && mergedGhost.sameBottom === true,
      JSON.stringify(mergedGhost));
    check('… boîtes DISJOINTES, « + cette vague » à gauche, « + nouvelle vague » à droite (un clic ne peut pas se tromper de cible)',
      mergedGhost.disjoint === true && mergedGhost.addFirst === true, JSON.stringify(mergedGhost));
    check('… la rangée ne coûte que la hauteur d\'UNE ligne (plus deux empilées)',
      mergedGhost.lineHeight <= mergedGhost.cellHeight + 0.5, JSON.stringify(mergedGhost));
    check('… plus aucune ligne d\'ajout pleine largeur en enfant du corps (la dernière vague en file a fusionné)',
      mergedGhost.addRowsInBody === 0 && mergedGhost.ghostLines === 1, JSON.stringify(mergedGhost));
    check('… et c\'est cette rangée unique qui ferme le groupe',
      mergedGhost.closesGroup === true, JSON.stringify(mergedGhost));

    // Deux vagues en file : SEULE la dernière fusionne. Celle du milieu garde
    // sa rangée, au contact des membres de SA vague — la fusion est une
    // économie de fin de groupe, pas une migration de toutes les lignes
    // d'ajout vers le bas (elles ne diraient plus à quelle vague elles
    // ajoutent).
    const twoQueued = JSON.parse(JSON.stringify(grouped));
    twoQueued.groups[0].members.push({
      key: 'm4', prompt: 'Encore plus tard', wave: 3, asked: { model: null, effort: null }, convId: null,
      status: 'queued', waveStatus: 'queued', canLink: false, canClose: false, note: '', hint: 'Queued — opens when this wave starts.',
    });
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: twoQueued })}, '*')`);
    await sleep(150);
    const midWave = await cdp.evaluate(`(() => {
      const body = document.querySelector('#flow .grp-body');
      const inBody = Array.from(body.querySelectorAll(':scope > .wave-add-row'));
      const merged = document.querySelector('#flow .ghost-line .wave-add-row');
      const next = inBody[0] ? inBody[0].nextElementSibling : null;
      return {
        inBody: inBody.length,
        merged: !!merged,
        mergedIsOther: !!merged && merged !== inBody[0],
        nextIsWaveHeader: !!next && next.classList.contains('wave-hdr'),
        total: document.querySelectorAll('#flow .wave-add-row').length,
      };
    })()`);
    check('vagues 2 et 3 en file : une seule ligne d\'ajout reste dans le corps (la vague 2), l\'autre a fusionné',
      midWave.total === 2 && midWave.inBody === 1 && midWave.merged === true && midWave.mergedIsOther === true,
      JSON.stringify(midWave));
    check('… et celle de la vague 2 reste au contact de ses membres (suivie de l\'en-tête de la vague 3)',
      midWave.nextIsWaveHeader === true, JSON.stringify(midWave));
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: grouped })}, '*')`);
    await sleep(150);

    // Prompt rempli → clic sur la ligne d'ajout de la vague 2 → addTaskToGroup, champ vidé.
    await cdp.evaluate(`(() => { const ta = document.querySelector('.task-top textarea.inp'); ta.value = 'Nouvelle tache en file'; ta.dispatchEvent(new Event('input')); })()`);
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`document.querySelector('#flow .wave-add-row').click()`);
    const afterAdd = await cdp.evaluate(`window.__sent`);
    check('clic ligne d\'ajout vague en file → addTaskToGroup (id du groupe, vague, prompt)',
      Array.isArray(afterAdd) && afterAdd.length === 1 && afterAdd[0].type === 'addTaskToGroup'
      && afterAdd[0].id === 'g1' && afterAdd[0].wave === 2 && afterAdd[0].task.prompt === 'Nouvelle tache en file',
      JSON.stringify(afterAdd));
    check('champ prompt vidé après dépôt',
      await cdp.evaluate(`document.querySelector('.task-top textarea.inp').value`) === '');

    // Prompt vide → clic = aucun message, focus rendu au champ (invitation à taper).
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`document.querySelector('#flow .wave-add-row').click()`);
    const afterEmptyClick = await cdp.evaluate(`window.__sent`);
    check('prompt vide : aucun message envoyé', Array.isArray(afterEmptyClick) && afterEmptyClick.length === 0, JSON.stringify(afterEmptyClick));
    check('… et le focus revient au champ prompt',
      await cdp.evaluate(`document.activeElement === document.querySelector('.task-top textarea.inp')`) === true);

    // Survol de la ligne d'ajout : la zone prompt passe en surbrillance (lien visuel).
    await cdp.evaluate(`document.querySelector('.task-top textarea.inp').value = 'x'`);
    await cdp.evaluate(`document.querySelector('#flow .wave-add-row').dispatchEvent(new MouseEvent('mouseenter'))`);
    check('survol de la ligne d\'ajout : la zone prompt passe en surbrillance',
      await cdp.evaluate(`document.querySelector('.task-top textarea.inp').classList.contains('hl-target')`) === true);
    await cdp.evaluate(`document.querySelector('#flow .wave-add-row').dispatchEvent(new MouseEvent('mouseleave'))`);
    check('fin du survol : surbrillance retirée',
      await cdp.evaluate(`document.querySelector('.task-top textarea.inp').classList.contains('hl-target')`) === false);

    // Fix orpheline « + add to this wave » (constat user 2026-08-05) : une
    // vague en file qui passe à lancée doit purger sa ligne d'ajout, pas la
    // laisser collée en fin de corps (waveNums la contient encore, seul son
    // statut queued change).
    const waveLaunched = JSON.parse(JSON.stringify(grouped));
    waveLaunched.groups[0].launchedWave = 2;
    waveLaunched.groups[0].nextWave = null;
    waveLaunched.groups[0].members[2].waveStatus = 'launched';
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: waveLaunched })}, '*')`);
    await sleep(150);
    check('vague 2 lancée : sa ligne « + add to this wave » disparaît (plus d\'orpheline en fin de corps)',
      await cdp.evaluate(`document.querySelectorAll('#flow .wave-add-row').length`) === 0);
    // … et la rangée fusionnée retombe sur son seul occupant : « + nouvelle
    // vague » reprend TOUTE la largeur, comme avant le lot B. La cellule
    // d'ajout est absente du DOM, jamais masquée par un style — un enfant de
    // flux coûterait sa place même invisible (invariant maison, cf. le pied
    // des membres en file et la croix des lignes de groupe).
    // Le champ a été vidé par le dépôt plus haut (l.~1266) : reposer une tâche
    // active, sinon « + nouvelle vague » elle-même est masquée à vide et ce
    // test mesurerait une géométrie nulle, pas la fusion qu'il vérifie.
    await cdp.evaluate(`(() => { const ta = document.querySelector('.task-top textarea.inp'); ta.value = 'Geometrie fantome solo'; ta.dispatchEvent(new Event('input')); })()`);
    const soloGhost = await cdp.evaluate(`(() => {
      const line = document.querySelector('#flow .ghost-line');
      if (!line) return { line: false };
      const cell = line.querySelector('.wave-ghost');
      const l = line.getBoundingClientRect(), c = cell.getBoundingClientRect();
      return { line: true, children: line.children.length, lineWidth: l.width, cellWidth: c.width };
    })()`);
    check('… la rangée fantôme reste, avec « + nouvelle vague » seule sur toute la largeur',
      soloGhost.line === true && soloGhost.children === 1
      && Math.abs(soloGhost.lineWidth - soloGhost.cellWidth) < 0.5, JSON.stringify(soloGhost));
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: grouped })}, '*')`);
    await sleep(150);

    // Ligne fantôme → nouvelle vague (wave: null).
    await cdp.evaluate(`(() => { const ta = document.querySelector('.task-top textarea.inp'); ta.value = 'Ligne fantome'; ta.dispatchEvent(new Event('input')); })()`);
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`document.querySelector('#flow .wave-ghost:not(.wave-add-row)').click()`);
    const afterGhost = await cdp.evaluate(`window.__sent`);
    check('clic ligne fantôme → addTaskToGroup avec wave: null (nouvelle vague)',
      Array.isArray(afterGhost) && afterGhost.length === 1 && afterGhost[0].type === 'addTaskToGroup' && afterGhost[0].wave === null,
      JSON.stringify(afterGhost));
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: STATE })}, '*')`);
    await sleep(150);

    console.log('\n10ter. Coller un bloc multi-vagues DANS un groupe existant (plan repli-auto étape 10)');
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: grouped })}, '*')`);
    await sleep(150);
    const multiBlock = '```claude-convs\nmodel: sonnet\neffort: medium\nstage: 1\nPremiere tache\n[---]\nmodel: opus\neffort: high\nstage: 2\nDeuxieme tache\n```';
    await cdp.evaluate(`(() => {
      const ta = document.querySelector('.task-top textarea.inp');
      ta.value = ${JSON.stringify(multiBlock)};
      ta.dispatchEvent(new Event('change'));
    })()`);
    await sleep(50);
    check('bloc reconnu : 2 tâches préremplies (mode étendu)',
      await cdp.evaluate(`document.querySelectorAll('#batchForm .task').length`) === 2);

    // Les deux cibles de cette section vivent sur la MÊME rangée depuis le lot
    // B densité : c'est exactement ce que la fusion ne doit pas confondre —
    // l'une refuse un bloc multi-tâches, l'autre le transfère en entier après
    // confirmation. La vérifier ici, c'est prouver que les deux règles
    // s'exercent bien sur des cellules voisines et non sur un bouton unique.
    check('(mise en place) les deux cibles testées ci-dessous sont bien les deux cellules de la MÊME rangée fantôme',
      await cdp.evaluate(`(() => {
        const line = document.querySelector('#flow .ghost-line');
        const a = document.querySelector('#flow .wave-add-row');
        const n = document.querySelector('#flow .wave-ghost:not(.wave-add-row)');
        return !!line && a.parentElement === line && n.parentElement === line && a !== n;
      })()`) === true);

    // « + ajouter à cette vague » (vague 2, en file) avec un bloc multi-tâches
    // dans le champ → REFUS, aucun message, le formulaire n'est PAS vidé.
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`document.querySelector('#flow .wave-add-row').click()`);
    const afterRefusal = await cdp.evaluate(`window.__sent`);
    check('« + ajouter à cette vague » sur un bloc multi-tâches → aucun message envoyé (pas de télescopage silencieux)',
      Array.isArray(afterRefusal) && afterRefusal.length === 0, JSON.stringify(afterRefusal));
    check('refus signalé en bannière', /multi-wave/i.test(await cdp.evaluate(`document.querySelector('#batchForm .banner')?.textContent || ''`)));
    check('le formulaire garde ses 2 tâches (rien de transféré)',
      await cdp.evaluate(`document.querySelectorAll('#batchForm .task').length`) === 2);

    // « + nouvelle vague » (ligne fantôme) avec le même bloc → confirmation
    // affichée, RIEN envoyé tant qu'elle n'est pas validée.
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`document.querySelector('#flow .wave-ghost:not(.wave-add-row)').click()`);
    const afterGhostMulti = await cdp.evaluate(`window.__sent`);
    check('clic ligne fantôme sur bloc multi-tâches → AUCUN message avant confirmation',
      Array.isArray(afterGhostMulti) && afterGhostMulti.length === 0, JSON.stringify(afterGhostMulti));
    const confirmText = await cdp.evaluate(`document.querySelectorAll('#batchForm .banner.info .btn')[1]?.closest('.banner').textContent || ''`);
    check('bannière de confirmation : compte tâches/vagues, group:/session: absents du bloc → rien à signaler dessus',
      /2/.test(confirmText) && !/ignored/i.test(confirmText), confirmText);

    // Annuler : la bannière disparaît, le formulaire est intact, rien envoyé.
    await cdp.evaluate(`document.querySelectorAll('#batchForm .banner.info .btn')[0].click()`);
    check('Annuler : bannière de confirmation disparue', await cdp.evaluate(`!document.querySelector('#batchForm .banner.info .btn.pri')`));
    check('Annuler : les 2 tâches sont toujours dans le formulaire',
      await cdp.evaluate(`document.querySelectorAll('#batchForm .task').length`) === 2);
    check('Annuler : toujours aucun message envoyé', await cdp.evaluate(`window.__sent.length`) === 0);

    // Re-déclenche puis CONFIRME : un seul message addTasksToGroup, vagues
    // RELATIVES (1,2 — le décalage sur la dernière vague du groupe se fait
    // côté extension, sur son état à jour), champ vidé après transfert.
    await cdp.evaluate(`document.querySelector('#flow .wave-ghost:not(.wave-add-row)').click()`);
    await cdp.evaluate(`document.querySelectorAll('#batchForm .banner.info .btn')[1].click()`);
    const afterConfirm = await cdp.evaluate(`window.__sent`);
    check('Confirmer → un seul addTasksToGroup, groupe cible, 2 tâches, vagues relatives 1 et 2, model/effort de section',
      Array.isArray(afterConfirm) && afterConfirm.length === 1 && afterConfirm[0].type === 'addTasksToGroup'
      && afterConfirm[0].id === 'g1' && afterConfirm[0].tasks.length === 2
      && afterConfirm[0].tasks[0].wave === 1 && afterConfirm[0].tasks[0].model === 'sonnet' && afterConfirm[0].tasks[0].effort === 'medium'
      && afterConfirm[0].tasks[1].wave === 2 && afterConfirm[0].tasks[1].model === 'opus' && afterConfirm[0].tasks[1].effort === 'high',
      JSON.stringify(afterConfirm));
    check('champ vidé après le transfert (retour au formulaire simple, une tâche vierge)',
      await cdp.evaluate(`document.querySelectorAll('#batchForm .task').length`) === 1
      && await cdp.evaluate(`document.querySelector('.task-top textarea.inp').value`) === '');

    // group:/session: du bloc → mentionnés dans la confirmation (ignorés dans ce mode).
    const namedBlock = '```claude-convs\ngroup: Nom du bloc\nsession: fake-token\nmodel: sonnet\nstage: 1\nSeule tache\n[---]\nmodel: opus\nstage: 2\nAutre tache\n```';
    await cdp.evaluate(`(() => {
      const ta = document.querySelector('.task-top textarea.inp');
      ta.value = ${JSON.stringify(namedBlock)};
      ta.dispatchEvent(new Event('change'));
    })()`);
    await sleep(50);
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`document.querySelector('#flow .wave-ghost:not(.wave-add-row)').click()`);
    const namedConfirmText = await cdp.evaluate(`document.querySelectorAll('#batchForm .banner.info .btn')[1]?.closest('.banner').textContent || ''`);
    check('group: présent dans le bloc → signalé comme ignoré dans la confirmation',
      /ignored/i.test(namedConfirmText) && /Nom du bloc/.test(namedConfirmText), namedConfirmText);
    // Referme proprement (Annuler) pour ne pas polluer la suite du banc.
    await cdp.evaluate(`document.querySelectorAll('#batchForm .banner.info .btn')[0].click()`);
    // Annuler ne remet le formulaire QU'à « pas de transfert en attente » — il
    // garde les 2 tâches du bloc (comportement voulu, testé plus haut). Les
    // sections suivantes du banc supposent le formulaire simple d'origine :
    // le Cancel du formulaire (pas celui de la bannière, déjà fermée) le fait.
    await cdp.evaluate(`Array.from(document.querySelectorAll('#batchForm button')).find((b) => b.textContent === 'Cancel')?.click()`);

    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: STATE })}, '*')`);
    await sleep(150);

    console.log('\n11. Lot 10 — l\'instant du « Create » : onglets ouverts, RIEN envoyé');
    // Le cas constaté en v2.18.5/6 : aucune conversation n'est encore listée
    // (le transcript naît au premier Entrée), donc la vue ne sait rien — et le
    // panneau affichait « ✓ done · closed » sur des tâches qui venaient de
    // s'ouvrir, avec un bandeau rouge « interrupted or went stale ».
    const justCreated = JSON.parse(JSON.stringify(STATE));
    justCreated.conversations = [];
    justCreated.groups = [{
      id: 'g10', name: 'Batch tout neuf', hue: 30, collapsed: false,
      launchedWave: 1, nextWave: 2, waveNotice: null,
      members: [
        { key: 'a', prompt: 'Tâche A', wave: 1, asked: { model: 'opus', effort: 'high' }, convId: 's-a', status: 'inserted', waveStatus: 'launched', canLink: false, canClose: false, note: 'press Enter in the tab', hint: 'Tab open with the prompt inserted — press Enter to start it.' },
        { key: 'b', prompt: 'Tâche B', wave: 1, asked: { model: 'opus', effort: 'high' }, convId: 's-b', status: 'inserted', waveStatus: 'launched', canLink: false, canClose: false, note: 'press Enter in the tab', hint: 'Tab open with the prompt inserted — press Enter to start it.' },
        { key: 'c', prompt: 'Tâche C', wave: 2, asked: { model: 'sonnet', effort: 'medium' }, convId: null, status: 'queued', waveStatus: 'queued', canLink: false, canClose: false, note: '', hint: 'Queued — opens when this wave starts.' },
      ],
    }];
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: justCreated })}, '*')`);
    await sleep(150);
    const fresh = await cdp.evaluate(`(() => {
      const notes = Array.from(document.querySelectorAll('#flow .m-note')).map(n => n.textContent);
      const links = Array.from(document.querySelectorAll('#flow .member')).map(m => {
        const b = Array.from(m.querySelectorAll('.m-foot button')).find(x => x.textContent.trim() === 'Link…');
        return b ? b.style.display : 'ABSENT';
      });
      return {
        notes: notes,
        links: links,
        err: !!document.querySelector('#flow .banner.err'),
        count: (document.querySelector('.grp-count') || {}).textContent,
        pendingTitle: (document.querySelector('#flow .m-pending') || {}).title,
      };
    })()`);
    check('aucune tâche n\'est déclarée terminée (0/3 done)', fresh.count === '0/3 done', JSON.stringify(fresh));
    check('aucune note « ✓ done · closed » sur des tâches qui viennent de s\'ouvrir',
      fresh.notes.every((n) => n.indexOf('done') === -1), JSON.stringify(fresh.notes));
    check('… elles disent « press Enter in the tab »',
      fresh.notes.filter((n) => n === 'press Enter in the tab').length === 2, JSON.stringify(fresh.notes));
    check('aucun bandeau rouge « ça ne finira pas tout seul » (l\'auto n\'est pas suspendu)',
      fresh.err === false);
    check('aucun Link… proposé (les membres SONT liés, la vue ne les connaît juste pas encore)',
      fresh.links.every((d) => d === 'none'), JSON.stringify(fresh.links));
    check('infobulle de la ligne en attente : celle de la table de vérité',
      fresh.pendingTitle === 'Tab open with the prompt inserted — press Enter to start it.', fresh.pendingTitle);

    console.log('\n12. Lot 10 (livrable secondaire) + lot 12 — lanceur toujours visible, en-têtes de vague');
    // Lot 12 : plus de bouton « + New batch » à cliquer — le formulaire (une
    // tâche vierge) est déjà là au chargement du panneau. En mode simple (une
    // seule tâche), aucun en-tête de vague ne doit apparaître (rien à en dire).
    const formSimple = await cdp.evaluate(`(() => {
      return { texts: Array.from(document.querySelectorAll('#batchForm .wave-hdr')).map(h => h.textContent) };
    })()`);
    check('formulaire toujours visible dès le chargement (pas de bouton à cliquer)',
      Array.isArray(formSimple.texts));
    check('mode simple (une seule tâche) : aucun en-tête de vague affiché',
      formSimple.texts.length === 0, JSON.stringify(formSimple));
    // « + Add task » étend automatiquement en mode « batch » (lot 12 §2) :
    // 2 tâches dans la même vague → l'en-tête annonce le parallélisme (lot 10).
    const formHdrs = await cdp.evaluate(`(() => {
      const btn = Array.from(document.querySelectorAll('#batchForm button')).find(b => b.textContent.indexOf('Add task') !== -1);
      if (!btn) return { error: 'no + Add task button' };
      btn.click();
      return { texts: Array.from(document.querySelectorAll('#batchForm .wave-hdr')).map(h => h.textContent) };
    })()`);
    check('mode étendu (2 tâches, 1 vague) : l\'en-tête annonce le parallélisme',
      !!formHdrs.texts && formHdrs.texts.length === 1 && formHdrs.texts[0] === '1 wave — all parallel',
      JSON.stringify(formHdrs));
    const formHdrs2 = await cdp.evaluate(`(() => {
      const btn = Array.from(document.querySelectorAll('#batchForm button')).find(b => b.textContent.indexOf('Add wave divider') !== -1);
      if (!btn) return { error: 'no add-wave button' };
      btn.click();
      return { texts: Array.from(document.querySelectorAll('#batchForm .wave-hdr')).map(h => h.textContent) };
    })()`);
    check('… et dès qu\'une seconde vague existe, les en-têtes redeviennent « wave N »',
      !!formHdrs2.texts && formHdrs2.texts.join('|') === 'wave 1|wave 2', JSON.stringify(formHdrs2));

    console.log('\n12b. Lot 12 §1 — le champ « Group name » apparaît/disparaît avec le nombre de tâches');
    const groupFieldExtended = await cdp.evaluate(`(() => {
      return { present: !!Array.from(document.querySelectorAll('#batchForm .fld-label')).find(l => l.textContent.indexOf('Group name') !== -1) };
    })()`);
    check('mode étendu (3 tâches après les clics précédents) : champ « Group name » affiché',
      groupFieldExtended.present === true, JSON.stringify(groupFieldExtended));
    // Retour à une seule tâche (suppression des deux ajoutées ci-dessus) :
    // retour au mode simple — « une seule tâche crée une conversation simple,
    // pas de groupe » (lot 2), donc le champ n'a plus lieu d'être affiché.
    await cdp.evaluate(`(() => {
      Array.from(document.querySelectorAll('#batchForm .xdel')).slice(1).forEach(b => b.click());
    })()`);
    const groupFieldSimple = await cdp.evaluate(`(() => ({
      present: !!Array.from(document.querySelectorAll('#batchForm .fld-label')).find(l => l.textContent.indexOf('Group name') !== -1),
      taskCount: document.querySelectorAll('#batchForm .task').length,
    }))()`);
    check('retour à une seule tâche : le champ « Group name » disparaît',
      groupFieldSimple.present === false && groupFieldSimple.taskCount === 1, JSON.stringify(groupFieldSimple));

    console.log('\n12c. Lot 14 — plus de bouton « inherit » : pré-sélection sur le défaut résolu');
    // Un prompt vide désactive déjà Create pour sa propre raison (rien à
    // lancer) — il faut en taper un pour isoler la garde-fou du lot 14 (« un
    // modèle/effort concret est requis pour CETTE tâche »).
    await cdp.evaluate(`(() => {
      const ta = document.querySelector('#batchForm .task textarea');
      ta.value = 'Une tâche à lancer';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const noResolution = await cdp.evaluate(`(() => {
      const pairs = Array.from(document.querySelectorAll('#batchForm .task .pair'));
      const modelPair = pairs.find(p => p.querySelector('.lbl').textContent === 'model');
      const labels = Array.from(modelPair.querySelectorAll('.seg button')).map(b => b.textContent);
      const on = modelPair.querySelector('.seg button.on');
      const createBtn = Array.from(document.querySelectorAll('#batchForm button')).find(b => b.textContent.indexOf('Create') === 0);
      return { labels, onLabel: on ? on.textContent : null, createDisabled: createBtn.disabled, createTitle: createBtn.title };
    })()`);
    check('plus jamais de bouton « inherit » dans les libellés',
      noResolution.labels.indexOf('inherit') === -1, JSON.stringify(noResolution.labels));
    check('settings jamais poussés (illisibles/absents côté extension) : aucun bouton modèle allumé, Create désactivé',
      noResolution.onLabel === null && noResolution.createDisabled === true && noResolution.createTitle === 'pick a model',
      JSON.stringify(noResolution));
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: { batch: { envConflict: [], busy: false, notice: null, inherit: { model: 'opus[1m]', effort: 'high' } } } })}, '*')`);
    await sleep(50);
    const resolvedOn = await cdp.evaluate(`(() => {
      const pairs = Array.from(document.querySelectorAll('#batchForm .task .pair'));
      const modelPair = pairs.find(p => p.querySelector('.lbl').textContent === 'model');
      const effortPair = pairs.find(p => p.querySelector('.lbl').textContent === 'effort');
      const modelOn = modelPair.querySelector('.seg button.on');
      const effortOn = effortPair.querySelector('.seg button.on');
      const createBtn = Array.from(document.querySelectorAll('#batchForm button')).find(b => b.textContent.indexOf('Create') === 0);
      return { modelText: modelOn ? modelOn.textContent : null, effortText: effortOn ? effortOn.textContent : null, createDisabled: createBtn.disabled };
    })()`);
    check('modèle résolu ⇒ bouton concret allumé (alias [1m] ramené à la famille « opus »)',
      resolvedOn.modelText === 'opus', JSON.stringify(resolvedOn));
    check('effort résolu ⇒ bouton « high » allumé',
      resolvedOn.effortText === 'high', JSON.stringify(resolvedOn));
    check('résolution complète ⇒ Create ré-activé (WYSIWYG : ce qui est allumé sera lancé)',
      resolvedOn.createDisabled === false, JSON.stringify(resolvedOn));

    console.log('\n12c-bis. Plan sélecteurs 2026-07-24 §1 — mapping ID complet → famille');
    // Bug observé : un défaut persisté en ID complet (`claude-fable-5[1m]`,
    // comme le stocke réellement ~/.claude/settings.json) n'allumait AUCUN
    // bouton, contrairement à la forme courte (`opus`, testée juste au-dessus).
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: { batch: { envConflict: [], busy: false, notice: null, inherit: { model: 'claude-fable-5[1m]', effort: 'max' } } } })}, '*')`);
    await sleep(50);
    const fullIdFable = await cdp.evaluate(`(() => {
      const modelPair = Array.from(document.querySelectorAll('#batchForm .task .pair')).find(p => p.querySelector('.lbl').textContent === 'model');
      const on = modelPair.querySelector('.seg button.on');
      return on ? on.textContent : null;
    })()`);
    check('ID complet avec tag (claude-fable-5[1m]) ⇒ bouton « fable » allumé',
      fullIdFable === 'fable', JSON.stringify(fullIdFable));
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: { batch: { envConflict: [], busy: false, notice: null, inherit: { model: 'claude-opus-4-8', effort: 'high' } } } })}, '*')`);
    await sleep(50);
    const fullIdOpus = await cdp.evaluate(`(() => {
      const modelPair = Array.from(document.querySelectorAll('#batchForm .task .pair')).find(p => p.querySelector('.lbl').textContent === 'model');
      const on = modelPair.querySelector('.seg button.on');
      return on ? on.textContent : null;
    })()`);
    check('ID complet sans tag (claude-opus-4-8) ⇒ bouton « opus » allumé',
      fullIdOpus === 'opus', JSON.stringify(fullIdOpus));
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: { batch: { envConflict: [], busy: false, notice: null, inherit: { model: 'inconnu-x', effort: null } } } })}, '*')`);
    await sleep(50);
    const unknownId = await cdp.evaluate(`(() => {
      const modelPair = Array.from(document.querySelectorAll('#batchForm .task .pair')).find(p => p.querySelector('.lbl').textContent === 'model');
      const on = modelPair.querySelector('.seg button.on');
      return on ? on.textContent : null;
    })()`);
    check('ID exotique inconnu ⇒ toujours null, jamais une valeur inventée',
      unknownId === null, JSON.stringify(unknownId));

    console.log('\n12c-ter. Plan sélecteurs 2026-07-24 §2 — dernier choix explicite');
    // Premier usage (jamais cliqué) : repli sur le défaut global mappé (§1),
    // déjà couvert par 12c-bis. Une fois un choix persisté, il prime — même si
    // le défaut global change entre-temps (dérive volontaire, cf. commentaire
    // de resolvedModel/resolvedEffort).
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: { batch: { envConflict: [], busy: false, notice: null, inherit: { model: 'opus', effort: 'high' }, lastModel: 'sonnet', lastEffort: 'medium' } } })}, '*')`);
    await sleep(50);
    const lastChoiceOn = await cdp.evaluate(`(() => {
      const pairs = Array.from(document.querySelectorAll('#batchForm .task .pair'));
      const modelOn = pairs.find(p => p.querySelector('.lbl').textContent === 'model').querySelector('.seg button.on');
      const effortOn = pairs.find(p => p.querySelector('.lbl').textContent === 'effort').querySelector('.seg button.on');
      return { model: modelOn ? modelOn.textContent : null, effort: effortOn ? effortOn.textContent : null };
    })()`);
    check('lastModel/lastEffort persistés priment sur le défaut global « inherit »',
      lastChoiceOn.model === 'sonnet' && lastChoiceOn.effort === 'med', JSON.stringify(lastChoiceOn));
    // Un clic explicite doit poster le choix à l'extension pour persistance
    // (workspaceState) — écrit au clic, pas seulement au Create.
    await cdp.evaluate(`window.__sent = []`);
    const clickSent = await cdp.evaluate(`(() => {
      const modelPair = Array.from(document.querySelectorAll('#batchForm .task .pair')).find(p => p.querySelector('.lbl').textContent === 'model');
      const haikuBtn = Array.from(modelPair.querySelectorAll('.seg button')).find(b => b.textContent === 'haiku');
      haikuBtn.click();
      return window.__sent;
    })()`);
    check('clic sur un bouton modèle ⇒ setLastBatchChoice posté à l\'extension',
      Array.isArray(clickSent) && clickSent.some((m) => m.type === 'setLastBatchChoice' && m.field === 'model' && m.value === 'haiku'),
      JSON.stringify(clickSent));

    console.log('\n12d. Lot 12 §1 — repli de « New conversation » : reflète le push, poste le clic');
    const collapsedInitial = await cdp.evaluate(`(() => ({
      hasCollapsedClass: document.getElementById('newConvBody').classList.contains('collapsed'),
      chevron: document.getElementById('newConvChevron').textContent,
    }))()`);
    check('déplié par défaut (aucun repli poussé)',
      collapsedInitial.hasCollapsedClass === false && collapsedInitial.chevron === '▾', JSON.stringify(collapsedInitial));
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: { ui: { collapsedNewConversation: true } } })}, '*')`);
    await sleep(50);
    const collapsedPushed = await cdp.evaluate(`(() => ({
      hasCollapsedClass: document.getElementById('newConvBody').classList.contains('collapsed'),
      chevron: document.getElementById('newConvChevron').textContent,
    }))()`);
    check('repli reflété depuis l\'état poussé (workspaceState porté par l\'extension)',
      collapsedPushed.hasCollapsedClass === true && collapsedPushed.chevron === '▸', JSON.stringify(collapsedPushed));
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`document.getElementById('newConvHead').click()`);
    const sentToggle = await cdp.evaluate(`window.__sent`);
    check('le clic sur le titre poste toggleCollapse/newConversation (persistance déléguée à l\'extension)',
      Array.isArray(sentToggle) && sentToggle.some((m) => m && m.type === 'toggleCollapse' && m.section === 'newConversation'),
      JSON.stringify(sentToggle));

    console.log('\n12d. Plan repli-auto étape 6 — notice de batch : texte réduit, disclaimer en tooltip');
    await cdp.evaluate(`window.postMessage(${JSON.stringify({
      type: 'state',
      state: { batch: {
        envConflict: [], busy: false,
        notice: '2 conversations not sent yet — press Enter in their tabs.',
        noticeHint: 'The official menu may briefly show the wrong model/effort until the first turn — this panel’s model · effort badges are the real state.',
        inherit: { model: null, effort: null },
      } },
    })}, '*')`);
    await sleep(80);
    const noticeShown = await cdp.evaluate(`(() => {
      const n = document.getElementById('batchNotice');
      return { text: n.textContent, title: n.title, shown: n.classList.contains('show') };
    })()`);
    check('texte du notice = EXACTEMENT le compteur actionnable, aucun texte de groupe/maîtresse/vagues concaténé',
      noticeShown.text === '2 conversations not sent yet — press Enter in their tabs.', JSON.stringify(noticeShown));
    check('disclaimer menu officiel posé en tooltip (title), jamais dans le texte visible',
      noticeShown.title.indexOf('official menu') !== -1 && noticeShown.text.indexOf('official menu') === -1, JSON.stringify(noticeShown));
    check('notice visible (classe show)', noticeShown.shown === true);

    await cdp.evaluate(`window.postMessage(${JSON.stringify({
      type: 'state',
      state: { batch: { envConflict: [], busy: false, notice: null, noticeHint: null, inherit: { model: null, effort: null } } },
    })}, '*')`);
    await sleep(80);
    const noticeGone = await cdp.evaluate(`(() => {
      const n = document.getElementById('batchNotice');
      return { text: n.textContent, title: n.title, shown: n.classList.contains('show') };
    })()`);
    // Cycle de vie (plan étape 6) : le notice ET son tooltip s'effacent
    // ensemble — un tooltip qui traîne pour un texte déjà vide serait le même
    // défaut de classe (état d'affichage qui survit à son objet).
    check('groupe/lot dissous → notice ET tooltip effacés ensemble',
      noticeGone.text === '' && noticeGone.title === '' && noticeGone.shown === false, JSON.stringify(noticeGone));

    console.log('\n13. Capsule v2 — ligne master au format standard + grip au-dessus (plan repli-auto étape 9, 2026-08-05)');
    // La master DEVIENT une ligne de conversation STANDARD (même fabrique
    // rowFor() que la liste plate) — la sobriété (pas de ctx/modèle) de
    // l'étape 3 est RÉVOQUÉE. La grip au-dessus ne montre plus le nom du
    // groupe : chevron, compteur, seg auto/man, et le ⌂-focus SEULEMENT sans
    // master désignée.
    const withMaster = JSON.parse(JSON.stringify(grouped));
    withMaster.groups[0].master = { convId: 'c3', title: 'Cadrage du chantier', listed: true, tabTitle: null, hint: 'Finished.', status: 'done' };
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: withMaster })}, '*')`);
    await sleep(150);
    const cap = await cdp.evaluate(`(() => {
      const masterRow = document.querySelector('#flow .grp-master-head .conv');
      const title = masterRow ? masterRow.querySelector('.title') : null;
      const homeBtn = Array.from(document.querySelectorAll('#flow .grp-head .gbtn')).find(b => b.textContent === '⌂');
      return {
        masterPresent: !!masterRow,
        titleText: title ? title.textContent : null,
        modelText: masterRow ? masterRow.querySelector('.model').textContent : null,
        hasCtxBar: !!masterRow && getComputedStyle(masterRow.querySelector('.bar-ctx')).display !== 'none',
        homeBtnVisible: homeBtn ? getComputedStyle(homeBtn).display !== 'none' : null,
        count: document.querySelector('#flow .grp-count').textContent,
        notInFlatList: !Array.from(document.querySelectorAll('#flow > .conv .title')).some(t => t.textContent === 'Terminée déjà lue'),
      };
    })()`);
    check('la master est une ligne de conv STANDARD (rowFor), pas un texte d\'en-tête', cap.masterPresent === true);
    check('… avec le titre RÉEL de la conv master (c3)', cap.titleText === 'Terminée déjà lue', cap.titleText);
    check('… modèle affiché (sobriété de l\'étape 3 révoquée par l\'user)', cap.modelText === 'Sonnet 5', cap.modelText);
    check('… barre de contexte affichée', cap.hasCtxBar === true, JSON.stringify(cap));
    check('⌂ absent quand une master est désignée', cap.homeBtnVisible === false, JSON.stringify(cap));
    check('la master ne compte pas dans « N/M done »', cap.count === '1/3 done', cap.count);
    check('nœud DOM unique : la master listée quitte la liste plate (aucun doublon)', cap.notInFlatList === true);

    // Clic sur la ligne master → focusConv (id RÉEL de la conv, comme n'importe
    // quelle ligne standard) ; ne replie pas le groupe (nœud distinct de la grip).
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`document.querySelector('#flow .grp-master-head .conv').click()`);
    const afterRowClick = await cdp.evaluate(`({
      sent: window.__sent,
      collapsed: document.querySelector('#flow .grp-body').classList.contains('collapsed'),
    })`);
    check('clic sur la ligne master → focusConv (id de la conv réelle)',
      Array.isArray(afterRowClick.sent) && afterRowClick.sent.some((m) => m.type === 'focusConv' && m.id === 'c3'),
      JSON.stringify(afterRowClick.sent));
    check('… et NE replie PAS le groupe', afterRowClick.collapsed === false);

    // Onglet master fermé (tabOpen:false sur la conv RÉELLE) : le titre se
    // barre — DÉCOULE de tabOpen exactement comme une ligne plate (rowFor),
    // plus jamais un champ status/member-truth recalculé pour la master listée.
    const masterClosed = JSON.parse(JSON.stringify(withMaster));
    masterClosed.conversations.find((c) => c.id === 'c3').tabOpen = false;
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: masterClosed })}, '*')`);
    await sleep(120);
    check('onglet fermé → titre barré, exactement comme une ligne plate',
      await cdp.evaluate(`document.querySelector('#flow .grp-master-head .conv .title').classList.contains('closed')`) === true);
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: withMaster })}, '*')`);
    await sleep(120);

    // Master busy (état RÉEL de la conv) : glyphe présent, et tourne — étape 16,
    // même règle qu'un membre busy (son icône est un nœud du rail comme un autre,
    // qui reprend désormais la même animation que les lignes plates).
    const masterBusy = JSON.parse(JSON.stringify(withMaster));
    masterBusy.conversations.find((c) => c.id === 'c3').state = 'busy';
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: masterBusy })}, '*')`);
    await sleep(150);
    const busyCap = await cdp.evaluate(`(() => {
      const ico = document.querySelector('#flow .grp-master-head .conv .ico-busy');
      const anims = ico ? ico.getAnimations({ subtree: true }) : [];
      return { present: !!ico, animCount: anims.length, name: anims[0] ? anims[0].animationName : null };
    })()`);
    check('statut busy → glyphe présent dans l\'anneau', busyCap.present === true, JSON.stringify(busyCap));
    check('… animé, même animation que les lignes plates (étape 16)',
      busyCap.animCount === 2 && busyCap.name === anim.name, JSON.stringify({ busyCap, flat: anim.name }));
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: withMaster })}, '*')`);
    await sleep(120);

    // Master hors de la fenêtre du panneau (ni transcript ni onglet suivis) :
    // fallback dégradé (réutilise le gabarit .conv/.ico/.title) — titre persisté
    // + tooltip member-truth, jamais de nœud manquant.
    const masterGone = JSON.parse(JSON.stringify(withMaster));
    masterGone.conversations = masterGone.conversations.filter((c) => c.id !== 'c3');
    masterGone.groups[0].master = { convId: 'c3', title: 'Cadrage du chantier', listed: false, tabTitle: null, hint: 'Finished — its tab has been closed.', status: 'done-closed' };
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: masterGone })}, '*')`);
    await sleep(150);
    const gone = await cdp.evaluate(`(() => {
      const fb = document.querySelector('#flow .grp-master-fallback');
      return {
        present: !!fb,
        text: fb ? fb.querySelector('.title').textContent : null,
        closed: fb ? fb.querySelector('.title').classList.contains('closed') : null,
        tooltip: fb ? fb.title : null,
      };
    })()`);
    check('hors de la vue : fallback dégradé (titre persisté)', gone.present === true && gone.text === 'Cadrage du chantier', JSON.stringify(gone));
    check('… barré (done-closed, statut member-truth — aucune conv réelle ici)', gone.closed === true);
    check('… tooltip = hint member-truth', gone.tooltip && gone.tooltip.indexOf('Finished') !== -1, gone.tooltip);

    // Dissociation : plus de master → la ligne master disparaît du DOM, ⌂
    // réapparaît, la conv redevient une ligne plate normale.
    const noMaster = JSON.parse(JSON.stringify(grouped));
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: noMaster })}, '*')`);
    await sleep(150);
    const afterUnset = await cdp.evaluate(`(() => {
      const homeBtn = Array.from(document.querySelectorAll('#flow .grp-head .gbtn')).find(b => b.textContent === '⌂');
      return {
        masterRowGone: !document.querySelector('#flow .grp-master-head'),
        homeBtnVisible: homeBtn ? getComputedStyle(homeBtn).display !== 'none' : null,
        backInFlatList: !!Array.from(document.querySelectorAll('#flow > .conv .title')).find(t => t.textContent === 'Terminée déjà lue'),
        members: document.querySelectorAll('#flow .member').length,
        count: document.querySelector('#flow .grp-count').textContent,
        gripTooltip: document.querySelector('#flow .grp-head').title,
      };
    })()`);
    check('sans master : la ligne master disparaît du DOM (rien qu\'une grip)', afterUnset.masterRowGone === true);
    check('… ⌂ réapparaît', afterUnset.homeBtnVisible === true);
    check('… la conv est de retour dans la liste plate', afterUnset.backInFlatList === true);
    check('… les membres sont intacts', afterUnset.members === 3 && afterUnset.count === '1/3 done', JSON.stringify(afterUnset));
    check('… la grip porte le nom du groupe en tooltip (capsule = grip seule)',
      afterUnset.gripTooltip === 'Refonte paiements', afterUnset.gripTooltip);

    console.log('\n13bis. Alignement unifié + rail P1 — la ligne master rejoint la mesure (plan repli-auto étape 9)');
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: withMaster })}, '*')`);
    await sleep(150);
    const align = await cdp.evaluate(`(() => {
      const bodyCs = getComputedStyle(document.querySelector('#flow .grp-body'));
      const flatConv = document.querySelector('#flow > .conv');
      const flatIco = flatConv.querySelector('.ico');
      const flatRect = flatConv.getBoundingClientRect();
      const flatIcoRect = flatIco.getBoundingClientRect();
      const grpConv = document.querySelector('#flow .grp-body .member .conv');
      const grpRect = grpConv.getBoundingClientRect();
      const grpIcoRect = grpConv.querySelector('.ico').getBoundingClientRect();
      const masterConv = document.querySelector('#flow .grp-master-head .conv');
      const masterRect = masterConv.getBoundingClientRect();
      const masterIcoRect = masterConv.querySelector('.ico').getBoundingClientRect();
      const railRect = document.querySelector('#flow .grp-rail').getBoundingClientRect();
      const gripRect = document.querySelector('#flow .grp-head').getBoundingClientRect();
      return {
        bodyPaddingLeft: bodyCs.paddingLeft, bodyBorderLeft: bodyCs.borderLeftWidth, bodyMarginLeft: bodyCs.marginLeft,
        flatLeft: flatRect.left, grpLeft: grpRect.left, masterLeft: masterRect.left,
        flatIcoCenter: flatIcoRect.left + flatIcoRect.width / 2,
        grpIcoCenter: grpIcoRect.left + grpIcoRect.width / 2,
        masterIcoCenter: masterIcoRect.left + masterIcoRect.width / 2,
        // Depuis le crochet de fin de lot (2026-08-17), la boîte du rail
        // s'étend jusqu'à la barre de contexte : sa largeur est celle du
        // CROCHET, plus celle du trait. L'axe se lit donc sur le trait
        // VERTICAL — le bord gauche de la boîte plus la moitié de son
        // border-left, la seule encre posée à gauche.
        railCenter: railRect.left + parseFloat(getComputedStyle(document.querySelector('#flow .grp-rail')).borderLeftWidth) / 2,
        gripAboveMaster: gripRect.bottom <= masterRect.top + 0.5,
      };
    })()`);
    check('corps de groupe sans indentation propre (padding/bordure/marge gauche à 0 — décision 2)',
      align.bodyPaddingLeft === '0px' && align.bodyBorderLeft === '0px' && align.bodyMarginLeft === '0px', JSON.stringify(align));
    check('ligne de conv groupée (membre) alignée EXACTEMENT sur la liste plate (même bord gauche)',
      Math.abs(align.flatLeft - align.grpLeft) < 0.5, JSON.stringify(align));
    check('ligne MASTER alignée EXACTEMENT sur la liste plate (mêmes offsets que les plates — plan étape 9)',
      Math.abs(align.flatLeft - align.masterLeft) < 0.5, JSON.stringify(align));
    // L'anneau est CSS-garanti concentrique à la boîte icône (top/left 50% +
    // margin -8,-8 : le centre du cercle égale toujours le centre de la boîte,
    // quelle que soit sa taille exacte) — mesurer le centre de l'icône revient
    // donc à mesurer le centre de l'anneau, sans recourir à un hack de rect
    // sur ::after (non exposé par getBoundingClientRect).
    check('anneau (≡ centre de l\'icône groupée) == axe des icônes plates',
      Math.abs(align.flatIcoCenter - align.grpIcoCenter) < 0.5, JSON.stringify(align));
    check('anneau de la MASTER == même axe (son icône est le premier nœud du rail P1)',
      Math.abs(align.flatIcoCenter - align.masterIcoCenter) < 0.5, JSON.stringify(align));
    check('rail P1 centré au pixel sur ce même axe',
      Math.abs(align.railCenter - align.flatIcoCenter) < 0.5, JSON.stringify(align));
    check('la grip est bien AU-DESSUS de la ligne master (rangée fine séparée)',
      align.gripAboveMaster === true, JSON.stringify(align));

    // Le rail va du bas de la CAPSULE (étape 19 : jamais un trait à l'intérieur
    // du cadre — sans master c'est le haut du corps, qui vaut la même chose)
    // jusqu'à la DERNIÈRE LIGNE du lot, où il tourne à 90° (crochet de fin de
    // lot, 2026-08-17). Il ne descend donc plus jusqu'à la ligne fantôme :
    // celle-ci est une invite d'ajout, pas un membre du lot, et le crochet
    // doit se fermer sur la dernière conversation — c'est tout l'objet du
    // changement. Mesuré sur la BARRE DE CONTEXTE de cette ligne : le trait
    // horizontal passe HOOK_DROP px sous son axe, et son extrémité s'arrête à
    // l'aplomb du bord gauche de cette même barre (crochet « au contact »).
    const railSpan = await cdp.evaluate(`(() => {
      const body = document.querySelector('#flow .grp-body').getBoundingClientRect();
      // Sommet attendu (2026-08-17) : le bas de la BULLE de la maîtresse, plus
      // le bas de sa ligne — la tête de lot est devenue un nœud d'où le trait
      // descend, elle n'est plus un cadre qu'on longe. Sans maîtresse, le haut
      // du corps, comme avant.
      const head = document.querySelector('#flow .grp-master-head');
      const headIco = head ? head.querySelector('.conv .ico') : null;
      const ringD = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--master-ring-d')) || 0;
      let start = body.top;
      if (head && head.parentElement.classList.contains('grp-body')) {
        const icoRect = headIco ? headIco.getBoundingClientRect() : null;
        start = icoRect ? icoRect.top + icoRect.height / 2 + ringD / 2
                        : head.getBoundingClientRect().bottom;
      }
      const rail = document.querySelector('#flow .grp-rail');
      const railRect = rail.getBoundingClientRect();
      const cs = getComputedStyle(rail);
      // Dernière LIGNE du lot : le dernier enfant direct du corps qui est un
      // membre — jamais la ligne fantôme, jamais un séparateur, exactement ce
      // que lastRowOf() retient côté panneau.
      const rows = Array.from(document.querySelectorAll('#flow .grp-body > .member'))
        .filter((m) => getComputedStyle(m).display !== 'none');
      const last = rows.length ? rows[rows.length - 1] : null;
      const lastBar = last ? last.querySelector('.bar-ctx') : null;
      const barRect = lastBar ? lastBar.getBoundingClientRect() : null;
      const lastRect = last ? last.getBoundingClientRect() : null;
      // Bord gauche de la colonne de CONTENU de cette ligne : l'aplomb où le
      // crochet s'arrête, qu'il y ait une barre de contexte (.body) ou que la
      // ligne soit encore en file (.m-body) — même abscisse dans les deux cas,
      // c'est tout l'intérêt de la mesurer ainsi.
      const content = last ? last.querySelector('.body, .m-body') : null;
      const contentLeft = content ? content.getBoundingClientRect().left : null;
      const ghostRect = document.querySelector('#flow .wave-ghost:not(.wave-add-row)').getBoundingClientRect();
      return {
        top: Math.abs(railRect.top - start) < 1,
        hasBar: !!barRect,
        // pied : axe de la barre + 4px (HOOK_DROP) quand elle existe ; sinon
        // le bas de la ligne — la même ordonnée à un demi-pixel près.
        foot: barRect ? (railRect.bottom - (barRect.top + barRect.height / 2))
            : lastRect ? (railRect.bottom - lastRect.bottom) : null,
        hookRight: contentLeft === null ? null : (railRect.right - contentLeft),
        aboveGhost: railRect.bottom <= ghostRect.top + 0.5,
        hasBottomBorder: parseFloat(cs.borderBottomWidth) > 0,
        radius: parseFloat(cs.borderBottomLeftRadius),
      };
    })()`);
    check('rail : sommet au bas de la BULLE de la maîtresse (ou du corps, sans maîtresse)', railSpan.top === true, JSON.stringify(railSpan));
    check('crochet : pied posé sur la dernière ligne (4px sous l\'axe de sa barre de contexte, ou son bas si elle est en file)',
      railSpan.foot !== null && Math.abs(railSpan.foot - (railSpan.hasBar ? 5 : 1)) < 1.5, JSON.stringify(railSpan));
    check('crochet : extrémité à l\'aplomb de la colonne de contenu (au contact, jamais au-delà)',
      railSpan.hookRight !== null && Math.abs(railSpan.hookRight) < 1.5, JSON.stringify(railSpan));
    check('crochet : reste au-dessus de la ligne fantôme finale (jamais plus bas)',
      railSpan.aboveGhost === true, JSON.stringify(railSpan));
    check('crochet : dessiné par le bord BAS du rail, avec son coude arrondi (un seul nœud, aucune couture)',
      railSpan.hasBottomBorder === true && railSpan.radius > 0, JSON.stringify(railSpan));

    // Anneau troué : le pseudo-élément ::after de l'icône reprend --grp-hue en
    // bordure, jamais une couleur libre.
    const ring = await cdp.evaluate(`(() => {
      const cs = getComputedStyle(document.querySelector('#flow .grp-body .member .conv .ico'), '::after');
      return { borderColor: cs.borderColor, background: cs.backgroundColor };
    })()`);
    check('anneau : bordure = teinte du groupe (--grp-hue), pas une couleur transparente par défaut',
      ring.borderColor !== '' && ring.borderColor !== 'rgba(0, 0, 0, 0)', JSON.stringify(ring));

    // Ligne « en attente » (m3, pas de conv liée) : même anneau, même axe.
    const pendingRing = await cdp.evaluate(`(() => {
      const ico = document.querySelector('#flow .grp-body .m-pending .ico-pending');
      if (!ico) return null;
      const rect = ico.getBoundingClientRect();
      const flatIco = document.querySelector('#flow > .conv .ico').getBoundingClientRect();
      return { present: true, centerDelta: Math.abs((rect.left + rect.width / 2) - (flatIco.left + flatIco.width / 2)) };
    })()`);
    check('ligne en attente (queued) : anneau présent, même axe',
      !!pendingRing && pendingRing.present && pendingRing.centerDelta < 0.5, JSON.stringify(pendingRing));

    // Séparateurs de vague et lignes fantômes : commencent après l'axe du
    // rail, ne le croisent pas (décision 2, dernier paragraphe).
    //
    // Mesuré en GÉOMÉTRIE depuis le lot B densité (2026-08-09) : la ligne
    // d'ajout de la dernière vague en file n'est plus un enfant du corps mais
    // une cellule de la rangée fantôme finale, qui porte l'écart pour elle —
    // lire sa marge PROPRE interrogerait la mauvaise boîte et jurerait « 0 »
    // sur une ligne pourtant bien placée. Ce que la règle protège, c'est le
    // bord gauche RÉEL de chaque bordure pointillée : il reste à droite du
    // rail, où que la cellule soit rangée.
    const sepOffset = await cdp.evaluate(`(() => {
      const hdr = document.querySelector('#flow .grp-body .wave-hdr:not(.launch)');
      const addRow = document.querySelector('#flow .wave-ghost.wave-add-row');
      const ghostNew = document.querySelector('#flow .wave-ghost:not(.wave-add-row)');
      const railEl = document.querySelector('#flow .grp-rail');
      const rail = railEl.getBoundingClientRect();
      return {
        hdrPaddingLeft: hdr ? parseFloat(getComputedStyle(hdr).paddingLeft) : null,
        // Bord droit du TRAIT VERTICAL, pas de la boîte : depuis le crochet de
        // fin de lot (2026-08-17) la boîte s'étend jusqu'à la barre de
        // contexte, mais son encre à cette hauteur-là se limite au border-left.
        // Ce que ces contrôles protègent est inchangé : aucune bordure
        // pointillée ne croise le trait que l'œil suit.
        railRight: rail.left + parseFloat(getComputedStyle(railEl).borderLeftWidth),
        addRowLeft: addRow ? addRow.getBoundingClientRect().left : null,
        ghostNewLeft: ghostNew ? ghostNew.getBoundingClientRect().left : null,
      };
    })()`);
    check('séparateur de vague inerte : padding-left après l\'axe du rail (14px + marge)',
      sepOffset.hdrPaddingLeft !== null && sepOffset.hdrPaddingLeft >= 20, JSON.stringify(sepOffset));
    check('ligne d\'ajout en file : bord gauche à droite du rail (sa bordure pointillée ne le croise pas)',
      sepOffset.addRowLeft !== null && sepOffset.addRowLeft >= sepOffset.railRight - 0.5, JSON.stringify(sepOffset));
    check('« + nouvelle vague » : même écart au rail, cellule voisine sur la même rangée',
      sepOffset.ghostNewLeft !== null && sepOffset.ghostNewLeft >= sepOffset.railRight - 0.5, JSON.stringify(sepOffset));

    console.log('\n13ter. Repli = les CONVERSATIONS du groupe disparaissent, la ligne master ne bouge PAS d\'un pixel (2026-08-07)');
    // Signalement user : replier « changeait l'apparence de la master » (elle
    // héritait du chevron, du chip et d'un cadre refermé en haut parce que la
    // grip s'effaçait). Invariant désormais mesuré : grip toujours là, ligne
    // master strictement identique dépliée/repliée — seuls membres, vagues et
    // rail sont masqués.
    const masterShape = `(() => {
      const head = document.querySelector('#flow .grp-master-head');
      const conv = head.querySelector('.conv');
      const r = conv.getBoundingClientRect();
      const ctx = conv.querySelector('.bar-ctx');
      const ctxRect = ctx ? ctx.getBoundingClientRect() : null;
      const cs = getComputedStyle(head);
      const after = getComputedStyle(head, '::after');
      return {
        // Largeur de VIEWPORT au moment de la mesure (2026-08-09) : une
        // géométrie en pixels absolus n'a de sens qu'à viewport constant. Si
        // la page cesse de déborder au repli, la barre de défilement disparaît
        // et TOUTE la colonne s'élargit de ~15px — un écart qui n'apprend rien
        // sur la ligne master. Mesurée ici pour que l'échec le DISE, au lieu
        // de laisser accuser le CSS de la ligne.
        clientWidth: document.documentElement.clientWidth,
        left: r.left, right: r.right, width: r.width, height: r.height,
        ctxRight: ctxRect ? ctxRect.right : null, ctxWidth: ctxRect ? ctxRect.width : null,
        radius: cs.borderTopLeftRadius + '/' + cs.borderTopRightRadius + '/' + cs.borderBottomRightRadius + '/' + cs.borderBottomLeftRadius,
        shadow: after.boxShadow,
        children: Array.from(head.children).filter((c) => getComputedStyle(c).display !== 'none').map((c) => c.className).join(','),
      };
    })()`;
    // Viewport figé le temps des DEUX mesures (2026-08-09) : replier le groupe
    // raccourcit la page, et si elle cesse alors de déborder, Chromium retire
    // la barre de défilement — la colonne entière s'élargit de 15px et toute
    // comparaison en pixels absolus tombe, sans que le CSS de la ligne ait
    // bougé d'un iota (mesuré : clientWidth 487 déplié / 502 replié, écart
    // strictement égal à celui des largeurs incriminées). Le seuil de
    // débordement dépend de la densité du panneau et de la taille de la
    // fenêtre : ce n'est pas une propriété du groupe, ça ne doit pas décider
    // du verdict. overflow-y:scroll réserve la gouttière dans les deux états ;
    // restauré juste après pour ne rien changer aux sections suivantes.
    await cdp.evaluate(`document.documentElement.style.overflowY = 'scroll'`);
    const shapeOpen = await cdp.evaluate(masterShape);
    const collapsedWithMaster = JSON.parse(JSON.stringify(withMaster));
    collapsedWithMaster.groups[0].collapsed = true;
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: collapsedWithMaster })}, '*')`);
    await sleep(150);
    const shapeCollapsed = await cdp.evaluate(masterShape);
    const repli = await cdp.evaluate(`(() => {
      const grip = document.querySelector('#flow .grp-head');
      const masterHead = document.querySelector('#flow .grp-master-head');
      const rail = document.querySelector('#flow .grp-rail');
      const members = document.querySelectorAll('#flow .member');
      return {
        gripVisible: getComputedStyle(grip).display !== 'none',
        gripChev: grip.querySelector('.chevron').textContent,
        gripCount: document.querySelector('#flow .grp-count').textContent,
        masterHeadVisible: getComputedStyle(masterHead).display !== 'none',
        railHidden: getComputedStyle(rail).display === 'none',
        membersHidden: Array.from(members).every((m) => getComputedStyle(m).display === 'none'),
      };
    })()`);
    check('la grip RESTE visible au repli (c\'est elle qui porte le chevron/compteur, jamais la master)',
      repli.gripVisible === true && repli.gripChev === '▸' && repli.gripCount === '1/3 done', JSON.stringify(repli));
    check('… la ligne master reste visible', repli.masterHeadVisible === true, JSON.stringify(repli));
    check('… seuls le rail et les membres du corps sont masqués',
      repli.railHidden === true && repli.membersHidden === true, JSON.stringify(repli));
    await cdp.evaluate(`document.documentElement.style.overflowY = ''`);
    // Ceinture : si la gouttière n'avait pas tenu, l'échec doit dire QUE c'est
    // le viewport, pas la ligne master (le JSON porte clientWidth pour ça).
    check('(mise en place) largeur de viewport identique dans les deux états — sinon la comparaison en pixels absolus ne veut rien dire',
      shapeOpen.clientWidth === shapeCollapsed.clientWidth,
      `${shapeOpen.clientWidth} vs ${shapeCollapsed.clientWidth}`);
    const sameShape = ['left', 'right', 'width', 'height', 'ctxRight', 'ctxWidth']
      .every((k) => shapeOpen[k] !== null && Math.abs(shapeOpen[k] - shapeCollapsed[k]) < 0.5);
    check('ligne master : géométrie IDENTIQUE dépliée/repliée (bords, largeur, hauteur, barre ctx)',
      sameShape === true, JSON.stringify({ open: shapeOpen, collapsed: shapeCollapsed }));
    check('… mêmes coins et même cadre (aucune bande refermée en haut au repli)',
      shapeOpen.radius === shapeCollapsed.radius && shapeOpen.shadow === shapeCollapsed.shadow,
      JSON.stringify({ open: shapeOpen, collapsed: shapeCollapsed }));
    check('… mêmes enfants visibles (aucun chevron/chip qui apparaît au repli)',
      shapeOpen.children === shapeCollapsed.children,
      JSON.stringify({ open: shapeOpen.children, collapsed: shapeCollapsed.children }));

    // Le chevron de la grip re-déplie (seul déclencheur, master ou pas).
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`document.querySelector('#flow .grp-head .chevron').click()`);
    const sentChev = await cdp.evaluate(`window.__sent`);
    check('clic sur le chevron de la grip → toggleGroupCollapse',
      Array.isArray(sentChev) && sentChev.some((m) => m.type === 'toggleGroupCollapse' && m.id === 'g1'), JSON.stringify(sentChev));

    // Retour à l'état déplié pour la suite du banc.
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: withMaster })}, '*')`);
    await sleep(120);

    console.log('\n13quater. ⤴ de la ligne master — RETRAIT du lot, geste identique à celui d\'un membre (2026-08-09)');
    // La ligne maîtresse portait DEUX sorties côte à côte (chip texte
    // « Dissocier » + ✕ de dissolution) dont l'une agissait sur la ligne et
    // l'autre sur le bloc entier : portée illisible depuis l'emplacement, et
    // dans un lot terminé les deux produisaient jusqu'au même écran. Il ne
    // reste qu'un geste par ligne — le MÊME ⤴ que tout membre, même classe
    // .m-out, donc même gabarit et même hover-only.
    const unlinkBtn = await cdp.evaluate(`(() => {
      const b = document.querySelector('#flow .grp-master-head .m-out');
      const cs = b ? getComputedStyle(b) : null;
      return { present: !!b, opacity: cs ? cs.opacity : null, glyph: b ? b.textContent : null,
               // .link-master exclu : ce ⌂ existe sur TOUTE ligne (rowFor est la
               // même fabrique partout) et c'est son contexte d'accueil qui le
               // masque ici — il ne compte pas comme une action de la master.
               chips: document.querySelectorAll('#flow .grp-master-head .chip:not(.link-master)').length };
    })()`);
    check('⤴ présent sur la ligne master, hover-only (opacité 0 au repos), et plus aucun chip d\'action à côté',
      unlinkBtn.present === true && unlinkBtn.opacity === '0' && unlinkBtn.glyph === '⤴' && unlinkBtn.chips === 0,
      JSON.stringify(unlinkBtn));
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`document.querySelector('#flow .grp-master-head .m-out').click()`);
    const sentUnlink = await cdp.evaluate(`window.__sent`);
    check('clic ⤴ → unlinkGroupMaster (id du groupe, geste réversible sans confirmation)',
      Array.isArray(sentUnlink) && sentUnlink.some((m) => m.type === 'unlinkGroupMaster' && m.id === 'g1'), JSON.stringify(sentUnlink));
    check('le ⤴ de la master ne dissout JAMAIS le lot (portée = la ligne qui le porte)',
      Array.isArray(sentUnlink) && !sentUnlink.some((m) => m.type === 'dissolveGroup'), JSON.stringify(sentUnlink));

    console.log('\n13quinquies. ✕ de la GRIP — dissolution du lot, portée par le lot et non par une de ses lignes (2026-08-09)');
    const killBtn = await cdp.evaluate(`(() => {
      const b = document.querySelector('#flow .grp-head .g-kill');
      const cs = b ? getComputedStyle(b) : null;
      return { present: !!b, opacity: cs ? cs.opacity : null, glyph: b ? b.textContent : null,
               inMasterRow: !!document.querySelector('#flow .grp-master-head .g-kill') };
    })()`);
    check('✕ présent sur la grip, hover-only, et absent de la ligne master',
      killBtn.present === true && killBtn.opacity === '0' && killBtn.glyph === '✕' && killBtn.inMasterRow === false,
      JSON.stringify(killBtn));
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`document.querySelector('#flow .grp-head .g-kill').click()`);
    const sentClose = await cdp.evaluate(`window.__sent`);
    check('clic ✕ → dissolveGroup avec id du groupe seul (aucun identifiant d\'onglet transporté)',
      Array.isArray(sentClose) && sentClose.some((m) => m.type === 'dissolveGroup' && m.id === 'g1' && m.convId === undefined),
      JSON.stringify(sentClose));
    // Le ✕ vit DANS la grip, dont le clic replie le groupe : sans la classe
    // .gbtn (que le handler de repli ignore), dissoudre replierait aussi.
    check('clic ✕ ne replie pas le groupe au passage (classe .gbtn ignorée par le handler de repli)',
      Array.isArray(sentClose) && !sentClose.some((m) => m.type === 'toggleGroupCollapse'), JSON.stringify(sentClose));

    console.log('\n14. Lot micro-allègements 2026-07-24 — dismiss du feedback de collage');
    // Bloc claude-convs BARE (pas de fence ``` — la zone de collage EST le
    // champ prompt, lot 2026-07-23) reconnu comme valide : bannière info avec ×.
    await cdp.evaluate(`(() => {
      const ta = document.querySelector('#batchForm .task textarea');
      ta.value = 'model: sonnet\\neffort: medium\\nFaire le lot 3';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(50);
    const pasted = await cdp.evaluate(`(() => {
      const banner = document.querySelector('#batchForm .banner.info');
      return {
        bannerText: banner ? banner.textContent : null,
        hasDismiss: banner ? !!banner.querySelector('.xdel') : null,
      };
    })()`);
    check('bloc reconnu : bannière « N tâche(s) pré-remplie(s) » avec × de fermeture',
      !!pasted.bannerText && pasted.bannerText.indexOf('prefilled') !== -1 && pasted.hasDismiss === true, JSON.stringify(pasted));
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`document.querySelector('#batchForm .banner.info .xdel').click()`);
    await sleep(50);
    const afterBannerDismiss = await cdp.evaluate(`(() => ({
      bannerGone: !document.querySelector('#batchForm .banner.info'),
      taskPrompt: (document.querySelector('#batchForm .task textarea') || {}).value,
      sent: window.__sent,
    }))()`);
    check('× ferme la bannière — état ÉPHÉMÈRE local, aucun message posté vers l\'extension',
      afterBannerDismiss.bannerGone === true && Array.isArray(afterBannerDismiss.sent) && afterBannerDismiss.sent.length === 0,
      JSON.stringify(afterBannerDismiss));
    check('… la tâche pré-remplie par le collage reste intacte (le dismiss ne touche que la bannière)',
      afterBannerDismiss.taskPrompt === 'Faire le lot 3', afterBannerDismiss.taskPrompt);

    // Bloc reconnu mais INVALIDE (modèle inconnu) : bannière d'erreur, même ×.
    await cdp.evaluate(`(() => {
      const ta = document.querySelector('#batchForm .task textarea');
      ta.value = 'model: bidon\\nFaire autre chose';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(50);
    const invalid = await cdp.evaluate(`(() => {
      const banner = document.querySelector('#batchForm .banner:not(.info)');
      return { bannerText: banner ? banner.textContent : null, hasDismiss: banner ? !!banner.querySelector('.xdel') : null };
    })()`);
    check('bloc non reconnu (modèle inconnu) : bannière d\'erreur avec × de fermeture',
      !!invalid.bannerText && invalid.bannerText.indexOf('not recognized') !== -1 && invalid.hasDismiss === true, JSON.stringify(invalid));
    await cdp.evaluate(`document.querySelector('#batchForm .banner:not(.info) .xdel').click()`);
    await sleep(50);
    check('… × la referme aussi', await cdp.evaluate(`!document.querySelector('#batchForm .banner:not(.info)')`) === true);

    console.log('\n15. Étape 12 — régressions capsule/rail après reload (thème clair)');
    // (a) masterIds/g.done : un groupe qui bascule ENTIER terminé (g.done)
    // pendant que sa master est encore listée (cas transitoire, cf. plan)
    // ne doit plus faire disparaître la conv des DEUX vues à la fois — elle
    // retombe dans la liste plate comme une conv normale.
    const doneButMasterListed = JSON.parse(JSON.stringify(withMaster));
    doneButMasterListed.groups[0].done = true;
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: doneButMasterListed })}, '*')`);
    await sleep(150);
    const vanish = await cdp.evaluate(`(() => ({
      grpPresent: !!document.querySelector('#flow .grp'),
      flatHasMaster: !!Array.from(document.querySelectorAll('#flow > .conv .title')).find(t => t.textContent === 'Terminée déjà lue'),
    }))()`);
    check('groupe g.done : plus rendu du tout (inchangé, étape 11)', vanish.grpPresent === false, JSON.stringify(vanish));
    check('… mais sa master (encore listée) ne disparaît PAS des deux vues à la fois : retombe dans la liste plate',
      vanish.flatHasMaster === true, JSON.stringify(vanish));
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: withMaster })}, '*')`);
    await sleep(150);

    // (b) Rail P1 : une seule mesure synchrone au moment du rendu ne suffit
    // pas si la mise en page bouge APRÈS coup sans nouveau postMessage (fait
    // constaté : au tout premier push après un reload de fenêtre, la mesure
    // peut tomber à 0 avant que la largeur restaurée par VS Code ne se
    // stabilise). On rejoue ici directement la panne (hauteur corrompue à 0,
    // exactement la valeur vue en repro) puis un redimensionnement RÉEL et
    // indépendant du contenu du groupe (spacer ajouté/retiré sur body) — le
    // ResizeObserver doit corriger tout seul, sans nouveau postMessage.
    await cdp.evaluate(`document.querySelector('#flow .grp-rail').style.height = '0px'`);
    const corrupted = await cdp.evaluate(`document.querySelector('#flow .grp-rail').getBoundingClientRect().height`);
    // Depuis le crochet (2026-08-17) le rail est une boîte à bordures : une
    // hauteur CSS de 0 laisse toujours l'épaisseur du trait horizontal (~2px),
    // c'est la boîte de BORDURE que mesure getBoundingClientRect. Le fait
    // reproduit reste le même — le rail ne couvre plus rien.
    check('(mise en place) hauteur du rail corrompue à 0, comme la panne reproduite',
      corrupted <= 2.5, String(corrupted));
    await cdp.evaluate(`(() => { const s = document.createElement('div'); s.id = 'qb-resize-spacer'; s.style.height = '400px'; document.body.appendChild(s); })()`);
    await sleep(250);
    await cdp.evaluate(`document.getElementById('qb-resize-spacer').remove()`);
    await sleep(250);
    const healed = await cdp.evaluate(`(() => {
      const rail = document.querySelector('#flow .grp-rail');
      const ghost = document.querySelector('#flow .wave-ghost:not(.wave-add-row)');
      // Le rail ne part plus du haut du corps mais du bas de la capsule (étape
      // 19) : sa hauteur attendue est l'écart entre les DEUX bouts mesurés,
      // jamais le seul offsetTop de la ligne fantôme.
      // Depuis le crochet de fin de lot, le pied n'est plus le sommet de la
      // ligne fantôme mais la dernière ligne : la guérison se prouve par une
      // hauteur redevenue franche ET un pied resté au-dessus du fantôme.
      return {
        railHeight: rail.getBoundingClientRect().height,
        ghostTop: ghost.offsetTop, railTop: rail.offsetTop,
        aboveGhost: rail.offsetTop + rail.getBoundingClientRect().height <= ghost.offsetTop + 0.5,
      };
    })()`);
    check('… le ResizeObserver corrige tout seul la hauteur corrompue, SANS nouveau postMessage',
      healed.railHeight > 10 && healed.aboveGhost === true, JSON.stringify(healed));

    // (c) Anneau vs fond du panneau, dans les DEUX thèmes RÉELS — le §7
    // existant (prefers-color-scheme) ne change RIEN ici : aucune @media
    // n'en dépend, tout passe par les variables --vscode-* que seul VRAI VS
    // Code injecte. On les pose nous-mêmes, comme le ferait le host, pour
    // que ce banc mesure ce que l'œil voit vraiment dans chaque thème.
    const THEMES = {
      dark: { '--vscode-sideBar-background': '#252526', '--vscode-editor-background': '#1e1e1e' },
      light: { '--vscode-sideBar-background': '#f3f3f3', '--vscode-editor-background': '#ffffff' },
    };
    for (const [name, vars] of Object.entries(THEMES)) {
      const setVars = Object.entries(vars).map(([k, v]) => `document.documentElement.style.setProperty('${k}','${v}')`).join(';');
      await cdp.evaluate(`(() => { ${setVars}; })()`);
      await sleep(80);
      const ringVsBody = await cdp.evaluate(`(() => {
        const ico = document.querySelector('#flow .grp-body .member .conv .ico');
        return { ringBg: getComputedStyle(ico, '::after').backgroundColor, bodyBg: getComputedStyle(document.body).backgroundColor };
      })()`);
      check(`thème ${name} : le fond de l'anneau égale EXACTEMENT le fond réel du panneau (même chaîne de variables)`,
        ringVsBody.ringBg === ringVsBody.bodyBg && ringVsBody.ringBg !== 'rgba(0, 0, 0, 0)', JSON.stringify(ringVsBody));
    }
    for (const k of Object.keys(THEMES.dark)) await cdp.evaluate(`document.documentElement.style.removeProperty('${k}')`);

    // Capture pour l'œil : deux instants, quelque chose doit avoir bougé à
    // l'écran. Faite sur l'état GROUPÉ — c'est le rendu du lot 2 qu'il faut
    // pouvoir regarder. Depuis l'amendement étape 5, le busy du groupe est
    // STATIQUE par construction (plus rien n'y bouge, c'est voulu) : le
    // membre en file (m3) porte donc le mouvement pour ce banc, sous la forme
    // du pulse d'opacité de son anneau (« inserted » — Entrée attendue).
    const shotState = JSON.parse(JSON.stringify(grouped));
    shotState.groups[0].members[2].status = 'inserted';
    shotState.groups[0].members[2].waveStatus = 'launched';
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: shotState })}, '*')`);
    await sleep(150);
    const shots = [];
    for (let i = 0; i < 2; i++) {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      shots.push(Buffer.from(r.data, 'base64'));
      await sleep(1300);
    }
    const outDir = path.join(os.tmpdir(), 'qb-panel-shots');
    fs.mkdirSync(outDir, { recursive: true });
    shots.forEach((b, i) => fs.writeFileSync(path.join(outDir, `panel-${i}.png`), b));
    check('deux captures à 1,3 s d\'écart diffèrent (le pulse a bougé à l\'écran)',
      !shots[0].equals(shots[1]), `captures dans ${outDir}`);
    console.log(`       captures : ${outDir}`);

    console.log('\n16. Étape 13 — ligne master : ÉGALITÉ MESURÉE avec les lignes standard, dans le cadre');
    // Le done de ce lot est un jeu d'INVARIANTS auto-référents : aucun nombre
    // magique, la référence est toujours une autre ligne du MÊME rendu. La
    // ligne master doit être une ligne standard à tous égards — le cadre
    // teinté n'est qu'un décor AUTOUR (peint en box-shadow inset et en fond),
    // jamais un wrapper qui déplace le contenu.
    //
    // Ce que la repro CDP a chiffré avant le fix : barre de contexte et croix
    // de la master décalées de 41,8px (le chip « délier », invisible mais
    // TOUJOURS dans le flux flex), et ligne master rendue 1px SOUS le cadre.
    const GEO = `(() => {
      const r = (n) => { const b = n.getBoundingClientRect(); return { l: +b.left.toFixed(2), r: +b.right.toFixed(2), t: +b.top.toFixed(2), b: +b.bottom.toFixed(2), w: +b.width.toFixed(2) }; };
      const q = (s) => document.querySelector(s);
      const master = q('#flow .grp-master-head .conv');
      const member = q('#flow .member .conv');
      // Référence plate : la première qui porte une barre de contexte VISIBLE —
      // une conv sans ctx la rend display:none, son rect vaut 0 et ne compare
      // plus rien (piège du premier passage de ce banc).
      const flat = Array.from(document.querySelectorAll('#flow > .conv')).find(function (c) {
        const b = c.querySelector('.bar-ctx');
        return b && getComputedStyle(b).display !== 'none';
      }) || q('#flow > .conv');
      const grip = q('#flow .grp-head');
      const head = q('#flow .grp-master-head');
      const ctr = (n) => { const b = n.getBoundingClientRect(); return +(b.left + b.width / 2).toFixed(2); };
      return {
        masterL: r(master).l, memberL: r(member).l, flatL: r(flat).l,
        masterIco: ctr(master.querySelector('.ico')), memberIco: ctr(member.querySelector('.ico')), flatIco: ctr(flat.querySelector('.ico')),
        masterCtx: r(master.querySelector('.bar-ctx')), memberCtx: r(member.querySelector('.bar-ctx')), flatCtx: r(flat.querySelector('.bar-ctx')),
        masterOut: r(q('#flow .grp-master-head .m-out')), memberOut: r(q('#flow .member .m-out')),
        grip: r(grip), head: r(head), masterRow: r(master),
        gripBorderBottom: parseFloat(getComputedStyle(grip).borderBottomWidth),
        gripBorderTotal: ['Top', 'Right', 'Bottom', 'Left']
          .reduce((s, side) => s + parseFloat(getComputedStyle(grip)['border' + side + 'Width']), 0),
        // 2026-08-17 : plus AUCUN cadre sur la ligne maîtresse — ni le pseudo
        // qui le peignait (étape 19), ni une bordure sur la ligne elle-même.
        headShadow: getComputedStyle(head, '::after').boxShadow,
        headShadowLayer: getComputedStyle(head, '::after').zIndex,
        headShadowPos: getComputedStyle(head, '::after').position,
        headBorderTotal: ['Top', 'Right', 'Bottom', 'Left']
          .reduce((s, side) => s + parseFloat(getComputedStyle(head)['border' + side + 'Width']), 0),
        // La bulle de tête : ce qui remplace le cadre. Mesurée sur le pseudo
        // de l'anneau, chez la maîtresse ET chez un membre, pour que la
        // comparaison ne dépende d'aucune valeur écrite ici.
        masterRing: (() => { const cs = getComputedStyle(master.querySelector('.ico'), '::after');
          return { d: parseFloat(cs.width), w: parseFloat(cs.borderTopWidth), bg: cs.backgroundColor }; })(),
        memberRing: (() => { const cs = getComputedStyle(member.querySelector('.ico'), '::after');
          return { d: parseFloat(cs.width), w: parseFloat(cs.borderTopWidth) }; })(),
        masterWeight: getComputedStyle(master.querySelector('.title')).fontWeight,
        memberWeight: getComputedStyle(member.querySelector('.title')).fontWeight,
        headBg: getComputedStyle(head).backgroundColor,
        gripBg: getComputedStyle(grip).backgroundColor,
        killPos: getComputedStyle(q('#flow .grp-head .g-kill')).position,
      };
    })()`;
    // Invariants vérifiés à l'identique dans plusieurs états du monde : une
    // égalité qui ne tient qu'au premier rendu ne vaut rien (c'est la leçon du
    // lot 12, où la mesure d'après-reload était la seule fausse).
    async function checkMasterGeometry(label) {
      const g = await cdp.evaluate(GEO);
      check(`${label} — bord gauche : master == membre == ligne plate`,
        Math.abs(g.masterL - g.memberL) < 0.5 && Math.abs(g.masterL - g.flatL) < 0.5, JSON.stringify(g));
      check(`${label} — axe de la colonne d'icône : master == membre == ligne plate`,
        Math.abs(g.masterIco - g.memberIco) < 0.5 && Math.abs(g.masterIco - g.flatIco) < 0.5, JSON.stringify(g));
      // 2026-08-07 — l'égalité porte désormais sur les DEUX bords, ligne plate
      // comprise. Avant, la barre d'une ligne de groupe était plus courte :
      // le bouton de sortie, enfant du flux, lui volait sa largeur. C'était
      // « par construction », donc jamais mesuré — et c'est très exactement ce
      // que l'user voyait. La construction a changé (overlay), l'invariant est
      // maintenant le même pour les trois lignes.
      check(`${label} — barre de contexte : master == membre == ligne plate (x, largeur ET bord droit)`,
        Math.abs(g.masterCtx.l - g.memberCtx.l) < 0.5 && Math.abs(g.masterCtx.l - g.flatCtx.l) < 0.5
        && Math.abs(g.masterCtx.w - g.memberCtx.w) < 0.5 && Math.abs(g.masterCtx.w - g.flatCtx.w) < 0.5
        && Math.abs(g.masterCtx.r - g.memberCtx.r) < 0.5 && Math.abs(g.masterCtx.r - g.flatCtx.r) < 0.5,
        JSON.stringify(g));
      check(`${label} — croix de droite : master == membre (x et largeur)`,
        Math.abs(g.masterOut.l - g.memberOut.l) < 0.5 && Math.abs(g.masterOut.w - g.memberOut.w) < 0.5, JSON.stringify(g));
      // Cadre teinté = grip + ligne master, sans interstice : la master est
      // DEDANS (constat user : elle flottait dessous).
      const frame = { l: Math.min(g.grip.l, g.head.l), t: g.grip.t, r: Math.max(g.grip.r, g.head.r), b: g.head.b };
      check(`${label} — cadre continu : la grip et la ligne master se touchent (aucun interstice)`,
        Math.abs(g.head.t - g.grip.b) < 0.5, `grip.bottom=${g.grip.b} master.top=${g.head.t}`);
      check(`${label} — bords latéraux du cadre alignés (grip et ligne master, même boîte)`,
        Math.abs(g.grip.l - g.head.l) < 0.5 && Math.abs(g.grip.r - g.head.r) < 0.5, JSON.stringify(g));
      check(`${label} — ligne master entièrement CONTENUE dans le cadre teinté`,
        g.masterRow.t >= frame.t - 0.5 && g.masterRow.b <= frame.b + 0.5
        && g.masterRow.l >= frame.l - 0.5 && g.masterRow.r <= frame.r + 0.5, JSON.stringify({ frame, row: g.masterRow }));
      // 2026-08-17 — le lot n'est plus une BOÎTE encadrée : ni la grip ni la
      // ligne maîtresse ne portent le moindre trait. Ces trois checks sont
      // l'inverse exact de ceux d'avant : ils tombent si un cadre revient,
      // d'où qu'il vienne (pseudo, bordure de la grip, bordure de la ligne).
      check(`${label} — la grip n'a AUCUNE bordure (bande teintée seule)`,
        g.gripBorderTotal === 0, String(g.gripBorderTotal));
      check(`${label} — la ligne maîtresse n'a AUCUN cadre (ni pseudo, ni bordure)`,
        g.headShadow === 'none' && g.headBorderTotal === 0,
        `${g.headShadow} / ${g.headBorderTotal}`);
      // Ce qui le remplace, mesuré par COMPARAISON avec un membre : la bulle
      // de tête est plus grosse et plus épaisse, et le titre plus gras. Aucune
      // valeur en dur ici — régler --master-ring-* ne fait pas mentir le banc,
      // seul un retour à l'anneau ordinaire le fait tomber.
      check(`${label} — bulle de tête plus grosse et plus épaisse que celle d'un membre`,
        g.masterRing.d > g.memberRing.d + 2 && g.masterRing.w > g.memberRing.w + 1,
        JSON.stringify({ master: g.masterRing, member: g.memberRing }));
      check(`${label} — titre de la maîtresse en gras, plus appuyé que celui d'un membre`,
        Number(g.masterWeight) >= 700 && Number(g.masterWeight) > Number(g.memberWeight),
        `${g.masterWeight} / ${g.memberWeight}`);
      check(`${label} — même fond teinté sur la grip et sur la ligne master (une seule variable)`,
        g.headBg === g.gripBg && g.headBg !== 'rgba(0, 0, 0, 0)', `${g.gripBg} / ${g.headBg}`);
      // Le ✕ de dissolution, lui, a le droit de rester dans le flux : il vit
      // désormais sur la GRIP (2026-08-09), qui ne porte aucune barre de
      // contexte — l'invariant « au pixel » ne concerne que les lignes de
      // conversation, dont l'égalité est vérifiée juste au-dessus.
      check(`${label} — le ✕ de dissolution est sur la grip, jamais sur une ligne`,
        g.killPos === 'static', g.killPos);
      return g;
    }

    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: withMaster })}, '*')`);
    await sleep(200);
    const geoRest = await checkMasterGeometry('rendu nominal');

    // 2026-08-07 — l'overlay ne doit RIEN pousser quand il apparaît : la
    // géométrie au survol est la même qu'au repos, sinon la ligne « bougerait »
    // sous le curseur et l'égalité avec une ligne plate ne tiendrait que dans
    // l'état où personne ne regarde. Survol de la ligne d'un membre, mesure
    // identique, puis retour.
    const hoverAt = async (sel) => {
      const c = await cdp.evaluate(`(() => { const b = document.querySelector('${sel}').getBoundingClientRect();
        return [b.left + b.width / 2, b.top + b.height / 2]; })()`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c[0], y: c[1], buttons: 0 });
      await sleep(150);
    };
    await hoverAt('#flow .member .conv');
    const geoHover = await cdp.evaluate(GEO);
    check('survol d\'une ligne de membre : le bouton de retrait apparaît…',
      await cdp.evaluate(`getComputedStyle(document.querySelector('#flow .member .m-out')).opacity`) === '1');
    check('… sans déplacer un seul pixel (barre de contexte et icône identiques au repos)',
      Math.abs(geoHover.memberCtx.l - geoRest.memberCtx.l) < 0.5
      && Math.abs(geoHover.memberCtx.r - geoRest.memberCtx.r) < 0.5
      && Math.abs(geoHover.memberIco - geoRest.memberIco) < 0.5,
      JSON.stringify({ rest: geoRest.memberCtx, hover: geoHover.memberCtx }));
    check('… et la barre reste alignée sur celle d\'une ligne plate pendant le survol',
      Math.abs(geoHover.memberCtx.r - geoHover.flatCtx.r) < 0.5
      && Math.abs(geoHover.memberCtx.l - geoHover.flatCtx.l) < 0.5,
      JSON.stringify(geoHover));
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2, buttons: 0 });
    await sleep(120);

    // Reload de fenêtre simulé : le panneau se vide (aucune source) puis se
    // repeuple — chemin de rendu qui avait produit la régression du lot 12.
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: { conversations: [], groups: [], quota: STATE.quota } })}, '*')`);
    await sleep(150);
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: withMaster })}, '*')`);
    await sleep(200);
    await checkMasterGeometry('après reload simulé');

    // Les deux thèmes : les mêmes égalités, plus l'invariant « l'anneau troue
    // le rail ». Preuve A/B insensible au sous-pixel : on capture le disque de
    // l'anneau AVEC puis SANS le rail (display:none) — images identiques ⇒
    // aucun pixel du rail ne transparaît. C'est ainsi qu'a été prise en défaut
    // la master « ✓ déjà lue », dont l'opacity de glyphe rendait tout l'anneau
    // translucide.
    const ringDisc = async (sel) => {
      const c = await cdp.evaluate(`(() => { const b = document.querySelector('${sel}').getBoundingClientRect();
        return [b.left + b.width / 2, b.top + b.height / 2]; })()`);
      return (await cdp.send('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: false,
        clip: { x: c[0] - 7, y: c[1] - 7, width: 14, height: 14, scale: 1 },
      })).data;
    };
    for (const [name, vars] of Object.entries(THEMES)) {
      const setVars = Object.entries(vars).map(([k, v]) => `document.documentElement.style.setProperty('${k}','${v}')`).join(';');
      await cdp.evaluate(`(() => { ${setVars}; })()`);
      await sleep(120);
      await checkMasterGeometry(`thème ${name}`);
      // Étape 16 : l'anneau busy de groupe tourne désormais (même keyframes que
      // les lignes plates). Cette preuve A/B compare deux captures prises à des
      // instants différents (l'ouverture/fermeture du rail entre les deux) —
      // sur une icône animée, pause()/currentTime restent asynchrones côté
      // Chromium (constaté flaky, thème tantôt dark tantôt light). Le membre
      // "done" (m2, jamais animé) porte exactement le même invariant d'anneau
      // opaque sans dépendre du minutage d'une pause d'animation.
      const sels = { membre: '#flow .member .conv .ico-done', master: '#flow .grp-master-head .conv .ico' };
      const withRail = {};
      for (const [who, sel] of Object.entries(sels)) withRail[who] = await ringDisc(sel);
      await cdp.evaluate(`document.querySelector('#flow .grp-rail').style.display = 'none'`);
      await sleep(80);
      for (const [who, sel] of Object.entries(sels)) {
        const bare = await ringDisc(sel);
        check(`thème ${name} — anneau ${who} STRICTEMENT opaque : le rail ne transparaît pas (image identique avec et sans rail)`,
          withRail[who] === bare);
      }
      await cdp.evaluate(`document.querySelector('#flow .grp-rail').style.display = ''`);
      await sleep(80);
    }
    for (const k of Object.keys(THEMES.dark)) await cdp.evaluate(`document.documentElement.style.removeProperty('${k}')`);

    // Master HORS DE VUE (fallback dégradé) : même conteneur, donc mêmes
    // offsets — le cadre l'englobe pareil. C'est l'état dans lequel l'user a
    // constaté le bug (après reload, master temporairement non listée).
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: masterGone })}, '*')`);
    await sleep(200);
    const fb = await cdp.evaluate(`(() => {
      const r = (n) => { const b = n.getBoundingClientRect(); return { l: +b.left.toFixed(2), r: +b.right.toFixed(2), t: +b.top.toFixed(2), b: +b.bottom.toFixed(2) }; };
      const row = document.querySelector('#flow .grp-master-fallback');
      const grip = document.querySelector('#flow .grp-head');
      const head = document.querySelector('#flow .grp-master-head');
      const member = document.querySelector('#flow .member .conv');
      return { row: r(row), grip: r(grip), head: r(head), member: r(member),
               out: r(document.querySelector('#flow .grp-master-head .m-out')),
               memberOut: r(document.querySelector('#flow .member .m-out')) };
    })()`);
    check('master hors de vue (fallback) — bord gauche aligné sur les lignes du groupe',
      Math.abs(fb.row.l - fb.member.l) < 0.5, JSON.stringify(fb));
    check('master hors de vue (fallback) — croix alignée sur celle des membres',
      Math.abs(fb.out.l - fb.memberOut.l) < 0.5, JSON.stringify(fb));
    check('master hors de vue (fallback) — toujours contenue dans le cadre (grip collée, mêmes bords)',
      Math.abs(fb.head.t - fb.grip.b) < 0.5 && fb.row.b <= fb.head.b + 0.5, JSON.stringify(fb));

    // Groupe REPLIÉ avec master (révisé 2026-08-07, puis 2026-08-17 sans
    // cadre) : la grip RESTE en place et sa bande teintée reste collée à la
    // ligne maîtresse — repliée, la tête de lot est la même qu'ouverte, en
    // plus court. Ce qui se mesure n'est plus un trait mais la CONTINUITÉ des
    // deux fonds : aucun interstice, aucun coin arrondi à leur couture.
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: collapsedWithMaster })}, '*')`);
    await sleep(200);
    const col = await cdp.evaluate(`(() => {
      const head = document.querySelector('#flow .grp-master-head');
      const grip = document.querySelector('#flow .grp-head');
      const gb = grip.getBoundingClientRect(); const hb = head.getBoundingClientRect();
      return { gripVisible: getComputedStyle(grip).display !== 'none',
               gripBg: getComputedStyle(grip).backgroundColor,
               headBg: getComputedStyle(head).backgroundColor,
               joined: Math.abs(hb.top - gb.bottom) < 0.5,
               shadow: getComputedStyle(head, '::after').boxShadow, radiusTop: getComputedStyle(head).borderTopLeftRadius };
    })()`);
    check('replié + master : la grip reste visible et sa bande teintée reste collée à la maîtresse…',
      col.gripVisible === true && col.joined === true && col.gripBg === col.headBg
      && col.gripBg !== 'rgba(0, 0, 0, 0)', JSON.stringify(col));
    check('… et la ligne maîtresse n\'invente aucun cadre au repli (coins hauts carrés, aucun trait)',
      col.shadow === 'none' && parseFloat(col.radiusTop) === 0, JSON.stringify(col));

    // Sans master : la grip reste la même bande teintée, elle ne se referme
    // sur rien — il n'y a plus de bordure à rétablir depuis 2026-08-17.
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: noMaster })}, '*')`);
    await sleep(200);
    const solo = await cdp.evaluate(`(() => {
      const grip = document.querySelector('#flow .grp-head');
      return { borderTotal: ['Top', 'Right', 'Bottom', 'Left']
                 .reduce((s, side) => s + parseFloat(getComputedStyle(grip)['border' + side + 'Width']), 0),
               bg: getComputedStyle(grip).backgroundColor,
               hasMasterClass: document.querySelector('#flow .grp').classList.contains('has-master'),
               masterRow: !!document.querySelector('#flow .grp-master-head') };
    })()`);
    check('sans master : la grip reste une bande teintée sans aucune bordure',
      solo.borderTotal === 0 && solo.bg !== 'rgba(0, 0, 0, 0)'
      && solo.hasMasterClass === false && solo.masterRow === false, JSON.stringify(solo));

    console.log('\n17. Étape 19 — polissage : le cadre tient dans TOUS les états interactifs, la croix est dedans, le rail dehors');
    // Constats user 2026-08-05 (capsule) : cadre avalé par le fond de la ligne
    // master SÉLECTIONNÉE, croix chevauchant la bande droite, rail dessiné À
    // L'INTÉRIEUR du cadre, glyphe ⚠ pas centré dans son anneau. Les quatre
    // sont ici des invariants MESURÉS, pas des réglages : la référence reste
    // toujours un autre élément du même rendu.
    const activeMaster = JSON.parse(JSON.stringify(withMaster));
    activeMaster.conversations.find((c) => c.id === 'c3').active = true;

    // Bande du cadre : un ruban de 2px de large pris sur le bord, à hauteur de
    // la ligne master. Le clip est calculé UNE fois (état au repos) et rejoué
    // tel quel dans les autres états — deux images identiques prouvent qu'AUCUN
    // fond n'est venu se peindre par-dessus.
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: withMaster })}, '*')`);
    await sleep(200);
    const bandClip = await cdp.evaluate(`(() => {
      const grip = document.querySelector('#flow .grp-head').getBoundingClientRect();
      const head = document.querySelector('#flow .grp-master-head').getBoundingClientRect();
      // Ruban pris au MILIEU de la hauteur : aux coins, la boîte est arrondie
      // (radius 6px) et le pixel du bord tombe HORS d'elle — on y verrait ce
      // qui passe derrière, ce qui n'est pas ce qu'on teste.
      return { l: Math.min(grip.left, head.left), r: Math.max(grip.right, head.right),
               t: head.top + head.height / 4, h: Math.max(6, head.height / 2) };
    })()`);
    // 1px de large, pris DANS la bande : un ruban plus large embarquerait le
    // fond juste derrière elle, qui a le droit de changer d'un état à l'autre.
    const band = async (side) => (await cdp.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: false,
      clip: { x: side === 'left' ? bandClip.l : bandClip.r - 1, y: bandClip.t, width: 1, height: bandClip.h, scale: 1 },
    })).data;
    const moveMouse = (x, y) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
    const masterCenter = await cdp.evaluate(`(() => { const b = document.querySelector('#flow .grp-master-head .conv').getBoundingClientRect();
      return [b.left + b.width / 2, b.top + b.height / 2]; })()`);

    // Fonds de sélection/survol : absents des THEMES ci-dessus (qui ne servaient
    // qu'à l'anneau), et .conv.active/:hover n'a AUCUN repli dans panel.js — sans
    // eux, la ligne « sélectionnée » resterait transparente et ce test ne
    // prouverait rien du tout.
    const PICK = {
      dark: { '--vscode-list-inactiveSelectionBackground': '#37373d', '--vscode-list-hoverBackground': '#2a2d2e' },
      light: { '--vscode-list-inactiveSelectionBackground': '#e4e6f1', '--vscode-list-hoverBackground': '#e8e8e8' },
    };
    for (const [name, themeVars] of Object.entries(THEMES)) {
      const vars = Object.assign({}, themeVars, PICK[name]);
      const setVars = Object.entries(vars).map(([k, v]) => `document.documentElement.style.setProperty('${k}','${v}')`).join(';');
      await cdp.evaluate(`(() => { ${setVars}; })()`);
      await moveMouse(2, 2);
      await sleep(120);
      const ref = { left: await band('left'), right: await band('right') };
      // (a) Ligne master SÉLECTIONNÉE — le cas exact du constat user.
      await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: activeMaster })}, '*')`);
      await sleep(180);
      check(`thème ${name} — ligne master sélectionnée : le fond de sélection est bien peint (sinon le test ne prouve rien)`,
        await cdp.evaluate(`getComputedStyle(document.querySelector('#flow .grp-master-head .conv')).backgroundColor`)
          !== 'rgba(0, 0, 0, 0)');
      for (const side of ['left', 'right'])
        check(`thème ${name} — … et la bande teintée ${side === 'left' ? 'gauche' : 'droite'} est INTACTE (pixels identiques au repos)`,
          await band(side) === ref[side]);
      // (b) Ligne master SURVOLÉE — même fond, autre variable de thème.
      await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: withMaster })}, '*')`);
      await sleep(180);
      await moveMouse(masterCenter[0], masterCenter[1]);
      await sleep(150);
      for (const side of ['left', 'right'])
        check(`thème ${name} — ligne master survolée : bande teintée ${side === 'left' ? 'gauche' : 'droite'} intacte`,
          await band(side) === ref[side]);
      await moveMouse(2, 2);
      await sleep(120);
      // (c) SUPPRIMÉ 2026-08-17 — « un fond d'enfant débordant ne peut pas
      // recouvrir le cadre ». Il n'y a plus de cadre à protéger : la tête de
      // lot se lit à sa bulle, son rail et son titre. Les deux mesures qui
      // précèdent gardent tout leur sens (la bande TEINTÉE, elle, survit à la
      // sélection comme au survol), et le §16 vérifie qu'aucun trait n'est
      // revenu s'ajouter. Ne pas ressusciter ce cas sans un cadre à défendre.
      for (const k of Object.keys(vars)) await cdp.evaluate(`document.documentElement.style.removeProperty('${k}')`);
    }

    // (d) Croix DANS le cadre sans avoir bougé d'un pixel : les deux exigences
    // ensemble, sinon on retombe dans le conflit signalé au plan (rentrer la
    // croix casserait l'égalité de l'étape 13). C'est donc le CADRE qui déborde.
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: withMaster })}, '*')`);
    await sleep(200);
    const cross = await cdp.evaluate(`(() => {
      const r = (n) => { const b = n.getBoundingClientRect(); return { l: +b.left.toFixed(2), r: +b.right.toFixed(2) }; };
      const grip = document.querySelector('#flow .grp-head').getBoundingClientRect();
      const head = document.querySelector('#flow .grp-master-head').getBoundingClientRect();
      const band = parseFloat(getComputedStyle(document.querySelector('#flow .grp-master-head'), '::after').boxShadow) || 1.5;
      return { master: r(document.querySelector('#flow .grp-master-head .m-out')),
               member: r(document.querySelector('#flow .member .m-out')),
               frameR: Math.max(grip.right, head.right), frameL: Math.min(grip.left, head.left), band: 1.5 };
    })()`);
    check('croix de la master : strictement À L\'INTÉRIEUR de la bande droite du cadre',
      cross.master.r < cross.frameR - cross.band, JSON.stringify(cross));
    check('… sans avoir bougé : même x que la croix d\'un membre (invariant étape 13 préservé)',
      Math.abs(cross.master.l - cross.member.l) < 0.5, JSON.stringify(cross));

    // (e) Le rail ne se dessine JAMAIS dans le cadre : intersection vide.
    // (e) RÉVISÉ 2026-08-17 — l'invariant d'avant (« aucune intersection avec
    // l'intérieur du cadre ») disait que le trait ne devait pas se dessiner
    // DANS la capsule. Sans capsule, il est remplacé par ce qu'on veut
    // vraiment : le rail PART DE LA BULLE de la maîtresse — son sommet tombe
    // au bas de l'anneau, jamais plus haut (il traverserait la bulle) ni plus
    // bas d'une ligne entière (il se décrocherait de sa tête).
    const railVsBubble = await cdp.evaluate(`(() => {
      const rail = document.querySelector('#flow .grp-rail').getBoundingClientRect();
      const ico = document.querySelector('#flow .grp-master-head .conv .ico').getBoundingClientRect();
      const ring = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--master-ring-d'));
      const center = ico.top + ico.height / 2;
      return { gap: +(rail.top - (center + ring / 2)).toFixed(2),
               belowCenter: rail.top > center, railTop: +rail.top.toFixed(2), center: +center.toFixed(2), ring };
    })()`);
    check('rail P1 : son sommet est au bas de la bulle de la maîtresse (jamais au travers)',
      Math.abs(railVsBubble.gap) < 1 && railVsBubble.belowCenter === true, JSON.stringify(railVsBubble));

    // (e bis) 2026-08-17 — le fond d'une ligne ne masque PAS le rail. Constat
    // user : survoler une conversation d'un lot effaçait le trait sur toute la
    // hauteur de la ligne. Cause : le rail se peignait SOUS les fonds de
    // lignes, et un fond de ligne est opaque.
    // Mesuré sur l'EMPILEMENT, pas sur les pixels, et c'est le bon outil ici :
    // l'ordre de peinture CSS est une règle exacte (un positionné à z-index 1
    // passe après tous les positionnés en auto, quel que soit l'ordre du DOM),
    // alors qu'un ruban de pixels sur le trait n'est pas calable — le poste
    // rend à devicePixelRatio 1,8 et le rail tombe à des abscisses
    // fractionnaires, si bien qu'un clip de 1px mélange toujours un peu du
    // fond qui, lui, DOIT changer au survol. Les trois valeurs doivent rester
    // STRICTEMENT ordonnées : lignes < rail < anneaux. À valeur égale, c'est
    // l'ordre du DOM qui trancherait — or place() réordonne les enfants du
    // corps, c'est très exactement ce qui a cassé les anneaux au premier jet.
    const stack = await cdp.evaluate(`(() => {
      const z = (el) => { const v = getComputedStyle(el).zIndex; return v === 'auto' ? 0 : Number(v); };
      const rail = document.querySelector('#flow .grp-rail');
      const row = document.querySelector('#flow .member .conv');
      return { rail: z(rail), row: z(row), master: z(document.querySelector('#flow .grp-master-head .conv')),
               ico: z(row.querySelector('.ico')), masterIco: z(document.querySelector('#flow .grp-master-head .conv .ico')),
               railPos: getComputedStyle(rail).position };
    })()`);
    check('rail P1 : au-dessus des fonds de lignes (survol et sélection ne peuvent plus l\'effacer)',
      stack.railPos === 'absolute' && stack.rail > stack.row && stack.rail > stack.master, JSON.stringify(stack));
    check('… et STRICTEMENT sous les anneaux, qui continuent de le trouer (jamais la même valeur, sinon le DOM arbitre)',
      stack.ico > stack.rail && stack.masterIco > stack.rail, JSON.stringify(stack));

    // (f) La pill « ▶ lancer la vague » ne CROISE plus le rail (constat user
    // 2026-08-07 : « la pill mord sur le trait ») : sa boîte commence après
    // l'axe, comme les autres en-têtes de vague — intersection vide PAR
    // GÉOMÉTRIE, même règle que la bannière waveCtrl du §7bis. Le z-index 1
    // de l'étape 19 reste en ceinture : si les boîtes se recroisent un jour,
    // la pill doit repasser devant — vérifié aussi, sans dépendre du rendu.
    const pillVsRail = await cdp.evaluate(`(() => {
      const pill = document.querySelector('#flow .wave-hdr.launch');
      if (!pill) return null;
      const b = pill.getBoundingClientRect();
      const railEl = document.querySelector('#flow .grp-rail');
      const rail = railEl.getBoundingClientRect();
      // Bord droit du TRAIT (border-left), pas de la boîte du crochet.
      return { railRight: rail.left + parseFloat(getComputedStyle(railEl).borderLeftWidth), pillLeft: b.left,
               z: getComputedStyle(pill).zIndex, pos: getComputedStyle(pill).position,
               railZ: getComputedStyle(railEl).zIndex };
    })()`);
    if (pillVsRail) {
      check('pill « ▶ vague » : sa boîte commence après l\'axe du rail (aucune morsure possible)',
        pillVsRail.pillLeft >= pillVsRail.railRight, JSON.stringify(pillVsRail));
      check('… et garde une ceinture d\'empilement STRICTEMENT au-dessus du rail (recroisement futur → pill devant)',
        pillVsRail.pos === 'relative' && Number(pillVsRail.z) > Number(pillVsRail.railZ), JSON.stringify(pillVsRail));
    }

    // (g) Symbole d'état centré dans son anneau — mesuré sur les PIXELS (un
    // ::before n'a pas de rect). Écrit du temps du glyphe ⚠ de substitution ;
    // depuis 2026-08-09 c'est le carré « stop » commun aux deux contextes qui
    // est mesuré ici, et la mesure vaut désormais preuve DOUBLE : centrage, et
    // surtout ENCRE PRÉSENTE dans l'anneau — une forme portée par la bordure de
    // l'hôte (l'ancienne écriture) serait avalée par le disque opaque et
    // rendrait `empty: true`, exactement le motif de l'arc busy en 2.28.2.
    // Le blob passe par createImageBitmap : la CSP du webview interdit un
    // img.src = 'data:…', mais rien n'interdit une image construite en mémoire.
    const SC = 12;
    async function inkOffset(sel) {
      const c = await cdp.evaluate(`(() => { const n = document.querySelector('${sel}');
        if (!n || getComputedStyle(n).display === 'none') return null;
        const b = n.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()`);
      if (!c) return null;
      const png = (await cdp.send('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: false,
        clip: { x: c[0] - 12, y: c[1] - 12, width: 24, height: 24, scale: SC },
      })).data;
      await cdp.evaluate(`(() => {
        window.__ink = null;
        const bin = atob('${png}');
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        createImageBitmap(new Blob([bytes], { type: 'image/png' })).then(function (img) {
          const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
          const g = cv.getContext('2d'); g.drawImage(img, 0, 0);
          const d = g.getImageData(0, 0, cv.width, cv.height).data;
          const cx = cv.width / 2, cy = cv.height / 2, rIn = 5.8 * ${SC};
          const lum = [], px = [];
          for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) {
            if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > rIn * rIn) continue;
            const i = (y * cv.width + x) * 4;
            const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            lum.push(l); px.push([x, y, l]);
          }
          const med = lum.slice().sort(function (a, b) { return a - b; })[Math.floor(lum.length / 2)];
          let l0 = 1e9, r0 = -1e9, t0 = 1e9, b0 = -1e9, n = 0;
          for (const p of px) {
            if (Math.abs(p[2] - med) < 40) continue;
            n++; if (p[0] < l0) l0 = p[0]; if (p[0] > r0) r0 = p[0]; if (p[1] < t0) t0 = p[1]; if (p[1] > b0) b0 = p[1];
          }
          window.__ink = n ? { dx: ((l0 + r0) / 2 - cx) / ${SC}, dy: ((t0 + b0) / 2 - cy) / ${SC}, px: n } : { empty: true };
        });
      })()`);
      for (let i = 0; i < 40; i++) {
        const v = await cdp.evaluate('window.__ink');
        if (v) return v;
        await sleep(50);
      }
      return null;
    }
    // Groupe portant un membre interrompu — le carré doit se voir DANS l'anneau.
    const warnState = JSON.parse(JSON.stringify(withMaster));
    warnState.conversations[5].state = 'interrupted';
    warnState.conversations[5].groupId = 'g1';
    warnState.groups[0].members.push({ key: 'm4', prompt: 'Coupée au clavier', wave: 2, asked: { model: 'opus', effort: 'high' }, convId: 'c6', status: 'interrupted', waveStatus: 'launched', canLink: false, canClose: false, note: '', hint: '' });
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: warnState })}, '*')`);
    await sleep(250);
    const warnInk = await inkOffset('#flow .grp-body .conv .ico-interrupted');
    check('carré « stop » d\'un membre : son ENCRE est VISIBLE dans l\'anneau (l\'anneau ne l\'avale pas)',
      !!warnInk && !warnInk.empty && warnInk.px > 0, JSON.stringify(warnInk));
    check('… et elle est centrée dans l\'anneau (≤ 0,75 px, le reste tient dans le tramage)',
      !!warnInk && !warnInk.empty && Math.abs(warnInk.dx) < 0.75 && Math.abs(warnInk.dy) < 0.75, JSON.stringify(warnInk));
    check('… le centrage vient de la boîte, pas d\'un décalage chiffré : aucune transform sur le symbole',
      await cdp.evaluate(`getComputedStyle(document.querySelector('#flow .grp-body .conv .ico-interrupted'), '::before').transform`) === 'none');

    console.log('\n18. Tri « ordre des onglets » — le bloc de groupe s\'INTERCALE dans le flux (2026-08-07)');
    // Avant ce lot, l'ordre était STRUCTUREL : deux conteneurs (#groups puis
    // #convs), donc un groupe passait toujours avant la moindre conversation
    // hors groupe, même si tous ses onglets étaient à l'extrême droite. Le
    // rang d'un bloc vaut désormais celui du plus à gauche de ses onglets —
    // maîtresse comprise. L'ordre du tableau `conversations` EST le rang :
    // c'est state.js qui l'a trié par onglets, le webview ne re-dérive rien.
    const fconv = (id, title, extra) => Object.assign({
      id, title, model: 'Opus 4.8', ctx: { pct: 20 }, state: 'idle',
      acked: true, active: false, tabOpen: true,
    }, extra || {});
    // Onglet 2 = la conv du groupe : elle a une conv plate à sa gauche ET une
    // à sa droite, le seul agencement où « groupes en tête » et « ordre des
    // onglets » ne peuvent pas se confondre.
    const flowConvs = [
      fconv('f1', 'Onglet 1 plate'),
      fconv('gm', 'Onglet 2 membre', { groupId: 'gf', state: 'busy' }),
      fconv('f3', 'Onglet 3 plate'),
    ];
    const flowGroup = {
      id: 'gf', name: 'Groupe intercalé', hue: 200, collapsed: false,
      launchedWave: 1, nextWave: null, waveNotice: null, master: null,
      members: [{
        key: 'k1', prompt: 'Membre du groupe', wave: 1, asked: { model: 'opus', effort: 'high' },
        convId: 'gm', status: 'busy', waveStatus: 'launched', canLink: false, canClose: false, note: '', hint: '',
      }],
    };
    const flowState = (order, convs, groups) => ({
      conversations: convs, groups, quota: STATE.quota, ui: { sortOrder: order },
    });
    // Lecture de l'ordre RÉEL du DOM : un bloc de groupe et une ligne plate
    // sont des frères, c'est tout l'objet du lot.
    const FLOW_ORDER = `Array.from(document.getElementById('flow').children).map(function (n) {
      if (n.classList.contains('grp')) return 'GROUPE';
      if (n.classList.contains('conv')) return (n.querySelector('.title') || {}).textContent;
      return '(' + n.className + ')';
    })`;
    const flowOrderOf = async (order, convs, groups) => {
      const msg = JSON.stringify({ type: 'state', state: flowState(order, convs, groups) });
      await cdp.evaluate(`window.postMessage(${msg}, '*')`);
      await sleep(180);
      return (await cdp.evaluate(FLOW_ORDER)).join(' | ');
    };

    check('ordre des onglets : la conv de gauche passe AVANT le groupe, celle de droite APRÈS',
      await flowOrderOf('tabOrder', flowConvs, [flowGroup])
        === 'Onglet 1 plate | GROUPE | Onglet 3 plate',
      await cdp.evaluate(FLOW_ORDER + '.join(" | ")'));

    // Un seul nœud par conversation, où qu'il tombe dans le flux (invariant
    // historique : jamais deux endroits du DOM pour la même conv).
    check('… et la conv du groupe n\'apparaît pas AUSSI en ligne plate',
      await cdp.evaluate(`document.querySelectorAll('#flow > .conv').length`) === 2
      && await cdp.evaluate(`document.querySelectorAll('.conv .title').length`) === 3);

    check('les autres modes de tri sont INCHANGÉS : « dernière activité » garde les groupes en tête',
      await flowOrderOf('lastActivity', flowConvs, [flowGroup])
        === 'GROUPE | Onglet 1 plate | Onglet 3 plate',
      await cdp.evaluate(FLOW_ORDER + '.join(" | ")'));
    check('… idem « état d\'abord »',
      await flowOrderOf('statusFirst', flowConvs, [flowGroup])
        === 'GROUPE | Onglet 1 plate | Onglet 3 plate',
      await cdp.evaluate(FLOW_ORDER + '.join(" | ")'));

    // La MAÎTRESSE compte comme n'importe quel onglet du bloc : c'est une conv
    // du groupe, simplement pas un membre. Master = l'onglet le plus à droite,
    // aucun membre lié → le bloc tombe à ce rang, pas en tête.
    const masterLast = JSON.parse(JSON.stringify(flowGroup));
    masterLast.master = { convId: 'f3', title: 'Onglet 3 plate', listed: true, tabTitle: null, hint: '', status: 'idle' };
    masterLast.members[0].convId = null;
    masterLast.members[0].status = 'not-linked';
    masterLast.members[0].canLink = true;
    check('rang du bloc = son onglet le plus à GAUCHE, maîtresse comprise (ici la maîtresse est la plus à droite)',
      await flowOrderOf('tabOrder', [flowConvs[0], flowConvs[2]], [masterLast])
        === 'Onglet 1 plate | GROUPE',
      await cdp.evaluate(FLOW_ORDER + '.join(" | ")'));

    const masterFirst = JSON.parse(JSON.stringify(masterLast));
    masterFirst.master = { convId: 'f1', title: 'Onglet 1 plate', listed: true, tabTitle: null, hint: '', status: 'idle' };
    check('… et le bloc repasse en tête dès que sa maîtresse est l\'onglet le plus à gauche',
      await flowOrderOf('tabOrder', [flowConvs[0], flowConvs[2]], [masterFirst])
        === 'GROUPE | Onglet 3 plate',
      await cdp.evaluate(FLOW_ORDER + '.join(" | ")'));

    // Aucun onglet matché du tout (tâches jamais lancées) : rang Infinity, donc
    // fin de flux — même convention qu'une conversation sans onglet dans
    // state.js, et surtout jamais un NaN qui rendrait le tri instable.
    const noTabGroup = JSON.parse(JSON.stringify(flowGroup));
    noTabGroup.members[0].convId = null;
    noTabGroup.members[0].status = 'not-linked';
    noTabGroup.members[0].canLink = true;
    check('groupe sans aucun onglet matché : rang Infinity → fin de flux, jamais un tri cassé',
      await flowOrderOf('tabOrder', [flowConvs[0], flowConvs[2]], [noTabGroup])
        === 'Onglet 1 plate | Onglet 3 plate | GROUPE',
      await cdp.evaluate(FLOW_ORDER + '.join(" | ")'));

    // Le message « aucune conversation » descend en fin de flux : un groupe de
    // tâches jamais lancées doit rester visible AU-DESSUS de lui.
    check('aucune conversation mais un groupe en attente : le groupe se rend, le message vient après',
      await flowOrderOf('tabOrder', [], [noTabGroup]) === 'GROUPE | (empty)',
      await cdp.evaluate(FLOW_ORDER + '.join(" | ")'));

    console.log('\n19. Filiation des lots — canon de la maîtresse : grip → ligne de tête → corps (plan arbre-filiation 2026-08-15, lot 2, AMENDÉ 2026-08-16)');
    // LE BUG D'ORIGINE : la maîtresse d'un lot B est très souvent MEMBRE d'un
    // lot A (le lot N propose les handoffs du lot N+1). Les deux blocs se
    // disputaient alors le MÊME nœud de conversation — celui qui servait en
    // dernier le prenait, l'autre gardait un emplacement VIDE. Le rendu
    // imbriqué supprime la dispute : la ligne reste membre de A, et devient la
    // tête de B.
    //
    // Le webview ne DÉDUIT aucune filiation : nestedUnder arrive tout résolu de
    // nesting.js (éprouvé cas par cas dans test-nesting.js). Ce banc mesure ce
    // que l'ŒIL doit voir, et rien d'autre.
    const nconv = (id, title, extra) => Object.assign({
      id, title, model: 'Opus 4.8', effort: 'high', ctx: { pct: 30 }, state: 'idle',
      acked: true, active: false, tabOpen: true,
    }, extra || {});
    const nmember = (key, prompt, convId, extra) => Object.assign({
      key, prompt, wave: 1, asked: { model: 'opus', effort: 'high' },
      convId: convId || null, status: convId ? 'busy' : 'queued',
      waveStatus: convId ? 'launched' : 'queued',
      canLink: false, canClose: false, canRelaunch: false, note: '', hint: '',
    }, extra || {});
    // A : maîtresse listée + 3 membres, dont a2 qui est la maîtresse de B.
    // B : maîtresse = a2 (déjà rendue comme membre de A) + 3 membres.
    const nestConvs = [
      nconv('am', 'A master'),
      nconv('a1', 'A task one', { groupId: 'A', state: 'busy' }),
      nconv('a2', 'A task two — opens B', { groupId: 'A' }),
      nconv('b1', 'B task one', { groupId: 'B', state: 'busy' }),
      nconv('b2', 'B task two', { groupId: 'B', state: 'done', acked: true }),
      nconv('z9', 'Flat conversation'),
    ];
    const mkA = () => ({
      id: 'A', name: 'Parent batch', hue: 210, collapsed: false, stamp: '14:12',
      launchedWave: 1, nextWave: null, waveNotice: null, done: false, nestedUnder: null,
      master: { convId: 'am', title: 'A master', listed: true, tabTitle: null, hint: '', status: 'idle' },
      members: [nmember('m1', 'A task one', 'a1'), nmember('m2', 'A task two — opens B', 'a2'), nmember('m3', 'A task three', null)],
    });
    const mkB = (nested) => ({
      id: 'B', name: 'Child batch', hue: 30, collapsed: false, stamp: '15:40',
      launchedWave: 1, nextWave: null, waveNotice: null, done: false,
      nestedUnder: nested ? { groupId: 'A', memberKey: 'm2' } : null,
      master: { convId: 'a2', title: 'A task two — opens B', listed: true, tabTitle: null, hint: '', status: 'idle' },
      members: [nmember('n1', 'B task one', 'b1'), nmember('n2', 'B task two', 'b2', { status: 'done', waveStatus: 'done' }), nmember('n3', 'B task three', null)],
    });
    const nestState = (groups, convs) => ({
      conversations: convs || nestConvs, groups, quota: STATE.quota, ui: { sortOrder: 'tabOrder' },
    });
    const pushNest = async (groups, convs) => {
      await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: nestState(groups, convs) })}, '*')`);
      await sleep(180);
    };

    // (a) Sans filiation : DEUX blocs frères, et la ligne a2 revendiquée deux
    // fois — c'est l'état d'avant, qu'on mesure pour que l'écart soit un fait
    // et pas une impression. `emptySlots` compte les emplacements de membre
    // restés vides : c'est la signature exacte du bug.
    await pushNest([mkA(), mkB(false)]);
    const nestBefore = await cdp.evaluate(`(() => ({
      rootBlocks: document.querySelectorAll('#flow > .grp').length,
      emptySlots: Array.from(document.querySelectorAll('#flow .m-slot')).filter(s => !s.children.length).length,
      convNodes: document.querySelectorAll('.conv').length,
    }))()`);
    check('(témoin, sans filiation) deux blocs frères, et un emplacement de membre reste VIDE — le bug que ce lot corrige',
      nestBefore.rootBlocks === 2 && nestBefore.emptySlots === 1, JSON.stringify(nestBefore));

    // (b) Avec filiation : un seul bloc racine, grip du sous-lot JUSTE AVANT
    // sa ligne de tête, corps JUSTE APRÈS — canon de la maîtresse (amendement
    // 2026-08-16) : .grp de l'enfant n'est plus un conteneur unique, ses deux
    // moitiés (.grp-head.nest-grip / .grp-body.nest-body) sont posées
    // séparément dans le corps du parent.
    await pushNest([mkA(), mkB(true)]);
    const nestAfter = await cdp.evaluate(`(() => {
      const host = Array.from(document.querySelectorAll('#flow .member'))
        .find(m => (m.querySelector('.title') || {}).textContent === 'A task two — opens B');
      const grip = document.querySelector('.grp-head.nest-grip');
      const bodySub = document.querySelector('.grp-body.nest-body');
      return {
        rootBlocks: document.querySelectorAll('#flow > .grp').length,
        emptySlots: Array.from(document.querySelectorAll('#flow .m-slot')).filter(s => !s.children.length).length,
        gripJustBeforeHost: !!grip && !!host && grip.nextElementSibling === host,
        bodyJustAfterHost: !!bodySub && !!host && host.nextElementSibling === bodySub,
        sameParentBody: !!grip && !!bodySub && !!host
          && grip.parentElement === host.parentElement && bodySub.parentElement === host.parentElement
          && host.parentElement.classList.contains('grp-body'),
        subHasMasterLine: !!bodySub && !!bodySub.querySelector('.grp-master-head'),
        masterHeads: document.querySelectorAll('#flow .grp-master-head').length,
        // Un nœud par conversation : les 6 convs, pas une de plus, pas une de moins.
        convNodes: document.querySelectorAll('.conv').length,
        dupTitles: (() => {
          const seen = {};
          Array.from(document.querySelectorAll('.conv .title')).forEach(t => { seen[t.textContent] = (seen[t.textContent] || 0) + 1; });
          return Object.keys(seen).filter(k => seen[k] > 1);
        })(),
      };
    })()`);
    check('un seul bloc RACINE dans le flux (le sous-lot n\'y est plus)', nestAfter.rootBlocks === 1, JSON.stringify(nestAfter));
    check('la grip du sous-lot est rangée JUSTE AVANT la ligne qui lui sert de tête', nestAfter.gripJustBeforeHost === true, JSON.stringify(nestAfter));
    check('… et son corps JUSTE APRÈS', nestAfter.bodyJustAfterHost === true, JSON.stringify(nestAfter));
    check('grip, ligne d\'accueil et corps vivent dans le MÊME corps de groupe — celui du parent',
      nestAfter.sameParentBody === true, JSON.stringify(nestAfter));
    check('le sous-lot n\'a PAS de ligne maîtresse (sa tête est la ligne du parent)',
      nestAfter.subHasMasterLine === false && nestAfter.masterHeads === 1, JSON.stringify(nestAfter));
    check('zéro emplacement de membre vide (le bug d\'origine a disparu)', nestAfter.emptySlots === 0, JSON.stringify(nestAfter));
    check('UN nœud, UN endroit : aucune conversation rendue deux fois',
      nestAfter.convNodes === 6 && nestAfter.dupTitles.length === 0, JSON.stringify(nestAfter));

    // (c) « Tête alignée » : la ligne de tête reste un membre du parent, sur le
    // rail du parent, au MÊME axe que ses sœurs. C'est le cœur de la décision
    // A du plan — si cet axe bouge, la ligne a cessé d'appartenir à A.
    const axes = await cdp.evaluate(`(() => {
      const cx = (n) => { const r = n.getBoundingClientRect(); return r.left + r.width / 2; };
      const railAxis = (n) => n.getBoundingClientRect().left + parseFloat(getComputedStyle(n).borderLeftWidth) / 2;
      const parent = document.querySelector('#flow > .grp');
      const subBody = document.querySelector('.grp-body.nest-body');
      const subGrip = document.querySelector('.grp-head.nest-grip');
      const memberIco = (root, title) => Array.from(root.querySelectorAll('.member'))
        .find(m => (m.querySelector('.title') || {}).textContent === title).querySelector('.ico');
      const flat = document.querySelector('#flow > .conv');
      return {
        flatIco: cx(flat.querySelector('.ico')),
        sisterIco: cx(memberIco(parent, 'A task one')),
        headIco: cx(memberIco(parent, 'A task two — opens B')),
        headLeft: memberIco(parent, 'A task two — opens B').closest('.conv').getBoundingClientRect().left,
        sisterLeft: memberIco(parent, 'A task one').closest('.conv').getBoundingClientRect().left,
        childIco: cx(memberIco(subBody, 'B task one')),
        // Axe d'un rail = celui de son TRAIT vertical : depuis le crochet de
        // fin de lot (2026-08-17) la boîte s'étend jusqu'à la colonne de
        // contenu, son centre géométrique ne dit plus rien de l'axe.
        parentRail: railAxis(parent.querySelector(':scope > .grp-body > .grp-rail')),
        subRail: railAxis(subBody.querySelector(':scope > .grp-rail')),
        parentBodyLeft: parent.querySelector(':scope > .grp-body').getBoundingClientRect().left,
        subBodyLeft: subBody.getBoundingClientRect().left,
        subGripLeft: subGrip.getBoundingClientRect().left,
      };
    })()`);
    check('la ligne de TÊTE garde l\'axe de ses sœurs membres (elle est restée dans le parent)',
      Math.abs(axes.headIco - axes.sisterIco) < 0.5 && Math.abs(axes.headIco - axes.flatIco) < 0.5, JSON.stringify(axes));
    check('… et leur bord gauche, au pixel', Math.abs(axes.headLeft - axes.sisterLeft) < 0.5, JSON.stringify(axes));
    check('décalage du CORPS du sous-lot = 28px exactement (minimum prouvé : à 14 son cadre traverse le rail du parent)',
      Math.abs((axes.subBodyLeft - axes.parentBodyLeft) - 28) < 0.5, JSON.stringify(axes));
    check('… et sa GRIP au même décalage (bleed annulé côté gauche)',
      Math.abs((axes.subGripLeft - axes.parentBodyLeft) - 28) < 0.5, JSON.stringify(axes));
    check('deux rails, deux axes : celui de l\'enfant est 28px à droite de celui du parent',
      Math.abs((axes.subRail - axes.parentRail) - 28) < 0.5, JSON.stringify(axes));
    check('les anneaux de l\'enfant tombent sur le rail de l\'enfant, pas sur celui du parent',
      Math.abs(axes.childIco - axes.subRail) < 0.5, JSON.stringify(axes));

    // (d) Les DEUX rails couvrent leurs propres anneaux, du premier au dernier.
    // Le bloc imbriqué s'intercale entre deux membres du parent : il ne doit pas
    // interrompre le trait — c'est LE piège trouvé à la maquette (rail tronqué,
    // parce que la hauteur est calculée en JS après placement).
    const rails = await cdp.evaluate(`(() => {
      // MEMBRES directs seulement : l'anneau de la ligne maîtresse est
      // volontairement AU-DESSUS du rail (étape 19 — le trait ne se dessine
      // jamais à l'intérieur de la capsule, cf. §13bis qui mesure ce départ).
      const span = (bodyEl) => {
        const rail = bodyEl.querySelector(':scope > .grp-rail').getBoundingClientRect();
        const icos = Array.from(bodyEl.querySelectorAll(':scope > .member .ico, :scope > .member .ico-pending'))
          .map(i => i.getBoundingClientRect());
        return {
          railTop: rail.top, railBottom: rail.bottom, height: rail.height,
          firstIco: Math.min.apply(null, icos.map(r => r.top + r.height / 2)),
          lastIco: Math.max.apply(null, icos.map(r => r.top + r.height / 2)),
          count: icos.length,
        };
      };
      return { parent: span(document.querySelector('#flow > .grp > .grp-body')), sub: span(document.querySelector('.grp-body.nest-body')) };
    })()`);
    check('rail du PARENT : couvre du premier au dernier de SES anneaux directs (le bloc imbriqué ne le coupe pas)',
      rails.parent.height > 0 && rails.parent.railTop <= rails.parent.firstIco + 0.5
      && rails.parent.railBottom >= rails.parent.lastIco - 0.5, JSON.stringify(rails.parent));
    check('rail de l\'ENFANT : couvre les siens de la même façon',
      rails.sub.height > 0 && rails.sub.railTop <= rails.sub.firstIco + 0.5
      && rails.sub.railBottom >= rails.sub.lastIco - 0.5, JSON.stringify(rails.sub));

    // (e) RÉVISÉ 2026-08-17 — la ligne de TÊTE d'un sous-lot n'a plus de
    // capsule du tout : elle suit la ligne maîtresse, dont elle reprend le
    // canon (les deux cadres sont partis ensemble, sinon le panneau dirait la
    // même chose de deux façons). Ce qui se mesure désormais : aucun trait sur
    // la ligne, une bulle au canon de tête, RESTÉE À LA COULEUR DU PARENT
    // (elle est un membre du parent : c'est la structure, pas un détail), et
    // son fond opaque — le rail du parent, lui, la traverse toujours.
    const caps = await cdp.evaluate(`(() => {
      const probe = document.createElement('span');
      probe.style.color = 'hsl(30, 45%, 55%)';
      document.body.appendChild(probe);
      const hueB = getComputedStyle(probe).color;
      probe.remove();
      const host = Array.from(document.querySelectorAll('#flow .member'))
        .find(m => (m.querySelector('.title') || {}).textContent === 'A task two — opens B');
      const head = host.querySelector('.m-head');
      const cs = getComputedStyle(head, '::after');
      const headRect = head.getBoundingClientRect();
      // Bulle de la ligne de tête vs bulle d'un membre ordinaire du PARENT :
      // taille (canon de tête) et teinte (celle du parent, jamais celle de
      // l'enfant) se prouvent l'une par l'autre, sans valeur écrite ici.
      const headIco = getComputedStyle(head.querySelector('.conv .ico'), '::after');
      const plainMember = Array.from(document.querySelectorAll('#flow .grp-body > .member'))
        .find((m) => m !== host && m.querySelector('.conv .ico'));
      const plainIco = plainMember ? getComputedStyle(plainMember.querySelector('.conv .ico'), '::after') : null;
      // Un CADRE (border réelle) qui contiendrait une ligne de conversation est
      // interdit dans tout le panneau : une capsule n'encadre qu'un EN-TÊTE.
      const framedConvs = Array.from(document.querySelectorAll('#flow .conv')).filter((c) => {
        for (let a = c.parentElement; a && a.id !== 'flow'; a = a.parentElement) {
          if (parseFloat(getComputedStyle(a).borderTopWidth) > 0) return true;
        }
        return false;
      }).length;
      return {
        hueB,
        shadow: cs.boxShadow, bg: cs.backgroundColor,
        radiusTL: cs.borderTopLeftRadius, radiusTR: cs.borderTopRightRadius,
        radiusBL: cs.borderBottomLeftRadius, radiusBR: cs.borderBottomRightRadius,
        left: parseFloat(cs.left), zIndex: cs.zIndex, pointer: cs.pointerEvents,
        // 3 bords désormais (gauche/droite/bas), une couche box-shadow par
        // bord — jamais l'ancien inset unique « 0 0 0 1.5px » qui peignait
        // les 4 à la fois. Compter les « inset », pas les virgules : chaque
        // rgb(r, g, b) en contient déjà deux.
        threeSided: (cs.boxShadow.match(/inset/g) || []).length === 3 && cs.boxShadow.indexOf('1.5px') !== -1,
        hostHasBorder: getComputedStyle(host).borderTopWidth,
        headWidth: headRect.width,
        framedConvs,
        headRing: { d: parseFloat(headIco.width), w: parseFloat(headIco.borderTopWidth),
                    color: headIco.borderTopColor, bg: headIco.backgroundColor },
        plainRing: plainIco ? { d: parseFloat(plainIco.width), w: parseFloat(plainIco.borderTopWidth),
                    color: plainIco.borderTopColor } : null,
        headWeight: getComputedStyle(head.querySelector('.conv .title')).fontWeight,
      };
    })()`);
    check('ligne de tête : AUCUN cadre (ni pseudo, ni bordure sur la ligne)',
      caps.shadow === 'none' && caps.hostHasBorder === '0px', JSON.stringify(caps));
    check('… bulle au canon de tête : plus grosse et plus épaisse que celle d\'un membre ordinaire',
      caps.plainRing !== null && caps.headRing.d > caps.plainRing.d + 2
      && caps.headRing.w > caps.plainRing.w + 1, JSON.stringify(caps));
    check('… mais RESTÉE à la couleur du parent (jamais celle de l\'enfant : la ligne appartient au parent)',
      caps.headRing.color === caps.plainRing.color && caps.headRing.color !== caps.hueB, JSON.stringify(caps));
    check('… titre en gras, comme une maîtresse', Number(caps.headWeight) >= 700, String(caps.headWeight));
    check('AUCUN élément à bordure ne contient une ligne de conversation (une capsule n\'encadre qu\'un en-tête)',
      caps.framedConvs === 0, JSON.stringify(caps));

    // (f) Cadre continu grip → tête : la grip perd sa bordure basse et son
    // coin bas-droit (règle .grp-head.nest-grip, même canon que
    // .grp.has-master > .grp-head) et s'aligne au pixel, bords gauche/droite,
    // sur la capsule de la ligne juste en dessous. Plus de chip : ⌂ masqué
    // (la maîtresse du sous-lot est déjà cette ligne), ✕ présent (dissolution
    // portée par l'objet qu'elle dissout, jamais par une ligne).
    const gripShape = await cdp.evaluate(`(() => {
      const grip = document.querySelector('.grp-head.nest-grip');
      const host = Array.from(document.querySelectorAll('#flow .member'))
        .find(m => (m.querySelector('.title') || {}).textContent === 'A task two — opens B');
      const mHead = host.querySelector('.m-head');
      const gripCs = getComputedStyle(grip);
      const gripRect = grip.getBoundingClientRect();
      const headRect = mHead.getBoundingClientRect();
      const mas = Array.from(grip.querySelectorAll('.gbtn')).find(b => b.textContent === '⌂');
      const kill = grip.querySelector('.g-kill');
      return {
        borderBottomWidth: gripCs.borderBottomWidth,
        borderBottomRightRadius: gripCs.borderBottomRightRadius,
        gripLeft: gripRect.left, gripRight: gripRect.right,
        headLeft: headRect.left, headRight: headRect.right,
        masHidden: !mas || getComputedStyle(mas).display === 'none',
        killPresent: !!kill,
      };
    })()`);
    check('grip du sous-lot : bas ouvert, coin bas-droit carré (même canon qu\'un lot racine avec master)',
      gripShape.borderBottomWidth === '0px' && gripShape.borderBottomRightRadius === '0px', JSON.stringify(gripShape));
    // La ligne de tête, elle, n'est PAS indentée (elle appartient au flux
    // normal du parent) — c'est sa CAPSULE (pseudo, décalée à --nest-indent
    // DEPUIS le bord de m-head) qui tombe au même endroit que la grip.
    check('bords gauche/droite de la grip et de la capsule de la ligne de tête alignés au pixel (un seul cadre continu)',
      Math.abs(gripShape.gripLeft - (gripShape.headLeft + 28)) < 0.5 && Math.abs(gripShape.gripRight - gripShape.headRight) < 0.5, JSON.stringify(gripShape));
    check('⌂ masqué sur la grip d\'un sous-lot (sa maîtresse est déjà la ligne du dessous)', gripShape.masHidden === true, JSON.stringify(gripShape));
    check('✕ (dissolution) présent sur la grip du sous-lot', gripShape.killPresent === true, JSON.stringify(gripShape));

    // (g) Le clic sur la grip agit sur le SOUS-LOT (jamais son parent) : repli
    // par le chevron, dissolution par le ✕ — même vocabulaire que la grip
    // d'un lot racine, aucune portée nouvelle inventée pour ce cas.
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`document.querySelector('.grp-head.nest-grip').click()`);
    const chevClick = await cdp.evaluate(`window.__sent`);
    check('clic sur la grip → toggleGroupCollapse du SOUS-LOT (jamais du parent)',
      Array.isArray(chevClick) && chevClick.length === 1
      && chevClick[0].type === 'toggleGroupCollapse' && chevClick[0].id === 'B', JSON.stringify(chevClick));
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`document.querySelector('.grp-head.nest-grip .g-kill').click()`);
    const killClick = await cdp.evaluate(`window.__sent`);
    check('✕ de la grip du sous-lot → dissolveGroup(B), jamais A',
      Array.isArray(killClick) && killClick.length === 1
      && killClick[0].type === 'dissolveGroup' && killClick[0].id === 'B', JSON.stringify(killClick));

    // (h) Le repli laisse la ligne de tête STRICTEMENT identique (bords,
    // hauteur, capsule) — même leçon que le repli de la ligne maîtresse d'un
    // lot racine : replier ne doit RIEN changer à ce qui n'est pas à lui.
    const headShape = `(() => {
      const host = Array.from(document.querySelectorAll('#flow .member'))
        .find(m => (m.querySelector('.title') || {}).textContent === 'A task two — opens B');
      const r = host.querySelector('.conv').getBoundingClientRect();
      const cs = getComputedStyle(host.querySelector('.m-head'), '::after');
      return { left: r.left, right: r.right, height: r.height, shadow: cs.boxShadow, capLeft: cs.left };
    })()`;
    // Même précaution qu'au §13ter : replier raccourcit la page, et si elle
    // cesse de déborder Chromium retire la barre de défilement — toute la
    // colonne s'élargit de ~15px et une comparaison en pixels absolus tombe
    // sans que le CSS ait bougé. La gouttière est réservée dans les deux états.
    await cdp.evaluate(`document.documentElement.style.overflowY = 'scroll'`);
    const openShape = await cdp.evaluate(headShape);
    const collapsedB = [mkA(), Object.assign(mkB(true), { collapsed: true })];
    await pushNest(collapsedB);
    const folded = await cdp.evaluate(`(() => {
      const bodySub = document.querySelector('.grp-body.nest-body');
      const grip = document.querySelector('.grp-head.nest-grip');
      return {
        chev: grip.querySelector('.chevron').textContent,
        bodyCollapsed: bodySub.classList.contains('collapsed'),
        membersHidden: Array.from(bodySub.querySelectorAll('.member')).every(m => getComputedStyle(m).display === 'none'),
      };
    })()`);
    const foldedShape = await cdp.evaluate(headShape);
    check('replié : le chevron de la grip bascule', folded.chev === '▸', folded.chev);
    check('… le corps du sous-lot disparaît', folded.bodyCollapsed === true && folded.membersHidden === true, JSON.stringify(folded));
    await cdp.evaluate(`document.documentElement.style.overflowY = ''`);
    check('… et la ligne de tête est STRICTEMENT identique (bords, hauteur, capsule)',
      ['left', 'right', 'height'].every(k => Math.abs(openShape[k] - foldedShape[k]) < 0.5)
      && openShape.shadow === foldedShape.shadow && openShape.capLeft === foldedShape.capLeft,
      JSON.stringify({ openShape, foldedShape }));
    await pushNest([mkA(), mkB(true)]);

    // (h) Idempotence : le vrai panneau re-place TOUT depuis l'état à chaque
    // push. Deux rendus du même état doivent donner le même DOM — la maquette,
    // qui opérait une chirurgie one-shot, fabriquait des chimères au second.
    const dom1 = await cdp.evaluate(`document.getElementById('flow').innerHTML`);
    await pushNest([mkA(), mkB(true)]);
    const dom2 = await cdp.evaluate(`document.getElementById('flow').innerHTML`);
    check('deux rendus successifs du même état → DOM identique (idempotence structurelle)',
      dom1 === dom2, `longueurs ${dom1.length} vs ${dom2.length}`);

    // (i) Retour au rendu classique : dès que la filiation tombe (maîtresse
    // délinquée, sortie de la fenêtre du panneau, cycle…), le sous-lot redevient
    // un bloc frère AVEC sa grip et sa ligne maîtresse. Rien n'est détruit,
    // c'est la même paire d'états qui s'inverse (appendChild réclame head/body
    // — dégradation silencieuse).
    await pushNest([mkA(), mkB(false)]);
    const nestBack = await cdp.evaluate(`(() => ({
      rootBlocks: document.querySelectorAll('#flow > .grp').length,
      nestGrips: document.querySelectorAll('.grp-head.nest-grip').length,
      nestBodies: document.querySelectorAll('.grp-body.nest-body').length,
      grips: Array.from(document.querySelectorAll('#flow .grp-head')).filter(h => getComputedStyle(h).display !== 'none').length,
      masterHeads: document.querySelectorAll('#flow .grp-master-head').length,
      hosts: document.querySelectorAll('#flow .member.nest-host').length,
    }))()`);
    check('filiation retirée : deux blocs frères, chacun avec sa grip et sa ligne maîtresse, plus aucune trace de nesting',
      nestBack.rootBlocks === 2 && nestBack.nestGrips === 0 && nestBack.nestBodies === 0
      && nestBack.grips === 2 && nestBack.masterHeads === 2 && nestBack.hosts === 0,
      JSON.stringify(nestBack));

    // (j) Chaîne à trois niveaux : C sous B sous A. Chaque cran ajoute 28px, et
    // il n'y a toujours qu'un seul bloc racine — deux grips et deux corps
    // imbriqués (B sous A, C sous B).
    const cConvs = nestConvs.concat([nconv('c1', 'C task one', { groupId: 'C', state: 'busy' })]);
    const groupC = {
      id: 'C', name: 'Grandchild batch', hue: 120, collapsed: false, stamp: '16:05',
      launchedWave: 1, nextWave: null, waveNotice: null, done: false,
      nestedUnder: { groupId: 'B', memberKey: 'n1' },
      master: { convId: 'b1', title: 'B task one', listed: true, tabTitle: null, hint: '', status: 'busy' },
      members: [nmember('o1', 'C task one', 'c1')],
    };
    await pushNest([mkA(), mkB(true), groupC], cConvs);
    const nestChain = await cdp.evaluate(`(() => {
      const parent = document.querySelector('#flow > .grp');
      const grips = Array.from(document.querySelectorAll('.grp-head.nest-grip'));
      const bodies = Array.from(document.querySelectorAll('.grp-body.nest-body'));
      const left = (n) => n.getBoundingClientRect().left;
      const base = left(parent.querySelector(':scope > .grp-body'));
      return {
        rootBlocks: document.querySelectorAll('#flow > .grp').length,
        grips: grips.length, bodies: bodies.length,
        depths: grips.map(g => Math.round(left(g) - base)),
      };
    })()`);
    check('chaîne à 3 niveaux : toujours UN seul bloc racine, deux grips et deux corps imbriqués',
      nestChain.rootBlocks === 1 && nestChain.grips === 2 && nestChain.bodies === 2, JSON.stringify(nestChain));
    check('… chaque cran décale de 28px de plus (28 puis 56)',
      nestChain.depths.sort((a, b) => a - b).join(',') === '28,56', JSON.stringify(nestChain));

    // (k) Rang dans le flux : le bloc parent parle pour TOUT ce qu'il affiche,
    // sous-lots compris. Ici l'onglet le plus à gauche du bloc appartient au
    // SOUS-lot — sans la fusion des rangs, le bloc entier tomberait derrière la
    // ligne plate qui le précède.
    const rankConvs = [
      nconv('b1', 'B task one', { groupId: 'B', state: 'busy' }),   // onglet 0
      nconv('z9', 'Flat conversation'),                              // onglet 1
      nconv('am', 'A master'),                                       // onglet 2
      nconv('a2', 'A task two — opens B', { groupId: 'A' }),         // onglet 3
    ];
    const rankA = mkA();
    rankA.members = [nmember('m2', 'A task two — opens B', 'a2')];
    const rankB = mkB(true);
    rankB.members = [nmember('n1', 'B task one', 'b1')];
    await pushNest([rankA, rankB], rankConvs);
    check('rang du bloc = son onglet le plus à gauche, SOUS-LOT COMPRIS (sinon il passerait derrière la ligne plate)',
      (await cdp.evaluate(FLOW_ORDER)).join(' | ') === 'GROUPE | Flat conversation',
      await cdp.evaluate(FLOW_ORDER + '.join(" | ")'));

    // (l) Thème sombre : la capsule et la grip doivent se voir. Une teinte
    // définie en hsl() ne dépend d'aucune variable de thème — ce qu'on vérifie
    // ici, c'est qu'aucune bande de fond ne se glisse ENTRE la grip et sa
    // ligne de tête, ni entre la capsule et le corps du sous-lot (visible en
    // sombre, invisible en clair : c'est exactement le défaut que le plan
    // interdit).
    await pushNest([mkA(), mkB(true)]);
    const darkVars = { '--vscode-sideBar-background': '#252526', '--vscode-editor-background': '#1e1e1e' };
    await cdp.evaluate(`(() => { ${Object.entries(darkVars).map(([k, v]) => `document.documentElement.style.setProperty('${k}','${v}')`).join(';')} })()`);
    await sleep(120);
    const nestDark = await cdp.evaluate(`(() => {
      const host = Array.from(document.querySelectorAll('#flow .member'))
        .find(m => (m.querySelector('.title') || {}).textContent === 'A task two — opens B');
      const bodySub = document.querySelector('.grp-body.nest-body');
      const gripSub = document.querySelector('.grp-head.nest-grip');
      const mHeadRect = host.querySelector('.m-head').getBoundingClientRect();
      const bodyTop = bodySub.getBoundingClientRect().top;
      const gripBottom = gripSub.getBoundingClientRect().bottom;
      return {
        gap: bodyTop - mHeadRect.bottom,
        gripToHostGap: mHeadRect.top - gripBottom,
        footVisible: getComputedStyle(host.querySelector('.m-foot')).display !== 'none',
        capShadow: getComputedStyle(host.querySelector('.m-head'), '::after').boxShadow,
        gripBg: getComputedStyle(gripSub).backgroundColor,
      };
    })()`);
    check('thème sombre : le corps du sous-lot est COLLÉ sous la capsule (aucune bande de fond entre les deux)',
      nestDark.footVisible === false && Math.abs(nestDark.gap) < 1, JSON.stringify(nestDark));
    check('… et la grip est COLLÉE au-dessus de la ligne de tête (cadre continu, aucune bande de fond)',
      Math.abs(nestDark.gripToHostGap) < 1, JSON.stringify(nestDark));
    // RÉVISÉ 2026-08-17 : ce qui doit rester peint n'est plus un cadre (il n'y
    // en a plus) mais le FOND teinté de la grip du sous-lot — une teinte hsl(),
    // donc indépendante des variables de thème. Et la ligne de tête, elle, ne
    // doit porter AUCUN trait, dans aucun thème.
    check('… la grip du sous-lot reste peinte (fond hsl, indépendant du thème) et la ligne de tête sans aucun cadre',
      nestDark.gripBg.indexOf('rgb') !== -1 && nestDark.gripBg !== 'rgba(0, 0, 0, 0)'
      && nestDark.capShadow === 'none', JSON.stringify(nestDark));
    for (const k of Object.keys(darkVars)) await cdp.evaluate(`document.documentElement.style.removeProperty('${k}')`);

    // ── 20. La maîtresse n'engage que son DERNIER lot ────────────────────
    // (plan PLAN_maitresse_dernier_lot_2026-08-15.md.) Deux lots revendiquent
    // la MÊME conversation maîtresse — une conv de cadrage qui enchaîne les
    // batchs, cas nominal. Il n'y a qu'UN nœud de conversation : les deux
    // capsules le réclament et l'une reste VIDE.
    // AUCUN code de rendu n'a été écrit pour ce plan : extension.js envoie
    // `master: null` au lot qui a cédé, et le webview emprunte sa branche
    // sans-maîtresse, déjà là depuis le lot 11. Ce qu'on mesure ici, c'est
    // qu'elle SUFFIT — et que le témoin montre bien le défaut d'avant.
    console.log('\n20. Deux lots pour une seule maîtresse — le plus ancien cède sa tête');
    const mkClaimA = (master) => ({
      id: 'A', name: 'Batch of 03:01', hue: 210, collapsed: false, stamp: '03:01',
      launchedWave: 1, nextWave: null, waveNotice: null, done: false, nestedUnder: null,
      master,
      members: [nmember('m1', 'A task one', 'a1'), nmember('m2', 'A task two', 'a2')],
    });
    const claimHead = { convId: 'am', title: 'A master', listed: true, tabTitle: null, hint: '', status: 'idle' };
    const mkClaimB = () => ({
      id: 'B', name: 'Batch of 14:34', hue: 30, collapsed: false, stamp: '14:34',
      launchedWave: 1, nextWave: null, waveNotice: null, done: false, nestedUnder: null,
      master: claimHead,
      members: [nmember('n1', 'B task one', 'b1'), nmember('n2', 'B task two', 'b2', { status: 'done', waveStatus: 'done' })],
    });
    const CLAIM_PROBE = `(() => {
      const slots = Array.from(document.querySelectorAll('#flow .grp-master-slot'));
      const seen = {};
      Array.from(document.querySelectorAll('.conv .title')).forEach(t => { seen[t.textContent] = (seen[t.textContent] || 0) + 1; });
      return {
        masterSlots: slots.length,
        emptyMasterSlots: slots.filter(s => !s.children.length).length,
        rootBlocks: document.querySelectorAll('#flow > .grp').length,
        convNodes: document.querySelectorAll('.conv').length,
        dupTitles: Object.keys(seen).filter(k => seen[k] > 1),
      };
    })()`;

    // (a) Témoin — les deux lots gardent leur maîtresse : le nœud part au
    // dernier rendu, l'autre capsule reste vide. C'est le bug, mesuré.
    await pushNest([mkClaimA(claimHead), mkClaimB()]);
    const claimBefore = await cdp.evaluate(CLAIM_PROBE);
    check('(témoin) deux capsules pour une seule conversation → une reste VIDE',
      claimBefore.masterSlots === 2 && claimBefore.emptyMasterSlots === 1, JSON.stringify(claimBefore));

    // (b) Corrigé — le lot le plus ancien reçoit `master: null`.
    await pushNest([mkClaimA(null), mkClaimB()]);
    const claimAfter = await cdp.evaluate(CLAIM_PROBE);
    check('une seule ligne maîtresse rendue, et plus aucune capsule vide',
      claimAfter.masterSlots === 1 && claimAfter.emptyMasterSlots === 0, JSON.stringify(claimAfter));
    check('les deux blocs sont toujours là (céder une tête ne dissout rien)',
      claimAfter.rootBlocks === 2, JSON.stringify(claimAfter));
    check('la conversation de cadrage est rendue UNE fois, sans doublon de titre',
      claimAfter.convNodes === claimBefore.convNodes && claimAfter.dupTitles.length === 0, JSON.stringify(claimAfter));
    const cededShape = await cdp.evaluate(`(() => {
      const blocks = Array.from(document.querySelectorAll('#flow > .grp'));
      const ceded = blocks.find(b => ((b.querySelector('.grp-label') || {}).textContent || '').indexOf('03:01') !== -1);
      return ceded ? {
        hasMasterHead: !!ceded.querySelector('.grp-master-head'),
        hasMasterClass: ceded.classList.contains('has-master'),
        members: ceded.querySelectorAll('.member').length,
        homeVisible: getComputedStyle(ceded.querySelector('.grp-head .gbtn:not(.g-kill)')).display !== 'none',
      } : null;
    })()`);
    check('le lot qui a cédé se rend comme un lot SANS maîtresse : grip seule, ses membres intacts',
      !!cededShape && cededShape.hasMasterHead === false && cededShape.hasMasterClass === false && cededShape.members === 2,
      JSON.stringify(cededShape));
    check('… et son ⌂ redevient proposable (re-lier fera rebasculer la tête vers lui)',
      !!cededShape && cededShape.homeVisible === true, JSON.stringify(cededShape));

    console.log('\n21. Bandeau de gel des onglets (plan gel-tabs 2026-08-17) — état d\'erreur, jamais dans les captures de fiche');
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: STATE })}, '*')`);
    await sleep(120);
    check('état nominal (tabsFrozen absent) : bandeau masqué',
      await cdp.evaluate(`getComputedStyle(document.querySelector('#tabsFrozenNotice')).display`) === 'none');
    const frozenState = Object.assign({}, STATE, { tabsFrozen: true });
    for (const scheme of ['dark', 'light']) {
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await sleep(80);
      await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: frozenState })}, '*')`);
      await sleep(120);
      const shot = await cdp.evaluate(`(() => {
        const n = document.querySelector('#tabsFrozenNotice');
        const cs = getComputedStyle(n);
        return { display: cs.display, color: cs.color, text: n.textContent };
      })()`);
      check(`thème ${scheme} : tabsFrozen:true → bandeau visible avec son texte`,
        shot.display === 'block' && shot.text.length > 0, JSON.stringify(shot));
      check(`thème ${scheme} : couleur résolue non transparente (${shot.color})`,
        !!shot.color && shot.color !== 'rgba(0, 0, 0, 0)' && shot.color !== 'transparent');
    }
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: STATE })}, '*')`);
    await sleep(120);
    check('retour à tabsFrozen:false → bandeau remasqué (pas de rémanence)',
      await cdp.evaluate(`getComputedStyle(document.querySelector('#tabsFrozenNotice')).display`) === 'none');

    console.log('\n22. Coût estimé ($) sur la ligne — cumul affiché, couleur au DERNIER TOUR (plan coût-conv 2026-08-17 + plan coût-fenêtre 2026-08-18 lot 2, B3)');
    // Ce que cette section garde : le montant s'affiche à droite du TITRE, il
    // ne coûte pas un pixel à la barre de contexte — l'invariant du §16, qui a
    // déjà été cassé deux fois par un enfant ajouté « juste à côté » d'une
    // ligne. Depuis B3 (2026-08-18), la couleur ne suit plus le CUMUL affiché
    // mais le coût du dernier tour COMPLET (`cost.lastTurn`) : le cumul et la
    // couleur peuvent donc légitimement diverger — c'est tout le sens du lot.
    const COST_PROBE = `(() => {
      const rows = Array.from(document.querySelectorAll('#flow > .conv'));
      const at = (i) => {
        const r = rows[i]; if (!r) return null;
        const c = r.querySelector('.cost');
        const t = r.querySelector('.title');
        const bar = r.querySelector('.bar-ctx');
        const bb = bar ? bar.getBoundingClientRect() : null;
        return {
          text: c ? c.textContent : null,
          shown: c ? getComputedStyle(c).display !== 'none' : false,
          cls: c ? c.className : null,
          tip: c ? c.title : null,
          color: c ? getComputedStyle(c).color : null,
          tabular: c ? getComputedStyle(c).fontVariantNumeric : null,
          titleClipped: t ? t.scrollWidth > t.clientWidth : false,
          rowH: +r.getBoundingClientRect().height.toFixed(2),
          bar: bb ? { l: +bb.left.toFixed(2), r: +bb.right.toFixed(2), w: +bb.width.toFixed(2) } : null,
          costInTitleRow: !!(c && c.parentElement && c.parentElement.classList.contains('title-row')),
        };
      };
      return { n: rows.length, r0: at(0), r1: at(1), r2: at(2), r3: at(3) };
    })()`;

    // Référence : le MÊME état, sans le moindre coût — c'est lui qui fixe la
    // géométrie à ne pas bouger.
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: STATE })}, '*')`);
    await sleep(150);
    const noCost = await cdp.evaluate(COST_PROBE);

    const withCost = JSON.parse(JSON.stringify(STATE));
    const mkCost = (total, lastTurn, turns) => ({
      total, input: total * 0.06, cacheRead: total * 0.4, cacheWrite: total * 0.15,
      output: total * 0.39, tools: 0, messages: 12,
      lastTurn: typeof lastTurn === 'number' ? lastTurn : 0,
      turns: typeof turns === 'number' ? turns : 0,
    });
    // Le CUMUL (`total`) n'a plus aucun rôle dans la couleur — seul le DERNIER
    // TOUR (`lastTurn`) en a un, exprès aligné sur des seuils différents pour
    // prouver la divergence : r0 gros cumul mais dernier tour minuscule, r1
    // petit cumul mais dernier tour cher.
    withCost.conversations[0].cost = mkCost(0.42, 0.1, 3);    // dernier tour < 0,5 $ → gris
    withCost.conversations[1].cost = mkCost(1.10, 0.6, 5);    // dernier tour ≥ 0,5 $ → jaune
    withCost.conversations[2].cost = mkCost(7.31, 3.0, 23);   // dernier tour ≥ 2 $ → rouge
    withCost.conversations[3].cost = null;           // aucune donnée d'usage
    // Titre volontairement long : l'ellipse doit rester au titre, jamais au
    // montant (un montant tronqué serait un mensonge, pas une abréviation).
    withCost.conversations[0].title = 'Conv au travail avec un titre vraiment très long qui ne tient pas dans la largeur du panneau';
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: withCost })}, '*')`);
    await sleep(150);
    const cost = await cdp.evaluate(COST_PROBE);

    check('le montant est rendu sur la ligne du TITRE (variante B), pas dans la méta',
      cost.r0.costInTitleRow === true && cost.r0.shown === true, JSON.stringify(cost.r0));
    check('format : symbole $ et DEUX décimales, en chiffres tabulaires',
      cost.r0.text === '$0.42' && cost.r2.text === '$7.31'
      && /tabular-nums/.test(cost.r0.tabular || ''),
      `${cost.r0.text} / ${cost.r2.text} / ${cost.r0.tabular}`);
    check('couleur au DERNIER TOUR (costTurnYellowDollars/costTurnRedDollars), pas au cumul : < 0,5 $ gris, ≥ 0,5 $ jaune, ≥ 2 $ rouge',
      !/pace-/.test(cost.r0.cls) && /pace-yellow/.test(cost.r1.cls) && /pace-red/.test(cost.r2.cls),
      `${cost.r0.cls} | ${cost.r1.cls} | ${cost.r2.cls}`);
    check('les trois couleurs sont RÉSOLUES et distinctes (jetons pace-* du thème)',
      cost.r0.color !== cost.r1.color && cost.r1.color !== cost.r2.color
      && [cost.r0, cost.r1, cost.r2].every((r) => r.color && r.color !== 'rgba(0, 0, 0, 0)'),
      `${cost.r0.color} | ${cost.r1.color} | ${cost.r2.color}`);
    check('tooltip : cumul, nombre de réponses, dernier tour, puis le détail — obligatoire dès qu\'un tour est clos (B3)',
      /^≈ \$7\.31 in 23 replies — last turn \$3\.00 — input /.test(cost.r2.tip || '')
      && /cache /.test(cost.r2.tip || '') && /output /.test(cost.r2.tip || ''),
      cost.r2.tip);
    check('conversation sans donnée d\'usage → RIEN (nœud masqué, pas un « $0.00 »)',
      cost.r3.shown === false && noCost.r3.shown === false, JSON.stringify(cost.r3));

    // L'invariant du lot : le montant n'a aucune emprise sur la barre de
    // contexte, ni sur la hauteur de ligne — il ne rogne que le titre, qui est
    // fait pour ça (ellipse).
    check('barre de contexte inchangée par l\'arrivée du montant (bord gauche, largeur, bord droit)',
      Math.abs(cost.r0.bar.l - noCost.r0.bar.l) < 0.5 && Math.abs(cost.r0.bar.w - noCost.r0.bar.w) < 0.5
      && Math.abs(cost.r0.bar.r - noCost.r0.bar.r) < 0.5,
      JSON.stringify({ avec: cost.r0.bar, sans: noCost.r0.bar }));
    check('hauteur de ligne inchangée (le montant est sur la ligne du titre, pas au-dessous)',
      Math.abs(cost.r0.rowH - noCost.r0.rowH) < 0.5, `${noCost.r0.rowH} → ${cost.r0.rowH}`);
    check('c\'est le TITRE qui s\'ellipse, jamais le montant',
      cost.r0.titleClipped === true && cost.r0.text === '$0.42', JSON.stringify(cost.r0));

    // Les seuils viennent des settings, pas du code : les déplacer repeint.
    // costThresholds (cumul) n'a plus AUCUN effet sur la couleur : le relever
    // à un niveau qui « éteindrait » r1/r2 s'il comptait encore ne doit rien
    // changer — c'est costTurnThresholds qui gouverne.
    const reThreshold = JSON.parse(JSON.stringify(withCost));
    reThreshold.ui = Object.assign({}, reThreshold.ui, { costThresholds: { redMin: 10, yellowMin: 8 } });
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: reThreshold })}, '*')`);
    await sleep(150);
    const untouched = await cdp.evaluate(COST_PROBE);
    check('costThresholds (cumul, obsolète) relevé → AUCUN effet, r1/r2 restent colorés',
      /pace-yellow/.test(untouched.r1.cls) && /pace-red/.test(untouched.r2.cls),
      `${untouched.r1.cls} | ${untouched.r2.cls}`);

    const reTurnThreshold = JSON.parse(JSON.stringify(withCost));
    reTurnThreshold.ui = Object.assign({}, reTurnThreshold.ui, { costTurnThresholds: { redMin: 10, yellowMin: 8 } });
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: reTurnThreshold })}, '*')`);
    await sleep(150);
    const moved = await cdp.evaluate(COST_PROBE);
    check('costTurnThresholds relevé (settings) → les mêmes derniers tours redeviennent gris',
      !/pace-/.test(moved.r1.cls) && !/pace-/.test(moved.r2.cls), `${moved.r1.cls} | ${moved.r2.cls}`);

    console.log('\n23. Coût mesuré par FENÊTRE DE QUOTA (plan coût-fenêtre 2026-08-18, A1/D1 + C1)');
    // Ce que cette section garde : le montant vit sur la ligne du HAUT, entre le
    // libellé et le pourcentage ; il n'ajoute pas un pixel de hauteur, ne
    // déplace pas le % ni la barre, ne touche pas au rail de la flèche ; et une
    // fenêtre sans montant calculable garde exactement sa tête d'avant.
    const QUOTA_PROBE = `(() => {
      const rows = Array.from(document.querySelectorAll('#quota .q'));
      const at = (i) => {
        const q = rows[i]; if (!q) return null;
        const head = q.querySelector('.q-head');
        const c = q.querySelector('.q-cost');
        const pct = q.querySelector('.q-pct');
        const bar = q.querySelector('.bar-q');
        const arrow = q.querySelector('.arrow');
        const rb = bar ? bar.getBoundingClientRect() : null;
        const rp = pct ? pct.getBoundingClientRect() : null;
        const rh = head ? head.getBoundingClientRect() : null;
        const rc = c ? c.getBoundingClientRect() : null;
        return {
          text: c ? c.textContent : null,
          tip: c ? c.title : null,
          tabular: c ? getComputedStyle(c).fontVariantNumeric : null,
          inHead: !!(c && c.parentElement && c.parentElement.classList.contains('q-head')),
          beforePct: !!(c && pct && (c.compareDocumentPosition(pct) & Node.DOCUMENT_POSITION_FOLLOWING)),
          qH: +q.getBoundingClientRect().height.toFixed(2),
          headH: rh ? +rh.height.toFixed(2) : null,
          bar: rb ? { l: +rb.left.toFixed(2), r: +rb.right.toFixed(2), w: +rb.width.toFixed(2) } : null,
          pctR: rp ? +rp.right.toFixed(2) : null,
          headR: rh ? +rh.right.toFixed(2) : null,
          arrowLeft: arrow ? arrow.style.left : null,
          costR: rc ? +rc.right.toFixed(2) : null,
          pctL: rp ? +rp.left.toFixed(2) : null,
        };
      };
      return { n: rows.length, r0: at(0), r1: at(1), r2: at(2), r3: at(3) };
    })()`;

    // Référence : le MÊME état, sans le moindre montant — c'est lui qui fixe la
    // géométrie à ne pas bouger.
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: STATE })}, '*')`);
    await sleep(150);
    const noQCost = await cdp.evaluate(QUOTA_PROBE);

    const withQCost = JSON.parse(JSON.stringify(STATE));
    withQCost.quota.windows[0].cost = 108.89;   // > 100 $ → arrondi à l'unité
    withQCost.quota.windows[1].cost = 1390.91;  // quatre chiffres, sidebar 300 px
    withQCost.quota.windows[2].cost = 41.30;    // < 100 $ → deux décimales
    withQCost.quota.windows[3].cost = null;     // rien de mesurable → aucun ajout
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: withQCost })}, '*')`);
    await sleep(150);
    const q = await cdp.evaluate(QUOTA_PROBE);

    check('le montant est sur la ligne du HAUT, entre le libellé et le %',
      q.r0.inHead === true && q.r0.beforePct === true, JSON.stringify(q.r0));
    check('au-dessus de 100 $ : arrondi à l\'unité, en chiffres tabulaires',
      q.r0.text === '≈ $109' && q.r1.text === '≈ $1,391' && /tabular-nums/.test(q.r0.tabular || ''),
      `${q.r0.text} | ${q.r1.text} | ${q.r0.tabular}`);
    check('en dessous de 100 $ : deux décimales, comme sur une ligne de conversation',
      q.r2.text === '≈ $41.30', q.r2.text);
    check('fenêtre sans montant calculable → RIEN d\'ajouté, la ligne garde sa tête',
      q.r3.text === null && noQCost.r3.text === null, JSON.stringify(q.r3));
    check('l\'infobulle porte les DEUX réserves (mesure partielle, tarif de liste)',
      /measured on this PC/.test(q.r0.tip || '') && /claude\.ai/.test(q.r0.tip || '')
      && /list prices/.test(q.r0.tip || '') && /not a spend/.test(q.r0.tip || ''),
      q.r0.tip);

    // L'invariant du lot : le gabarit de la ligne de quota ne bouge pas d'un
    // pixel — ni sa hauteur, ni la barre, ni la position de la flèche, ni le %.
    check('hauteur du bloc de fenêtre inchangée (aucune ligne ajoutée)',
      Math.abs(q.r0.qH - noQCost.r0.qH) < 0.5 && Math.abs(q.r1.qH - noQCost.r1.qH) < 0.5,
      `${noQCost.r0.qH} → ${q.r0.qH} | ${noQCost.r1.qH} → ${q.r1.qH}`);
    check('hauteur de la ligne du haut inchangée',
      Math.abs(q.r0.headH - noQCost.r0.headH) < 0.5, `${noQCost.r0.headH} → ${q.r0.headH}`);
    check('barre de quota inchangée (bord gauche, largeur, bord droit)',
      Math.abs(q.r0.bar.l - noQCost.r0.bar.l) < 0.5 && Math.abs(q.r0.bar.w - noQCost.r0.bar.w) < 0.5
      && Math.abs(q.r0.bar.r - noQCost.r0.bar.r) < 0.5,
      JSON.stringify({ avec: q.r0.bar, sans: noQCost.r0.bar }));
    check('la flèche de burn-rate ne bouge pas (le montant ne partage pas son rail)',
      q.r0.arrowLeft === noQCost.r0.arrowLeft && q.r1.arrowLeft === noQCost.r1.arrowLeft,
      `${noQCost.r0.arrowLeft} → ${q.r0.arrowLeft}`);
    check('le % reste collé au bord droit, jamais poussé hors de la ligne',
      Math.abs(q.r1.pctR - noQCost.r1.pctR) < 0.5 && q.r1.pctR <= q.r1.headR + 0.5,
      JSON.stringify({ pctR: q.r1.pctR, headR: q.r1.headR, sans: noQCost.r1.pctR }));
    check('montant et % ne se chevauchent jamais, même sur quatre chiffres',
      q.r1.costR < q.r1.pctL, JSON.stringify({ costR: q.r1.costR, pctL: q.r1.pctL }));

    // Le montant vit sur la ligne du haut : le tick local de 30 s recompose les
    // fenêtres (retick) et ne doit pas le perdre en route.
    const qShots = [];
    for (const scheme of ['dark', 'light']) {
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      await sleep(120);
      const col = await cdp.evaluate(`getComputedStyle(document.querySelector('.q-cost')).color`);
      check(`thème ${scheme} : le montant a une couleur résolue non transparente (${col})`,
        !!col && col !== 'rgba(0, 0, 0, 0)' && col !== 'transparent');
      qShots.push(Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'));
    }
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    const qDir = path.join(os.tmpdir(), 'qb-quota-cost-shots');
    fs.mkdirSync(qDir, { recursive: true });
    qShots.forEach((b, i) => fs.writeFileSync(path.join(qDir, `quota-${['dark', 'light'][i]}.png`), b));
    console.log(`       captures : ${qDir}`);

    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: STATE })}, '*')`);
    await sleep(120);
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
