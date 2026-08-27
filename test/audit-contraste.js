// Audit de contraste de la LIGNE SÉLECTIONNÉE du panneau QuotaSaver.
//
// Rend le vrai panneau (panel.js) dans Brave offscreen, met la ligne active
// dans chaque état qu'elle peut prendre, et calcule pour chaque élément le
// ratio de contraste WCAG contre le fond RÉEL de la ligne — couleurs
// semi-transparentes composées, pseudo-éléments compris. Les couleurs de thème
// viennent de palettes.json (fichiers de thème du VS Code installé), jamais de
// mémoire.
//
//   node audit-contraste.js            → les deux thèmes, seuils par défaut
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Module = require('module');
const { spawn, execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const WebSocket = require(path.join(ROOT, 'node_modules', 'ws'));
const { palettes } = require(path.join(__dirname, 'theme-palette.js'));

const stub = { window: {}, Uri: { parse: (s) => s },
  l10n: { bundle: {}, t: (m, ...a) => (a.length ? m.replace(/\{(\d+)\}/g, (_, i) => (a[i] !== undefined ? a[i] : '')) : m) } };
const orig = Module._load;
Module._load = function (r, ...x) { if (r === 'vscode') return stub; return orig.call(this, r, ...x); };
const { ClaudePanelProvider } = require(path.join(ROOT, 'panel.js'));

let html = null;
new ClaudePanelProvider({}, {}).resolveWebviewView({
  webview: { options: {}, cspSource: 'vscode-resource:', set html(v) { html = v; }, get html() { return html; },
    postMessage: () => {}, onDidReceiveMessage: () => ({ dispose() {} }) },
  onDidDispose: () => ({ dispose() {} }),
});
html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/i, '');

const PAL = palettes(fs.readFileSync(path.join(ROOT, 'panel.js'), 'utf8'));
const FONTS = { '--vscode-font-family': "'Segoe UI',sans-serif", '--vscode-font-size': '13px',
  '--vscode-editor-font-family': 'Consolas,monospace' };

const cost = (t) => ({ total: t, input: t * .06, cacheRead: t * .4, cacheWrite: t * .15, output: t * .39, tools: 0, messages: 12 });
const ctx = (p) => ({ pct: p, tokens: p * 2000, denom: 200000 });

// Un cas = un état possible de la LIGNE active. `extra` fusionne dans la conv.
const CASES = [
  { name: 'en cours · ctx vert', extra: { state: 'busy', acked: true, ctx: ctx(22), cost: cost(0.4) } },
  { name: 'en attente · ctx jaune', extra: { state: 'waiting', acked: true, ctx: ctx(45), cost: cost(2.2) } },
  { name: 'terminée non lue · ctx rouge', extra: { state: 'done', acked: false, ctx: ctx(78), cost: cost(9.5) } },
  { name: 'terminée lue (idle) · ctx rouge', extra: { state: 'done', acked: true, ctx: ctx(78), cost: cost(9.5) } },
  { name: 'interrompue', extra: { state: 'interrupted', acked: true, ctx: ctx(60), cost: cost(1.1) } },
  { name: 'onglet fermé (titre barré)', extra: { state: 'done', acked: true, tabOpen: false, ctx: ctx(33), cost: cost(0.2) } },
  { name: 'épinglée à relire', extra: { state: 'done', acked: true, pinned: true, ctx: ctx(15), cost: cost(0.3) } },
];

const BASE_CONV = { id: 'x1', title: 'Conversation sélectionnée de démonstration', model: 'Opus 4.8',
  effort: 'high', ctx: ctx(40), cost: cost(1), state: 'busy', acked: true, active: true, tabOpen: true };
const OTHERS = [
  { id: 'o1', title: 'Autre conversation', model: 'Sonnet 5', effort: 'medium', ctx: ctx(20), cost: cost(0.5), state: 'done', acked: true, active: false, tabOpen: true },
];
// Le cas « membre de lot » a ses propres décors (rail, anneau, avertissement de
// modèle demandé ≠ modèle réel) : il est joué à part, avec un groupe.
const GROUP = [{ id: 'g1', name: 'Lot de démonstration', stamp: '14:12', hue: 262, collapsed: false,
  launchedWave: 1, nextWave: 2, waveNotice: null,
  master: { convId: 'm1', title: 'Tête de lot', tabTitle: null, listed: true, status: 'done', hint: '' },
  members: [{ key: 'w1', prompt: 'Tâche du lot', wave: 1, asked: { model: 'sonnet', effort: 'medium' },
    convId: 'x1', status: 'busy', waveStatus: 'launched', canLink: false, canClose: false, canRelaunch: false, note: '', hint: '' }] }];
const MASTER_CONV = { id: 'm1', title: 'Tête de lot', model: 'Opus 4.8', effort: 'high', ctx: ctx(52),
  cost: cost(1.6), state: 'done', acked: true, active: false, tabOpen: true };

// Bloc claude-convs joué tel quel dans le champ prompt pour mettre la ligne
// dans son état « maîtresse désignée au collage » (plan agrafe 2026-08-27) —
// la classe .master-target n'est JAMAIS posée à la main ici : elle doit venir
// du vrai applyBlockPaste + de la vraie réponse masterResolved, sinon l'audit
// mesurerait un état que le panneau ne produit pas.
const MASTER_BLOCK = [
  '```claude-convs',
  'group: Audit',
  'model: sonnet',
  'effort: medium',
  'stage: 1',
  'Premiere tache de mesure, assez longue pour depasser le seuil de recherche.',
  '[---]',
  'model: opus',
  'effort: high',
  'stage: 2',
  'Seconde tache de mesure, elle aussi assez longue pour la meme raison.',
  '```',
].join('\n');

const state = (conv, withGroup) => ({
  conversations: withGroup ? [MASTER_CONV, Object.assign({}, conv, { groupId: 'g1' })] : [conv, ...OTHERS],
  groups: withGroup ? GROUP : [],
  quota: { windows: [], burnRate: { greenMax: .85, yellowMax: 1 }, ageMin: 1, source: 'oauth' },
  sounds: { enabled: false }, canary: false,
  ui: { collapsedConversations: false, collapsedQuota: true, sortOrder: 'tabOrder' },
  batch: { envConflict: [], busy: false, notice: null, noticeHint: null, inherit: { model: 'sonnet', effort: 'medium' }, lastModel: null, lastEffort: null },
});

// ── plomberie CDP ──────────────────────────────────────────────────────────
const PORT = 9223;
// Profil de navigateur dédié : réutilisé s'il existe déjà (un onglet de plus),
// sinon créé au chaud dans le dossier temporaire — jamais le profil de l'utilisateur.
const USER_DATA = process.env.QUOTASAVER_BROWSER_PROFILE || path.join(os.tmpdir(), 'quotasaver-audit-profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url, timeout = 2000) => new Promise((res, rej) => {
  const r = http.get(url, { timeout }, (x) => { let b = ''; x.on('data', (c) => b += c); x.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); });
  r.on('error', rej); r.on('timeout', () => { r.destroy(); rej(new Error('timeout')); });
});
const httpPut = (url) => new Promise((res, rej) => {
  const r = http.request(url, { method: 'PUT' }, (x) => { let b = ''; x.on('data', (c) => b += c); x.on('end', () => { try { res(JSON.parse(b)); } catch { res(b); } }); });
  r.on('error', rej); r.end();
});
class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.url, { perMessageDeflate: false });
    await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('cdp timeout')), 5000); this.ws.on('open', () => { clearTimeout(t); res(); }); this.ws.on('error', rej); });
    this.ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } });
  }
  send(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async evaluate(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception && r.exceptionDetails.exception.description); return r.result.value; }
  close() { try { this.ws.close(); } catch {} }
}

// Mesure exécutée DANS la page : contraste WCAG de chaque élément de la ligne
// active contre le fond réel de la ligne (transparences composées).
const PROBE = `(() => {
  // Cible par défaut la ligne SÉLECTIONNÉE ; window.__auditSel la déplace sur
  // une autre ligne (ex. la maîtresse désignée au collage, qui n'est pas
  // forcément celle qu'on regarde).
  const row = document.querySelector(window.__auditSel || '.conv.active');
  if (!row) return { error: 'pas de ligne a mesurer (' + (window.__auditSel || '.conv.active') + ')' };
  // Passer par un canvas, PAS par une regex sur rgb() : getComputedStyle rend
  // les color-mix() en color(srgb ...) -- c'est-a-dire, ici, exactement les
  // couleurs de la ligne selectionnee. Une regex rgb() les rendait invisibles
  // a la sonde, qui declarait donc "rien a signaler" sur les elements memes
  // qu'on cherchait a mesurer.
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const parse = (c) => {
    const v = String(c || '').trim();
    if (!v || v === 'none' || v === 'transparent' || v === 'rgba(0, 0, 0, 0)') return null;
    cx.clearRect(0, 0, 1, 1);
    cx.fillStyle = 'rgba(0,0,0,0)';
    cx.fillStyle = v;
    cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    if (d[3] === 0) return null;
    return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
  };
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); const hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); };
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

  // FOND RÉEL de la ligne, et non sa seule backgroundColor. Deux cas que la
  // lecture naïve ratait :
  //  - une ligne NON sélectionnée ne peint rien : son fond est celui du
  //    panneau, qu'il faut aller chercher chez ses ancêtres (la version
  //    précédente rendait null et plantait) ;
  //  - une ligne maîtresse peint sa teinte en CALQUE (background-image), que
  //    backgroundColor ne voit pas — on la relit sur la custom property
  //    animée, qui est la couleur exactement peinte à cette image.
  const bgOf = (el) => {
    let n = el, acc = null;
    while (n) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c) { acc = acc ? over(acc, c) : c; if (c.a >= 0.999) return acc; }
      n = n.parentElement;
    }
    return acc || { r: 255, g: 255, b: 255, a: 1 };
  };
  const rowTint = row.classList.contains('master-target')
    ? parse(getComputedStyle(row).getPropertyValue('--master-cue-bg')) : null;
  const rowBg = rowTint ? over(rowTint, bgOf(row)) : bgOf(row);
  const out = [];
  const label = (el) => {
    const cls = (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) || '';
    return el.tagName.toLowerCase() + (cls ? '.' + String(cls).trim().split(/\\s+/).join('.') : '');
  };
  const visible = (el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0.02 && r.width > 0 && r.height > 0; };

  const walk = (el) => {
    if (!visible(el)) { const s0 = getComputedStyle(el), r0 = el.getBoundingClientRect();
      out.push({ kind: 'ignoré', el: label(el), why: s0.display + '/' + s0.visibility + '/op' + s0.opacity + '/' + Math.round(r0.width) + 'x' + Math.round(r0.height), color: '', ratio: 99 }); return; }
    const s = getComputedStyle(el);
    const ownText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
    const op = parseFloat(s.opacity) || 1;
    // texte propre à cet élément
    if (ownText) {
      let c = parse(s.color);
      if (c) { c = Object.assign({}, c, { a: c.a * op }); out.push({ kind: 'texte', el: label(el),
        text: el.textContent.trim().slice(0, 24), color: hex(over(c, rowBg)), ratio: +ratio(over(c, rowBg), rowBg).toFixed(2) }); }
    }
    // fond propre (barres, pastilles) et remplissage SVG
    const bg = parse(s.backgroundColor);
    if (bg && bg.a > 0.03 && el !== row) {
      const c = Object.assign({}, bg, { a: bg.a * op });
      out.push({ kind: 'fond', el: label(el), color: hex(over(c, rowBg)), ratio: +ratio(over(c, rowBg), rowBg).toFixed(2) });
    }
    if (['path', 'circle', 'rect', 'polygon'].includes(el.tagName.toLowerCase())) {
      const f = parse(s.fill);
      if (f && f.a > 0.03 && String(s.fill) !== 'none') {
        const c = Object.assign({}, f, { a: f.a * op });
        out.push({ kind: 'svg', el: label(el), color: hex(over(c, rowBg)), ratio: +ratio(over(c, rowBg), rowBg).toFixed(2) });
      }
      const st = parse(s.stroke);
      if (st && st.a > 0.03 && String(s.stroke) !== 'none') {
        const c = Object.assign({}, st, { a: st.a * op });
        out.push({ kind: 'trait', el: label(el), color: hex(over(c, rowBg)), ratio: +ratio(over(c, rowBg), rowBg).toFixed(2) });
      }
    }
    for (const pseudo of ['::before', '::after']) {
      const ps = getComputedStyle(el, pseudo);
      if (!ps || ps.content === 'none') continue;
      const pbg = parse(ps.backgroundColor);
      if (pbg && pbg.a > 0.03) out.push({ kind: 'fond', el: label(el) + pseudo, color: hex(over(pbg, rowBg)), ratio: +ratio(over(pbg, rowBg), rowBg).toFixed(2) });
      const pbc = parse(ps.borderTopColor);
      if (pbc && pbc.a > 0.03 && parseFloat(ps.borderTopWidth) > 0) out.push({ kind: 'anneau', el: label(el) + pseudo, color: hex(over(pbc, rowBg)), ratio: +ratio(over(pbc, rowBg), rowBg).toFixed(2) });
      if (ps.content && ps.content !== 'none' && ps.content !== '""' && ps.content !== 'normal') {
        const pc = parse(ps.color);
        if (pc) out.push({ kind: 'texte', el: label(el) + pseudo, text: ps.content.slice(0, 16), color: hex(over(pc, rowBg)), ratio: +ratio(over(pc, rowBg), rowBg).toFixed(2) });
      }
    }
    for (const ch of el.children) walk(ch);
  };
  walk(row);
  return { rowBg: hex(rowBg), items: out, html: row.outerHTML.slice(0, 1800) };
})()`;

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-audit-'));
  const file = path.join(dir, 'panel.html');
  fs.writeFileSync(file, html, 'utf8');
  const fileUrl = 'file:///' + file.replace(/\\/g, '/');

  let child = null, alive = null;
  try { alive = await getJson(`http://127.0.0.1:${PORT}/json/version`, 800); } catch {}
  if (!alive) {
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) { try { fs.unlinkSync(path.join(USER_DATA, f)); } catch {} }
    const exe = [process.env.BRAVE_EXE,
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    ].filter(Boolean).find((p) => { try { return fs.existsSync(p); } catch { return false; } });
    if (!exe) throw new Error('navigateur introuvable (poser BRAVE_EXE)');
    child = spawn(exe,
      [`--remote-debugging-port=${PORT}`, `--user-data-dir=${USER_DATA}`, '--profile-directory=Default',
        '--no-first-run', '--no-default-browser-check', '--window-position=-32000,-32000', '--window-size=440,1200', 'about:blank'],
      { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    let v = null; for (let i = 0; i < 40 && !v; i++) { try { v = await getJson(`http://127.0.0.1:${PORT}/json/version`); } catch { await sleep(250); } }
    if (!v) throw new Error('Brave absent');
  }
  let cdp = null, tabId = null;
  const report = {};
  try {
    let page;
    if (child) { const t = await getJson(`http://127.0.0.1:${PORT}/json/list`); page = t.find((x) => x.type === 'page'); }
    else { page = await httpPut(`http://127.0.0.1:${PORT}/json/new?about:blank`); tabId = page.id; }
    cdp = new Cdp(page.webSocketDebuggerUrl); await cdp.connect();
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 1200, deviceScaleFactor: 1, mobile: false });
    // Le stub GARDE les messages sortants : c'est ainsi qu'on relit le numéro
    // de collage réellement émis par le webview pour lui répondre, au lieu de
    // l'inventer (la réponse est datée du collage, cf. panel.js).
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__sent = []; window.acquireVsCodeApi = () => ({ postMessage(m){ window.__sent.push(m); }, getState(){}, setState(){} });' });
    await cdp.send('Page.navigate', { url: fileUrl });
    await sleep(700);

    for (const theme of ['light', 'dark']) {
      const vars = Object.assign({}, FONTS, PAL[theme]);
      const set = Object.entries(vars).map(([k, v]) => `document.documentElement.style.setProperty('${k}',${JSON.stringify(v)})`).join(';');
      await cdp.evaluate(`(() => { ${set}; document.body.style.margin='0'; })()`);
      report[theme] = [];
      for (const c of CASES) {
        for (const inGroup of [false, true]) {
          // asMaster : la MÊME ligne, une fois ordinaire, une fois désignée
          // conversation maîtresse par un collage — c'est-à-dire avec le fond
          // teinté de la respiration. Le fond change, donc TOUT ce que la
          // ligne porte doit être remesuré dessus (règle du dossier : « tout
          // fond saturé posé sous des éléments existants »).
          for (const asMaster of [false, true]) {
            const conv = Object.assign({}, BASE_CONV, c.extra);
            await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: state(conv, inGroup) })}, '*')`);
            await sleep(180);
            const armed = await cdp.evaluate(`(() => {
              const ta = document.querySelector('#batchForm .task-top textarea.inp');
              if (!ta) return 'pas de champ prompt';
              window.__sent.length = 0;
              ta.value = ${JSON.stringify(asMaster ? MASTER_BLOCK : '')};
              ta.dispatchEvent(new Event('change', { bubbles: true }));
              if (!${asMaster}) return 'off';
              const ask = window.__sent.filter((m) => m && m.type === 'resolveMasterPaste').pop();
              if (!ask) return 'aucune recherche demandee';
              window.postMessage({ type: 'masterResolved', seq: ask.seq, sessionId: ${JSON.stringify(BASE_CONV.id)},
                title: ${JSON.stringify(BASE_CONV.title)}, matches: 1, reason: 'single-match', via: 'search' }, '*');
              return 'on';
            })()`);
            if (asMaster && armed !== 'on') { console.error('  ' + theme + ' / ' + c.name + ' → ' + armed); continue; }
            await sleep(140);
            if (asMaster) {
              // AU PIC de la respiration, et mesuré sur l'animation RÉELLE :
              // on la met en pause à mi-cycle plutôt que d'espérer tomber au
              // bon moment. 600ms = la moitié de --master-cue-period (1,2s).
              const frozen = await cdp.evaluate(`(() => {
                const row = document.querySelector('.conv.master-target');
                if (!row) return 'aucune ligne maitresse';
                const anims = document.getAnimations().filter((a) => a.animationName === 'master-breathe');
                if (!anims.length) return 'aucune animation master-breathe';
                anims.forEach((a) => { a.pause(); a.currentTime = 600; });
                return 'ok';
              })()`);
              if (frozen !== 'ok') { console.error('  ' + theme + ' / ' + c.name + ' → ' + frozen); continue; }
              await sleep(60);
            }
            const r = await cdp.evaluate(PROBE);
            if (r && r.error) { console.error('  ' + theme + ' / ' + c.name + ' → ' + r.error); continue; }
            report[theme].push({
              cas: c.name + (inGroup ? ' (membre de lot)' : '') + (asMaster ? ' [maitresse au pic]' : ''),
              rowBg: r.rowBg, items: r.items, html: r.html,
            });
          }
        }
      }

      // La maîtresse NON SÉLECTIONNÉE — le cas de loin le plus fréquent, et
      // celui que le cadrage a chiffré (titre sur le fond au pic). Mesuré à
      // part parce que la boucle ci-dessus sonde toujours la ligne
      // sélectionnée : ici c'est une AUTRE ligne qui porte la teinte, sur le
      // fond du panneau et non sur celui de la sélection.
      // TÉMOIN OBLIGATOIRE : la même ligne SANS la teinte. Une ligne non
      // sélectionnée n'avait jamais été sondée jusqu'ici, et plusieurs de ses
      // couleurs sont sous le seuil PAR DESIGN sur le fond du panneau (la
      // piste des barres à 12% du texte, le ✓ d'une conversation terminée et
      // lue à 25% d'alpha). Sans témoin, on attribuerait ces écarts à la
      // teinte qu'on vient de poser — le suffixe « [temoin sans teinte] »
      // rend la comparaison lisible dans le rapport JSON.
      for (const inGroup of [false, true]) {
        const targetId = inGroup ? MASTER_CONV.id : OTHERS[0].id;
        const sel = '#flow .conv';
        for (const tinted of [false, true]) {
          await cdp.evaluate(`window.postMessage(${JSON.stringify({ type: 'state', state: state(Object.assign({}, BASE_CONV), inGroup) })}, '*')`);
          await sleep(180);
          const armed = await cdp.evaluate(`(() => {
            const ta = document.querySelector('#batchForm .task-top textarea.inp');
            if (!ta) return 'pas de champ prompt';
            window.__sent.length = 0;
            ta.value = ${JSON.stringify(MASTER_BLOCK)};
            ta.dispatchEvent(new Event('change', { bubbles: true }));
            if (!${tinted}) {
              ta.value = '';
              ta.dispatchEvent(new Event('change', { bubbles: true }));
              return 'off';
            }
            const ask = window.__sent.filter((m) => m && m.type === 'resolveMasterPaste').pop();
            if (!ask) return 'aucune recherche demandee';
            window.postMessage({ type: 'masterResolved', seq: ask.seq, sessionId: ${JSON.stringify(targetId)},
              title: 'x', matches: 1, reason: 'single-match', via: 'search' }, '*');
            return 'on';
          })()`);
          if (armed !== (tinted ? 'on' : 'off')) { console.error('  ' + theme + ' / maitresse non selectionnee → ' + armed); continue; }
          await sleep(140);
          const frozen = await cdp.evaluate(`(() => {
            // Le témoin vise la MÊME ligne (par identité, pas par classe) pour
            // que la comparaison porte sur la seule teinte.
            const row = [...document.querySelectorAll(${JSON.stringify(sel)})]
              .find((n) => (n.title || '').indexOf(${JSON.stringify(targetId === MASTER_CONV.id ? MASTER_CONV.title : OTHERS[0].title)}) === 0);
            if (!row) return 'ligne cible introuvable';
            if (row.classList.contains('active')) return 'la cible est la ligne selectionnee, cas deja couvert';
            if (${tinted}) {
              if (!row.classList.contains('master-target')) return 'la teinte n a pas ete posee';
              const anims = document.getAnimations().filter((a) => a.animationName === 'master-breathe');
              if (!anims.length) return 'aucune animation master-breathe';
              anims.forEach((a) => { a.pause(); a.currentTime = 600; });
            } else if (row.classList.contains('master-target')) return 'teinte residuelle sur le temoin';
            row.setAttribute('data-audit-target', '1');
            window.__auditSel = '[data-audit-target]';
            return 'ok';
          })()`);
          if (frozen !== 'ok') { console.error('  ' + theme + ' / maitresse non selectionnee → ' + frozen); continue; }
          await sleep(60);
          const r = await cdp.evaluate(PROBE);
          await cdp.evaluate(`(() => { window.__auditSel = null;
            document.querySelectorAll('[data-audit-target]').forEach((n) => n.removeAttribute('data-audit-target')); })()`);
          if (r && r.error) { console.error('  ' + theme + ' / maitresse non selectionnee → ' + r.error); continue; }
          report[theme].push({
            cas: 'ligne non selectionnee' + (inGroup ? ' (tete de lot)' : '') + (tinted ? ' [maitresse au pic]' : ' [temoin sans teinte]'),
            rowBg: r.rowBg, items: r.items, html: r.html,
          });
        }
      }
    }
  } finally {
    if (cdp) cdp.close();
    if (child) { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {} }
    else if (tabId) { try { await httpPut(`http://127.0.0.1:${PORT}/json/close/${tabId}`); } catch {} }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  const outFile = path.join(os.tmpdir(), 'quotasaver-contraste.json');
  fs.writeFileSync(outFile, JSON.stringify(report, null, 1), 'utf8');
  // Seuils WCAG : 4.5 pour du texte courant, 3 pour du gros texte et des
  // éléments graphiques porteurs de sens (glyphes, barres, anneaux).
  const SEUIL = { texte: 4.5, fond: 3, svg: 3, trait: 3, anneau: 3 };
  // Faux positif UNIQUE et voulu : le disque de .ico::after ne « contraste »
  // pas, il MASQUE le rail du lot — il doit être exactement du fond de la
  // ligne. Le signaler serait demander de casser ce masque.
  const ATTENDU = (it) => it.kind === 'fond' && /\.ico[.\w-]*::after$/.test(it.el);
  let worst = [];
  for (const theme of Object.keys(report)) {
    for (const c of report[theme]) {
      for (const it of c.items) {
        const s = SEUIL[it.kind] || 3;
        if (it.ratio < s && !ATTENDU(it)) worst.push({ theme, cas: c.cas, ...it, seuil: s });
      }
    }
  }
  // dédoublonnage par (thème, élément, couleur) : le même défaut revient dans
  // plusieurs cas, on veut la liste des CAUSES, pas des occurrences.
  const seen = new Set();
  worst = worst.filter((w) => { const k = w.theme + '|' + w.el + '|' + w.color; if (seen.has(k)) return false; seen.add(k); return true; });
  worst.sort((a, b) => a.ratio - b.ratio);
  console.log('fond de ligne : clair ' + report.light[0].rowBg + ' · sombre ' + report.dark[0].rowBg);
  console.log(worst.length + ' élément(s) sous le seuil :');
  for (const w of worst) console.log(`  ${w.ratio.toFixed(2)} (<${w.seuil}) ${w.theme.padEnd(5)} ${w.kind.padEnd(6)} ${w.el}${w.text ? ' « ' + w.text + ' »' : ''} ${w.color}  [${w.cas}]`);
  console.log('détail complet : ' + outFile);
  if (worst.length) process.exitCode = 1;
}
run().catch((e) => { console.error('échec:', e && e.message); process.exit(1); });
