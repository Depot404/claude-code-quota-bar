// Générateur de MAQUETTE JOUABLE à partir du panneau RÉEL.
//
// POURQUOI — une maquette réécrite à la main ne prouve rien du panneau : elle
// prouve la maquette. Ce script prend le HTML EXACT que `panel.js` donne à VS
// Code (même provider que test-panel-render.js et make-store-shots.js), y
// injecte les variables de thème que seul VS Code fournirait, un jeu de données
// et un collage simulé, puis écrit un fichier .html qu'on ouvre au navigateur.
// Ce qu'on regarde est donc le panneau lui-même, avec ses vraies classes, ses
// vraies mesures et son vrai JavaScript.
//
//   node test/make-mockup.js [chemin de sortie] [--dark]
//
// Règles de ce fichier (comme make-store-shots.js) : il est PUBLIABLE, donc
// tout ce qu'il contient est INVENTÉ — aucun titre, prompt ou nom réel. Les
// libellés d'interface, eux, passent par le bundle FR pour que la maquette ait
// la tête du panneau tel qu'il s'affiche ici.
const Module = require('module');
const fs = require('fs');
const path = require('path');

const BUNDLE = (function () {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'l10n', 'bundle.l10n.fr.json'), 'utf8')); }
  catch { return {}; }
})();
const stub = {
  window: {}, Uri: { parse: (s) => s },
  l10n: {
    bundle: BUNDLE,
    t: (message, ...args) => {
      const s = BUNDLE[message] || message;
      return args.length ? s.replace(/\{(\d+)\}/g, (_, i) => (args[i] !== undefined ? args[i] : '')) : s;
    },
  },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'vscode') return stub;
  return origLoad.call(this, req, ...rest);
};
const { ClaudePanelProvider } = require(path.join(__dirname, '..', 'panel.js'));
const { palettes } = require(path.join(__dirname, 'theme-palette.js'));

const outFile = process.argv.find((a, i) => i >= 2 && !a.startsWith('--'))
  || path.join(__dirname, '..', 'MOCKUP_panneau_reel.html');
const dark = process.argv.includes('--dark');

// ── Le jeu de données : un lot à trois vagues, la première lancée mais dont la
//    tâche a perdu son lien avant envoi — le cas où l'on veut justement glisser
//    un bloc devant elle. Tout est inventé.
const HOUR = 3600 * 1000;
const now = Date.now();
const CONVS = [
  { id: 'm0', title: 'Plan the payroll form', model: 'Opus 5', effort: 'high', ctx: { pct: 20 }, state: 'done', acked: true, active: false, tabOpen: true, cost: 8.38 },
  { id: 'g1a', title: 'Data model for the prefilled payslip', model: 'Sonnet 5', effort: 'medium', ctx: { pct: 6 }, state: 'done', acked: false, active: false, tabOpen: true },
  { id: 'c9', title: 'Sedentary staff pay guarantee', model: 'Sonnet 5', effort: 'medium', ctx: { pct: 16 }, state: 'done', acked: true, active: false, tabOpen: true, cost: 3.59 },
];
const GROUPS = [{
  id: 'g1',
  name: 'Prefilled payslip',
  stamp: '14:48',
  hue: 262,
  collapsed: false,
  waveMode: 'auto',
  launchedWave: 2,
  nextWave: 3,
  waveNotice: null,
  master: { convId: 'm0', title: 'Plan the payroll form', tabTitle: null, listed: true, status: 'done', hint: '' },
  members: [
    { key: 'w1', prompt: 'Data model for the prefilled payslip. A payslip may exist in the database without having been worked.', wave: 1, asked: { model: 'sonnet', effort: 'medium' }, convId: 'g1a', status: 'done', waveStatus: 'done', canLink: false, canClose: true, canRelaunch: false, note: '', hint: '' },
    { key: 'w2', prompt: 'Prefill the payslip form from the roster. Depends on the data model batch already delivered.', wave: 2, asked: { model: 'sonnet', effort: 'medium' }, convId: 'g1b', status: 'busy', waveStatus: 'launched', canLink: false, canClose: false, canRelaunch: false, note: '', hint: stub.l10n.t('Queued — opens when this wave starts.') },
    { key: 'w3', prompt: 'Badge "roster changed" on a prefilled payslip. Depends on the two batches above.', wave: 3, asked: { model: 'sonnet', effort: 'medium' }, convId: null, status: 'queued', waveStatus: 'queued', canLink: false, canClose: false, canRelaunch: false, note: '', hint: stub.l10n.t('Queued — opens when this wave starts.') },
  ],
}];
const QUOTA = {
  windows: [
    { label: '5h window', pct: 23, resetsAt: new Date(now + 2.5 * HOUR).toISOString(), resetLabel: '18:20', windowMs: 5 * HOUR, pace: 'green', elapsedPct: 50, cost: 12.4 },
    { label: '7d window', pct: 61, resetsAt: new Date(now + 6 * 24 * HOUR).toISOString(), resetLabel: 'Fri', windowMs: 7 * 24 * HOUR, pace: 'green', elapsedPct: 14, cost: 96.2 },
  ],
  burnRate: { greenMax: 0.85, yellowMax: 1.0 },
  ageMin: 2, source: 'oauth',
};
// Le bloc collé dans « Nouvelle conversation » : 4 prompts, 4 vagues — le cas
// qui n'entre dans aucune vague existante.
const BLOCK = [
  '```claude-convs',
  'group: Prefilled payslip',
  'model: sonnet',
  'effort: medium',
  'stage: 1',
  'Silent loss on an undeclared incident: the form drops it without a word.',
  '[---]',
  'model: sonnet',
  'effort: medium',
  'stage: 2',
  'Data model for the prefilled payslip.',
  '[---]',
  'model: sonnet',
  'effort: medium',
  'stage: 3',
  'Prefill the payslip form from the roster.',
  '[---]',
  'model: sonnet',
  'effort: medium',
  'stage: 4',
  'Badge "roster changed" on a prefilled payslip.',
  '```',
].join('\n');

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
if (!html) { console.error('le provider n\'a rendu aucun document'); process.exit(1); }

// La CSP du webview interdit tout script sans le nonce de VS Code : dans un
// fichier local elle bloquerait le shim. On la retire de la COPIE (jamais du
// panneau), et on garde le nonce du document pour nos propres balises.
const nonce = (html.match(/<script nonce="([^"]+)">/) || [])[1] || '';
html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '<!-- CSP retirée pour la maquette locale -->');

const pal = palettes(fs.readFileSync(path.join(__dirname, '..', 'panel.js'), 'utf8'));
// Les DEUX palettes vivent dans le document : une maquette qui n'existe que
// dans un thème ne peut rien dire du contraste dans l'autre, et le thème
// réellement actif chez l'user change dans la journée (autoDetectColorScheme).
// --dark ne choisit plus que celui affiché à l'ouverture.
const vars = function (t) { return Object.entries(t).map(function (kv) { return kv[0] + ':' + kv[1]; }).join(';'); };

// Shim AVANT le script du panneau : acquireVsCodeApi + les variables de thème.
const shim = `<style>:root{${vars(pal.light)}}
  html.dark{${vars(pal.dark)}}
  html,body{background:var(--vscode-sideBar-background);}
  /* position:relative — dans VS Code le webview OCCUPE toute la largeur, donc
     le decor pose en coordonnees de document (agrafe, etiquette) se cale sur
     lui. Sans ca, la maquette le calerait sur le viewport de 820px et
     l'etiquette partirait a droite du panneau : un faux defaut fabrique par la
     maquette elle-meme. */
  body{max-width:420px;position:relative;box-shadow:0 0 0 1px var(--vscode-panel-border);}
  /* Bascule de thème — n'existe QUE dans ce fichier, jamais dans l'extension. */
  #themetog{position:fixed;top:10px;left:440px;z-index:9999;cursor:pointer;
    font:12px/1.6 var(--vscode-font-family);color:var(--vscode-button-foreground);
    background:var(--vscode-button-background);border:0;border-radius:4px;padding:5px 12px;}
</style>
<script nonce="${nonce}">
  window.__sent = [];
  window.acquireVsCodeApi = () => ({ postMessage: (m) => { window.__sent.push(m); if (m && m.type === 'resolveMasterPaste') window.__answerMaster(m.seq); } });
</script>`;
html = html.replace('</head>', shim + '\n</head>');

// Bootstrap APRÈS le script du panneau : l'état, puis le collage du bloc, puis
// la réponse « maîtresse trouvée » que l'extension enverrait.
const boot = `<script nonce="${nonce}">
  window.__answerMaster = function (seq) {
    setTimeout(function () {
      window.postMessage({ type: 'masterResolved', seq: seq, sessionId: 'm0', title: 'Plan the payroll form', matches: 1, reason: 'paste' }, '*');
    }, 30);
  };
  window.postMessage({ type: 'state', state: ${JSON.stringify({ conversations: CONVS, groups: GROUPS, quota: QUOTA, sounds: { enabled: false } })} }, '*');
  setTimeout(function () {
    var ta = document.querySelector('.task-top textarea.inp');
    if (!ta) return;
    ta.value = ${JSON.stringify(BLOCK)};
    ta.dispatchEvent(new Event('change'));
  }, 120);
  setTimeout(function () {
    var b = document.createElement('button');
    b.id = 'themetog';
    var paint = function () {
      b.textContent = document.documentElement.classList.contains('dark')
        ? 'Passer au th\u00e8me clair' : 'Passer au th\u00e8me sombre';
    };
    b.addEventListener('click', function () {
      document.documentElement.classList.toggle('dark');
      paint();
      // Le décor de collage (agrafe, flèche) est peint en coordonnées de
      // document : un simple événement de défilement le refait.
      window.dispatchEvent(new Event('scroll'));
    });
    paint();
    document.body.appendChild(b);
  }, 400);
</script>`;
html = html.replace('</body>', boot + '\n</body>');
// Cache file:// de Chromium : sans ça, F5 ressert l'ancienne version.
html = html.replace('<head>', '<head>\n<meta http-equiv="Cache-Control" content="no-store">');
if (dark) html = html.replace('<html', '<html class="dark"');

fs.writeFileSync(outFile, html, 'utf8');
console.log('maquette écrite : ' + outFile + ' (deux thèmes, ouverte en ' + (dark ? 'sombre' : 'clair') + ', ' + Math.round(html.length / 1024) + ' Ko)');
