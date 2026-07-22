const vscode = require('vscode');

// ============================================================================
// Panneau « Claude Convs » — WebviewView de la sidebar secondaire (droite).
//
// WebviewView (et pas TreeView) parce qu'il faut des couleurs libres, des barres
// de progression et un spinner animé, qu'aucune TreeItem ne sait rendre.
//
// CONTRAT D'ÉTAT — seul objet échangé extension.js → webview (postMessage) :
//   {
//     conversations: [{
//       id: string,           // session_id, clé de rendu
//       title: string,        // entrée `ai-title` du JSONL, sinon 1er prompt
//       model: string|null,   // « Opus 4.8 », ou l'id brut si non reconnu
//       ctx: { pct, tokens, denom } | null,
//       state: 'busy'|'waiting'|'done'|'stale'|'idle'|'interrupted',
//       acked: boolean,       // ✓ déjà lu (onglet consulté après la fin du tour)
//       active: boolean,      // conv de l'onglet sélectionné dans cette fenêtre
//     }],
//     quota: {
//       windows: [{
//         label: string,               // "5h window", "7d window", "Fable (7d)"…
//         pct: number,
//         resetsAt: string|null,
//         resetLabel: string,
//         windowMs: number,
//         pace: 'green'|'yellow'|'red'|null,
//         elapsedPct: number|null,     // % de la fenêtre écoulé → position flèche
//       }],
//       burnRate: { greenMax: number, yellowMax: number },
//       ageMin: number|null,  // fraîcheur du cache quota
//       source: string|null,
//     },
//     sounds: { enabled: boolean },  // reflète claudeCodeQuotaBar.sounds.enabled
//     ui: {
//       collapsedConversations: boolean,  // claudeCodeQuotaBar.collapsedConversations
//       collapsedQuota: boolean,          // claudeCodeQuotaBar.collapsedQuota
//       sortOrder: 'tabOrder'|'lastActivity'|'statusFirst',  // claudeCodeQuotaBar.conversationSortOrder
//     },
//     canary: boolean,       // lot 13 §1 : conv(s) busy/waiting mais zéro onglet
//                             // Claude détecté depuis > 2 min — viewType dérivé ?
//   }
//
// Le webview ne lit AUCUN fichier et ne fait aucun appel réseau. `pace` et
// `elapsedPct` arrivent déjà résolus côté extension (extension.js:
// burnRatePace/paceColor/windowElapsedPct) pour le premier rendu ; ENTRE deux
// pushes, un tick local de 30 s (lot 7) les ré-évalue lui-même — resetsAt +
// windowMs + burnRate suffisent, sans I/O. La formule est donc dupliquée une
// fois, par nécessité (extension host et webview sont deux runtimes séparés),
// mais c'est la MÊME formule des deux côtés : voir windowElapsedPct/
// burnRatePace/paceColor plus bas, à garder en miroir exact de extension.js.
// ============================================================================

const VIEW_TYPE = 'claudeCodeQuotaBar.panel';

class ClaudePanelProvider {
  // handlers : { openUsage, refresh, ready, focusConv } — le webview ne fait
  // qu'émettre des intentions, extension.js décide quoi en faire.
  constructor(context, handlers = {}) {
    this._context = context;
    this._handlers = handlers;
    this._view = null;
    this._state = null;
  }

  resolveWebviewView(view) {
    this._view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = renderHtml(view.webview);

    view.webview.onDidReceiveMessage((msg) => {
      const handler = this._handlers[msg && msg.type];
      if (handler) handler(msg);
    });

    view.onDidDispose(() => { this._view = null; });

    // Le webview repart de zéro à chaque résolution (première ouverture, ou
    // après un déchargement) : on lui repousse le dernier état connu tout de
    // suite pour éviter un panneau vide jusqu'au prochain refresh.
    if (this._state) this.update(this._state);
    else if (this._handlers.ready) this._handlers.ready();
  }

  update(state) {
    this._state = state;
    if (this._view) this._view.webview.postMessage({ type: 'state', state });
  }

  // Lot 9 : pas de fetch quota événementiel quand le panneau n'est pas à
  // l'écran (onglet sidebar non actif) — même logique que le tick lot 7, côté
  // extension host cette fois (webviewView.visible, pas document.hidden).
  isVisible() {
    return !!(this._view && this._view.visible);
  }
}

ClaudePanelProvider.viewType = VIEW_TYPE;

function nonceOf() {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function renderHtml(webview) {
  const nonce = nonceOf();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root {
    --busy: var(--vscode-charts-purple, #b180d7);
    --waiting: var(--vscode-charts-yellow, #cca700);
    --done: var(--vscode-charts-green, #89d185);
    --stale: var(--vscode-charts-yellow, #cca700);
    --muted: var(--vscode-descriptionForeground, #999);
    --pace-green: var(--vscode-charts-green, #89d185);
    --pace-yellow: var(--vscode-charts-yellow, #cca700);
    --pace-red: var(--vscode-charts-red, #f14c4c);
  }
  body {
    padding: 6px 8px 10px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
  }
  h2 {
    display: flex; align-items: center; gap: 6px;
    margin: 10px 0 4px;
    font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase;
    color: var(--muted);
  }
  h2 .count {
    font-size: 10px; letter-spacing: 0;
    padding: 0 5px; border-radius: 8px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .empty { padding: 6px 2px; color: var(--muted); font-style: italic; }
  /* Canari viewType (lot 13 §1) : signal discret, jamais de popup. Réutilise
     la teinte "attention" déjà en place, pas une couleur dédiée. */
  .canary {
    display: none;
    margin: 2px 2px 6px; padding: 4px 6px; border-radius: 4px;
    font-size: 11px; color: var(--waiting);
    background: color-mix(in srgb, var(--waiting) 12%, transparent);
  }
  .canary.show { display: block; }

  /* ── Conversations ── */
  .conv {
    display: grid; grid-template-columns: 16px 1fr; gap: 8px;
    padding: 5px 6px; border-radius: 4px;
    cursor: pointer;
  }
  .conv:hover { background: var(--vscode-list-hoverBackground); }
  .conv.active { background: var(--vscode-list-inactiveSelectionBackground); }
  .conv .body { min-width: 0; }
  .conv .title {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .conv.active .title { font-weight: 600; }
  .conv .meta {
    display: flex; gap: 6px; align-items: baseline;
    font-size: 11px; color: var(--muted);
  }
  .conv .meta .model { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .conv .meta .ctx { margin-left: auto; flex: none; font-variant-numeric: tabular-nums; }

  /* Pastilles d'état : la forme porte l'info autant que la couleur
     (daltonisme + thèmes à contraste élevé). */
  .ico { margin-top: 4px; width: 10px; height: 10px; justify-self: center; }
  .ico-stale { border-radius: 50%; background: transparent; border: 1.5px dashed var(--stale); }
  /* « ? » : un seul état visuel pour TOUTE attente user (question posée,
     permission, idle_prompt) — le lot 11 unifie ces trois signaux hooks/
     transcript derrière le même symbole. Pas d'animation : contrairement au
     spinner busy, il n'y a rien de continu à montrer, juste une attente. */
  .ico-waiting {
    color: var(--waiting); font-size: 11px; font-weight: 700; line-height: 10px; text-align: center;
  }
  .ico-waiting::before { content: '?'; }
  /* Deux teintes du check : vif = terminé, pas encore relu ; atténué = déjà
     consulté (ack.js) ou rien à relire. Il n'y a plus de pastille grise « idle »
     — un check atténué dit « rien en cours », là où le gris disait
     « conversation inutile ». Le check ne s'éteint plus par timer : seule la
     lecture le calme. */
  .ico-done {
    color: var(--done); font-size: 11px; line-height: 10px; text-align: center;
  }
  .ico-done.read { opacity: .45; }
  /* Interruption manuelle (Stop / Échap) : le carré du « stop » universel, creux
     et muet. Une forme franche, pas une teinte de plus — la pastille voisine est
     un ✓ (« rien à faire ») alors qu'une interruption dit l'inverse : le travail
     est resté en plan. Muted et non coloré : c'est un fait à retrouver dans la
     liste, pas une alerte qui réclame quelque chose. Distinct du cercle pointillé
     de l'état stale par la forme comme par le trait. */
  .ico-interrupted {
    border: 1.5px solid var(--muted);
    border-radius: 1px;
    box-sizing: border-box;
    width: 9px; height: 9px;
    margin-top: 4.5px;
  }
  .ico-busy {
    border: 1.5px solid color-mix(in srgb, var(--busy) 25%, transparent);
    border-top-color: var(--busy);
    border-radius: 50%;
    animation: spin .8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  /* PAS de @media (prefers-reduced-motion: reduce) ici, et c'est délibéré.
     Chromium — donc ce webview — dérive cette préférence de
     SPI_GETCLIENTAREAANIMATION, l'option Windows « Effets d'animation », que ce
     poste a sur OFF (mesuré le 2026-07-15 : reduce = true dans le moteur de
     rendu). La règle qui coupait l'animation ici était donc TOUJOURS active :
     c'est elle qui figeait l'arc violet. Ces deux animations ne sont pas
     décoratives, elles PORTENT l'état de la conversation — les couper, c'est
     supprimer l'information, pas la tempérer. Aucun risque vestibulaire non
     plus : rotation et fondu d'une pastille de 10 px, sans déplacement. */

  /* ── Barres ── */
  .bar {
    height: 3px; margin-top: 3px; border-radius: 2px; overflow: hidden;
    background: var(--vscode-progressBar-background, #0e70c0);
    background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
  }
  .bar > i { display: block; height: 100%; border-radius: 2px; }
  .bar-ctx > i { background: var(--muted); opacity: .7; }
  .bar-q { height: 6px; }
  .bar-q > i { background: var(--vscode-progressBar-background, #0e70c0); }
  /* Burn-rate : %utilisé / %fenêtre écoulée. Pas de signal fiable (reset trop
     proche/loin) → couleur neutre par défaut. */
  .bar-q.pace-green > i { background: var(--pace-green); }
  .bar-q.pace-yellow > i { background: var(--pace-yellow); }
  .bar-q.pace-red > i { background: var(--pace-red); }
  .q-pct.pace-green { color: var(--pace-green); }
  .q-pct.pace-yellow { color: var(--pace-yellow); }
  .q-pct.pace-red { color: var(--pace-red); }

  /* Flèche « où je devrais être » (lot 7) : position = % de la fenêtre déjà
     écoulé. Sous la barre, dans son propre rail — jamais dans .bar, dont
     l'overflow:hidden la couperait. var(--vscode-descriptionForeground) suit
     le thème actif (clair/sombre) sans règle dédiée. */
  .bar-wrap { position: relative; }
  .arrow-track { position: relative; height: 6px; }
  .arrow {
    position: absolute; top: 0; width: 0; height: 0;
    border-left: 4px solid transparent; border-right: 4px solid transparent;
    border-bottom: 5px solid var(--muted);
    transform: translateX(-50%);
  }

  /* ── Quota ── */
  .q { margin: 8px 0 10px; }
  .q-head { display: flex; align-items: baseline; }
  .q-label { font-size: 11px; color: var(--muted); }
  .q-pct { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 600; }
  .q-sub { margin-top: 3px; font-size: 11px; color: var(--muted); }

  /* ── Pied ── */
  .foot {
    display: flex; align-items: center; gap: 10px;
    margin-top: 12px; padding-top: 8px;
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
    font-size: 11px; color: var(--muted);
  }
  .foot .age { margin-right: auto; font-variant-numeric: tabular-nums; }
  .link {
    color: var(--vscode-textLink-foreground); cursor: pointer;
    background: none; border: 0; padding: 0; font: inherit;
  }
  .link:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }

  /* ── Bascule des sons (en-tête) ── */
  .topbar { display: flex; justify-content: flex-end; }
  .sounds-toggle {
    background: none; border: 0; cursor: pointer; padding: 2px 4px;
    font-size: 14px; line-height: 1; color: var(--muted);
    border-radius: 3px;
  }
  .sounds-toggle:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
  .sounds-toggle.on { color: var(--vscode-foreground); }

  /* ── En-têtes de section repliables ── */
  .sec-head {
    display: flex; align-items: center; gap: 6px;
    margin: 10px 0 4px; padding: 2px 2px;
    border-radius: 3px; cursor: pointer; user-select: none;
  }
  .sec-head:hover { background: var(--vscode-list-hoverBackground); }
  .sec-head h2 { margin: 0; }
  /* Chevron : la maquette à 9px était illisible (retour user) — 13px reste
     discret à côté d'un h2 à 11px tout en restant une vraie cible de clic. */
  .chevron {
    flex: 0 0 auto; width: 14px; text-align: center;
    font-size: 13px; line-height: 1; color: var(--muted);
  }
  .sec-head .spacer { flex: 1 1 auto; }
  .sort-select {
    font-size: 10px; padding: 1px 3px; border-radius: 3px;
    background: var(--vscode-dropdown-background, var(--vscode-input-background));
    color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border, rgba(128,128,128,.35)));
  }
  .sec-body.collapsed { display: none; }
</style>
</head>
<body>
  <div class="topbar">
    <button class="sounds-toggle" id="soundsToggle" title="Toggle notification sounds"></button>
  </div>
  <section>
    <div class="sec-head" id="convHead">
      <span class="chevron" id="convChevron">▾</span>
      <h2>Conversations <span class="count" id="convCount"></span></h2>
      <span class="spacer"></span>
      <select class="sort-select" id="sortSelect" title="Sort conversations by">
        <option value="tabOrder">Tab order</option>
        <option value="lastActivity">Last activity</option>
        <option value="statusFirst">Status first</option>
      </select>
    </div>
    <div class="sec-body" id="convBody">
      <div class="canary" id="canary">⚠ Claude tabs not detected — viewType changed?</div>
      <div id="convs"></div>
    </div>
  </section>
  <section>
    <div class="sec-head" id="quotaHead">
      <span class="chevron" id="quotaChevron">▾</span>
      <h2>Quota</h2>
    </div>
    <div class="sec-body" id="quotaBody">
      <div id="quota"></div>
    </div>
  </section>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const convsEl = document.getElementById('convs');
  const quotaEl = document.getElementById('quota');
  const countEl = document.getElementById('convCount');
  const soundsToggleEl = document.getElementById('soundsToggle');
  const canaryEl = document.getElementById('canary');
  const convHeadEl = document.getElementById('convHead');
  const convChevronEl = document.getElementById('convChevron');
  const convBodyEl = document.getElementById('convBody');
  const quotaHeadEl = document.getElementById('quotaHead');
  const quotaChevronEl = document.getElementById('quotaChevron');
  const quotaBodyEl = document.getElementById('quotaBody');
  const sortSelectEl = document.getElementById('sortSelect');

  // Le select est DANS le sec-head cliquable : un clic pour ouvrir le menu
  // (ou choisir une option) ne doit pas aussi replier la section. contains()
  // inclut l'élément lui-même, donc ce garde couvre le clic d'ouverture ET les
  // clics dans le popup natif remontant jusqu'ici.
  convHeadEl.addEventListener('click', function (e) {
    if (sortSelectEl.contains(e.target)) return;
    vscode.postMessage({ type: 'toggleCollapse', section: 'conversations' });
  });
  quotaHeadEl.addEventListener('click', function () {
    vscode.postMessage({ type: 'toggleCollapse', section: 'quota' });
  });
  sortSelectEl.addEventListener('change', function () {
    vscode.postMessage({ type: 'setSortOrder', order: sortSelectEl.value });
  });

  // Reflète l'état réel des settings, jamais un état local — même raison que
  // renderSoundsToggle : d'autres fenêtres/le settings.json peuvent le changer.
  function renderUi(ui) {
    const collapsedConv = !!(ui && ui.collapsedConversations);
    const collapsedQuota = !!(ui && ui.collapsedQuota);
    convBodyEl.classList.toggle('collapsed', collapsedConv);
    convChevronEl.textContent = collapsedConv ? '▸' : '▾';
    quotaBodyEl.classList.toggle('collapsed', collapsedQuota);
    quotaChevronEl.textContent = collapsedQuota ? '▸' : '▾';
    const order = (ui && ui.sortOrder) || 'tabOrder';
    if (sortSelectEl.value !== order) sortSelectEl.value = order;
  }

  // Icône haut-parleur : reflète l'état réel du setting, pas un état local —
  // l'extension repousse le nouvel état à toutes les fenêtres après un clic
  // (onDidChangeConfiguration), y compris celle qui n'a pas cliqué.
  function renderSoundsToggle(enabled) {
    soundsToggleEl.textContent = enabled ? '🔊' : '🔇';
    soundsToggleEl.classList.toggle('on', !!enabled);
    soundsToggleEl.title = enabled ? 'Notification sounds: on (click to mute)' : 'Notification sounds: off (click to enable)';
  }
  soundsToggleEl.addEventListener('click', function () {
    vscode.postMessage({ type: 'toggleSounds' });
  });
  renderSoundsToggle(false);

  // textContent partout, jamais innerHTML : les titres viennent des prompts
  // de l'utilisateur, donc de données non fiables.
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function bar(cls, pct) {
    const b = el('div', 'bar ' + cls);
    const fill = el('i');
    fill.style.width = Math.min(100, Math.max(1, pct)) + '%';
    b.appendChild(fill);
    return b;
  }

  // ── Conversations : rendu INCRÉMENTAL ────────────────────────────────────
  // Reconstruire la liste à chaque état (replaceChildren + recréation des nœuds)
  // détruit et recrée la pastille d'activité : son animation CSS repart alors de
  // zéro à chaque message écrit dans le transcript, et l'arc paraît figé. On
  // garde donc les nœuds vivants et on ne touche que ce qui change (mêmes
  // garde-fous : aucune donnée non fiable hors textContent).
  const rows = new Map();   // id → nœuds réutilisés d'un rendu à l'autre

  function stateLabel(c) {
    if (c.state === 'busy') return 'working…';
    if (c.state === 'waiting') return 'waiting for you';
    if (c.state === 'stale') return 'stale — no activity for a while';
    if (c.state === 'done') return c.acked ? 'done — read' : 'done — not read yet';
    if (c.state === 'interrupted') return 'interrupted — unfinished';
    return 'nothing running';
  }

  // L'état « idle » (aucun état connu des hooks) se rend comme un ✓ déjà lu :
  // la conv est là, elle ne demande rien. « interrupted » a sa propre forme —
  // il dit le contraire du ✓ (cf. le carré ci-dessus dans la feuille de style).
  function icoClass(c) {
    if (c.state === 'done') return 'ico ico-done' + (c.acked ? ' read' : '');
    if (c.state === 'idle') return 'ico ico-done read';
    return 'ico ico-' + c.state;
  }

  function setText(node, text) { if (node.textContent !== text) node.textContent = text; }
  function setClass(node, cls) { if (node.className !== cls) node.className = cls; }

  function createRow() {
    const root = el('div', 'conv');
    const ico = el('span', 'ico');
    const body = el('div', 'body');
    const title = el('div', 'title');
    const meta = el('div', 'meta');
    const model = el('span', 'model');
    const ctx = el('span', 'ctx');
    const ctxBar = bar('bar-ctx', 0);
    meta.appendChild(model);
    meta.appendChild(ctx);
    body.appendChild(title);
    body.appendChild(meta);
    body.appendChild(ctxBar);
    root.appendChild(ico);
    root.appendChild(body);
    const row = { root, ico, title, model, ctx, ctxBar, fill: ctxBar.firstChild, data: null };
    root.addEventListener('click', function () {
      if (row.data) vscode.postMessage({ type: 'focusConv', id: row.data.id, title: row.data.title });
    });
    return row;
  }

  function updateRow(row, c) {
    row.data = c;
    setClass(row.root, 'conv' + (c.active ? ' active' : ''));
    const tip = (c.title || '') + ' — ' + stateLabel(c);
    if (row.root.title !== tip) row.root.title = tip;
    setClass(row.ico, icoClass(c));
    // Le ✓ est du texte, les autres états sont des formes CSS.
    setText(row.ico, (c.state === 'done' || c.state === 'idle') ? '✓' : '');
    setText(row.title, c.title || 'Untitled');
    setText(row.model, c.model || '—');
    setText(row.ctx, c.ctx ? 'ctx ' + Math.round(c.ctx.pct) + '%' : '');
    row.ctxBar.style.display = c.ctx ? '' : 'none';
    if (c.ctx) {
      const w = Math.min(100, Math.max(1, c.ctx.pct)) + '%';
      if (row.fill.style.width !== w) row.fill.style.width = w;
    }
  }

  function renderConvs(list) {
    countEl.textContent = list.length ? String(list.length) : '';

    let empty = convsEl.querySelector('.empty');
    if (!list.length) {
      rows.forEach((r) => r.root.remove());
      rows.clear();
      if (!empty) convsEl.appendChild(el('div', 'empty', 'No recent conversation here.'));
      return;
    }
    if (empty) empty.remove();

    const seen = new Set();
    list.forEach(function (c, i) {
      seen.add(c.id);
      let row = rows.get(c.id);
      if (!row) { row = createRow(); rows.set(c.id, row); }
      updateRow(row, c);
      // Ne déplacer que ce qui est mal placé : réinsérer un nœud relance ses
      // animations CSS — exactement ce qu'on veut éviter pour le spinner.
      if (convsEl.children[i] !== row.root) {
        convsEl.insertBefore(row.root, convsEl.children[i] || null);
      }
    });
    rows.forEach(function (row, id) {
      if (seen.has(id)) return;
      row.root.remove();
      rows.delete(id);
    });
  }

  function arrowTrack(elapsedPct) {
    const track = el('div', 'arrow-track');
    if (elapsedPct != null) {
      const tri = el('div', 'arrow');
      tri.style.left = Math.min(100, Math.max(0, elapsedPct)) + '%';
      track.appendChild(tri);
    }
    return track;
  }

  function renderQuota(q) {
    quotaEl.replaceChildren();
    const windows = (q && q.windows) || [];
    for (const w of windows) {
      const paceCls = w.pace ? ' pace-' + w.pace : '';
      const wrap = el('div', 'q');
      const head = el('div', 'q-head');
      head.appendChild(el('span', 'q-label', w.label));
      head.appendChild(el('span', 'q-pct' + paceCls, Math.round(w.pct) + '%'));
      wrap.appendChild(head);
      const barWrap = el('div', 'bar-wrap');
      barWrap.appendChild(bar('bar-q' + paceCls, w.pct));
      barWrap.appendChild(arrowTrack(w.elapsedPct));
      wrap.appendChild(barWrap);
      if (w.resetLabel) wrap.appendChild(el('div', 'q-sub', 'resets ' + w.resetLabel));
      quotaEl.appendChild(wrap);
    }
    if (!windows.length) quotaEl.appendChild(el('div', 'empty', 'No usage data yet.'));

    const foot = el('div', 'foot');
    const age = q.ageMin == null ? '' : (q.ageMin <= 1 ? 'just now' : q.ageMin + ' min ago');
    foot.appendChild(el('span', 'age', age));
    const refresh = el('button', 'link', 'Refresh');
    refresh.addEventListener('click', function () { vscode.postMessage({ type: 'refresh' }); });
    const usage = el('button', 'link', 'Usage page');
    usage.addEventListener('click', function () { vscode.postMessage({ type: 'openUsage' }); });
    foot.appendChild(refresh);
    foot.appendChild(usage);
    quotaEl.appendChild(foot);
  }

  // ── Auto-actualisation de la flèche (lot 7) ──────────────────────────────
  // Position et couleur ne dépendent que de l'horloge et de resetsAt : un tick
  // local de 30 s les ré-évalue SANS I/O entre deux pushes réseau (poll quota
  // à 5 min, inchangé). Formule EXACTEMENT en miroir de extension.js
  // (windowElapsedPct/burnRatePace/paceColor) — même dénominateur, mêmes
  // gardes de masquage (resetsAt absent, reset passé, remainMs ≥ windowMs).
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
  function paceColor(pace, thresholds) {
    if (pace == null || !thresholds) return null;
    if (pace <= thresholds.greenMax) return 'green';
    if (pace <= thresholds.yellowMax) return 'yellow';
    return 'red';
  }

  let lastQuota = null;
  let tickTimer = null;

  function retick(q) {
    if (!q || !q.windows) return q;
    return Object.assign({}, q, {
      windows: q.windows.map(function (w) {
        if (!w.resetsAt) return w;
        const elapsedPct = windowElapsedPct(w.resetsAt, w.windowMs);
        return Object.assign({}, w, {
          elapsedPct: elapsedPct == null ? null : Math.min(100, Math.max(0, elapsedPct)),
          pace: paceColor(burnRatePace(w.pct, w.resetsAt, w.windowMs), q.burnRate),
        });
      }),
    });
  }

  // Coupé (pas seulement ignoré) quand le webview est caché : rien à
  // consommer à vide. document.hidden reflète la visibilité réelle du
  // panneau dans VS Code (Page Visibility API, supportée par les webviews).
  function startTick() {
    if (tickTimer) return;
    tickTimer = setInterval(function () {
      if (lastQuota) renderQuota(retick(lastQuota));
    }, 30000);
  }
  function stopTick() {
    if (!tickTimer) return;
    clearInterval(tickTimer);
    tickTimer = null;
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopTick(); else startTick();
  });

  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (!msg || msg.type !== 'state') return;
    renderConvs((msg.state && msg.state.conversations) || []);
    lastQuota = (msg.state && msg.state.quota) || {};
    renderQuota(lastQuota);
    renderSoundsToggle(!!(msg.state && msg.state.sounds && msg.state.sounds.enabled));
    renderUi(msg.state && msg.state.ui);
    canaryEl.classList.toggle('show', !!(msg.state && msg.state.canary));
  });

  if (!document.hidden) startTick();

  vscode.postMessage({ type: 'ready' });
}());
</script>
</body>
</html>`;
}

module.exports = { ClaudePanelProvider, VIEW_TYPE };
