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
// Jetons de couleur des thèmes RÉELS de l'installation (theme-palette.js) : le
// host offscreen n'injecte aucun --vscode-*, or la ligne d'ajout « armée » se
// peint avec button.background. Le mesurer suppose donc de le poser d'abord,
// comme le ferait VS Code — et de le poser à sa VRAIE valeur.
const { palettes } = require(path.join(__dirname, 'theme-palette.js'));
const PALETTE = palettes(fs.readFileSync(path.join(__dirname, '..', 'panel.js'), 'utf8'));

const BRAVE_CANDIDATES = [
  process.env.BRAVE_EXE,
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
].filter(Boolean);
const USER_DATA_DIR = 'C:\\OctopusData\\BraveOctopus';
const PORT = 9223;

let pass = 0, fail = 0;
// ── Bancs LENTS, sautes par defaut (2026-08-28) ─────────────────────────────
// Mesure du jour : 88,5 s d'attente reelle sur 151 pauses, dont 65 s pour la
// SEULE section 8 (deux ticks de 30 s a attendre pour de vrai). Trois quarts du
// temps de ce banc pour une verification qui ne regarde aucun pixel — l'user a
// tranche : « seuls les bancs indispensables doivent tourner ». Ce qui est lent
// ET independant du rendu passe donc derriere `--slow`, que Publish.ps1 pose
// avant toute publication ; le reste du banc (507 verifications de geometrie et
// de comportement) tourne en ~25 s et reste le defaut.
const SLOW = process.argv.includes('--slow') || process.env.CLAUDE_QUOTA_SLOW === '1';

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
    // Heartbeat de fraîcheur NEUTRALISÉ pour les sections 1-24 (seuils
    // repoussés à l'infini) : ses `ready` spontanés tomberaient tôt ou tard
    // dans une des fenêtres « __sent doit contenir exactement X » et rendraient
    // le banc flaky. La mécanique réelle, elle, est testée en §25 sur une
    // page rechargée avec des délais compressés.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.acquireVsCodeApi = () => ({ postMessage: (m) => { (window.__sent = window.__sent || []).push(m); } });
window.QUOTABAR_STALE_TUNING = { pullAfterMs: 1e9, frozenAfterMs: 1e9 };`,
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

    if (!SLOW) {
      console.log('\n8. Auto-actualisation sans interaction — SAUTÉE (65 s d\'attente réelle ; --slow pour la jouer)');
    } else {
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
    }

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
    // échantillonne 24×24 autour de l'icône busy du groupe. Avant le fix
    // (2026-08-06) : 0 pixel distinct — l'arc était peint puis ENTIÈREMENT
    // recouvert par le disque opaque de l'anneau.
    // Amendé (chantier contraste, 2026-08-26) : cette conv (c1) est AUSSI la
    // ligne active du panneau (héritée de STATE), et .conv.active adoucit
    // désormais --busy en color-mix(--vscode-charts-blue 30%, --sel-fg) pour
    // rester lisible sur le fond de sélection saturé (mesuré : ratio 3.77,
    // cf. audit-contraste.js) — l'ancien seuil de bleu SATURÉ pur (R<50 &&
    // B>220) ne le détecte plus, et l'élargir confondrait l'encre de l'arc
    // avec celle du RAIL voisin (hsl(210,45%,55%) ≈ 89,140,192, visible dans
    // le même carré 24×24 au-dessus/en-dessous du disque de l'anneau, cf.
    // hueBorder en JS — LUI AUSSI bleuté). On mesure donc RELATIVEMENT : deux
    // couleurs de référence lues sur le rendu réel (le rail, la ligne active
    // elle-même) plutôt que des seuils RVB figés — un pixel ne compte comme
    // « encre de l'anneau » que s'il diffère nettement des DEUX. Et pour
    // prouver que ce n'est pas un simple disque uni (le bug exact de
    // 2026-08-06 : arc + piste fondus en une seule teinte), il faut au moins
    // DEUX teintes distinctes parmi cette encre — le serpentin et sa piste.
    const busyRefs = await cdp.evaluate(`(() => {
      const rail = document.querySelector('#flow .grp-rail');
      const rowEl = document.querySelector('#flow .ico-busy').closest('.conv');
      const parse = (s) => (s.match(/\\d+(\\.\\d+)?/g) || []).slice(0, 3).map(Number);
      return { rail: parse(getComputedStyle(rail).borderLeftColor), row: parse(getComputedStyle(rowEl).backgroundColor) };
    })()`);
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
      const rail = ${JSON.stringify(busyRefs.rail)}, row = ${JSON.stringify(busyRefs.row)};
      const dist = (r, g, b, ref) => Math.hypot(r - ref[0], g - ref[1], b - ref[2]);
      createImageBitmap(new Blob([bytes], { type: 'image/png' })).then(function (img) {
        const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
        const ctx2d = cv.getContext('2d'); ctx2d.drawImage(img, 0, 0);
        const d = ctx2d.getImageData(0, 0, cv.width, cv.height).data;
        const buckets = new Map();
        let ink = 0;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], gg = d[i + 1], b = d[i + 2];
          if (dist(r, gg, b, rail) > 40 && dist(r, gg, b, row) > 40) {
            ink++;
            const key = Math.round(r / 15) + ',' + Math.round(gg / 15) + ',' + Math.round(b / 15);
            buckets.set(key, (buckets.get(key) || 0) + 1);
          }
        }
        const shades = [...buckets.values()].filter((n) => n > 30).length;
        window.__busyInk = { ink, shades };
      });
    })()`);
    let busyInk = null;
    for (let i = 0; i < 20 && !busyInk; i++) { await sleep(100); busyInk = await cdp.evaluate(`window.__busyInk`); }
    check('… et l\'arc bleu est VISIBLE dans l\'anneau du groupe, en AU MOINS deux teintes distinctes serpentin/piste, ni rail ni fond (pixels, pas style calculé)',
      !!busyInk && busyInk.ink > 50 && busyInk.shades >= 2, JSON.stringify(busyInk));
    // `anim.name` capturé section 3 sur une ligne PLATE (.ico-busy hors groupe) :
    // même nom d'animation ici ⇒ une seule définition CSS, aucune divergence.
    check('… même nom d\'animation que .ico-busy des lignes plates (une seule définition)',
      grpBusyAnim.name != null && grpBusyAnim.name === anim.name,
      JSON.stringify({ grp: grpBusyAnim.name, flat: anim.name }));
    check('membre non lié : son prompt s\'affiche, sans état emprunté',
      await cdp.evaluate(`(document.querySelector('.m-pending .m-prompt')||{}).textContent`) === 'Pas encore lancée');
    check('compteur « terminées » du groupe',
      await cdp.evaluate(`document.querySelector('.grp-count').textContent`) === '1/3 done');

    console.log('\n9ter. « Ce qui reste à faire » (étape 11) — masquage au rendu, jamais le store');
    // Groupe à 3 vagues : vague 1 (m1, m2) ENTIÈREMENT done-closed → doit
    // disparaître, ligne ET en-tête « wave 1 » ; vague 2 mêle un `stale` et un
    // `unsent-lost`, qui restent visibles (il reste un remède : aller voir /
    // relier / relancer) ; vague 3 (m5, `queued`) force `multiWave` pour que
    // l'absence de l'en-tête « wave 1 » soit un fait mesuré, pas un effet de
    // bord d'une vague unique restante. `g.done` (calculé côté extension.js,
    // group-done.js) reste false : il reste des membres à faire — la maîtresse,
    // elle, n'entre plus dans ce calcul (2026-08-18).
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
      waveLabels.includes('wave 2') && waveLabels.includes('wave 3 — queued'), JSON.stringify(waveLabels));
    check('compteur « terminées » : calculé sur le store COMPLET (les cachés comptent)',
      await cdp.evaluate(`document.querySelector('.grp-count').textContent`) === '2/5 done');
    check('des membres restent à faire : le lot est toujours rendu',
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

    // Tous les membres finis, onglets fermés, MAÎTRESSE ENCORE VIVANTE
    // (2026-08-18) : c'est désormais la condition suffisante — extension.js
    // pose `done` vrai sur les seuls statuts des membres, et le lot entier
    // quitte le DOM. La conv de cadrage, elle, n'est plus tête de lot : elle
    // retourne dans la liste plate (`masterIds` ne la retient plus, même
    // filtre `!g.done`), ce que la section suivante mesure sur un état réel.
    const allDoneMasterOpen = JSON.parse(JSON.stringify(hidden));
    allDoneMasterOpen.groups[0].done = true;   // ce que group-done.js conclut
    allDoneMasterOpen.groups[0].members.forEach(function (m) {
      m.status = 'done-closed'; m.waveStatus = 'done';
      m.canLink = false; m.canClose = false; m.canRelaunch = false; m.note = '✓ done · closed';
    });
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: allDoneMasterOpen })}, '*')`);
    await sleep(150);
    check("tous les membres finis+fermés : le lot n'est plus rendu, maîtresse vivante ou non",
      await cdp.evaluate(`document.querySelectorAll('#flow .grp').length`) === 0);
    check('… et plus aucune capsule de maîtresse ne traîne',
      await cdp.evaluate(`document.querySelectorAll('#flow .grp-master-fallback').length`) === 0);

    // La maîtresse LISTÉE d'un lot ainsi retiré redevient une ligne plate —
    // c'est tout l'objet du changement : elle perd son « tag » de lot sans que
    // rien n'ait été écrit dans le store ni fermé.
    const freedMaster = JSON.parse(JSON.stringify(allDoneMasterOpen));
    freedMaster.groups[0].master = {
      convId: 'c3', title: 'Terminée déjà lue', listed: true, tabTitle: null,
      hint: 'Finished.', status: 'done',
    };
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: freedMaster })}, '*')`);
    await sleep(150);
    check("… l'ex-maîtresse reprend sa ligne dans la liste plate (une seule fois)",
      await cdp.evaluate(`[...document.querySelectorAll('#flow > .conv .title')].filter(e => e.textContent === 'Terminée déjà lue').length`) === 1);

    console.log('\n9quater. Membre fini + onglet ouvert dont la conv n\'a jamais reçu c.groupId (2026-08-30)');
    // Repro exacte du défaut signalé par l'user sur son panneau réel (« en
    // fermant les onglets, les lignes de conversation sont réapparues dans
    // l'extension ») et mesuré au CDP (instrument-flat-leak.js) : un membre
    // encore `done` (onglet ouvert, PAS `done-closed`) dont la conv ne porte
    // aucun `groupId` — exactement ce que fabrique test/make-mockup.js.
    // `flat` ne s'appuyait QUE sur `c.groupId` : layoutFlow (appelé après
    // renderGroups) replace alors le MÊME nœud DOM partagé (rowFor met en
    // cache un nœud par conv) dans la liste plate, ce qui le retire de
    // `mn.slot` — la ligne quitte visuellement son lot, `.m-slot` reste vide.
    const groupIdLeak = JSON.parse(JSON.stringify(grouped));
    delete groupIdLeak.conversations[1].groupId;   // c2 : aucun indice côté conv, comme sur le panneau réel
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: groupIdLeak })}, '*')`);
    await sleep(150);
    check('le membre fini (onglet ouvert) reste DANS son lot malgré l\'absence de c.groupId',
      await cdp.evaluate(`[...document.querySelectorAll('#flow .grp .conv .title')].some(e => e.textContent === 'Terminée jamais lue')`));
    check('… et n\'est pas dupliqué/déporté dans la liste plate',
      await cdp.evaluate(`[...document.querySelectorAll('#flow > .conv .title')].filter(e => e.textContent === 'Terminée jamais lue').length`) === 0);
    check('… aucun m-slot de membre laissé vide (le nœud n\'est pas volé par layoutFlow)',
      await cdp.evaluate(`[...document.querySelectorAll('#flow .grp .m-slot')].every(s => s.children.length > 0)`));

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
      // Depuis le chantier contraste (2.70.x), les COULEURS d'un symbole
      // s'adaptent au fond colore du lot pour rester lisibles : ce qui doit
      // rester identique, c'est la FORME - glyphe, bordure, rayon, animation.
      // Comparer aussi les couleurs reviendrait a interdire ce chantier.
      const strip = (s) => { if (!s) return null; const o = JSON.parse(s);
        delete o.borderColor; delete o.pseudoColor; delete o.color; return JSON.stringify(o); };
      check('etat ' + state + ' : la FORME du symbole dans un lot est la meme que hors lot',
        !!pair.grp && strip(pair.grp) === strip(pair.flat),
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
    // Resserré 2026-08-27 (MOCKUP_auto_sans_bouton) : en AUTO, plus AUCUN
    // séparateur n'est cliquable, jamais — pas même la PROCHAINE vague à
    // ouvrir, qui garde donc la même mention « — queued » que toute autre
    // vague en file. La seule porte vers un forçage est l'interrupteur
    // manuel/auto de l'en-tête (couvert plus bas).
    check('avec 2 vagues en AUTO, la vague 2 (prochaine à lancer) reste inerte « — queued »',
      waveHdrTexts.indexOf('wave 2 — queued') !== -1, waveHdrTexts);
    // Infobulle (2026-09-02, §d) : le prompt COMPLET d'abord, l'explication
    // d'état en dessous — jamais plus le hint seul (.m-prompt est tronqué en
    // CSS, c'était le seul endroit pour relire un prompt coincé).
    check('membre en attente de sa vague : prompt + « queued » dans l\'infobulle, pas « pas encore lié »',
      await cdp.evaluate(`(document.querySelector('.m-pending')||{}).title`) === 'Pas encore lancée\n\nQueued — opens when this wave starts.');
    check('aucun bouton ▶ dédié en bas de vague (supprimé, lot 4)',
      await cdp.evaluate(`!Array.from(document.querySelectorAll('#flow button')).some(b => b.textContent.includes('Launch wave'))`) === true);
    check('AUCUN séparateur cliquable en AUTO, vague non bloquée (plus de style "launch")',
      await cdp.evaluate(`document.querySelectorAll('#flow .wave-hdr.launch').length`) === 0);
    check('aucune bannière de succès affichée', await cdp.evaluate(`!document.querySelector('#flow .banner.info')`) === true);
    // Cliquer un séparateur inerte ne doit plus jamais rien envoyer en AUTO.
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`Array.from(document.querySelectorAll('#flow .wave-hdr'))[1].click()`);
    const afterInertClick = await cdp.evaluate(`window.__sent`);
    check('clic sur le séparateur de la vague 2 en AUTO → rien envoyé',
      Array.isArray(afterInertClick) && afterInertClick.length === 0, JSON.stringify(afterInertClick));
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
    // L'ancien « chemin de secours » (séparateur franc/bleu cliquable même en
    // AUTO pour une vague hard-bloquée) est retiré (2026-08-27, contrat
    // AUTO-sans-bouton) : plus rien n'est cliquable en AUTO, hard-bloquée ou
    // non — seule bascule vers MANUEL ouvre une porte.
    check('AUTO + vague hard-bloquée : toujours aucun séparateur cliquable',
      await cdp.evaluate(`document.querySelectorAll('#flow .wave-hdr.launch').length`) === 0);
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
    check('… et ne mentionne plus ▶ ni l\'avance auto suspendue, en AUTO',
      banner && banner.text.indexOf('▶') === -1 && banner.text.indexOf('suspended') === -1, JSON.stringify(banner));
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
    check('… toujours aucun séparateur cliquable en AUTO (lien mort-né)',
      await cdp.evaluate(`document.querySelectorAll('#flow .wave-hdr.launch').length`) === 0);
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
      Array.from(document.querySelectorAll('#flow .wave-hdr'))[1].click();
      return window.__sent;
    })()`);
    check('clic sur le séparateur d\'une vague hard-bloquée en AUTO → rien envoyé (plus d\'échappatoire)',
      Array.isArray(afterBlockedClick) && afterBlockedClick.length === 0, JSON.stringify(afterBlockedClick));
    // Une vague PLUS LOIN en file que la prochaine à lancer garde elle aussi
    // « — queued » : aucune des deux n'est jamais singularisée en AUTO.
    const triWave = JSON.parse(JSON.stringify(grouped));
    triWave.groups[0].members.push({
      key: 'm4', prompt: 'Vague 3', wave: 3, asked: { model: null, effort: null },
      convId: null, status: 'queued', waveStatus: 'queued', canLink: false, canClose: false,
      note: '', hint: 'Queued — opens when this wave starts.',
    });
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: triWave })}, '*')`);
    await sleep(120);
    const triHdrTexts = await cdp.evaluate(`Array.from(document.querySelectorAll('#flow .wave-hdr')).map(h => h.textContent).join('|')`);
    check('3 vagues en AUTO : aucune ne devient ▶, la 2 comme la 3 restent « — queued »',
      triHdrTexts.indexOf('wave 2 — queued') !== -1 && triHdrTexts.indexOf('wave 3 — queued') !== -1
      && triHdrTexts.indexOf('▶') === -1, triHdrTexts);
    // ── Mode MANUEL (2026-08-26, ROUVERT 2026-08-28) : seule porte vers un
    // forçage, et elle est ouverte dès qu'il reste une vague en file — y
    // compris quand la vague courante tourne encore (waves.js canForceLaunch,
    // « forcer un partiel »). Le resserrement du 2026-08-27 la fermait, et
    // l'interrupteur manuel semblait alors ne rien faire (constat user).
    const manualNotReady = JSON.parse(JSON.stringify(grouped));
    manualNotReady.groups[0].waveMode = 'manual';
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: manualNotReady })}, '*')`);
    await sleep(120);
    check('MANUEL, vague courante PAS finie : le ▶ est quand même offert (sinon l\'interrupteur ne donne la main sur rien)',
      await cdp.evaluate(`(() => { const h = document.querySelector('#flow .wave-hdr.launch'); return h ? h.textContent.trim() : null; })()`) === '▶ wave 2');
    const manualReadyState = JSON.parse(JSON.stringify(manualNotReady));
    manualReadyState.groups[0].members[0].status = 'done';
    manualReadyState.groups[0].members[0].waveStatus = 'done';
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: manualReadyState })}, '*')`);
    await sleep(120);
    check('MANUEL, vague courante finie : ▶ wave 2 apparaît (pri)',
      await cdp.evaluate(`(() => { const h = document.querySelector('#flow .wave-hdr.launch'); return h ? h.textContent.trim() + '|' + h.classList.contains('pri') : null; })()`) === '▶ wave 2|true');
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`document.querySelector('#flow .wave-hdr.launch').click()`);
    const afterManualClick = await cdp.evaluate(`window.__sent`);
    check('MANUEL : clic ▶ → launchWave (le clic EST l\'acte, sans confirmation)',
      Array.isArray(afterManualClick) && afterManualClick.length === 1 && afterManualClick[0].type === 'launchWave'
      && afterManualClick[0].id === 'g1' && afterManualClick[0].wave === 2 && afterManualClick[0].force === undefined,
      JSON.stringify(afterManualClick));
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
          movers: mv ? Array.from(mv.querySelectorAll('.m-jump')).filter(function (b) { return getComputedStyle(b).display !== 'none'; }).length : 0,
          movePos: mv ? getComputedStyle(mv).position : null,
          movePE: mv ? getComputedStyle(mv).pointerEvents : null,
        };
      });
      return { rows: rows, launched: rows.filter(function (r) { return !r.queued; }), queued: rows.filter(function (r) { return r.queued; }) };
    })()`);
    check('au moins une tâche en file propose bien son menu de vague (sinon ce banc ne prouve rien)',
      rowH.queued.some(function (r) { return r.movers > 0; }), JSON.stringify(rowH.queued));
    check('… et elle n\'est JAMAIS plus haute qu\'une tâche lancée (le pied ne réserve plus rien)',
      rowH.queued.every(function (q) { return rowH.launched.every(function (l) { return q.h <= l.h; }); }),
      JSON.stringify(rowH.rows));
    check('… pied replié pour de bon (hauteur 0, pas seulement « petite »)',
      rowH.queued.every(function (q) { return q.foot === 0; }), JSON.stringify(rowH.queued));
    check('le menu de vague est un OVERLAY, clics désarmés au repos (il ne vole pas le clic de la ligne)',
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

    console.log('\n10quinquies. Menu « vague n ▾ » : ce qui est PROPOSÉ à l\'écran = ce que le store accepte (2026-08-27)');
    // Le pill a remplacé les ◂/▸ : celles-ci déplaçaient d\'un CRAN, geste juste
    // mais indirect — autant de clics que de vagues à franchir, et un résultat
    // qui dépendait de qui partageait la vague de départ. Ce que ce bloc
    // verrouille est le même invariant qu\'elles avaient : un contrôle qui ne
    // fait rien MENT, donc ce que le menu offre doit être exactement ce que
    // groups.js setMemberWave accepterait. C\'est le seul banc qui peut le voir
    // (la condition est du DOM, pas une valeur de retour).
    const movers = JSON.parse(JSON.stringify(grouped));
    movers.groups[0].members.push(
      { key: 'm4', prompt: 'Vague 2, accompagnée', wave: 2, asked: { model: null, effort: null }, convId: null, status: 'queued', waveStatus: 'queued', canLink: false, canClose: false, canRelaunch: false, note: '', hint: 'Queued — opens when this wave starts.' },
      { key: 'm5', prompt: 'Vague 3, toute seule', wave: 3, asked: { model: null, effort: null }, convId: null, status: 'queued', waveStatus: 'queued', canLink: false, canClose: false, canRelaunch: false, note: '', hint: 'Queued — opens when this wave starts.' });
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: movers })}, '*')`);
    await sleep(150);

    const jumpRows = `(() => {
      return Array.from(document.querySelectorAll('#flow .member')).map(function (m) {
        const p = m.querySelector('.m-prompt');
        const j = m.querySelector('.m-jump');
        return {
          prompt: p ? p.textContent : null,
          queued: !!m.querySelector('.m-pending'),
          jump: !!j && getComputedStyle(j).display !== 'none',
          label: j ? j.textContent : null,
        };
      });
    })()`;
    const jr = await cdp.evaluate(jumpRows);
    const jRow = function (list, txt) { return list.find(function (r) { return r.prompt === txt; }) || {}; };
    check('chaque tâche EN FILE porte son numéro de vague en bouton-menu',
      jr.filter(function (r) { return r.queued; }).every(function (r) { return r.jump === true; }), JSON.stringify(jr));
    check('… et le libellé porte bien SA vague (celle de la ligne, pas celle du lot)',
      /3/.test(jRow(jr, 'Vague 3, toute seule').label || ''), JSON.stringify(jRow(jr, 'Vague 3, toute seule')));
    check('une tâche DÉJÀ LANCÉE n\'en a aucun (elle ne bouge plus)',
      jr.filter(function (r) { return !r.queued; }).every(function (r) { return r.jump === false; }),
      JSON.stringify(jr.filter(function (r) { return !r.queued; })));

    // Ouverture : rien n\'est envoyé tant qu\'aucune destination n\'est choisie,
    // et l\'overlay est tenu ouvert — sans quoi le pointeur, en descendant dans
    // le menu, sortirait de la ligne et le ferait disparaître.
    const openJumpOn = function (txt) {
      return `(() => {
        const m = Array.from(document.querySelectorAll('#flow .member')).find(function (x) {
          const p = x.querySelector('.m-prompt');
          return p && p.textContent === ${JSON.stringify(txt)};
        });
        m.querySelector('.m-jump').click();
      })()`;
    };
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(openJumpOn('Vague 2, accompagnée'));
    const menu = await cdp.evaluate(`(() => {
      const m = document.querySelector('#flow .m-menu');
      if (!m) return { open: false };
      const btns = Array.from(m.querySelectorAll('button'));
      return {
        open: true,
        sent: window.__sent.length,
        labels: btns.map(function (b) { return b.textContent.trim(); }),
        dead: btns.filter(function (b) { return b.disabled; }).map(function (b) { return b.textContent.trim(); }),
        held: !!m.closest('.member').classList.contains('menu-open'),
      };
    })()`);
    check('clic sur le pill : le menu s\'ouvre sans rien envoyer, et l\'overlay est tenu ouvert',
      menu.open === true && menu.sent === 0 && menu.held === true, JSON.stringify(menu));
    check('… il liste la vague EN COURS (1, « démarre aussitôt ») puis les vagues en file (2 et 3)',
      menu.labels.length === 4 && /1/.test(menu.labels[0]) && /running|cours/i.test(menu.labels[0])
      && /2/.test(menu.labels[1]) && /3/.test(menu.labels[2]),
      JSON.stringify(menu.labels));
    check('… la vague COURANTE est marquée « ici » et n\'est pas cliquable (le store la refuserait)',
      menu.dead.length === 1 && /2/.test(menu.dead[0]) && /\(ici\)|\(here\)/.test(menu.dead[0]), JSON.stringify(menu));
    check('… et « nouvelle vague à la fin » ferme la liste',
      /fin|end/i.test(menu.labels[menu.labels.length - 1]), JSON.stringify(menu.labels));

    // Le geste : UN clic, une destination ABSOLUE — là où il fallait autant de
    // flèches que de vagues à franchir.
    await cdp.evaluate(`Array.from(document.querySelectorAll('#flow .m-menu button')).find(function (b) { return !b.disabled && /3/.test(b.textContent); }).click()`);
    const afterJump = await cdp.evaluate(`window.__sent`);
    check('choisir une vague → un seul setMemberWave, avec le numéro visé',
      Array.isArray(afterJump) && afterJump.length === 1 && afterJump[0].type === 'setMemberWave'
      && afterJump[0].id === 'g1' && afterJump[0].key === 'm4' && afterJump[0].wave === 3, JSON.stringify(afterJump));
    check('… et le menu s\'est refermé', await cdp.evaluate(`!document.querySelector('#flow .m-menu')`) === true);

    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(openJumpOn('Vague 2, accompagnée'));
    await cdp.evaluate(`Array.from(document.querySelectorAll('#flow .m-menu button')).find(function (b) { return /fin|end/i.test(b.textContent); }).click()`);
    const afterJumpNew = await cdp.evaluate(`window.__sent`);
    check('« nouvelle vague à la fin » → setMemberWave avec wave: null',
      Array.isArray(afterJumpNew) && afterJumpNew.length === 1
      && afterJumpNew[0].type === 'setMemberWave' && afterJumpNew[0].wave === null, JSON.stringify(afterJumpNew));

    // Le MIROIR du refus du store (setMemberWave) : un membre déjà SEUL au bout
    // de la file est déjà « à la fin » — la proposer ne ferait que renuméroter.
    await cdp.evaluate(openJumpOn('Vague 3, toute seule'));
    const soloMenu = await cdp.evaluate(`(() => {
      const m = document.querySelector('#flow .m-menu');
      return m ? Array.from(m.querySelectorAll('button')).map(function (b) { return b.textContent.trim(); }) : null;
    })()`);
    check('membre SEUL de la DERNIÈRE vague : « nouvelle vague à la fin » n\'est PAS proposée',
      Array.isArray(soloMenu) && !soloMenu.some(function (l) { return /fin|end/i.test(l); }), JSON.stringify(soloMenu));
    check('… mais les autres vagues en file le restent (il peut toujours rejoindre la 2)',
      Array.isArray(soloMenu) && soloMenu.some(function (l) { return /2/.test(l); }), JSON.stringify(soloMenu));
    await cdp.evaluate(`document.body.click()`);

    // Contre-épreuve : dès qu\'une seconde ligne l\'accompagne sur cette dernière
    // vague, « à la fin » revient — c\'est ce cas-là qui fabrique une vague au
    // bout, et le store l\'accepte.
    const moversPair = JSON.parse(JSON.stringify(movers));
    moversPair.groups[0].members.push(
      { key: 'm6', prompt: 'Vague 3, plus seule', wave: 3, asked: { model: null, effort: null }, convId: null, status: 'queued', waveStatus: 'queued', canLink: false, canClose: false, canRelaunch: false, note: '', hint: 'Queued — opens when this wave starts.' });
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: moversPair })}, '*')`);
    await sleep(150);
    await cdp.evaluate(openJumpOn('Vague 3, toute seule'));
    const pairMenu = await cdp.evaluate(`(() => {
      const m = document.querySelector('#flow .m-menu');
      return m ? Array.from(m.querySelectorAll('button')).map(function (b) { return b.textContent.trim(); }) : null;
    })()`);
    check('même ligne, désormais accompagnée : « nouvelle vague à la fin » REVIENT',
      Array.isArray(pairMenu) && pairMenu.some(function (l) { return /fin|end/i.test(l); }), JSON.stringify(pairMenu));

    // Un lot vivant pousse son état toutes les 30 s et à chaque transition : le
    // menu est REPEINT, jamais refermé sous les doigts.
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: moversPair })}, '*')`);
    await sleep(150);
    check('un push d\'état pendant que le menu est ouvert ne le referme pas',
      await cdp.evaluate(`!!document.querySelector('#flow .m-menu')`) === true);
    await cdp.evaluate(`document.body.click()`);
    check('un clic ailleurs referme le menu',
      await cdp.evaluate(`!document.querySelector('#flow .m-menu')`) === true);
    await cdp.evaluate(openJumpOn('Vague 3, toute seule'));
    await cdp.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    check('Échap referme le menu',
      await cdp.evaluate(`!document.querySelector('#flow .m-menu')`) === true);

    // Géométrie : le pill est un OVERLAY comme les flèches qu\'il remplace — au
    // survol la ligne ne grandit pas d\'un pixel, et il ne recouvre pas le ⤴.
    const jGeom = await cdp.evaluate(`(() => {
      const m = Array.from(document.querySelectorAll('#flow .member')).find(function (x) {
        const p = x.querySelector('.m-prompt');
        return p && p.textContent === 'Vague 3, toute seule';
      });
      const before = m.getBoundingClientRect().height;
      const ev = function (t) { m.dispatchEvent(new MouseEvent(t, { bubbles: true })); };
      ev('mouseover'); ev('mouseenter');
      const head = m.querySelector('.m-head').getBoundingClientRect();
      const mv = m.querySelector('.m-move').getBoundingClientRect();
      const out = m.querySelector('.m-out').getBoundingClientRect();
      return {
        before: Math.round(before * 10) / 10, after: Math.round(m.getBoundingClientRect().height * 10) / 10,
        overlap: Math.round(mv.right) > Math.round(out.left),
        inside: Math.round(mv.left) >= Math.round(head.left) && Math.round(mv.right) <= Math.round(head.right),
      };
    })()`);
    check('au survol, la ligne ne grandit pas d\'un pixel',
      jGeom.before === jGeom.after, JSON.stringify(jGeom));
    check('… et le pill + le ⤴ tiennent côte à côte dans les bords de la ligne',
      jGeom.overlap === false && jGeom.inside === true, JSON.stringify(jGeom));

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

    // Ambiguïté d'appariement onglet (lot 3, plan d'appariement 2026-08-21) :
    // signe discret + infobulle, jamais de nouvelle ligne (gabarit inchangé).
    const ambiguousState = JSON.parse(JSON.stringify(STATE));
    ambiguousState.conversations[1].tabAmbiguous = true;   // c2
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: ambiguousState })}, '*')`);
    await sleep(150);
    const ambInfo = await cdp.evaluate(`(() => {
      const rows = document.querySelectorAll('#flow > .conv');
      return { c1: getComputedStyle(rows[0].querySelector('.amb')).display,
               c2: getComputedStyle(rows[1].querySelector('.amb')).display,
               c2Title: rows[1].querySelector('.amb').title };
    })()`);
    check('conv NON ambiguë : le signe reste masqué (display:none)', ambInfo.c1 === 'none', JSON.stringify(ambInfo));
    check('conv ambiguë (tabAmbiguous) : le signe apparaît', ambInfo.c2 !== 'none', JSON.stringify(ambInfo));
    check('… avec une infobulle qui explique la collision', ambInfo.c2Title.length > 0, JSON.stringify(ambInfo));
    check('aucune ligne ajoutée pour autant — même gabarit qu\'une ligne plate ordinaire',
      await cdp.evaluate(`document.querySelectorAll('#flow > .conv').length`) === STATE.conversations.length);
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

    console.log('\n10bis. Ajout en file : ce sont les LIGNES du lot qui sont les cibles (2026-08-29)');
    // Les deux lignes-boutons de vague (« + nouvelle vague », « + cette vague »)
    // ont disparu : survoler une ligne du lot désigne SA vague, et le clic y
    // dépose. Survoler la DERNIERE ligne couvre ce que « + nouvelle vague »
    // faisait — c'est ce qui autorisait sa suppression.
    check('plus aucune ligne-bouton de vague dans le panneau',
      await cdp.evaluate(`document.querySelectorAll('#flow .wave-ghost').length`) === 0);

    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: grouped })}, '*')`);
    await sleep(150);
    // UNE seule tâche au formulaire : le bloc tient en une vague, il REJOINT
    // donc la vague survolée (mode 'into') au lieu de s'insérer derrière elle.
    await cdp.evaluate(`(() => { const ta = document.querySelector('.task-top textarea.inp'); ta.value = 'Nouvelle tache en file'; ta.dispatchEvent(new Event('input')); })()`);
    const lastWave = await cdp.evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('#flow [data-ins-wave]'));
      const r = rows[rows.length - 1];
      if (!r) return null;
      (r.querySelector('.conv, .m-pending') || r).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      return Number(r.dataset.insWave);
    })()`);
    await sleep(220);
    const hov = await cdp.evaluate(`(() => ({
      zones: document.querySelectorAll('.ins-zone').length,
      hot: document.querySelectorAll('#flow .ins-hot').length,
      tag: (function () { const t = document.querySelector('.ins-tag'); return t ? t.textContent : null; })(),
      hl: document.querySelector('.task-top textarea.inp').classList.contains('hl-target'),
    }))()`);
    check('survol d une ligne : la vague s eclaire, et d UN seul cadre',
      hov.zones === 1 && hov.hot >= 2, JSON.stringify(hov));
    check('… un ruban dit ce qui va se passer', !!hov.tag && hov.tag.indexOf('wave') !== -1, JSON.stringify(hov));
    check('… et le champ prompt s allume : c est SON contenu qui va tomber la',
      hov.hl === true, JSON.stringify(hov));

    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('#flow [data-ins-wave]'));
      rows[rows.length - 1].click();
    })()`);
    const afterAdd = await cdp.evaluate(`window.__sent`);
    check('clic sur la ligne -> addTasksToGroup, mode into, sur la vague de la ligne',
      Array.isArray(afterAdd) && afterAdd.length === 1 && afterAdd[0].type === 'addTasksToGroup'
      && afterAdd[0].id === 'g1' && afterAdd[0].mode === 'into' && afterAdd[0].wave === lastWave
      && afterAdd[0].tasks.length === 1 && afterAdd[0].tasks[0].prompt === 'Nouvelle tache en file',
      JSON.stringify([afterAdd, lastWave]));
    check('champ prompt vidé après dépôt',
      await cdp.evaluate(`document.querySelector('.task-top textarea.inp').value`) === '');
    check('… et le décor de survol s eteint avec lui',
      await cdp.evaluate(`document.querySelectorAll('.ins-zone, .ins-tag').length`) === 0);

    // Champ VIDE : la ligne redevient ce qu'elle a toujours été — un raccourci
    // vers l'onglet. Le clic ne peut pas insérer ce qui n'existe pas.
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('#flow [data-ins-wave]'));
      const r = rows[rows.length - 1];
      (r.querySelector('.conv, .m-pending') || r).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      r.click();
    })()`);
    await sleep(120);
    const emptyClick = await cdp.evaluate(`window.__sent`);
    check('champ vide : aucune insertion, la ligne garde son geste d origine',
      Array.isArray(emptyClick) && emptyClick.every(function (m) { return m.type !== 'addTasksToGroup'; }),
      JSON.stringify(emptyClick));
    check('… et rien ne s eclaire : sans matiere a deposer, il n y a pas de cible',
      await cdp.evaluate(`document.querySelectorAll('.ins-zone').length`) === 0);

    // VAGUES A TROUS — le cas reel qui a echappe a tout le banc (2026-08-30).
    // Une vague videe de ses membres n'a plus d'en-tete : un lot affiche alors
    // 1 puis 4. L'apercu doit se poser devant la PREMIERE vague qui suit, pas
    // devant un numero calcule qui n'existe pas.
    const gapped = JSON.parse(JSON.stringify(grouped));
    gapped.groups[0].members = gapped.groups[0].members.map(function (m) {
      return m.wave === 2 ? Object.assign({}, m, { wave: 4 }) : m;
    });
    gapped.groups[0].nextWave = 4;
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: gapped })}, '*')`);
    await sleep(150);
    await cdp.evaluate(`(() => { const ta = document.querySelector('.task-top textarea.inp'); ta.value = 'Une tache pour la vague 1'; ta.dispatchEvent(new Event('input')); })()`);
    const gapWaves = await cdp.evaluate(`Array.from(document.querySelectorAll('#flow .grp-body > .wave-hdr .wave-hdr-label')).map(function (n) { return n.textContent; })`);
    check('(mise en place) le lot affiche bien des vagues NON contigues',
      gapWaves.join('|') === 'wave 1|wave 4 \u2014 queued', JSON.stringify(gapWaves));
    await cdp.evaluate(`(() => {
      const r = Array.from(document.querySelectorAll('#flow [data-ins-wave]'))
        .find(function (x) { return Number(x.dataset.insWave) === 1; });
      (r.querySelector('.conv, .m-pending') || r).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    })()`);
    await sleep(220);
    const gapSpot = await cdp.evaluate(`(() => {
      const prev = document.querySelector('.master-preview');
      const next = prev ? prev.nextElementSibling : null;
      return {
        present: !!prev,
        nextIsWaveHeader: !!next && next.classList.contains('wave-hdr'),
        nextLabel: next ? next.textContent : null,
        atEndOfBody: !!next && next.classList.contains('ghost-line'),
      };
    })()`);
    check('vagues a trous : l apercu se pose DEVANT la vague suivante, pas en fin de lot',
      gapSpot.present === true && gapSpot.nextIsWaveHeader === true && gapSpot.atEndOfBody === false,
      JSON.stringify(gapSpot));

    // VAGUE DEJA PASSEE — le lot de l'user etait arrive a la vague 4, sa vague 1
    // terminee. Le store refuse toute vague anterieure a celle en cours
    // (groups.js : n < launchedWave). Le ruban le disait pour un bloc
    // MULTI-vagues seulement : sur un bloc mono-vague il restait vert, donc une
    // cible morte presentee comme vivante (2026-08-30).
    const pastWave = JSON.parse(JSON.stringify(gapped));
    pastWave.groups[0].launchedWave = 4;
    pastWave.groups[0].nextWave = null;
    // La vague 4 est EN COURS, la 1 terminee : c'est le cas de l'user. Un lot
    // dont TOUT est fini se replie tout seul (repli auto), ce qui masquerait
    // les lignes qu'on veut survoler.
    pastWave.groups[0].members = pastWave.groups[0].members.map(function (m) {
      return m.wave === 1
        ? Object.assign({}, m, { status: 'done', waveStatus: 'done', canClose: true })
        : Object.assign({}, m, { status: 'busy', waveStatus: 'launched', canClose: false });
    });
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: pastWave })}, '*')`);
    await sleep(150);
    await cdp.evaluate(`(() => { const ta = document.querySelector('.task-top textarea.inp'); ta.value = 'Une tache de plus'; ta.dispatchEvent(new Event('input')); })()`);
    const prevSpotBefore = await cdp.evaluate(`(() => {
      const p = document.querySelector('.master-preview');
      return p && p.nextElementSibling ? p.nextElementSibling.className : null;
    })()`);
    await cdp.evaluate(`(() => {
      const r = Array.from(document.querySelectorAll('#flow [data-ins-wave]'))
        .find(function (x) { return Number(x.dataset.insWave) === 1; });
      if (r) (r.querySelector('.conv, .m-pending') || r).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    })()`);
    await sleep(220);
    const past = await cdp.evaluate(`(() => {
      const p = document.querySelector('.master-preview');
      return {
        tag: (function () { const t = document.querySelector('.ins-tag'); return t ? t.textContent : null; })(),
        refusedStyle: !!document.querySelector('.ins-tag.no'),
        prevNext: p && p.nextElementSibling ? p.nextElementSibling.className : null,
      };
    })()`);
    const pastHeaders = await cdp.evaluate(`Array.from(document.querySelectorAll('#flow .grp-body > .wave-hdr .wave-hdr-label')).map(function (n) { return n.textContent; })`);
    console.log('       [sonde] en-tetes rendus : ' + JSON.stringify(pastHeaders));
    check('(mise en place) le lot est bien arrive a la vague 4',
      pastHeaders.join('|').indexOf('wave 4') !== -1, JSON.stringify(pastHeaders));
    check('vague DEJA PASSEE : le ruban dit non au lieu de promettre un depot',
      !!past.tag && /already past/.test(past.tag) && past.refusedStyle === true, JSON.stringify(past));
    // Le contrat n'est pas « il n'a pas bouge depuis la mesure d'avant » (un
    // survol precedent pouvait encore le deplacer) mais « il est a sa place PAR
    // DEFAUT » : en fin de corps, la ou les taches iront reellement.
    check('… et l apercu reste a sa place par defaut, en fin de lot',
      past.prevNext === null || /ghost-line/.test(past.prevNext || ''), JSON.stringify(past));
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`(() => {
      const r = Array.from(document.querySelectorAll('#flow [data-ins-wave]'))
        .find(function (x) { return Number(x.dataset.insWave) === 1; });
      if (r) r.click();
    })()`);
    await sleep(120);
    check('… et le clic n envoie rien',
      await cdp.evaluate(`(window.__sent || []).filter(function (m) { return m.type === 'addTasksToGroup'; }).length`) === 0);

    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: STATE })}, '*')`);
    await sleep(150);

    console.log('\n10ter. Plusieurs prompts : deux gestes nommes + apercu au survol (2026-08-29)');
    // Un formulaire a K vagues ne rentre dans AUCUNE vague : les lignes d'ajout
    // changent alors de sens ET de nom (« + insert here »), et le clic envoie
    // mode:'before'. Avant le 2026-08-29, un geste unique fondait la premiere
    // vague du bloc dans la vague visee et intercalait les suivantes — d'ou le
    // melange signale par l'user (une tache existante a cote d'une nouvelle).
    // Le survol, lui, MONTRE le resultat sans rien envoyer.
    //
    // FORMULAIRE CONSTRUIT A LA MAIN (2026-09-01), plus par collage : un bloc
    // colle designe une conversation maitresse, et depuis le verrouillage il
    // REFUSE toute cible d'insertion (mesure en 10quater). Le geste d'insertion
    // vit desormais uniquement sur un formulaire SANS maitresse — c'est lui
    // qu'on mesure ici, avec les memes cibles et les memes envois qu'avant.
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: grouped })}, '*')`);
    await sleep(150);
    const pasteBlock = async function (txt) {
      await cdp.evaluate(`(() => {
        const ta = document.querySelector('.task-top textarea.inp');
        ta.value = ${JSON.stringify(txt)};
        ta.dispatchEvent(new Event('change'));
      })()`);
      await sleep(80);
    };
    const clickFormBtn = function (label) {
      return `(() => {
        const b = Array.from(document.querySelectorAll('#batchForm button'))
          .find(function (x) { return x.textContent.indexOf(${JSON.stringify(label)}) !== -1; });
        if (b) b.click();
        return !!b;
      })()`;
    };
    // Deux taches : meme vague (« + Add task ») ou deux vagues (« + Add wave
    // divider »). Cancel d'abord — le formulaire garde l'etat du scenario
    // precedent, et c'est le seul geste qui le remet vraiment a zero.
    // Modele/effort choisis PAR TACHE, au selecteur (chaque bouton porte sa
    // valeur en title) : c'est ce que le bloc colle apportait avant, et ce que
    // le depot doit continuer de transporter tel quel.
    const pickPerTask = async function (i, model, effort) {
      await cdp.evaluate(`document.querySelectorAll('#batchForm .task')[${i}].querySelector('button[title=${JSON.stringify(model)}]').click()`);
      await sleep(60);
      await cdp.evaluate(`document.querySelectorAll('#batchForm .task')[${i}].querySelector('button[title=${JSON.stringify(effort)}]').click()`);
      await sleep(60);
    };
    const handTasks = async function (split) {
      await cdp.evaluate(clickFormBtn('Cancel'));
      await sleep(80);
      await cdp.evaluate(`(() => {
        const ta = document.querySelector('#batchForm .task textarea.inp');
        ta.value = 'Premiere tache'; ta.dispatchEvent(new Event('input'));
      })()`);
      await cdp.evaluate(clickFormBtn(split ? 'Add wave divider' : 'Add task'));
      await sleep(100);
      await cdp.evaluate(`(() => {
        const ta = document.querySelectorAll('#batchForm .task textarea.inp')[1];
        ta.value = 'Deuxieme tache'; ta.dispatchEvent(new Event('input'));
      })()`);
      await sleep(100);
      await pickPerTask(0, 'sonnet', 'medium');
      await pickPerTask(1, 'opus', 'high');
      await sleep(80);
    };
    const rowOfWave = function (w) {
      return `(function () {
        return Array.from(document.querySelectorAll('#flow [data-ins-wave]'))
          .find(function (r) { return Number(r.dataset.insWave) === ${w}; });
      })()`;
    };
    const hoverWave = async function (w) {
      await cdp.evaluate(`(() => {
        const r = ${rowOfWave(w)};
        if (!r) return;
        (r.querySelector('.conv, .m-pending') || r).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      })()`);
      await sleep(160);
    };
    await handTasks(true);
    check('formulaire a DEUX vagues construit a la main (mode etendu)',
      await cdp.evaluate(`document.querySelectorAll('#batchForm .task').length`) === 2);

    // SURVOL de la ligne de la vague 1 : le bloc se pose DERRIERE elle, donc
    // devant la vague 2. L'apercu s'y installe, les vagues suivantes sont
    // renumerotees, la fleche de l'agrafe suit — et RIEN n'est envoye.
    await cdp.evaluate(`window.__sent = []`);
    const targetTopBefore = await cdp.evaluate(`(() => {
      const r = ${rowOfWave(1)};
      return r ? Math.round(r.getBoundingClientRect().top) : null;
    })()`);
    await hoverWave(1);
    const hovered = await cdp.evaluate(`(() => {
      const prev = document.querySelector('.master-preview');
      const tip = document.querySelector('.mcue-tip');
      const target = ${rowOfWave(1)};
      return {
        // Depuis 2026-08-29 l'apercu pose de VRAIS separateurs de vague (il doit
        // montrer ce que le lot aura, pas un rendu maison) : les deux jeux
        // d'en-tetes portent donc la meme classe et se distinguent par leur
        // parent, jamais par leur selecteur.
        waves: Array.from(document.querySelectorAll('.master-preview .wave-hdr-label')).map(function (n) { return n.textContent; }),
        bumped: document.querySelectorAll('#flow .wave-hdr.bumped').length,
        headers: Array.from(document.querySelectorAll('#flow .wave-hdr-label')).filter(function (n) { return !n.closest('.master-preview'); }).map(function (n) { return n.textContent; }),
        tag: (function () { const t = document.querySelector('.ins-tag'); return t ? t.textContent : null; })(),
        zones: document.querySelectorAll('.ins-zone').length,
        tipY: tip ? Math.round(tip.getBoundingClientRect().top) : null,
        prevY: prev ? Math.round(prev.getBoundingClientRect().top) : null,
        targetTop: target ? Math.round(target.getBoundingClientRect().top) : null,
        prevAfterTarget: !!prev && !!target
          && (target.compareDocumentPosition(prev) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        sent: (window.__sent || []).length,
      };
    })()`);
    check('survol : le ruban annonce une insertion DERRIERE la vague visee',
      !!hovered.tag && /insert after this wave/.test(hovered.tag), JSON.stringify(hovered.tag));
    check('… un seul cadre eclaire la vague visee', hovered.zones === 1, String(hovered.zones));
    check('survol : l\'apercu annonce les numeros DEFINITIFS (vagues 2 et 3, pas 1 et 2)',
      hovered.waves.join('|') === 'wave 2 \u2014 queued|wave 3 \u2014 queued', JSON.stringify(hovered.waves));
    check('… la vague en file est repoussee a 4 et le DIT (classe bumped)',
      hovered.bumped === 1 && hovered.headers.join('|') === 'wave 1|wave 4 \u2014 queued', JSON.stringify(hovered.headers));
    // L'apercu se DEPLACE jusqu'a la cible (il occupe la place qu'il annonce),
    // mais il se pose DERRIERE la vague visee : celle-ci ne se derobe donc pas
    // sous la souris qui la vise — c'etait le reproche du 2026-08-29.
    check('… l\'apercu se pose bien APRES la ligne visee, dans le corps du lot',
      hovered.prevAfterTarget === true, JSON.stringify(hovered));
    check('… et la vague visee ne bouge PAS d\'un pixel sous la souris',
      hovered.targetTop === targetTopBefore, JSON.stringify([targetTopBefore, hovered.targetTop]));
    check('… la fleche de l\'agrafe a quitte la maitresse pour le haut de l\'apercu',
      hovered.tipY !== null && Math.abs(hovered.tipY - hovered.prevY) < 40, JSON.stringify(hovered));
    check('… et RIEN n\'a ete envoye : le survol montre, il n\'engage pas', hovered.sent === 0);

    // CLIC sur la ligne : le geste EXACT que l'apercu montrait, sans confirmation.
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`${rowOfWave(1)}.click()`);
    const afterMultiWave = await cdp.evaluate(`window.__sent`);
    check('clic sur la vague 1 -> UN addTasksToGroup, mode before, vague 2, vagues relatives et modeles conserves',
      Array.isArray(afterMultiWave) && afterMultiWave.length === 1 && afterMultiWave[0].type === 'addTasksToGroup'
      && afterMultiWave[0].id === 'g1' && afterMultiWave[0].wave === 2 && afterMultiWave[0].mode === 'before'
      && afterMultiWave[0].tasks.length === 2
      && afterMultiWave[0].tasks[0].wave === 1 && afterMultiWave[0].tasks[0].model === 'sonnet' && afterMultiWave[0].tasks[0].effort === 'medium'
      && afterMultiWave[0].tasks[1].wave === 2 && afterMultiWave[0].tasks[1].model === 'opus' && afterMultiWave[0].tasks[1].effort === 'high',
      JSON.stringify(afterMultiWave));
    check('sortie du depot : la numerotation d\'origine revient',
      await cdp.evaluate(`document.querySelectorAll('#flow .wave-hdr.bumped').length`) === 0);
    check('aucune banniere de refus (le message « multi-vagues » n\'existe plus)',
      await cdp.evaluate(`!document.querySelector('#batchForm .banner:not(.info)')`) === true);
    check('formulaire vide apres le depot (retour au formulaire simple, une tache vierge)',
      await cdp.evaluate(`document.querySelectorAll('#batchForm .task').length`) === 1
      && await cdp.evaluate(`document.querySelector('.task-top textarea.inp').value`) === '');

    // NOUVELLE VAGUE EN FIN DE LOT — ce que « + nouvelle vague » faisait, et la
    // raison pour laquelle ce bouton a pu disparaitre : survoler la DERNIERE
    // vague pose le bloc derriere elle, donc apres tout le lot.
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: grouped })}, '*')`);
    await sleep(150);
    await handTasks(true);
    await hoverWave(2);
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`${rowOfWave(2)}.click()`);
    const afterLastWave = await cdp.evaluate(`window.__sent`);
    check('clic sur la DERNIERE vague -> le bloc se pose derriere elle (vague 3, mode before)',
      Array.isArray(afterLastWave) && afterLastWave.length === 1
      && afterLastWave[0].type === 'addTasksToGroup' && afterLastWave[0].wave === 3
      && afterLastWave[0].mode === 'before' && afterLastWave[0].tasks.length === 2,
      JSON.stringify(afterLastWave));

    // Formulaire MONO-vague : le geste redevient « rejoindre la vague », y compris la
    // vague EN COURS — et le depot part DIRECTEMENT. La confirmation qui
    // existait pour ce cas a ete retiree le 2026-08-29 : elle s'affichait dans
    // le formulaire, a l'autre bout du panneau, et l'user en concluait que le
    // bouton ne faisait rien (« ca ne fait absolument rien »). Ce qu'elle
    // disait est maintenant sur le ruban de la ligne visee.
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: grouped })}, '*')`);
    await sleep(150);
    await handTasks(false);
    await hoverWave(1);
    check('formulaire mono-vague sur la vague EN COURS : le ruban dit « starts now »',
      /starts now/.test(await cdp.evaluate(`(function () { const t = document.querySelector('.ins-tag'); return t ? t.textContent : ''; })()`)),
      await cdp.evaluate(`(function () { const t = document.querySelector('.ins-tag'); return t ? t.textContent : ''; })()`));
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`${rowOfWave(1)}.click()`);
    const afterRunningClick = await cdp.evaluate(`window.__sent`);
    check('… et le clic depose DIRECTEMENT dans la vague en cours (mode into, vague 1), sans confirmation',
      Array.isArray(afterRunningClick) && afterRunningClick.length === 1
      && afterRunningClick[0].wave === 1 && afterRunningClick[0].mode === 'into'
      && afterRunningClick[0].tasks.length === 2, JSON.stringify(afterRunningClick));
    check('… aucune banniere de confirmation ne subsiste dans le formulaire',
      await cdp.evaluate(`!Array.from(document.querySelectorAll('#batchForm .banner')).some(function (b) { return /already running/i.test(b.textContent); })`) === true);

    console.log('\n10quater. Bloc AVEC maitresse MEMBRE d\'un lot vivant : defaut SOEUR, imbrication explicite au survol (2026-09-02)');
    // Decision deleguee a Claude, §9(a) de NOTES_audit_simplification_harmonisation
    // (commit dd620926) : un bloc /handoffs colle avec « session: » DEVIENT par
    // defaut une SOEUR — les taches rejoignent le lot de la maitresse, en
    // nouvelle(s) vague(s) juste apres la sienne (addTasksToGroup), au lieu de
    // fonder un sous-lot IMBRIQUE en silence (2026-09-01, constat user a
    // captures a l'appui). L'imbrication reste possible, mais seulement au
    // survol EXPLICITE de la ligne de la maitresse elle-meme. Le survol des
    // AUTRES lignes de son propre lot redevient une cible ORDINAIRE ; celui
    // d'un AUTRE lot reste refuse (ruban reformule).
    const twoLots = JSON.parse(JSON.stringify(grouped));
    twoLots.groups.push({
      id: 'g2', name: 'Autre chantier', hue: 90, collapsed: false,
      launchedWave: 1, nextWave: 2, waveNotice: null,
      members: [
        { key: 'y1', prompt: 'Tache independante', wave: 1, asked: { model: 'sonnet', effort: 'medium' }, convId: null, status: 'queued', waveStatus: 'queued', canLink: false, canClose: false, note: '', hint: '' },
      ],
    });
    // effort: explicite sur les deux sections — le lot precedent (batchState)
    // n'a jamais recu de « inherit », un modele sans effort resterait
    // « unresolved » et desactiverait le bouton Create, faussant les
    // scenarios de clic ci-dessous.
    const masterBlock = '```claude-convs\nsession: fake-token\nmodel: sonnet\neffort: medium\nstage: 1\nSeule tache\n[---]\nmodel: opus\neffort: high\nstage: 2\nAutre tache\n```';
    const rowOfPrompt = function (text) {
      return `(function () {
        return Array.from(document.querySelectorAll('#flow [data-ins-wave]'))
          .find(function (r) {
            const t = r.querySelector('.conv .title, .m-pending .m-prompt');
            return t && t.textContent === ${JSON.stringify(text)};
          });
      })()`;
    };
    const hoverEl = async function (exprStr) {
      await cdp.evaluate(`(() => {
        const r = ${exprStr};
        if (!r) return;
        (r.querySelector('.conv, .m-pending') || r).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      })()`);
      await sleep(160);
    };
    // Recharge twoLots, colle le bloc et le fait resoudre vers c1 — MEMBRE de
    // g1 (m1, vague 1, vague EN COURS). Chaque scenario reprend a zero depuis
    // ce meme point : un clic/Create abouti vide le formulaire.
    const pasteAndResolve = async function () {
      await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: twoLots })}, '*')`);
      await sleep(150);
      await pasteBlock(masterBlock);
      // Le numero de la question posee a l'extension au collage : c'est lui
      // que la reponse doit porter, sinon le webview la jette (recherche perimee).
      const seq = await cdp.evaluate(`(window.__sent || []).filter(function (m) { return m.type === 'resolveMasterPaste'; }).pop().seq`);
      await cdp.evaluate(`window.postMessage({ type: 'masterResolved', seq: ${seq}, sessionId: 'c1', title: 'Conv au travail', matches: 1, reason: 'session' }, '*')`);
      await sleep(200);
    };

    // AVANT resolution : verrouille comme AVANT ce lot — la condition porte
    // sur ce qui est ECRIT dans le formulaire, jamais sur une maitresse encore
    // inconnue (sinon la cible s'ouvrirait puis se fermerait au retour de la
    // reponse). Comportement INCHANGE, meme ruban qu'en 2.100.0.
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: twoLots })}, '*')`);
    await sleep(150);
    await pasteBlock(masterBlock);
    await cdp.evaluate(`window.__sent = []`);
    await hoverWave(2);
    const stillLocked = await cdp.evaluate(`(() => ({
      tag: (function () { const t = document.querySelector('.ins-tag'); return t ? t.textContent : null; })(),
      refusedStyle: !!document.querySelector('.ins-tag.no'),
      zones: document.querySelectorAll('.ins-zone').length,
    }))()`);
    check('avant resolution de la maitresse : verrouille comme avant (ruban « sets the place »)',
      !!stillLocked.tag && /master conversation sets the place/.test(stillLocked.tag)
      && stillLocked.refusedStyle === true && stillLocked.zones === 0, JSON.stringify(stillLocked));
    await cdp.evaluate(`${rowOfWave(2)}.click()`);
    await sleep(120);
    check('… le clic est inerte tant que la maitresse n est pas resolue',
      await cdp.evaluate(`(window.__sent || []).filter(function (m) { return m.type === 'addTasksToGroup'; }).length`) === 0);

    // DEFAUT, rien survole : l'apercu est SOEUR, a PLAT dans le corps de g1 —
    // vague de la maitresse (1) + 1, donc vagues 2 et 3 pour ce bloc a 2 vagues.
    await pasteAndResolve();
    const sisterDefault = await cdp.evaluate(`(() => {
      const prev = document.querySelector('.master-preview');
      if (!prev) return { present: false };
      return {
        present: true,
        nested: prev.classList.contains('nested'),
        parentIsBody: !!prev.parentElement && prev.parentElement.classList.contains('grp-body'),
        waves: Array.from(prev.querySelectorAll('.wave-hdr-label')).map(function (n) { return n.textContent; }),
      };
    })()`);
    check('rien survole : apercu SOEUR present, a PLAT dans le corps du lot (jamais .nested)',
      sisterDefault.present === true && sisterDefault.nested === false && sisterDefault.parentIsBody === true,
      JSON.stringify(sisterDefault));
    check('… ses vagues sont deja les DEFINITIVES (2 et 3 — juste apres la vague 1 de la maitresse)',
      sisterDefault.waves.join('|') === 'wave 2 — queued|wave 3 — queued', JSON.stringify(sisterDefault));
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(clickFormBtn('Create'));
    await sleep(120);
    const sentDefault = await cdp.evaluate(`window.__sent`);
    check('Create SANS survol -> addTasksToGroup dans g1, vague 2, mode before (jamais createBatch)',
      Array.isArray(sentDefault) && sentDefault.length === 1 && sentDefault[0].type === 'addTasksToGroup'
      && sentDefault[0].id === 'g1' && sentDefault[0].wave === 2 && sentDefault[0].mode === 'before'
      && sentDefault[0].tasks.length === 2, JSON.stringify(sentDefault));

    // SURVOL D'UNE AUTRE LIGNE DU MEME LOT (m2, soeur de la maitresse dans g1,
    // meme vague EN COURS) : cible ORDINAIRE, memes regles qu'un bloc sans
    // maitresse — plus jamais refusee.
    await pasteAndResolve();
    await cdp.evaluate(`window.__sent = []`);
    await hoverEl(rowOfPrompt('Terminée jamais lue'));
    const sisterHover = await cdp.evaluate(`(() => ({
      tag: (function () { const t = document.querySelector('.ins-tag'); return t ? t.textContent : null; })(),
      refusedStyle: !!document.querySelector('.ins-tag.no'),
      zones: document.querySelectorAll('.ins-zone').length,
    }))()`);
    check('survol d\'une AUTRE ligne du lot de la maitresse : ACCEPTE (plus refuse)',
      sisterHover.refusedStyle === false && sisterHover.zones === 1
      && !!sisterHover.tag && /insert after this wave/.test(sisterHover.tag), JSON.stringify(sisterHover));
    await cdp.evaluate(`${rowOfPrompt('Terminée jamais lue')}.click()`);
    await sleep(120);
    const sentSisterHover = await cdp.evaluate(`window.__sent`);
    check('… et le clic depose bien addTasksToGroup dans g1 (jamais createBatch)',
      Array.isArray(sentSisterHover) && sentSisterHover.length === 1
      && sentSisterHover[0].type === 'addTasksToGroup' && sentSisterHover[0].id === 'g1', JSON.stringify(sentSisterHover));

    // SURVOL D'UN AUTRE LOT (g2) : toujours refuse, ruban REFORMULE (« batch »,
    // plus « place ») puisqu'une place par defaut existe deja ailleurs.
    await pasteAndResolve();
    await cdp.evaluate(`window.__sent = []`);
    await hoverEl(rowOfPrompt('Tache independante'));
    const otherLot = await cdp.evaluate(`(() => ({
      tag: (function () { const t = document.querySelector('.ins-tag'); return t ? t.textContent : null; })(),
      refusedStyle: !!document.querySelector('.ins-tag.no'),
      zones: document.querySelectorAll('.ins-zone').length,
    }))()`);
    check('survol d\'un AUTRE lot : refuse, ruban reformule « the master conversation sets the batch »',
      otherLot.refusedStyle === true && otherLot.zones === 0
      && !!otherLot.tag && /master conversation sets the batch/.test(otherLot.tag), JSON.stringify(otherLot));
    await cdp.evaluate(`${rowOfPrompt('Tache independante')}.click()`);
    await sleep(120);
    check('… le clic est inerte : aucun autre lot ne peut recevoir la maitresse',
      await cdp.evaluate(`(window.__sent || []).filter(function (m) { return m.type === 'addTasksToGroup'; }).length`) === 0);

    // SURVOL DE LA LIGNE DE LA MAITRESSE ELLE-MEME : SEUL geste qui produit
    // encore l'imbrication (comportement de 2.98.0/2.100.0, plus jamais en silence).
    await pasteAndResolve();
    await cdp.evaluate(`window.__sent = []`);
    await hoverEl(rowOfPrompt('Conv au travail'));
    const nestedHoverTag = await cdp.evaluate(`(() => ({
      tag: (function () { const t = document.querySelector('.ins-tag'); return t ? t.textContent : null; })(),
      refusedStyle: !!document.querySelector('.ins-tag.no'),
    }))()`);
    check('survol de la ligne de la maitresse elle-meme : « nested under this conversation »',
      nestedHoverTag.refusedStyle === false && !!nestedHoverTag.tag
      && /nested under this conversation/.test(nestedHoverTag.tag), JSON.stringify(nestedHoverTag));
    const nest = await cdp.evaluate(`(() => {
      const prev = document.querySelector('.master-preview');
      if (!prev) return { present: false };
      const member = prev.previousElementSibling;
      const rail = prev.querySelector('.mp-rail');
      return {
        present: true,
        nested: prev.classList.contains('nested'),
        parentIsBody: !!prev.parentElement && prev.parentElement.classList.contains('grp-body'),
        prevIsHostMember: !!member && member.classList.contains('member')
          && !!member.querySelector('.conv .title') && member.querySelector('.conv .title').textContent === 'Conv au travail',
        indent: Math.round(prev.getBoundingClientRect().left - (member ? member.getBoundingClientRect().left : 0)),
        railHooked: !!rail && rail.classList.contains('hooked'),
      };
    })()`);
    check('… l\'apercu bascule en imbrique, pose juste sous la ligne d accueil, decale comme un vrai corps de sous-lot',
      nest.present === true && nest.nested === true && nest.parentIsBody === true
      && nest.prevIsHostMember === true && nest.indent >= 20, JSON.stringify(nest));
    check('… son rail ferme son propre bloc, comme celui du sous-lot a naitre',
      nest.railHooked === true, JSON.stringify(nest));

    // (b) 2026-09-02 : pendant la composition, le ⤴ des lignes n'est plus un
    // controle — celui de la ligne d'accueil, juste au-dessus de l'apercu,
    // etait cliquable, et un clic sur une cible refusee le traversait.
    const outWhileComposing = await cdp.evaluate(`(() => {
      const prev = document.querySelector('.master-preview');
      const host = prev && prev.previousElementSibling;
      const out = host && host.querySelector('.m-out');
      return {
        composing: document.body.classList.contains('composing'),
        hostOutDisplay: out ? getComputedStyle(out).display : null,
        anyVisible: Array.from(document.querySelectorAll('.m-out')).some(function (b) { return getComputedStyle(b).display !== 'none'; }),
      };
    })()`);
    check('pendant la composition, le corps porte .composing et aucun ⤴ n est cliquable (ligne d accueil comprise)',
      outWhileComposing.composing === true && outWhileComposing.hostOutDisplay === 'none' && outWhileComposing.anyVisible === false,
      JSON.stringify(outWhileComposing));
    // (c) 2026-09-02 : la × qui vide le formulaire emporte le ruban avec elle
    // (seul le chemin « pointeur sorti de la ligne » le retirait) — verifie ici
    // sur la cible IMBRIQUEE (non refusee), l'autre moitie du decor.
    await cdp.evaluate(`Array.from(document.querySelectorAll('#batchForm .xdel')).forEach(function (b) { b.click(); })`);
    await sleep(120);
    const afterDelete = await cdp.evaluate(`(() => ({
      tag: !!document.querySelector('.ins-tag'),
      hot: document.querySelectorAll('.ins-hot').length,
      composing: document.body.classList.contains('composing'),
      outBack: Array.from(document.querySelectorAll('.m-out')).some(function (b) { return getComputedStyle(b).display !== 'none'; }),
    }))()`);
    check('… la × du formulaire retire le ruban, la vague eclairee et .composing (le ⤴ revient)',
      afterDelete.tag === false && afterDelete.hot === 0 && afterDelete.composing === false && afterDelete.outBack === true,
      JSON.stringify(afterDelete));

    // CLIC (ou Create) PENDANT LE SURVOL IMBRIQUE -> createBatch, exactement
    // comme avant ce lot (jamais addTasksToGroup, jamais une deuxieme fondation
    // silencieuse).
    await pasteAndResolve();
    await cdp.evaluate(`window.__sent = []`);
    await hoverEl(rowOfPrompt('Conv au travail'));
    await cdp.evaluate(`${rowOfPrompt('Conv au travail')}.click()`);
    await sleep(120);
    const sentNestedClick = await cdp.evaluate(`window.__sent`);
    check('clic sur la ligne de la maitresse en survol imbrique -> createBatch (jamais addTasksToGroup)',
      Array.isArray(sentNestedClick) && sentNestedClick.length === 1 && sentNestedClick[0].type === 'createBatch',
      JSON.stringify(sentNestedClick));

    console.log('\n10septies. Le CLIC désigne — ou retire — la maîtresse (MOCKUP_refus_maitresse, 2026-09-02)');
    // Un bloc collé SANS ligne session: se rattachait quand même à la conv qui
    // l'a écrit (master.js, recherche par texte) sans aucun moyen de le
    // refuser AVANT Create. Ligne PLATE (hors lot) : le clic désigne, ou
    // détache si elle est déjà la maîtresse — le choix EXPLICITE de l'user
    // prime sur toute résolution serveur.
    const flatRowOf = function (text) {
      return `(function () {
        return Array.from(document.querySelectorAll('#flow > .conv'))
          .find(function (r) { const t = r.querySelector('.title'); return t && t.textContent === ${JSON.stringify(text)}; });
      })()`;
    };
    // Bloc SANS session: — aucune recherche automatique n'a de quoi conclure,
    // et ce n'est délibérément pas nécessaire : composingMasterPick() ne
    // dépend que de form.masterPaste, jamais d'une résolution aboutie.
    const plainBlock = '```claude-convs\nmodel: sonnet\neffort: medium\nUne tache\n```';
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: grouped })}, '*')`);
    await sleep(150);
    await pasteBlock(plainBlock);
    await cdp.evaluate(`window.__sent = []`);

    // Ligne plate (« Sans état hooks », c4 — jamais rattachée à g1) : survol →
    // ruban « set as the master conversation ».
    await hoverEl(flatRowOf('Sans état hooks'));
    const designateHover = await cdp.evaluate(`(() => ({
      tag: (function () { const t = document.querySelector('.ins-tag'); return t ? t.textContent : null; })(),
      refusedStyle: !!document.querySelector('.ins-tag.no'),
      zones: document.querySelectorAll('.ins-zone').length,
    }))()`);
    check('ligne plate, pas encore la maîtresse : ruban « set as the master conversation »',
      designateHover.refusedStyle === false && designateHover.zones === 1
      && !!designateHover.tag && /set as the master conversation/.test(designateHover.tag), JSON.stringify(designateHover));
    // Une ligne MEMBRE d'un lot (m1, « Conv au travail ») : jamais désignable
    // ici, quoi qu'elle affiche par ailleurs — rowInsertTarget garde la main
    // (guard structurel !closest('.grp-body'), pas une question de résolution :
    // sans maîtresse résolue le ruban dit encore « sets the place », comme
    // avant ce lot — 10quater le couvre déjà en détail une fois résolue).
    await hoverEl(rowOfPrompt('Conv au travail'));
    const memberStillOrdinary = await cdp.evaluate(`(() => {
      const t = document.querySelector('.ins-tag');
      return t ? t.textContent : null;
    })()`);
    check('… une ligne DANS un lot ignore TOUJOURS ce ruban, même sans session: (rowInsertTarget garde la main)',
      !!memberStillOrdinary && !/set as the master conversation|detach from this conversation/.test(memberStillOrdinary),
      JSON.stringify(memberStillOrdinary));

    // Clic sur la ligne plate : aucun message envoyé (choix purement local
    // jusqu'à Create), et le survol suivant le confirme désignée.
    await hoverEl(flatRowOf('Sans état hooks'));
    await cdp.evaluate(`${flatRowOf('Sans état hooks')}.click()`);
    await sleep(120);
    check('le clic de désignation n\'envoie RIEN à l\'extension (choix local jusqu\'à Create)',
      (await cdp.evaluate(`window.__sent`)).length === 0);
    await hoverEl(flatRowOf('Sans état hooks'));
    const detachHover = await cdp.evaluate(`(() => {
      const t = document.querySelector('.ins-tag');
      return t ? t.textContent : null;
    })()`);
    check('… la MÊME ligne, survolée à nouveau : ruban « detach from this conversation »',
      !!detachHover && /detach from this conversation/.test(detachHover), JSON.stringify(detachHover));

    // Create : le choix EXPLICITE voyage tel quel (createBatch, jamais un
    // second addTasksToGroup — cette maîtresse n'a pas de lot vivant).
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(clickFormBtn('Create'));
    await sleep(120);
    const sentDesignate = await cdp.evaluate(`window.__sent`);
    check('Create transporte master: {explicit:true, sessionId:<id de la ligne cliquée>}',
      Array.isArray(sentDesignate) && sentDesignate.length === 1 && sentDesignate[0].type === 'createBatch'
      && !!sentDesignate[0].master && sentDesignate[0].master.explicit === true
      && typeof sentDesignate[0].master.sessionId === 'string' && sentDesignate[0].master.sessionId.length > 0,
      JSON.stringify(sentDesignate));

    // DÉTACHER : même ligne désignée deux fois (2ᵉ clic = détachement), Create
    // doit alors transporter sessionId NUL — jamais relancer sa propre recherche.
    await pasteBlock(plainBlock);
    await cdp.evaluate(`window.__sent = []`);
    await hoverEl(flatRowOf('Sans état hooks'));
    await cdp.evaluate(`${flatRowOf('Sans état hooks')}.click()`);
    await sleep(120);
    await cdp.evaluate(`${flatRowOf('Sans état hooks')}.click()`);
    await sleep(160);

    // LOT AUTONOME — signalé par l'user sur la 2.102.0 : détacher la maîtresse
    // faisait disparaître TOUT l'aperçu, alors que c'est le seul endroit qui
    // montre ce que « Créer » va produire. La maquette validée le pose sous
    // l'en-tête « New conversation » ; il doit vivre DANS le corps de la
    // section (c'est lui qui porte le repli), jamais à côté.
    const detachedDecor = await cdp.evaluate(`(() => {
      const prev = document.querySelector('.master-preview');
      const chip = document.querySelector('.master-chip');
      return {
        preview: !!prev,
        inNewConvBody: !!prev && !!prev.closest('#newConvBody'),
        nested: !!prev && prev.classList.contains('nested'),
        firstOfBody: !!prev && prev.parentElement.firstElementChild === prev,
        prompts: prev ? Array.from(prev.querySelectorAll('.m-prompt')).map(function (n) { return n.textContent; }) : [],
        masterTargets: document.querySelectorAll('.conv.master-target').length,
        cue: document.querySelectorAll('.mcue-v, .mcue-tip').length,
        chipSign: chip ? (chip.querySelector('.sign') || {}).textContent : null,
        chipWho: chip ? (chip.querySelector('.who') || {}).textContent : null,
      };
    })()`);
    check('maîtresse détachée : l\'aperçu des futures conversations EXISTE toujours',
      detachedDecor.preview === true, JSON.stringify(detachedDecor));
    check('… posé en tête du CORPS de « New conversation » (il suit donc le repli de la section)',
      detachedDecor.inNewConvBody === true && detachedDecor.firstOfBody === true, JSON.stringify(detachedDecor));
    check('… à plat, jamais imbriqué (le lot naît autonome, à la racine)',
      detachedDecor.nested === false && detachedDecor.prompts.length === 1, JSON.stringify(detachedDecor));
    check('… plus AUCUNE ligne ne respire (plus de maîtresse désignée)',
      detachedDecor.masterTargets === 0, JSON.stringify(detachedDecor));
    check('… et AUCUNE agrafe : elle dit la filiation, il n\'y en a plus',
      detachedDecor.cue === 0, JSON.stringify(detachedDecor));
    check('… la pastille dit le GESTE (⤴ détachée), jamais un échec de recherche (⚠ aucune trouvée)',
      detachedDecor.chipSign === '⤴' && /detached/i.test(detachedDecor.chipWho || ''), JSON.stringify(detachedDecor));

    await cdp.evaluate(clickFormBtn('Create'));
    await sleep(120);
    const sentDetach = await cdp.evaluate(`window.__sent`);
    check('deux clics (désigner puis détacher) : Create transporte master: {explicit:true, sessionId:null}',
      Array.isArray(sentDetach) && sentDetach.length === 1 && sentDetach[0].type === 'createBatch'
      && !!sentDetach[0].master && sentDetach[0].master.explicit === true && sentDetach[0].master.sessionId === null,
      JSON.stringify(sentDetach));

    // MÊME MANQUE, AUTRE PORTE (capture user du 2026-09-02) : la recherche
    // n'a rien trouvé — « No master conversation found · standalone batch ».
    // Aucun clic n'est en cause, et l'aperçu doit être là pour la même raison.
    await pasteBlock(plainBlock);
    const seqNone = await cdp.evaluate(`(window.__sent || []).filter(function (m) { return m.type === 'resolveMasterPaste'; }).pop().seq`);
    await cdp.evaluate(`window.postMessage({ type: 'masterResolved', seq: ${seqNone}, sessionId: null, title: '', matches: 0, reason: 'not-found' }, '*')`);
    await sleep(200);
    const noMasterDecor = await cdp.evaluate(`(() => {
      const prev = document.querySelector('.master-preview');
      const chip = document.querySelector('.master-chip');
      return {
        preview: !!prev && !!prev.closest('#newConvBody'),
        chipSign: chip ? (chip.querySelector('.sign') || {}).textContent : null,
        chipWho: chip ? (chip.querySelector('.who') || {}).textContent : null,
      };
    })()`);
    check('recherche sans résultat : l\'aperçu est là aussi, au même endroit',
      noMasterDecor.preview === true, JSON.stringify(noMasterDecor));
    check('… et la pastille garde son ⚠ « aucune trouvée » (là, c\'est bien un échec)',
      noMasterDecor.chipSign === '⚠' && /No master conversation found/i.test(noMasterDecor.chipWho || ''),
      JSON.stringify(noMasterDecor));
    await cdp.evaluate(clickFormBtn('Cancel'));
    await sleep(120);

    console.log('\n10octies. Défaut SŒUR : jamais une vague déjà LANCÉE (correctif 2026-09-02, §b)');
    // Cas réel qui motive ce correctif : la maîtresse a fini sa vague (1), le
    // lot-hôte est déjà à la vague 2 — host.wave + 1 (= 2) visait une vague
    // DÉJÀ lancée, refusée en silence par le store (groups.js addTasks) ; ni
    // l'aperçu ni le clic Create ne devaient plus jamais proposer ce numéro.
    const laggingHost = JSON.parse(JSON.stringify(STATE));
    laggingHost.conversations[0].groupId = 'g3';   // c1 → membre de g3, vague 1 (finie)
    laggingHost.groups = [{
      id: 'g3', name: 'Lot déjà avancé', hue: 40, collapsed: false,
      launchedWave: 2, nextWave: 3, waveNotice: null,
      members: [
        { key: 'n1', prompt: 'Conv au travail', wave: 1, asked: { model: 'sonnet', effort: 'medium' }, convId: 'c1', status: 'done-closed', waveStatus: 'done', canLink: false, canClose: false, canRelaunch: false, note: '✓ done · closed', hint: '' },
        { key: 'n2', prompt: 'Vague 2 en cours', wave: 2, asked: { model: 'sonnet', effort: 'medium' }, convId: null, status: 'not-linked', waveStatus: 'launched', canLink: true, canClose: false, canRelaunch: true, note: 'not linked yet', hint: '' },
      ],
    }];
    const soloBlock = '```claude-convs\nsession: fake-token\nmodel: sonnet\neffort: medium\nUne tache seule\n```';
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: laggingHost })}, '*')`);
    await sleep(150);
    await pasteBlock(soloBlock);
    const seqLagging = await cdp.evaluate(`(window.__sent || []).filter(function (m) { return m.type === 'resolveMasterPaste'; }).pop().seq`);
    await cdp.evaluate(`window.postMessage({ type: 'masterResolved', seq: ${seqLagging}, sessionId: 'c1', title: 'Conv au travail', matches: 1, reason: 'session' }, '*')`);
    await sleep(200);
    const laggingPreview = await cdp.evaluate(`(() => {
      const prev = document.querySelector('.master-preview');
      return prev ? Array.from(prev.querySelectorAll('.wave-hdr-label')).map(function (n) { return n.textContent; }) : null;
    })()`);
    check('aperçu SŒUR : vague 3 (max(vague maîtresse + 1, launchedWave + 1)), JAMAIS vague 2 (déjà lancée)',
      Array.isArray(laggingPreview) && laggingPreview.join('|') === 'wave 3 — queued', JSON.stringify(laggingPreview));
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(clickFormBtn('Create'));
    await sleep(120);
    const sentLagging = await cdp.evaluate(`window.__sent`);
    check('Create SANS survol -> addTasksToGroup vague 3 (jamais 2, jamais un dépôt refusé en silence)',
      Array.isArray(sentLagging) && sentLagging.length === 1 && sentLagging[0].type === 'addTasksToGroup'
      && sentLagging[0].id === 'g3' && sentLagging[0].wave === 3 && sentLagging[0].mode === 'before',
      JSON.stringify(sentLagging));

    await cdp.evaluate(clickFormBtn('Cancel'));
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
    // Prompt COMPLET + hint de la table de vérité en dessous (2026-09-02, §d).
    check('infobulle de la ligne en attente : prompt + hint de la table de vérité',
      fresh.pendingTitle === 'Tâche A\n\nTab open with the prompt inserted — press Enter to start it.', fresh.pendingTitle);

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

    console.log('\n12b. Lot 12 §1 — plus AUCUN champ de nom dans le formulaire (2026-08-30)');
    // Deux rangees pour un libelle facultatif, dans une barre laterale ou le
    // pixel vertical est la ressource rare. Un lot se renomme apres coup, et un
    // bloc colle qui porte « group: » le nomme sans qu'on tape quoi que ce soit.
    check('aucun champ « Group name », quel que soit le nombre de taches',
      await cdp.evaluate(`!Array.from(document.querySelectorAll('#batchForm .fld-label')).some(function (l) { return l.textContent.indexOf('Group name') !== -1; })`) === true);

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
      const labels = Array.from(modelPair.querySelectorAll('.segA1 button')).map(b => b.textContent);
      const on = modelPair.querySelector('.segA1 button.on');
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
      const modelOn = modelPair.querySelector('.segA1 button.on');
      const effortOn = effortPair.querySelector('.segA1 button.on');
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
      const on = modelPair.querySelector('.segA1 button.on');
      return on ? on.textContent : null;
    })()`);
    check('ID complet avec tag (claude-fable-5[1m]) ⇒ bouton « fable » allumé',
      fullIdFable === 'fable', JSON.stringify(fullIdFable));
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: { batch: { envConflict: [], busy: false, notice: null, inherit: { model: 'claude-opus-4-8', effort: 'high' } } } })}, '*')`);
    await sleep(50);
    const fullIdOpus = await cdp.evaluate(`(() => {
      const modelPair = Array.from(document.querySelectorAll('#batchForm .task .pair')).find(p => p.querySelector('.lbl').textContent === 'model');
      const on = modelPair.querySelector('.segA1 button.on');
      return on ? on.textContent : null;
    })()`);
    check('ID complet sans tag (claude-opus-4-8) ⇒ bouton « opus » allumé',
      fullIdOpus === 'opus', JSON.stringify(fullIdOpus));
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: { batch: { envConflict: [], busy: false, notice: null, inherit: { model: 'inconnu-x', effort: null } } } })}, '*')`);
    await sleep(50);
    const unknownId = await cdp.evaluate(`(() => {
      const modelPair = Array.from(document.querySelectorAll('#batchForm .task .pair')).find(p => p.querySelector('.lbl').textContent === 'model');
      const on = modelPair.querySelector('.segA1 button.on');
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
      const modelOn = pairs.find(p => p.querySelector('.lbl').textContent === 'model').querySelector('.segA1 button.on');
      const effortOn = pairs.find(p => p.querySelector('.lbl').textContent === 'effort').querySelector('.segA1 button.on');
      return { model: modelOn ? modelOn.textContent : null, effort: effortOn ? effortOn.textContent : null };
    })()`);
    check('lastModel/lastEffort persistés priment sur le défaut global « inherit »',
      lastChoiceOn.model === 'sonnet' && lastChoiceOn.effort === 'med', JSON.stringify(lastChoiceOn));
    // Un clic explicite doit poster le choix à l'extension pour persistance
    // (workspaceState) — écrit au clic, pas seulement au Create.
    await cdp.evaluate(`window.__sent = []`);
    const clickSent = await cdp.evaluate(`(() => {
      const modelPair = Array.from(document.querySelectorAll('#batchForm .task .pair')).find(p => p.querySelector('.lbl').textContent === 'model');
      const haikuBtn = Array.from(modelPair.querySelectorAll('.segA1 button')).find(b => b.textContent === 'haiku');
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
      const ghostRect = document.querySelector('#flow .ghost-line').getBoundingClientRect();
      return {
        top: Math.abs(railRect.top - start) < 1,
        hasBar: !!barRect,
        // pied : axe de la barre + 4px (HOOK_DROP) quand elle existe ; sinon
        // le bas de la ligne — la même ordonnée à un demi-pixel près.
        foot: barRect ? (railRect.bottom - (barRect.top + barRect.height / 2))
            : lastRect ? (railRect.bottom - lastRect.bottom) : null,
        hookRight: contentLeft === null ? null : (railRect.right - contentLeft),
        // Le repere de fin de corps a une hauteur NULLE depuis le retrait des
        // lignes-boutons (2026-08-29) : le crochet, pose a HOOK_W/2 sous le bas
        // de la derniere ligne, le touche donc au pixel. Ce que l'invariant
        // protege reste le meme : le trait ne descend pas AU-DELA du corps.
        aboveGhost: railRect.bottom <= ghostRect.top + 2,
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

    // Séparateur de vague : commence APRÈS l'axe du rail, ne le croise pas
    // (décision 2, dernier paragraphe). Les deux lignes-boutons qui étaient
    // mesurées ici ont disparu le 2026-08-29 — ce sont les lignes du lot qui
    // portent désormais les cibles d'insertion.
    const sepOffset = await cdp.evaluate(`(() => {
      const hdr = document.querySelector('#flow .grp-body .wave-hdr:not(.launch)');
      return { hdrPaddingLeft: hdr ? parseFloat(getComputedStyle(hdr).paddingLeft) : null };
    })()`);
    check('s\u00e9parateur de vague inerte : padding-left apr\u00e8s l\'axe du rail (14px + marge)',
      sepOffset.hdrPaddingLeft !== null && sepOffset.hdrPaddingLeft >= 20, JSON.stringify(sepOffset));

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
    const pasted = await cdp.evaluate(`(() => ({
      banner: !!document.querySelector('#batchForm .banner.info'),
      taskPrompt: (document.querySelector('#batchForm .task textarea') || {}).value,
    }))()`);
    // Plus de banniere de SUCCES (2026-08-30) : elle disait « N taches
    // pre-remplies » juste au-dessus des N taches pre-remplies. Ce qui doit
    // rester vrai, c'est le PRE-REMPLISSAGE lui-meme.
    check('bloc reconnu : aucune banniere de succes, mais la tache EST pre-remplie',
      pasted.banner === false && pasted.taskPrompt === 'Faire le lot 3',
      JSON.stringify(pasted));

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
      const ghost = document.querySelector('#flow .ghost-line');
      // Le rail ne part plus du haut du corps mais du bas de la capsule (étape
      // 19) : sa hauteur attendue est l'écart entre les DEUX bouts mesurés,
      // jamais le seul offsetTop de la ligne fantôme.
      // Depuis le crochet de fin de lot, le pied n'est plus le sommet de la
      // ligne fantôme mais la dernière ligne : la guérison se prouve par une
      // hauteur redevenue franche ET un pied resté au-dessus du fantôme.
      return {
        railHeight: rail.getBoundingClientRect().height,
        ghostTop: ghost.offsetTop, railTop: rail.offsetTop,
        aboveGhost: rail.offsetTop + rail.getBoundingClientRect().height <= ghost.offsetTop + 2,
      };
    })()`);
    check('… le ResizeObserver corrige tout seul la hauteur corrompue, SANS nouveau postMessage',
      healed.railHeight > 10 && healed.aboveGhost === true, JSON.stringify(healed));

    // (c) Anneau vs fond RÉEL de la ligne qui le porte, dans les DEUX thèmes
    // RÉELS — le §7 existant (prefers-color-scheme) ne change RIEN ici :
    // aucune @media n'en dépend, tout passe par les variables --vscode-* que
    // seul VRAI VS Code injecte. On les pose nous-mêmes, comme le ferait le
    // host, pour que ce banc mesure ce que l'œil voit vraiment.
    // Amendé (chantier contraste, 2026-08-26) : depuis que .conv.active peint
    // son PROPRE --row-bg (la couleur de sélection, PAS le fond du panneau —
    // cf. commentaire sur --row-bg dans panel.js, étape 2026-08-26), l'ancien
    // invariant unique « l'anneau égale le fond du PANNEAU » n'est plus vrai
    // que pour un membre ORDINAIRE. Sur le membre ACTIF (m1, aussi busy — la
    // même conv qu'au §9 juste au-dessus), l'anneau doit désormais égaler le
    // fond RÉEL DE SA LIGNE, sa couleur de sélection — exactement ce que
    // audit-contraste.js mesure déjà (ratio 1, faux positif VOULU, cf. son
    // commentaire "Faux positif UNIQUE et voulu"). Les DEUX preuves survivent
    // ici : le membre ordinaire garde le test d'origine (étape 12, régression
    // thème clair), le membre actif obtient le sien.
    const THEMES = {
      dark: { '--vscode-sideBar-background': '#252526', '--vscode-editor-background': '#1e1e1e' },
      light: { '--vscode-sideBar-background': '#f3f3f3', '--vscode-editor-background': '#ffffff' },
    };
    for (const [name, vars] of Object.entries(THEMES)) {
      const setVars = Object.entries(vars).map(([k, v]) => `document.documentElement.style.setProperty('${k}','${v}')`).join(';');
      await cdp.evaluate(`(() => { ${setVars}; })()`);
      await sleep(80);
      const rings = await cdp.evaluate(`(() => {
        const icos = [...document.querySelectorAll('#flow .grp-body .member .conv .ico')];
        const ordinary = icos.find((n) => !n.closest('.conv').classList.contains('active'));
        const active = icos.find((n) => n.closest('.conv').classList.contains('active'));
        return {
          ordinaryRingBg: ordinary && getComputedStyle(ordinary, '::after').backgroundColor,
          bodyBg: getComputedStyle(document.body).backgroundColor,
          activeRingBg: active && getComputedStyle(active, '::after').backgroundColor,
          activeRowBg: active && getComputedStyle(active.closest('.conv')).backgroundColor,
        };
      })()`);
      check(`thème ${name} : le fond de l'anneau d'un membre ORDINAIRE égale EXACTEMENT le fond réel du panneau (même chaîne de variables)`,
        rings.ordinaryRingBg === rings.bodyBg && rings.ordinaryRingBg !== 'rgba(0, 0, 0, 0)', JSON.stringify(rings));
      check(`thème ${name} : le fond de l'anneau du membre ACTIF égale le fond RÉEL DE SA LIGNE (couleur de sélection, plus le fond du panneau — 2026-08-26)`,
        rings.activeRingBg === rings.activeRowBg && rings.activeRingBg !== rings.bodyBg && rings.activeRingBg !== 'rgba(0, 0, 0, 0)', JSON.stringify(rings));
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

    // (a) Sans filiation : DEUX blocs frères, la ligne a2 revendiquée deux fois
    // (membre de A, maîtresse de B) — c'est l'état d'avant, qu'on mesure pour
    // que l'écart soit un fait et pas une impression.
    //
    // AMENDEMENT 2026-08-27 — `emptySlots` valait 1 ici jusqu'à cette date :
    // le dernier bloc rendu prenait le nœud de conversation et le premier
    // gardait un emplacement VIDE, donc invisible. Ce n'était pas seulement la
    // preuve « il faut la filiation », c'était aussi une ligne PERDUE à
    // l'écran, sans filiation pour la sauver quand les deux blocs sont bien
    // deux blocs (lot dont la maîtresse est le membre d'un autre lot que la
    // filiation a refusé de nester — ou deux membres poussés sur la même conv
    // par une redirection husk→successeur, cf. panel.js `rowOwner`). Le
    // panneau tranche désormais AVANT de rendre : le membre garde sa ligne,
    // la tête de B retombe sur son repli dégradé. `emptySlots` doit donc
    // valoir 0 ici comme partout ailleurs — plus jamais d'emplacement vide,
    // quelle que soit la cause de la double revendication.
    await pushNest([mkA(), mkB(false)]);
    const nestBefore = await cdp.evaluate(`(() => ({
      rootBlocks: document.querySelectorAll('#flow > .grp').length,
      emptySlots: Array.from(document.querySelectorAll('#flow .m-slot')).filter(s => !s.children.length).length,
      convNodes: document.querySelectorAll('.conv').length,
      // La ligne disputée reste chez le MEMBRE (A/m2), jamais escamotée.
      a2InMember: !!Array.from(document.querySelectorAll('#flow .member .conv .title'))
        .find(t => t.textContent === 'A task two — opens B'),
      // …et la tête de B affiche son repli dégradé plutôt qu'une capsule vide.
      bMasterFallback: !!document.querySelector('.grp-master-fallback'),
    }))()`);
    check('(témoin, sans filiation) deux blocs frères, AUCUN emplacement vide : le membre garde sa ligne',
      nestBefore.rootBlocks === 2 && nestBefore.emptySlots === 0 && nestBefore.a2InMember === true,
      JSON.stringify(nestBefore));

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
    check('… mais sa GRIP, elle, reste PLEINE LARGEUR comme la ligne d\'accueil (2026-08-27, variante B retenue sur capture : la boîte ne décale plus, seul son contenu l\'est via un padding)',
      Math.abs(axes.subGripLeft - axes.parentBodyLeft) < 0.5, JSON.stringify(axes));
    check('deux rails, deux axes : celui de l\'enfant est 28px à droite de celui du parent',
      Math.abs((axes.subRail - axes.parentRail) - 28) < 0.5, JSON.stringify(axes));
    check('les anneaux de l\'enfant tombent sur le rail de l\'enfant, pas sur celui du parent',
      Math.abs(axes.childIco - axes.subRail) < 0.5, JSON.stringify(axes));

    // (c bis) DEUX MEMBRES, UNE SEULE CONVERSATION (2026-08-27). Le store
    // garantit qu'un sessionId n'appartient qu'à un membre (groups.js
    // `attach`) : le doublon ne peut donc venir que d'une redirection
    // husk→successeur (supersede.js), qui pousse le membre d'un vieux lot sur
    // la conversation d'un lot voisin. Vécu ce jour-là : le lot le plus ancien
    // se retrouvait réduit à sa POIGNÉE — sa ligne prise par le voisin, son
    // emplacement vide donc invisible, et rien à l'écran pour le retirer.
    // Le lien DIRECT garde la ligne, quel que soit l'ordre du store (ici le
    // redirigé est rendu EN PREMIER, exprès) ; le redirigé retombe sur sa
    // ligne « en attente », visible, avec son prompt.
    const dupGroup = (id, stamp, hue, key, prompt, extra) => ({
      id, name: 'Dup ' + id, hue, collapsed: false, stamp,
      launchedWave: 1, nextWave: null, waveNotice: null, done: false,
      nestedUnder: null, master: null,
      members: [nmember(key, prompt, 'a1', extra)],
    });
    await pushNest([
      dupGroup('Q', '09:00', 30, 'q1', 'Vieux lot — membre redirigé', { redirected: true }),
      dupGroup('P', '10:00', 210, 'p1', 'Lot courant — lien direct'),
    ]);
    const dup = await cdp.evaluate(`(() => {
      const blockOf = (stamp) => Array.from(document.querySelectorAll('#flow > .grp'))
        .find(g => (g.querySelector('.grp-label') || {}).textContent === 'batch ' + stamp);
      const P = blockOf('10:00'), Q = blockOf('09:00');
      return {
        blocks: document.querySelectorAll('#flow > .grp').length,
        emptySlots: Array.from(document.querySelectorAll('#flow .m-slot')).filter(s => !s.children.length).length,
        // Un seul nœud pour la conv disputée, et il est chez le lien DIRECT.
        rowNodes: Array.from(document.querySelectorAll('.conv .title')).filter(t => t.textContent === 'A task one').length,
        rowInDirect: !!(P && Array.from(P.querySelectorAll('.conv .title')).find(t => t.textContent === 'A task one')),
        rowInRedirected: !!(Q && Array.from(Q.querySelectorAll('.conv .title')).find(t => t.textContent === 'A task one')),
        // …et le perdant montre bien quelque chose : sa ligne « en attente ».
        redirectedPending: !!(Q && Q.querySelector('.m-pending')),
        redirectedPromptShown: !!(Q && Array.from(Q.querySelectorAll('.m-prompt'))
          .find(p => p.textContent === 'Vieux lot — membre redirigé')),
      };
    })()`);
    check('conv revendiquée par deux membres : un seul nœud, chez le lien DIRECT (l\'ordre du store ne décide pas)',
      dup.rowNodes === 1 && dup.rowInDirect === true && dup.rowInRedirected === false, JSON.stringify(dup));
    check('… le lot redirigé garde une ligne VISIBLE (« en attente » + son prompt), jamais un emplacement vide',
      dup.emptySlots === 0 && dup.redirectedPending === true && dup.redirectedPromptShown === true, JSON.stringify(dup));
    check('… et les deux lots restent des blocs à part entière', dup.blocks === 2, JSON.stringify(dup));
    // Le panneau est un état PARTAGÉ entre les cas de cette section : on rend
    // la scène imbriquée avant de continuer, sinon (d) mesure MON DOM.
    await pushNest([mkA(), mkB(true)]);

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

    // (e) RÉVISÉ 2026-08-17, puis 2026-08-22 (« bulle scindée », choix user
    // sur MOCKUP_bulle_scindee_2026-08-22.html) — la ligne de TÊTE d'un
    // sous-lot n'a plus de capsule du tout : elle suit la ligne maîtresse,
    // dont elle reprend le canon. Sa bulle, elle, porte désormais les DEUX
    // couleurs (double rôle = membre du parent ET tête du sous-lot) : anneau
    // scindé verticalement, moitié gauche parent, moitié droite enfant —
    // peint en backgrounds (border transparente : une border n'a qu'une
    // couleur), avec un trou central radial OPAQUE qui continue de trouer le
    // rail du parent, lequel traverse toujours la ligne.
    // La peinture scindée passe par var(--vscode-sideBar-background, …) (même
    // chaîne que le fond du body, invariant étape 12) : sans hôte VS Code la
    // substitution est invalide et TOUT le background tombe à « none » — on
    // injecte donc la variable le temps de la mesure, comme les sections
    // thème plus haut (le vrai webview l'a toujours).
    // La bulle scindée peint son fond avec var(--vscode-sideBar-background) —
    // même chaîne que le body, invariant de l'étape 12. Sans hôte VS Code la
    // substitution est invalide et le fond disparaît : on injecte la variable
    // le temps de la mesure, comme les sections « thème » plus haut.
    await cdp.evaluate(`document.documentElement.style.setProperty('--vscode-sideBar-background', '#252526')`);
    const caps = await cdp.evaluate(`(() => {
      const probe = document.createElement('span');
      probe.style.color = 'hsl(30, 45%, 55%)';
      document.body.appendChild(probe);
      const hueB = getComputedStyle(probe).color;
      probe.style.color = 'hsl(210, 45%, 55%)';
      const hueA = getComputedStyle(probe).color;
      probe.remove();
      const host = Array.from(document.querySelectorAll('#flow .member'))
        .find(m => (m.querySelector('.title') || {}).textContent === 'A task two — opens B');
      const head = host.querySelector('.m-head');
      const cs = getComputedStyle(head, '::after');
      const headIcoEl = head.querySelector('.conv .ico');
      const headIco = getComputedStyle(headIcoEl, '::after');
      // Le tracé qui remplace le pseudo : deux arcs au stroke + le fond opaque.
      const svg = headIcoEl.querySelector('svg.split-ring');
      const strokes = svg ? Array.from(svg.querySelectorAll('path[stroke-width]')).map((pth) => {
        const st = getComputedStyle(pth);
        const d = pth.getAttribute('d') || '';
        const m = d.match(/^M (-?[\\d.]+) (-?[\\d.]+) A ([\\d.]+)/);
        return { stroke: st.stroke, w: parseFloat(st.strokeWidth), r: m ? parseFloat(m[3]) : null, startX: m ? parseFloat(m[1]) : null };
      }) : [];
      const fills = svg ? svg.querySelectorAll('circle[fill], path[fill]:not([stroke-width])').length : 0;
      // Comparaisons : un membre ordinaire du PARENT, et la maîtresse racine.
      const plainMember = Array.from(document.querySelectorAll('#flow .grp-body > .member'))
        .find((m) => m !== host && m.querySelector('.conv .ico'));
      const plainIco = plainMember ? getComputedStyle(plainMember.querySelector('.conv .ico'), '::after') : null;
      const masterIcoEl = document.querySelector('.grp-master-head .conv .ico');
      const masterIco = masterIcoEl ? getComputedStyle(masterIcoEl, '::after') : null;
      const framedConvs = Array.from(document.querySelectorAll('#flow .conv')).filter((c) => {
        for (let a = c.parentElement; a && a.id !== 'flow'; a = a.parentElement) {
          if (parseFloat(getComputedStyle(a).borderTopWidth) > 0) return true;
        }
        return false;
      }).length;
      return {
        hueA, hueB,
        shadow: cs.boxShadow, hostHasBorder: getComputedStyle(host).borderTopWidth,
        headPseudoDisplay: headIco.display,
        hasSvg: !!svg, strokes, fills,
        plainRing: plainIco ? { d: parseFloat(plainIco.width), w: parseFloat(plainIco.borderTopWidth), color: plainIco.borderTopColor } : null,
        masterRing: masterIco ? { display: masterIco.display, d: parseFloat(masterIco.width), color: masterIco.borderTopColor } : null,
        framedConvs,
        headWeight: getComputedStyle(head.querySelector('.conv .title')).fontWeight,
      };
    })()`);
    const near = (a, b, tol) => a !== null && Math.abs(a - b) <= (tol || 0.3);
    // Les deux arcs, reconnus par leur COULEUR (pas par leur ordre dans le DOM) :
    // c'est le rôle qui décide du canon, la mesure doit suivre le même chemin.
    const arcParent = (caps.strokes || []).find((k) => k.stroke === caps.hueA);
    const arcChild = (caps.strokes || []).find((k) => k.stroke === caps.hueB);
    check('ligne de tête : AUCUN cadre (ni pseudo, ni bordure sur la ligne)',
      caps.shadow === 'none' && caps.hostHasBorder === '0px', JSON.stringify(caps));
    check('… son anneau mono-couleur s\'efface au profit du tracé scindé (2026-08-22)',
      caps.headPseudoDisplay === 'none' && caps.hasSvg === true, JSON.stringify(caps));
    check('… DEUX arcs : le lot parent au canon d\'un MEMBRE, le sous-lot au canon d\'une TÊTE',
      !!arcParent && !!arcChild
      && near(arcParent.w, 1.5) && near(arcParent.r, (18 - 1.5) / 2)
      && near(arcChild.w, 4.25) && near(arcChild.r, (24 - 4.25) / 2), JSON.stringify(caps.strokes));
    check('… ils se chevauchent sur l\'axe : chaque arc démarre du CÔTÉ de l\'autre',
      !!arcParent && !!arcChild && arcParent.startX > 0 && arcChild.startX < 0, JSON.stringify(caps.strokes));
    check('… le fond reste opaque et épouse la forme (disque plein + une moitié par rayon)',
      caps.fills === 3, JSON.stringify(caps));
    check('… un membre ordinaire garde son anneau mono-couleur, au canon 18px de SON lot',
      caps.plainRing !== null && near(caps.plainRing.d, 18)
      && caps.plainRing.w > 0 && caps.plainRing.w < 4.25
      && caps.plainRing.color === caps.hueA, JSON.stringify(caps.plainRing));
    check('… et la maîtresse RACINE, qui n\'a qu\'UN rôle, garde sa bulle d\'une seule couleur',
      caps.masterRing !== null && caps.masterRing.display !== 'none'
      && near(caps.masterRing.d, 24) && caps.masterRing.color === caps.hueA, JSON.stringify(caps.masterRing));
    await cdp.evaluate(`document.documentElement.style.removeProperty('--vscode-sideBar-background')`);
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
    // normal du parent). RÉVISÉ 2026-08-27 (constat user sur capture réelle,
    // panneau étroit — variante B) : la grip ne décale plus SA BOÎTE non plus,
    // seul son contenu (chevron/libellé) l'est par un padding — les deux
    // boîtes tombent donc au même bord, gauche ET droit, sans qu'aucune des
    // deux n'ait dû bouger.
    check('bords gauche/droite de la grip et de la ligne d\'accueil alignés au pixel (un seul cadre continu)',
      Math.abs(gripShape.gripLeft - gripShape.headLeft) < 0.5 && Math.abs(gripShape.gripRight - gripShape.headRight) < 0.5, JSON.stringify(gripShape));
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

    // (j) Chaîne à trois niveaux : C sous B sous A. RÉVISÉ 2026-08-27
    // (variante B) : la grip ne décale plus sa propre boîte — seul le CORPS
    // d'un sous-lot reste indenté de 28px par cran. La grip de B, posée
    // directement dans le corps de A, tombe donc à 0 ; celle de C, posée dans
    // le corps DE B (déjà décalé de 28), hérite de ce 28 sans qu'un second
    // cran ne s'ajoute. Il n'y a toujours qu'un seul bloc racine — deux grips
    // et deux corps imbriqués (B sous A, C sous B).
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
    check('… la grip de B est pleine largeur (0), celle de C hérite seulement du décalage du CORPS de B (28) — pas de cumul 28+28',
      nestChain.depths.sort((a, b) => a - b).join(',') === '0,28', JSON.stringify(nestChain));

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
          // Le détail tarifaire doit rester ATTEIGNABLE : la boîte du montant
          // est celle que recouvrent les deux overlays hover-only (⌂ et la
          // marque), et le montant s'efface au survol — sans eux, plus aucune
          // surface sous le curseur ne porte ce détail.
          rowTip: r.title,
          mkSetTip: (r.querySelector('.mk-set') || {}).title,
          linkTip: (r.querySelector('.link-master') || {}).title,
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
    // Détail devenu inatteignable à la souris (signalé 2026-08-24) : au survol,
    // le montant passe à opacity 0 et sa boîte est recouverte par ⌂ et la
    // marque — pointer le chiffre affichait l'infobulle du bouton. Les trois
    // surfaces de cette zone portent donc le MÊME détail, d'une seule source.
    const DETAIL = '≈ $7.31 in 23 replies';
    check('le détail tarifaire est atteignable partout sur la ligne (infobulle de la ligne)',
      (cost.r2.rowTip || '').indexOf(DETAIL) >= 0, cost.r2.rowTip);
    check('… les deux boutons, eux, gardent leur libellé NU (variante C : le tarif ne les alourdit pas)',
      (cost.r2.mkSetTip || '').indexOf(DETAIL) < 0 && (cost.r2.linkTip || '').indexOf(DETAIL) < 0
      && (cost.r2.mkSetTip || '').indexOf('Pin ') === 0 && (cost.r2.linkTip || '').indexOf('Link ') === 0,
      `${cost.r2.mkSetTip} | ${cost.r2.linkTip}`);
    check('ligne sans donnée d’usage : aucune infobulle tarifaire, nulle part',
      (cost.r3.rowTip || '').indexOf('≈') < 0 && (cost.r3.mkSetTip || '').indexOf('≈') < 0
      && (cost.r3.linkTip || '').indexOf('≈') < 0,
      JSON.stringify({ row: cost.r3.rowTip, mk: cost.r3.mkSetTip, lm: cost.r3.linkTip }));
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

    console.log('\n24. Bandeau d\'onboarding (lot 2026-08-19) — NON masquable, deux manques séparés, disparaît de lui-même');
    // Moyenne RGB d'une zone captée en écran RÉEL (Page.captureScreenshot),
    // décodée dans la PAGE (createImageBitmap — la CSP interdit img.src data:
    // mais pas une image construite en mémoire), même motif que la preuve par
    // pixels de l'arc busy (§9bis) : ce qui suit prouve un encre PEINTE, pas
    // seulement un getComputedStyle qui pourrait décrire une règle jamais
    // appliquée (spécificité, cascade, media query oubliée…).
    async function avgColorOfRect(rect) {
      if (!rect || rect.width < 1 || rect.height < 1) return null;
      const shot = (await cdp.send('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: false,
        clip: { x: rect.left, y: rect.top, width: rect.width, height: rect.height, scale: 1 },
      })).data;
      await cdp.evaluate(`(() => {
        window.__avgColor = null;
        const bin = atob('` + shot + `');
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        createImageBitmap(new Blob([bytes], { type: 'image/png' })).then(function (img) {
          const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
          const g = cv.getContext('2d'); g.drawImage(img, 0, 0);
          const d = g.getImageData(0, 0, cv.width, cv.height).data;
          let r = 0, gg = 0, b = 0, n = 0;
          for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
          window.__avgColor = { r: r / n, g: gg / n, b: b / n };
        });
      })()`);
      let out = null;
      for (let i = 0; i < 30 && !out; i++) { await sleep(50); out = await cdp.evaluate(`window.__avgColor`); }
      return out;
    }
    function rectOf(sel) {
      return cdp.evaluate(`(() => { const n = document.querySelector('${sel}'); if (!n) return null;
        const r = n.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }; })()`);
    }
    async function bannerProbe() {
      return cdp.evaluate(`(() => {
        const n = document.getElementById('hooksBanner');
        const cs = getComputedStyle(n);
        const txt = document.getElementById('hooksBannerText');
        const btn = document.getElementById('hooksBannerInstall');
        return {
          shown: n.classList.contains('show'),
          display: cs.display,
          text: txt ? txt.textContent : null,
          btnText: btn ? btn.textContent : null,
          buttonCount: n.querySelectorAll('button').length,
          hasXdel: !!n.querySelector('.xdel'),
          hasAnyDismissTitle: Array.from(n.querySelectorAll('*')).some((e) => /dismiss|masquer|fermer/i.test(e.title || '')),
        };
      })()`);
    }

    console.log('       24a. état SANS champ setup (contrat non respecté par cette source) → bandeau masqué, jamais affiché sur une supposition');
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: STATE })}, '*')`);
    await sleep(120);
    let bp = await bannerProbe();
    check('setup absent → bandeau masqué (display:none)', bp.shown === false && bp.display === 'none', JSON.stringify(bp));

    console.log('       24b. hooks ET /handoffs manquants → bandeau visible, nomme ce qui est éteint');
    const bothMissing = Object.assign({}, STATE, { setup: { hooksInstalled: false, handoffsInstalled: false } });
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: bothMissing })}, '*')`);
    await sleep(120);
    bp = await bannerProbe();
    check('bandeau visible', bp.shown === true && bp.display === 'block', JSON.stringify(bp));
    check('le texte nomme ce qui est éteint (icônes/son/coût), pas un vague "something is missing"',
      /icon/i.test(bp.text || '') && /sound/i.test(bp.text || '') && /cost/i.test(bp.text || ''), bp.text);
    check('le bouton "Install hooks" est présent', bp.btnText === 'Install hooks', bp.btnText);
    check('AUCUN mécanisme de fermeture : pas de .xdel, pas de titre "dismiss", UN SEUL bouton (Install)',
      bp.hasXdel === false && bp.hasAnyDismissTitle === false && bp.buttonCount === 1, JSON.stringify(bp));
    check('aucun × littéral dans le bandeau', !/×/.test((bp.text || '') + (bp.btnText || '')));

    console.log('       24c. preuve par les PIXELS : la zone du bandeau est réellement peinte, pas juste "display:block" sans encre');
    const bannerRect = await rectOf('#hooksBanner');
    // Bande de contrôle : même largeur, prise dans #convBody juste AU-DESSUS du
    // bandeau (le fond nu de la sidebar, avant toute peinture de bandeau).
    const aboveRect = bannerRect && { left: bannerRect.left, top: Math.max(0, bannerRect.top - 10), width: bannerRect.width, height: 6 };
    const insideRect = bannerRect && { left: bannerRect.left + 4, top: bannerRect.top + 3, width: Math.max(1, bannerRect.width - 8), height: 4 };
    // Séquentiel, jamais Promise.all : les deux appels décodent leur image via
    // le MÊME global de page (window.__avgColor) — en parallèle, le second
    // écrase `null` par-dessus le résultat du premier avant qu'il soit lu, une
    // course qui donnait deux fois (255,255,255) au premier essai de ce banc.
    const aboveColor = await avgColorOfRect(aboveRect);
    const insideColor = await avgColorOfRect(insideRect);
    const delta = aboveColor && insideColor
      ? Math.abs(aboveColor.r - insideColor.r) + Math.abs(aboveColor.g - insideColor.g) + Math.abs(aboveColor.b - insideColor.b)
      : -1;
    check('la couleur moyenne À L\'INTÉRIEUR du bandeau diffère nettement du fond nu juste au-dessus (delta RVB cumulé > 20)',
      delta > 20, JSON.stringify({ aboveColor, insideColor, delta }));

    console.log('       24d. SEULS les hooks manquent (poste avec une install antérieure à /handoffs, ou fichier supprimé à la main) → message DIFFÉRENT, séparé');
    const onlyHandoffsMissing = Object.assign({}, STATE, { setup: { hooksInstalled: true, handoffsInstalled: false } });
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: onlyHandoffsMissing })}, '*')`);
    await sleep(120);
    bp = await bannerProbe();
    check('bandeau toujours visible (un seul des deux suffit)', bp.shown === true, JSON.stringify(bp));
    check('le texte nomme /handoffs, PAS "icons blank / sounds never play" (message du cas hooks manquants)',
      /handoffs/i.test(bp.text || '') && !/icon/i.test(bp.text || ''), bp.text);

    console.log('       24e. les deux sont installés → le bandeau disparaît DE LUI-MÊME (test principal de la maquette)');
    const bothInstalled = Object.assign({}, STATE, { setup: { hooksInstalled: true, handoffsInstalled: true } });
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: bothInstalled })}, '*')`);
    await sleep(120);
    bp = await bannerProbe();
    check('bandeau remasqué automatiquement, sans action de l\'user', bp.shown === false && bp.display === 'none', JSON.stringify(bp));

    console.log('       24f. clic du bouton → poste installHooksNow (même chemin que la commande Palette)');
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: bothMissing })}, '*')`);
    await sleep(120);
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`document.getElementById('hooksBannerInstall').click()`);
    await sleep(50);
    const sentInstall = await cdp.evaluate(`window.__sent`);
    check('un SEUL message installHooksNow posté, rien d\'autre', Array.isArray(sentInstall) && sentInstall.length === 1 && sentInstall[0].type === 'installHooksNow', JSON.stringify(sentInstall));

    console.log('       24g. non-régression du formulaire « New conversation » après le retrait de l\'astuce CLAUDE.md');
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: STATE })}, '*')`);
    await sleep(120);
    const tipResidue = await cdp.evaluate(`({
      tipRestoreNode: document.getElementById('newConvTipRestore'),
      tipRestoreClass: document.querySelectorAll('.tip-restore').length,
      tipText: document.body.textContent.indexOf('copy an instruction for your CLAUDE.md'),
    })`);
    check('aucune trace DOM de l\'ancienne astuce (#newConvTipRestore, .tip-restore, son texte)',
      tipResidue.tipRestoreNode === null && tipResidue.tipRestoreClass === 0 && tipResidue.tipText === -1, JSON.stringify(tipResidue));
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`document.getElementById('newConvHead').click()`);
    await sleep(50);
    const sentCollapse = await cdp.evaluate(`window.__sent`);
    check('l\'en-tête « New conversation » replie toujours la section (le guard retiré ne l\'a pas cassé)',
      Array.isArray(sentCollapse) && sentCollapse.length === 1 && sentCollapse[0].type === 'toggleCollapse' && sentCollapse[0].section === 'newConversation',
      JSON.stringify(sentCollapse));

    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: STATE })}, '*')`);
    await sleep(120);

    console.log('\n25. Heartbeat de fraîcheur — un panneau privé d\'états le dit et fige ses spinners (incident 2026-08-21)');
    // Page rechargée avec des délais compressés (tick 150 ms, pull 400 ms,
    // gel 900 ms) : ce script d'injection s'exécute APRÈS celui du début de
    // banc (ordre d'ajout), il écrase donc la neutralisation. La mécanique
    // testée est le vrai code du webview, seules les constantes de temps
    // changent.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.QUOTABAR_STALE_TUNING = { tickMs: 150, pullAfterMs: 400, frozenAfterMs: 900 };`,
    });
    await cdp.send('Page.navigate', { url: 'file:///' + file.replace(/\\/g, '/') });
    await sleep(600);
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: STATE })}, '*')`);
    await sleep(120);
    check('état frais : aucune dégradation affichée, spinner en marche',
      await cdp.evaluate(`(() => {
        const ps = getComputedStyle(document.querySelector('.ico-busy'), '::before').animationPlayState;
        return !document.body.classList.contains('data-stale')
          && !document.getElementById('dataStaleNotice').classList.contains('show')
          && ps.indexOf('paused') === -1;
      })()`) === true);
    await cdp.evaluate(`window.__sent = []`);
    // t+700 ms sans état : au-delà de pullAfterMs (400) mais sous frozenAfterMs
    // (900) — le webview re-demande l'état, sans accuser personne à l'écran.
    await sleep(700);
    const pulled = await cdp.evaluate(`(window.__sent || []).filter((m) => m && m.type === 'ready').length`);
    check('silence > pullAfterMs : le webview re-demande l\'état de lui-même (ready ≥ 1)', pulled >= 1, `ready envoyés: ${pulled}`);
    check('mais pas encore de bandeau : le gel ne s\'affiche qu\'après frozenAfterMs',
      await cdp.evaluate(`document.body.classList.contains('data-stale')`) === false);
    // t+1500 ms sans état : les pulls sont restés sans réponse — dégradation
    // VISIBLE, et plus une seule animation ne prétend que « ça travaille ».
    await sleep(800);
    check('silence > frozenAfterMs : bandeau affiché + classe data-stale posée',
      await cdp.evaluate(`document.body.classList.contains('data-stale')
        && document.getElementById('dataStaleNotice').classList.contains('show')`) === true);
    check('toutes les animations sont en pause (le spinner ne ment plus)',
      await cdp.evaluate(`getComputedStyle(document.querySelector('.ico-busy'), '::before').animationPlayState.indexOf('paused')`) !== -1);
    // Un état arrive : preuve fraîche, tout se rétablit immédiatement.
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: STATE })}, '*')`);
    await sleep(120);
    check('un état reçu efface tout : bandeau retiré, spinner relancé',
      await cdp.evaluate(`(() => {
        const ps = getComputedStyle(document.querySelector('.ico-busy'), '::before').animationPlayState;
        return !document.body.classList.contains('data-stale')
          && !document.getElementById('dataStaleNotice').classList.contains('show')
          && ps.indexOf('paused') === -1;
      })()`) === true);

    console.log('\n26. Marque « à relire » (lot 2, plan marque_a_relire 2026-08-22, variante B) — zéro chevauchement marque/geste/⌂/coût, au repos ET au survol, ligne marquée et non marquée');
    // Page rechargée, tuning neutralisé de nouveau (le script §25 gagne sinon
    // sur toute nouvelle navigation, cf. son commentaire) : ce banc part d'un
    // DOM frais, sans résidu d'une ligne c1/c2 déjà passée par un groupe (§19).
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.QUOTABAR_STALE_TUNING = { pullAfterMs: 1e9, frozenAfterMs: 1e9 };`,
    });
    await cdp.send('Page.navigate', { url: 'file:///' + file.replace(/\\/g, '/') });
    await sleep(600);

    const pinState = JSON.parse(JSON.stringify(STATE));
    pinState.conversations[0].pinned = true;
    pinState.conversations[0].cost = { total: 0.42, input: 0.02, cacheRead: 0.16, cacheWrite: 0.06, output: 0.16, tools: 0, messages: 12, lastTurn: 0.1, turns: 3 };
    pinState.conversations[1].pinned = false;
    pinState.conversations[1].cost = { total: 1.1, input: 0.05, cacheRead: 0.4, cacheWrite: 0.15, output: 0.4, tools: 0, messages: 8, lastTurn: 0.6, turns: 5 };
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: pinState })}, '*')`);
    await sleep(150);

    const PIN_PROBE = `(() => {
      const rows = Array.from(document.querySelectorAll('#flow > .conv'));
      const g = (row, sel) => {
        const n = row.querySelector(sel);
        if (!n) return null;
        const cs = getComputedStyle(n);
        const r = n.getBoundingClientRect();
        return { visible: cs.display !== 'none' && parseFloat(cs.opacity) > 0.02,
                 rect: { l: +r.left.toFixed(2), r: +r.right.toFixed(2), t: +r.top.toFixed(2), b: +r.bottom.toFixed(2) } };
      };
      const at = (i) => {
        const row = rows[i]; if (!row) return null;
        const ctxBar = row.querySelector('.bar-ctx');
        return {
          pinned: row.classList.contains('mk-pinned'),
          titleLeft: +row.querySelector('.title').getBoundingClientRect().left.toFixed(2),
          ctxBarLeft: ctxBar ? +ctxBar.getBoundingClientRect().left.toFixed(2) : null,
          mkPin: g(row, '.mk-pin'), mkSet: g(row, '.mk-set'), linkMaster: g(row, '.link-master'), cost: g(row, '.cost'),
          rowRect: (() => { const r = row.getBoundingClientRect();
            return { l: +r.left.toFixed(2), t: +r.top.toFixed(2), r: +r.right.toFixed(2), b: +r.bottom.toFixed(2) }; })(),
        };
      };
      return { r0: at(0), r1: at(1) };
    })()`;

    // Rectangles qui se touchent au pixel près (bord commun) ne comptent pas
    // comme un chevauchement — seule une aire de recouvrement réelle compte.
    function overlaps(a, b) {
      const eps = 0.5;
      return a.rect.l < b.rect.r - eps && b.rect.l < a.rect.r - eps
        && a.rect.t < b.rect.b - eps && b.rect.t < a.rect.b - eps;
    }
    function checkNoOverlap(label, probe, expectedVisible) {
      const items = Object.entries(probe).filter(([k, v]) => ['mkPin', 'mkSet', 'linkMaster', 'cost'].includes(k) && v && v.visible);
      const names = items.map(([n]) => n).sort();
      check(`${label} : exactement les gestes attendus sont visibles (${expectedVisible.join(', ')})`,
        names.length === expectedVisible.length && expectedVisible.every((n) => names.includes(n)),
        `visibles: ${names.join(', ') || '(aucun)'}`);
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const [na, a] = items[i], [nb, b] = items[j];
          check(`${label} : ${na} et ${nb} ne se chevauchent pas`, !overlaps(a, b),
            JSON.stringify({ [na]: a.rect, [nb]: b.rect }));
        }
      }
    }

    console.log('       26a. au repos (souris hors de toute ligne) : la marque posée (si marquée) et le coût sont visibles, la pose et le ⌂ restent invisibles');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2, buttons: 0 });
    await sleep(150);
    const rest = await cdp.evaluate(PIN_PROBE);
    check('ligne 0 (marquée) : classe .mk-pinned posée', rest.r0.pinned === true);
    check('ligne 1 (non marquée) : classe .mk-pinned absente', rest.r1.pinned === false);
    checkNoOverlap('repos · marquée', rest.r0, ['mkPin', 'cost']);
    checkNoOverlap('repos · non marquée', rest.r1, ['cost']);
    check('le titre de la ligne marquée est décalé par la marque (décision 2, ~15px assumés, jamais réservés sur les autres lignes)',
      rest.r0.titleLeft - rest.r1.titleLeft > 8 && rest.r0.titleLeft - rest.r1.titleLeft < 30,
      `titleLeft r0=${rest.r0.titleLeft} r1=${rest.r1.titleLeft}`);
    check('la barre de contexte des deux lignes démarre au MÊME x (la marque ne rogne rien hors du title-row, invariant §16)',
      Math.abs(rest.r0.ctxBarLeft - rest.r1.ctxBarLeft) < 0.5, `${rest.r0.ctxBarLeft} vs ${rest.r1.ctxBarLeft}`);

    console.log('       26b. au survol de la ligne MARQUÉE : la pose et le ⌂ apparaissent, le coût cède la place, la marque posée reste');
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: (rest.r0.rowRect.l + rest.r0.rowRect.r) / 2, y: (rest.r0.rowRect.t + rest.r0.rowRect.b) / 2, buttons: 0,
    });
    await sleep(180);
    const hoverPinned = await cdp.evaluate(PIN_PROBE);
    checkNoOverlap('survol · marquée', hoverPinned.r0, ['linkMaster', 'mkPin', 'mkSet']);

    console.log('       26c. au survol de la ligne NON marquée : la pose et le ⌂ apparaissent, le coût cède la place, aucune marque posée');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2, buttons: 0 });
    await sleep(120);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: (rest.r1.rowRect.l + rest.r1.rowRect.r) / 2, y: (rest.r1.rowRect.t + rest.r1.rowRect.b) / 2, buttons: 0,
    });
    await sleep(180);
    const hoverUnpinned = await cdp.evaluate(PIN_PROBE);
    checkNoOverlap('survol · non marquée', hoverUnpinned.r1, ['linkMaster', 'mkSet']);

    console.log('       26d. le clic pose/retire — un seul message togglePinConv, avec le bon id, jamais autre chose');
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`document.querySelectorAll('#flow > .conv')[1].querySelector('.mk-set').click()`);
    await sleep(50);
    const sentSet = await cdp.evaluate(`window.__sent`);
    check('clic sur la pose (.mk-set) de la ligne non marquée → togglePinConv id=c2',
      Array.isArray(sentSet) && sentSet.length === 1 && sentSet[0].type === 'togglePinConv' && sentSet[0].id === 'c2',
      JSON.stringify(sentSet));
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`document.querySelectorAll('#flow > .conv')[0].querySelector('.mk-pin').click()`);
    await sleep(50);
    const sentPin = await cdp.evaluate(`window.__sent`);
    check('clic sur la marque posée (.mk-pin) de la ligne marquée → togglePinConv id=c1, jamais focusConv',
      Array.isArray(sentPin) && sentPin.length === 1 && sentPin[0].type === 'togglePinConv' && sentPin[0].id === 'c1',
      JSON.stringify(sentPin));

    console.log('\n27. Ligne sans onglet : barree si terminee, et son clic ne peut JAMAIS ouvrir');
    // Ce que ce banc verrouille : la ligne que seule la marque retient dit à
    // l'écran ce que le clic fera. Un titre non barré + un clic qui cherche un
    // onglet inexistant, c'était le no-op silencieux d'avant ce lot.
    const goneState = JSON.parse(JSON.stringify(STATE));
    goneState.conversations = [
      // c1 : marquée, onglet PROUVÉ fermé (tabGone), état terminé.
      { id: 'c1', title: 'Marquee onglet ferme', model: 'Opus 4.8', ctx: { pct: 34 }, state: 'done', acked: true, active: false, pinned: true, tabOpen: false, tabGone: true },
      // c2 : ligne ordinaire, onglet ouvert — témoin de non-régression du clic.
      { id: 'c2', title: 'Ligne ordinaire', model: 'Sonnet 5', ctx: { pct: 20 }, state: 'done', acked: true, active: false, tabOpen: true },
      // c3 : marquée, INTERROMPUE, onglet fermé — l'ancien barré ne visait que
      // les convs `done` : le fait « son onglet n'est plus là » ne dépend pas
      // de l'état.
      { id: 'c3', title: 'Marquee interrompue fermee', model: 'Haiku 4.5', ctx: { pct: 8 }, state: 'interrupted', acked: true, active: false, pinned: true, tabOpen: false, tabGone: true },
    ];
    goneState.groups = [];
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: goneState })}, '*')`);
    await sleep(180);
    const goneProbe = await cdp.evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('#flow > .conv'));
      return rows.map((r) => ({
        title: r.querySelector('.title').textContent,
        closed: r.querySelector('.title').classList.contains('closed'),
        pinned: r.classList.contains('mk-pinned'),
        tip: r.title,
      }));
    })()`);
    check('les trois lignes sont rendues (aucune n\'est perdue)', goneProbe.length === 3, JSON.stringify(goneProbe.map((r) => r.title)));
    check('la ligne marquée · onglet fermé est BARRÉE', goneProbe[0].closed === true && goneProbe[0].pinned === true, JSON.stringify(goneProbe[0]));
    check('la ligne ordinaire (onglet ouvert, terminée) n\'est PAS barrée', goneProbe[1].closed === false, JSON.stringify(goneProbe[1]));
    check('une ligne INTERROMPUE sans onglet n est plus barree (le barre ne vise que les terminees)',
      goneProbe[2].closed === false, JSON.stringify(goneProbe[2]));
    check('aucune infobulle ne promet plus une reouverture (le panneau n ouvre plus rien)',
      !/reopen|rouvrir/i.test(goneProbe[0].tip), goneProbe[0].tip);

    console.log('       27a. le clic : rouvrir sur une ligne fermée, focus sur une ligne ordinaire');
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`document.querySelectorAll('#flow > .conv')[0].click()`);
    await sleep(50);
    const sentReopen = await cdp.evaluate(`window.__sent`);
    check('clic sur une ligne sans onglet -> focusConv, JAMAIS une demande d ouverture',
      Array.isArray(sentReopen) && sentReopen.length === 1 && sentReopen[0].type === 'focusConv',
      JSON.stringify(sentReopen));
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`document.querySelectorAll('#flow > .conv')[1].click()`);
    await sleep(50);
    const sentFocus = await cdp.evaluate(`window.__sent`);
    check('clic sur la ligne ordinaire → focusConv (non-régression)',
      Array.isArray(sentFocus) && sentFocus.length === 1 && sentFocus[0].type === 'focusConv' && sentFocus[0].id === 'c2',
      JSON.stringify(sentFocus));

    console.log('       27b. membre de lot terminé · onglet fermé et MARQUÉ : sa vague le retire, la liste plate le récupère — jamais les deux vues à la fois');
    const orphan = JSON.parse(JSON.stringify(goneState));
    orphan.conversations = [
      { id: 'c1', title: 'Membre fini ferme marque', model: 'Opus 4.8', ctx: { pct: 34 }, state: 'done', acked: true, active: false, pinned: true, tabOpen: false, tabGone: true, groupId: 'g1' },
      { id: 'c2', title: 'Membre encore ouvert', model: 'Sonnet 5', ctx: { pct: 20 }, state: 'busy', acked: true, active: false, tabOpen: true, groupId: 'g1' },
    ];
    orphan.groups = [{
      id: 'g1', name: 'Lot en cours', hue: 210, collapsed: false,
      launchedWave: 1, nextWave: 2, waveNotice: null, done: false,
      members: [
        // done-closed : renderGroups le retire de sa vague (filtre existant).
        { key: 'm1', prompt: 'Membre fini ferme marque', wave: 1, asked: { model: 'opus', effort: 'high' }, convId: 'c1', status: 'done-closed', waveStatus: 'done', canLink: false, canClose: false, canRelaunch: false, note: '✓ done · closed', hint: '' },
        { key: 'm2', prompt: 'Membre encore ouvert', wave: 1, asked: { model: 'sonnet', effort: 'medium' }, convId: 'c2', status: 'busy', waveStatus: 'launched', canLink: false, canClose: false, canRelaunch: false, note: '', hint: '' },
      ],
    }];
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: orphan })}, '*')`);
    await sleep(200);
    const orphanProbe = await cdp.evaluate(`(() => {
      const nodes = Array.from(document.querySelectorAll('#flow .conv'));
      const find = (id) => nodes.filter((n) => n.querySelector('.title') && n.querySelector('.title').textContent.indexOf(id) === 0);
      return {
        marked: find('Membre fini ferme marque').length,
        markedInGroup: find('Membre fini ferme marque').filter((n) => !!n.closest('.grp')).length,
        markedFlat: find('Membre fini ferme marque').filter((n) => !n.closest('.grp')).length,
        open: find('Membre encore ouvert').length,
        openInGroup: find('Membre encore ouvert').filter((n) => !!n.closest('.grp')).length,
      };
    })()`);
    check('le membre marqué, terminé et fermé est rendu UNE fois — et une seule (invariant : un nœud, un endroit)',
      orphanProbe.marked === 1, JSON.stringify(orphanProbe));
    check('…dans la LISTE PLATE, puisque sa vague ne le rend plus (sinon il disparaissait des deux vues)',
      orphanProbe.markedFlat === 1 && orphanProbe.markedInGroup === 0, JSON.stringify(orphanProbe));
    check('le membre encore ouvert, lui, reste DANS son lot (aucun effet de bord)',
      orphanProbe.open === 1 && orphanProbe.openInGroup === 1, JSON.stringify(orphanProbe));

    console.log('\n28. Lot solo (1 membre, sans maîtresse) — grip RÉDUITE, jamais la ligne (2026-09-02, régression 9554162b)');
    // L'invariant du CLAUDE.md de ce dossier : après un « Create », la tâche
    // lancée a TOUJOURS une surface à l'écran. Un jour, shouldCreateGroup
    // (extension.js) a refusé de fonder le lot d'une tâche solo pour un
    // simple nom de groupe — avant le premier Entrée le transcript n'existe
    // pas encore (la liste plate exige transcript + onglet), donc RIEN
    // n'apparaissait. Revenu sur ce refus (extension.js, test-batch-notice.js
    // §16) ; ce banc-ci prouve l'autre moitié, côté rendu : la grip peut
    // perdre son chrome (chevron, interrupteur, compteur, ⌂) sur un lot à un
    // seul membre sans maîtresse, mais jamais la LIGNE de la tâche elle-même.
    const soloState = JSON.parse(JSON.stringify(STATE));
    soloState.conversations = [];
    soloState.groups = [{
      id: 'g-solo', name: 'Refonte paiement', hue: 150, collapsed: false, stamp: '20:19',
      launchedWave: 1, nextWave: null, waveNotice: null, done: false,
      nestedUnder: null, master: null,
      members: [
        { key: 'a', prompt: 'Tâche solo tout juste créée', wave: 1, asked: { model: 'opus', effort: 'high' }, convId: 's-solo', status: 'inserted', waveStatus: 'launched', canLink: false, canClose: false, note: 'press Enter in the tab', hint: 'Tab open with the prompt inserted — press Enter to start it.' },
      ],
    }];
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: soloState })}, '*')`);
    await sleep(150);
    const soloGrip = await cdp.evaluate(`(() => {
      const grp = document.querySelector('#flow .grp');
      const head = grp && grp.querySelector('.grp-head');
      const disp = (sel) => { const n = head && head.querySelector(sel); return n ? getComputedStyle(n).display : 'ABSENT'; };
      const pending = grp && grp.querySelector('.m-pending');
      return {
        blocks: document.querySelectorAll('#flow .grp').length,
        pendingPrompt: pending ? pending.querySelector('.m-prompt').textContent : null,
        chevDisp: disp('.chevron'),
        tgDisp: disp('.tg'),
        countDisp: disp('.grp-count'),
        masDisp: disp('.gbtn:not(.g-kill)'),
        labelText: head ? head.querySelector('.grp-label').textContent : null,
        killDisp: disp('.g-kill'),
      };
    })()`);
    check('la tâche solo a TOUJOURS une surface à l\'écran : sa ligne « en attente » avec son prompt',
      soloGrip.blocks === 1 && soloGrip.pendingPrompt === 'Tâche solo tout juste créée', JSON.stringify(soloGrip));
    check('… mais la grip a perdu chevron, interrupteur manuel/auto, compteur et ⌂ (chrome sans raison sur 1 membre sans maîtresse)',
      soloGrip.chevDisp === 'none' && soloGrip.tgDisp === 'none' && soloGrip.countDisp === 'none' && soloGrip.masDisp === 'none',
      JSON.stringify(soloGrip));
    check('… il ne reste que l\'identité du lot (label visible) et le ✕ de dissolution (présent, pas display:none)',
      soloGrip.labelText === 'batch ' + soloState.groups[0].stamp && soloGrip.killDisp !== 'none', JSON.stringify(soloGrip));

    console.log('       28a. le clic sur la grip solo ne replie rien (pas de chevron à faire mentir)');
    await cdp.evaluate(`window.__sent = []`);
    await cdp.evaluate(`document.querySelector('#flow .grp .grp-head').click()`);
    await sleep(50);
    const soloClick = await cdp.evaluate(`window.__sent`);
    check('aucun toggleGroupCollapse posté', Array.isArray(soloClick) && soloClick.length === 0, JSON.stringify(soloClick));

    console.log('       28b. dès qu\'une maîtresse se résout, la grip retrouve tout son chrome (la réduction ne vaut QUE le cas solo sans maîtresse)');
    const soloMastered = JSON.parse(JSON.stringify(soloState));
    soloMastered.groups[0].master = { convId: 'm1', title: 'Conv de cadrage', listed: false, status: 'busy' };
    await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: soloMastered })}, '*')`);
    await sleep(150);
    const mastered = await cdp.evaluate(`(() => {
      const head = document.querySelector('#flow .grp .grp-head');
      const disp = (sel) => { const n = head.querySelector(sel); return n ? getComputedStyle(n).display : 'ABSENT'; };
      return { chevDisp: disp('.chevron'), tgDisp: disp('.tg'), countDisp: disp('.grp-count') };
    })()`);
    check('1 membre + maîtresse → chevron/interrupteur/compteur redeviennent visibles',
      mastered.chevDisp !== 'none' && mastered.tgDisp !== 'none' && mastered.countDisp !== 'none', JSON.stringify(mastered));

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
