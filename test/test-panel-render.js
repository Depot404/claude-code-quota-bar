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
    const intIco = await cdp.evaluate(`(() => {
      const i = document.querySelectorAll('.conv')[5].querySelector('.ico');
      const cs = getComputedStyle(i);
      return { text: i.textContent, cls: i.className, radius: cs.borderTopLeftRadius,
               style: cs.borderTopStyle, tip: document.querySelectorAll('.conv')[5].title };
    })()`);
    check('interrupted rendu en carré (classe dédiée, aucun ✓ dans la pastille)',
      intIco.cls.includes('ico-interrupted') && intIco.text === '', JSON.stringify(intIco));
    check('trait plein et angles droits — ni le ✓ done, ni le cercle pointillé stale',
      intIco.style === 'solid' && parseFloat(intIco.radius) <= 2, JSON.stringify(intIco));
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

    // waiting/interrupted/stale d'une conv LISTÉE (c1, réutilisée) : chacun un
    // glyphe visible dans l'anneau, en plus du ✓ done déjà couvert.
    for (const [state, expectGlyph] of [['waiting', '?'], ['interrupted', '⚠'], ['stale', '⚠']]) {
      const s = JSON.parse(JSON.stringify(grouped));
      s.conversations[0].state = state;
      await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: s })}, '*')`);
      await sleep(120);
      const g = await cdp.evaluate(`(() => {
        const ico = document.querySelector('#flow .grp-body .member .conv .ico');
        const before = getComputedStyle(ico, '::before');
        return { cls: ico.className, glyph: before.content.replace(/"/g, ''), anims: ico.getAnimations().length };
      })()`);
      check('groupe, état ' + state + ' : glyphe « ' + expectGlyph + ' » rendu dans l\'anneau',
        g.glyph === expectGlyph, JSON.stringify(g));
      check('… ' + state + ' : jamais de spinner (statique)', g.anims === 0, JSON.stringify(g));
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
      const rail = document.querySelector('#flow .grp-rail').getBoundingClientRect();
      const banner = document.querySelector('#flow .wave-ctrl .banner').getBoundingClientRect();
      return { railRight: rail.left + rail.width, bannerLeft: banner.left };
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
        notice: '2/3 conversation(s) opened — press Enter in each tab.',
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
      noticeShown.text === '2/3 conversation(s) opened — press Enter in each tab.', JSON.stringify(noticeShown));
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
        railCenter: railRect.left + railRect.width / 2,
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
    // jusqu'à la ligne fantôme finale (jamais la ligne d'ajout en file
    // « + add to this wave »), jamais plus bas.
    const railSpan = await cdp.evaluate(`(() => {
      const body = document.querySelector('#flow .grp-body').getBoundingClientRect();
      const head = document.querySelector('#flow .grp-master-head');
      const start = head && head.parentElement.classList.contains('grp-body')
        ? head.getBoundingClientRect().bottom : body.top;
      const railRect = document.querySelector('#flow .grp-rail').getBoundingClientRect();
      const ghostRect = document.querySelector('#flow .wave-ghost:not(.wave-add-row)').getBoundingClientRect();
      return { top: Math.abs(railRect.top - start) < 1, bottom: Math.abs(railRect.bottom - ghostRect.top) < 1 };
    })()`);
    check('rail : sommet au bas de la capsule (ou du corps, sans master)', railSpan.top === true, JSON.stringify(railSpan));
    check('rail : pied au sommet de la ligne fantôme finale (jamais plus bas)', railSpan.bottom === true, JSON.stringify(railSpan));

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

    // Séparateurs de vague et ligne d'ajout en file : commencent après l'axe
    // du rail, ne le croisent pas (décision 2, dernier paragraphe).
    const sepOffset = await cdp.evaluate(`(() => {
      const hdr = document.querySelector('#flow .grp-body .wave-hdr:not(.launch)');
      const addRow = document.querySelector('#flow .wave-ghost.wave-add-row');
      return {
        hdrPaddingLeft: hdr ? parseFloat(getComputedStyle(hdr).paddingLeft) : null,
        addRowMarginLeft: addRow ? parseFloat(getComputedStyle(addRow).marginLeft) : null,
      };
    })()`);
    check('séparateur de vague inerte : padding-left après l\'axe du rail (14px + marge)',
      sepOffset.hdrPaddingLeft !== null && sepOffset.hdrPaddingLeft >= 20, JSON.stringify(sepOffset));
    check('ligne d\'ajout en file : margin-left après l\'axe du rail (sa bordure pointillée ne le croise pas)',
      sepOffset.addRowMarginLeft !== null && sepOffset.addRowMarginLeft >= 20, JSON.stringify(sepOffset));

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
        left: r.left, right: r.right, width: r.width, height: r.height,
        ctxRight: ctxRect ? ctxRect.right : null, ctxWidth: ctxRect ? ctxRect.width : null,
        radius: cs.borderTopLeftRadius + '/' + cs.borderTopRightRadius + '/' + cs.borderBottomRightRadius + '/' + cs.borderBottomLeftRadius,
        shadow: after.boxShadow,
        children: Array.from(head.children).filter((c) => getComputedStyle(c).display !== 'none').map((c) => c.className).join(','),
      };
    })()`;
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

    console.log('\n13quater. Délier au survol — hover-only, zéro pixel permanent (plan repli-auto étape 9)');
    // Sans cette porte de sortie, un ⌂ posé par erreur serait irréversible —
    // même classe m-hover que les mouveurs ◂/▸ d'un membre (opacité 0 au
    // repos, révélée au survol de la ligne master).
    const unlinkBtn = await cdp.evaluate(`(() => {
      const b = document.querySelector('#flow .grp-master-head .m-hover');
      const cs = b ? getComputedStyle(b) : null;
      return { present: !!b, opacity: cs ? cs.opacity : null, hasClass: !!b && b.classList.contains('m-hover') };
    })()`);
    check('bouton « délier » présent sur la ligne master, hover-only (opacité 0 au repos)',
      unlinkBtn.present === true && unlinkBtn.opacity === '0' && unlinkBtn.hasClass === true, JSON.stringify(unlinkBtn));
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`document.querySelector('#flow .grp-master-head .m-hover').click()`);
    const sentUnlink = await cdp.evaluate(`window.__sent`);
    check('clic → unlinkGroupMaster (id du groupe, geste réversible sans confirmation)',
      Array.isArray(sentUnlink) && sentUnlink.some((m) => m.type === 'unlinkGroupMaster' && m.id === 'g1'), JSON.stringify(sentUnlink));

    console.log('\n13quinquies. ⨯ de la ligne master — DISSOLUTION seule (plan repli-auto étape 15 : jamais de fermeture d\'onglet ; confirmation existante côté extension, cf. test-group-master-focus.js)');
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`document.querySelector('#flow .grp-master-head .m-out').click()`);
    const sentClose = await cdp.evaluate(`window.__sent`);
    check('clic ⨯ → dissolveGroup avec id du groupe seul (aucun identifiant d\'onglet transporté)',
      Array.isArray(sentClose) && sentClose.some((m) => m.type === 'dissolveGroup' && m.id === 'g1' && m.convId === undefined),
      JSON.stringify(sentClose));

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
    check('(mise en place) hauteur du rail corrompue à 0, comme la panne reproduite',
      corrupted === 0, String(corrupted));
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
      return { railHeight: rail.getBoundingClientRect().height, ghostTop: ghost.offsetTop, railTop: rail.offsetTop };
    })()`);
    check('… le ResizeObserver corrige tout seul la hauteur corrompue, SANS nouveau postMessage',
      healed.railHeight > 0 && Math.abs(healed.railHeight - (healed.ghostTop - healed.railTop)) < 1, JSON.stringify(healed));

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
        // Étape 19 : le cadre est peint par le pseudo-élément (calque au-dessus
        // des fonds d'enfants), plus par le conteneur lui-même.
        headShadow: getComputedStyle(head, '::after').boxShadow,
        headShadowLayer: getComputedStyle(head, '::after').zIndex,
        headShadowPos: getComputedStyle(head, '::after').position,
        headBg: getComputedStyle(head).backgroundColor,
        gripBg: getComputedStyle(grip).backgroundColor,
        unlinkPos: getComputedStyle(q('#flow .grp-master-head .m-hover')).position,
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
      check(`${label} — la grip ne referme plus le cadre en bas (c'est la master qui le fait)`,
        g.gripBorderBottom === 0, String(g.gripBorderBottom));
      check(`${label} — le cadre de la ligne master est peint en box-shadow inset (jamais une bordure : elle décalerait le contenu)`,
        /inset/.test(g.headShadow) && g.headShadow !== 'none', g.headShadow);
      // Étape 19 — sur un CALQUE au-dessus des enfants : c'est ce qui rend un
      // recouvrement par le fond d'une ligne sélectionnée/survolée structurellement
      // impossible, au lieu de dépendre de la largeur de cette ligne.
      check(`${label} — … et ce cadre est un calque AU-DESSUS des fonds d'enfants (pseudo-élément positionné)`,
        g.headShadowPos === 'absolute' && Number(g.headShadowLayer) >= 1,
        `${g.headShadowPos} / ${g.headShadowLayer}`);
      check(`${label} — même fond teinté sur la grip et sur la ligne master (une seule variable)`,
        g.headBg === g.gripBg && g.headBg !== 'rgba(0, 0, 0, 0)', `${g.gripBg} / ${g.headBg}`);
      check(`${label} — « délier » hors du flux (position absolute) : zéro pixel de GABARIT, pas seulement d'encre`,
        g.unlinkPos === 'absolute', g.unlinkPos);
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

    // Groupe REPLIÉ avec master (révisé 2026-08-07) : la grip RESTE en place et
    // continue de fermer le cadre en haut — la capsule repliée est donc la même
    // qu'ouverte, en plus court. La ligne master garde ses trois bandes
    // (gauche/droite/bas) : elle n'a jamais à se déguiser en cadre complet.
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: collapsedWithMaster })}, '*')`);
    await sleep(200);
    const col = await cdp.evaluate(`(() => {
      const head = document.querySelector('#flow .grp-master-head');
      const grip = document.querySelector('#flow .grp-head');
      const gb = grip.getBoundingClientRect(); const hb = head.getBoundingClientRect();
      return { gripVisible: getComputedStyle(grip).display !== 'none',
               gripBorderTop: parseFloat(getComputedStyle(grip).borderTopWidth),
               joined: Math.abs(hb.top - gb.bottom) < 0.5,
               shadow: getComputedStyle(head, '::after').boxShadow, radiusTop: getComputedStyle(head).borderTopLeftRadius };
    })()`);
    check('replié + master : la grip reste visible et ferme le cadre en haut…',
      col.gripVisible === true && col.gripBorderTop > 1 && col.joined === true, JSON.stringify(col));
    check('… la ligne master garde ses TROIS bandes (gauche/droite/bas), coins hauts non arrondis',
      (col.shadow.match(/inset/g) || []).length === 3 && parseFloat(col.radiusTop) === 0, JSON.stringify(col));

    // Sans master : la grip EST le cadre entier, elle reprend sa bordure basse.
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: noMaster })}, '*')`);
    await sleep(200);
    const solo = await cdp.evaluate(`(() => {
      const grip = document.querySelector('#flow .grp-head');
      return { borderBottom: parseFloat(getComputedStyle(grip).borderBottomWidth),
               hasMasterClass: document.querySelector('#flow .grp').classList.contains('has-master'),
               masterRow: !!document.querySelector('#flow .grp-master-head') };
    })()`);
    check('sans master : la grip redevient un cadre complet (bordure basse rétablie)',
      solo.borderBottom > 1 && solo.hasMasterClass === false && solo.masterRow === false, JSON.stringify(solo));

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
        check(`thème ${name} — … et la bande ${side === 'left' ? 'gauche' : 'droite'} du cadre est INTACTE (pixels identiques au repos)`,
          await band(side) === ref[side]);
      // (b) Ligne master SURVOLÉE — même fond, autre variable de thème.
      await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: withMaster })}, '*')`);
      await sleep(180);
      await moveMouse(masterCenter[0], masterCenter[1]);
      await sleep(150);
      for (const side of ['left', 'right'])
        check(`thème ${name} — ligne master survolée : bande ${side === 'left' ? 'gauche' : 'droite'} intacte`,
          await band(side) === ref[side]);
      await moveMouse(2, 2);
      await sleep(120);
      // (c) La propriété STRUCTURELLE, pas seulement le cas du jour : même un
      // enfant qui déborderait de toute la capsule avec un fond opaque ne peut
      // plus effacer le cadre (il est peint sur un calque au-dessus).
      await cdp.evaluate(`(() => { const c = document.querySelector('#flow .grp-master-head .conv');
        c.style.background = '#ff00ff'; c.style.margin = '0 -40px'; })()`);
      await sleep(120);
      for (const side of ['left', 'right'])
        check(`thème ${name} — un fond d'enfant débordant NE PEUT PAS recouvrir le cadre (bande ${side === 'left' ? 'gauche' : 'droite'})`,
          await band(side) === ref[side]);
      await cdp.evaluate(`(() => { const c = document.querySelector('#flow .grp-master-head .conv');
        c.style.background = ''; c.style.margin = ''; })()`);
      await sleep(120);
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
    const railVsFrame = await cdp.evaluate(`(() => {
      const rail = document.querySelector('#flow .grp-rail').getBoundingClientRect();
      const grip = document.querySelector('#flow .grp-head').getBoundingClientRect();
      const head = document.querySelector('#flow .grp-master-head').getBoundingClientRect();
      const frame = { t: Math.min(grip.top, head.top), b: Math.max(grip.bottom, head.bottom) };
      return { overlap: +(Math.min(rail.bottom, frame.b) - Math.max(rail.top, frame.t)).toFixed(2),
               railTop: +rail.top.toFixed(2), frameBottom: +frame.b.toFixed(2) };
    })()`);
    check('rail P1 : aucune intersection avec l\'intérieur du cadre (il démarre au bord bas de la capsule)',
      railVsFrame.overlap <= 0.5, JSON.stringify(railVsFrame));

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
      const rail = document.querySelector('#flow .grp-rail').getBoundingClientRect();
      return { railRight: rail.left + rail.width, pillLeft: b.left,
               z: getComputedStyle(pill).zIndex, pos: getComputedStyle(pill).position };
    })()`);
    if (pillVsRail) {
      check('pill « ▶ vague » : sa boîte commence après l\'axe du rail (aucune morsure possible)',
        pillVsRail.pillLeft >= pillVsRail.railRight, JSON.stringify(pillVsRail));
      check('… et garde son z-index 1 de ceinture (recroisement futur → pill devant, jamais un trait au travers)',
        pillVsRail.pos === 'relative' && pillVsRail.z === '1', JSON.stringify(pillVsRail));
    }

    // (g) Glyphe ⚠ centré dans son anneau — mesuré sur les PIXELS (un ::before
    // n'a pas de rect, et l'encre d'un caractère ne remplit jamais sa boîte).
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
    // Groupe portant les deux glyphes ⚠ : interrupted (muted) et stale.
    const warnState = JSON.parse(JSON.stringify(withMaster));
    warnState.conversations[5].state = 'interrupted';
    warnState.conversations[5].groupId = 'g1';
    warnState.groups[0].members.push({ key: 'm4', prompt: 'Coupée au clavier', wave: 2, asked: { model: 'opus', effort: 'high' }, convId: 'c6', status: 'interrupted', waveStatus: 'launched', canLink: false, canClose: false, note: '', hint: '' });
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: warnState })}, '*')`);
    await sleep(250);
    const warnInk = await inkOffset('#flow .grp-body .conv .ico-interrupted');
    check('glyphe ⚠ : son ENCRE est centrée dans l\'anneau (≤ 0,75 px, le reste tient dans le tramage)',
      !!warnInk && !warnInk.empty && Math.abs(warnInk.dx) < 0.75 && Math.abs(warnInk.dy) < 0.75, JSON.stringify(warnInk));
    check('… et le centrage vient de la boîte (flex), pas d\'un décalage chiffré : aucune transform sur le glyphe',
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
