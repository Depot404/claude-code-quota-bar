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
//       title: string,        // nom de l'ONGLET si connu (state.vscdb), sinon
//                             // entrée `ai-title` du JSONL, sinon 1er prompt
//       tabTitle: string|null,// libellé brut du store d'onglets — jamais rendu,
//                             // renvoyé tel quel au clic (matching de focus)
//       model: string|null,   // « Opus 4.8 », ou l'id brut si non reconnu
//       effort: string|null,  // effort RÉEL du dernier tour (transcript)
//       asked: { model, effort } | null,   // ce qu'on avait demandé au lancement
//       mismatch: { model?: {asked, real}, effort?: {asked, real} } | null,
//       ctx: { pct, tokens, denom } | null,
//       state: 'busy'|'waiting'|'done'|'stale'|'idle'|'interrupted',
//       acked: boolean,       // ✓ déjà lu (onglet consulté après la fin du tour)
//       active: boolean,      // conv de l'onglet sélectionné dans cette fenêtre
//       groupId: string|null, // membre d'un groupe → rendue DANS sa section
//       tabOpen: boolean,     // un onglet porte encore cette conv (badge ⨯)
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
//     batch: {
//       envConflict: string[],  // nos env vars définies dans claudeCode.environmentVariables
//                               // → sélecteurs désactivés (elles écraseraient nos choix)
//       busy: boolean,          // un « Create » est en cours (lancements sérialisés)
//       notice: string|null,    // retour du dernier « Create »
//     },
//     groups: [{                // lot 2 — métadonnées ; lot 4 ajoute le moteur
//                               // de vagues (autoAdvance, launchedWave, nextWave,
//                               // waveNotice, member.status)
//       id, name, hue: number, collapsed: boolean,
//       autoAdvance: boolean,   // toggle de passage de vague (lot 4)
//       launchedWave: number,   // vague la plus avancée déjà ouverte
//       nextWave: number|null,  // vague à proposer au ▶ manuel, null = aucune
//       waveNotice: string|null,// annonce transitoire (ouverture auto, échec)
//       members: [{
//         key: string,          // identité du membre dans son groupe
//         prompt: string,       // ce qu'on a inséré à l'ouverture
//         wave: number,
//         asked: { model, effort },
//         convId: string|null,  // conversation rattachée — null = pas encore liée
//         status: 'queued'|'launched'|'done'|'stale',  // lot 4 (waves.js)
//       }],
//     }],
//   }
//
// Un membre n'a PAS d'état propre : son état, son modèle, son contexte sont
// ceux de la conversation qu'il pointe (appariement par `convId` dans
// `conversations`). C'est ce qui garantit qu'une conv rendue dans un groupe et
// une conv rendue à plat disent exactement la même chose — il n'y a qu'un seul
// rendu de ligne (createRow/updateRow), réutilisé aux deux endroits.
//
// Le formulaire de création groupée vit ENTIÈREMENT dans le webview (état local
// `form`) : il ne descend jamais de l'extension, sinon chaque push d'état
// (transition de conv, tick quota) écraserait la saisie en cours. Le seul
// message qui remonte est `createBatch` — l'extension revalide tout (batch.js
// normalizeTasks), le webview n'est pas une source fiable.
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

// Lot 15 : le bundle actif (vscode.l10n.bundle — vide en anglais, ou les
// paires source→traduction de la locale VS Code courante) est injecté tel
// quel dans le webview ; c'est un runtime SÉPARÉ (Chromium, pas l'hôte
// d'extension) qui n'a pas accès à vscode.l10n lui-même.
function l10nBundle() {
  try { return (vscode.l10n && vscode.l10n.bundle) || {}; } catch { return {}; }
}

function renderHtml(webview) {
  const nonce = nonceOf();
  const bundleJson = JSON.stringify(l10nBundle()).replace(/</g, '\\u003c');
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
  /* Terminée avec l'onglet fermé (lot 4 §5) : le barré DÉCOULE de tabOpen,
     jamais d'une mémoire locale — rouvrir l'onglet l'efface tout seul. */
  .conv .title.closed { text-decoration: line-through; }
  .conv .meta {
    display: flex; gap: 6px; align-items: baseline;
    font-size: 11px; color: var(--muted);
  }
  .conv .meta .model { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
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
  /* Sous-en-tête repliable de « New conversation » (lot 12) : même mécanique
     que .sec-head (chevron + repli), gabarit plus discret — ce n'est pas une
     section de haut niveau comme Conversations/Quota, c'est une extension du
     lanceur, toujours dépliée par défaut. */
  .sec-head.sub { margin: 8px 0 4px; }
  .sec-head.sub h3 {
    margin: 0; font-size: 11px; font-weight: 600; letter-spacing: .06em;
    text-transform: uppercase; color: var(--muted);
  }

  /* ── Création groupée (lot 1) ─────────────────────────────────────────────
     Tout est bâti sur les variables de thème VS Code : le panneau doit rester
     lisible en clair, en sombre et en contraste élevé, sans une seule couleur
     en dur. Les boutons segmentés remplacent tout dropdown (décision 4 du
     plan) : le choix courant est visible sans ouvrir quoi que ce soit. */
  .batch { margin-top: 10px; }
  .btn {
    font: inherit; font-size: 11px;
    padding: 3px 8px; border-radius: 3px; cursor: pointer;
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
  }
  .btn:hover { background: var(--vscode-list-hoverBackground); }
  .btn.pri {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-background);
  }
  .btn.pri:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
  .btn[disabled] { opacity: .45; cursor: default; }
  /* ▶ atténué en mode auto (lot allègement 2026-07-24) : reste cliquable
     (force + confirmation côté extension), jamais désactivé — disabled
     serait le seul chemin à nouveau court-circuité en mode manuel/bloqué. */
  .btn.pri.dim {
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--muted); border-color: var(--vscode-panel-border, rgba(128,128,128,.35));
  }
  .btn.pri.dim:hover { background: var(--vscode-list-hoverBackground); }
  .hint { margin-top: 6px; font-size: 11px; color: var(--muted); }
  .tip-restore {
    margin-left: 6px; cursor: pointer; opacity: .5; font-size: 10px;
    display: inline-flex; align-items: center; justify-content: center;
    width: 14px; height: 14px; border-radius: 50%;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.4));
  }
  .tip-restore:hover { opacity: 1; }
  .notice {
    display: none;
    margin: 6px 0; padding: 4px 6px; border-radius: 4px; font-size: 11px;
    background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
  }
  .notice.show { display: block; }
  .banner {
    margin: 6px 0; padding: 4px 6px; border-radius: 4px; font-size: 11px;
    background: color-mix(in srgb, var(--waiting) 12%, transparent); color: var(--waiting);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .banner.info { background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent); color: var(--muted); }
  .banner.err { background: color-mix(in srgb, var(--vscode-errorForeground, #f14c4c) 14%, transparent); color: var(--vscode-errorForeground, #f14c4c); }
  .fld-label { display: block; margin: 8px 0 3px; font-size: 10px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
  textarea.inp {
    width: 100%; box-sizing: border-box; resize: vertical;
    font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.45;
    padding: 4px 6px; border-radius: 3px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, rgba(128,128,128,.35)));
  }
  textarea.inp:focus, input.inp:focus { outline: 1px solid var(--vscode-focusBorder); }
  /* Ajout en file (plan ajout-tache 2026-07-24) : lien visuel au survol d'un
     « + » (vague ou ligne fantôme) — montre QUEL texte sera injecté. */
  textarea.inp.hl-target {
    outline: 1px solid var(--vscode-focusBorder);
    background: color-mix(in srgb, var(--vscode-focusBorder) 12%, var(--vscode-input-background));
  }
  input.inp {
    width: 100%; box-sizing: border-box; font: inherit; font-size: 11px;
    padding: 3px 6px; border-radius: 3px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, rgba(128,128,128,.35)));
  }
  .wave-hdr {
    display: flex; align-items: center; gap: 6px;
    margin: 10px 0 4px; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted);
  }
  .wave-hdr::before, .wave-hdr::after { content: ''; flex: 1; height: 1px; background: var(--vscode-panel-border, rgba(128,128,128,.35)); }
  .wave-hdr-label {
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  /* Séparateur devenu bouton de lancement (lot 4 §2) : la prochaine vague à
     ouvrir remplace le bouton ▶ du bas — plus de ligne dédiée, la même
     sémantique (dim = auto, franc/bleu = attend l'humain) que l'ancien
     bouton, portée sur le séparateur lui-même. Vagues déjà lancées/en file
     au-delà de la prochaine restent le style inerte ci-dessus. */
  .wave-hdr.launch {
    cursor: pointer; justify-content: center;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
    border-radius: 12px; padding: 3px 10px;
  }
  .wave-hdr.launch::before, .wave-hdr.launch::after { content: none; }
  .wave-hdr.launch:hover { background: var(--vscode-list-hoverBackground); }
  .wave-hdr.launch.pri {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-background);
  }
  .wave-hdr.launch.pri:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
  /* Ligne fantôme « + nouvelle vague » : toujours présente en fin de groupe. */
  .wave-ghost {
    display: flex; align-items: center; justify-content: center;
    margin: 10px 0 4px; padding: 3px 4px; border-radius: 3px; cursor: pointer;
    font-size: 10px; letter-spacing: .06em; color: var(--muted);
    border-top: 1px dashed var(--vscode-panel-border, rgba(128,128,128,.35));
  }
  .wave-ghost:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); }
  .task {
    margin-bottom: 6px; padding: 6px; border-radius: 4px;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
  }
  .task-top { display: flex; gap: 4px; align-items: flex-start; }
  .task-top textarea { flex: 1; min-width: 0; }
  .task-row { display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: center; margin-top: 5px; }
  .task-row .lbl { font-size: 10px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
  /* Un libellé ne doit JAMAIS se retrouver seul en fin de ligne, séparé des
     boutons qu'il nomme : la sidebar est étroite, le retour à la ligne est la
     règle, pas l'exception. Chaque couple libellé+segment est donc insécable. */
  .pair { display: inline-flex; align-items: center; gap: 4px; }
  .xdel {
    flex: none; border: 0; background: none; cursor: pointer;
    color: var(--muted); font-size: 13px; line-height: 1; padding: 2px 4px; border-radius: 3px;
  }
  .xdel:hover { color: var(--vscode-errorForeground, #f14c4c); background: var(--vscode-list-hoverBackground); }
  .seg {
    display: inline-flex; border-radius: 3px; overflow: hidden;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
  }
  .seg button {
    font: inherit; font-size: 10px; padding: 2px 5px; cursor: pointer;
    border: 0; border-right: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
    background: transparent; color: var(--muted);
  }
  .seg button:last-child { border-right: 0; }
  .seg button:hover { background: var(--vscode-list-hoverBackground); }
  .seg button.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .seg.off button { opacity: .4; cursor: default; }
  .form-foot { display: flex; gap: 6px; align-items: center; margin-top: 10px; }
  .form-foot .spacer { flex: 1; }
  /* Badge d'écart intention/réel : le seul endroit du panneau qui parle de ce
     qui a été DEMANDÉ. Discret et non cliquable — c'est un constat, pas une
     action (la correction se fait par /model dans la conversation). */
  .mismatch { color: var(--vscode-errorForeground, #f14c4c); font-size: 10px; }
  .conv .mismatch { display: none; }
  .conv .mismatch.show { display: block; }

  /* ── Groupes (lot 2) ──────────────────────────────────────────────────────
     Un groupe est un LIANT, pas un cadre : un filet vertical teinté du groupe
     et un en-tête, rien de plus. Les lignes de conversation à l'intérieur sont
     exactement celles de la liste plate — même nœud, même rendu, même clic. */
  .grp { margin: 2px 0 8px; }
  .grp-head {
    display: flex; align-items: center; gap: 5px;
    padding: 3px 4px; border-radius: 3px; cursor: pointer; user-select: none;
  }
  .grp-head:hover { background: var(--vscode-list-hoverBackground); }
  .grp-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; }
  /* Titre = TOUJOURS le nom court du groupe (lot allègement v2 2026-07-24,
     volet C — renverse le choix « titre = conv maîtresse » de la 2.20.0) :
     la maîtresse a désormais sa propre ligne pleine largeur, plus rien à
     afficher ici. */
  .grp-name {
    flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: 12px; font-weight: 600;
  }
  .grp-count { flex: none; font-size: 10px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .grp-head .spacer { flex: 1 1 auto; }
  /* Fix régression 2.20.0 : sans flex:none, un titre de groupe long comprimait
     le segment auto/manuel jusqu'à le rendre illisible. Seul .grp-name (titre,
     ellipsis) et .spacer doivent pouvoir rétrécir — tout le reste de l'en-tête
     est fixe. */
  .grp-adv { flex: none; font-size: 9px; margin-right: 2px; }
  .grp-adv[hidden] { display: none; }
  .gbtn {
    flex: none; border: 0; background: none; cursor: pointer; padding: 1px 4px;
    border-radius: 3px; font-size: 11px; line-height: 1.2; color: var(--muted);
  }
  .gbtn:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); }
  /* Filet vertical teinté du groupe : ce qui rattache visuellement les lignes à
     leur en-tête sans les enfermer dans une boîte. padding-top (lot 5 §2ter) :
     bloque le margin-collapse du 1er séparateur de vague, sinon le trait part
     avec un trou visible sous le cadre de la master. */
  .grp-body { border-left: 2px solid var(--muted); margin-left: 7px; padding-left: 5px; padding-top: 1px; }
  .grp-body.collapsed { display: none; }
  /* Conv maîtresse (lot allègement v2 2026-07-24, volet C) : rendue au format
     STANDARD d'une ligne de conv (même fabrique que la liste, rowFor) —
     pleine largeur, hors du filet vertical des membres, jamais dupliquée
     (le groupe l'ACCUEILLE, la liste la cède). Vide (aucune maîtresse) → pas
     de hauteur. Repliée avec le reste du groupe via .collapsed.
     Cadre variante B (lot 5 §2ter, maquette validée MOCKUP_master_cadre) :
     teinte du groupe (bordure + fond légèrement teinté), coin bas-gauche à 0
     pour que le filet du corps (même teinte) parte du cadre sans couture.
     Couleur/fond posés en JS (renderGroups, dépend de g.hue) — ici seulement
     la forme. Dépassement à gauche du filet si le corps est indenté :
     accepté par l'user, aucun alignement forcé. */
  .grp-master-slot {
    border: 2px solid var(--muted); border-radius: 6px; border-bottom-left-radius: 0;
    padding: 4px 6px; margin: 2px 0 0 0;
  }
  .grp-master-slot:empty { display: none; border: 0; padding: 0; margin: 0; }
  .grp-master-slot.collapsed { display: none; }
  /* Fallback hors-vue (ni transcript ni onglet dans la fenêtre du panneau) :
     titre persisté grisé, sans état ni ctx — dégradation silencieuse. */
  .conv.off .title { color: var(--muted); text-decoration: line-through; }
  .conv.off:hover { background: none; }
  /* Moteur de vagues (lot 4) : en-tête de vague identique à celui du formulaire,
     toggle auto/manuel dans l'en-tête de groupe, contrôle de vague suivante en
     bas de la vague courante. */
  .wave-ctrl { margin: 2px 0 10px; }
  .wave-ctrl:empty { display: none; margin: 0; }
  .wave-ctrl .btn { margin-top: 3px; }
  /* Ligne + croix rouge dans le MÊME flux flex (lot 5 §2bis) : .m-slot
     rétrécit (min-width: 0, comme tout maillon de la chaîne de troncature
     du lot 4 §3), la croix reste fixe — l'ellipsis du titre s'arrête avant
     elle, plus de recouvrement possible par construction (contraste avec
     l'ancien .m-out en position: absolute). */
  .m-head { display: flex; align-items: flex-start; gap: 4px; min-width: 0; }
  .m-slot { flex: 1; min-width: 0; }
  /* Ligne d'un membre PAS ENCORE lié à une conversation : le prompt, et
     l'aveu qu'on ne sait pas encore de quelle conv il s'agit. Jamais un état
     emprunté à une autre — un membre non lié n'a pas d'état. */
  .m-pending {
    display: grid; grid-template-columns: 16px 1fr; gap: 8px;
    padding: 5px 6px; border-radius: 4px;
  }
  .m-pending .ico-pending {
    margin-top: 4px; width: 9px; height: 9px; justify-self: center; box-sizing: border-box;
    border: 1.5px dashed var(--muted); border-radius: 2px;
  }
  .m-body { min-width: 0; }
  .m-prompt {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--muted); font-size: 12px;
  }
  /* Modèle · effort PRÉVUS sur une tâche pas encore lancée (lot 4 §4) : simple
     intention, jamais confondue avec la pastille d'écart (mismatchOf) d'une
     conv réelle — grisé + italique, distinct du texte plein du prompt. */
  .m-intent {
    display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: 10px; font-style: italic; color: var(--muted); opacity: .75;
  }
  /* Actions d'un membre : sous sa ligne, alignées sur le titre (16 px d'icône +
     8 px de gouttière). Le retrait (croix rouge cerclée, lot 4 §1, devenue
     l'unique sortie au lot 5) est passé inline sur la ligne elle-même — le
     pied ne garde plus que « Link… » et ◂/▸ ; vide, il ne réserve plus de
     hauteur. ◂/▸ (déplacer une tâche en file vers une vague voisine) restent
     au survol : action d'édition ponctuelle du formulaire de vagues, hors
     périmètre de ce lot. */
  .m-foot { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 0 0 3px 24px; }
  .m-foot:empty { display: none; }
  .m-note { font-size: 10px; color: var(--muted); }
  .m-hover { opacity: 0; transition: opacity .1s; }
  .member:hover .m-hover, .m-hover:focus-visible { opacity: 1; }
  /* Croix rouge cerclée = seule action de sortie d'un membre (lot 5), inline
     à droite de sa ligne — élément du flux flex de .m-head (flex: none),
     JAMAIS en position: absolute (lot 5 §2bis, fix de la superposition avec
     le texte) : le titre tronqué (ellipsis, .m-slot) s'arrête avant elle par
     construction. Distincte du badge ⨯ de fermeture d'onglet de la liste
     générale (celui-ci ferme un onglet seul ; celle-ci ferme ET retire). */
  .m-out {
    flex: none; margin-top: 4px;
    width: 15px; height: 15px; box-sizing: border-box; padding: 0;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: 50%; border: 1px solid var(--vscode-errorForeground, #f14c4c);
    background: var(--vscode-sideBar-background, var(--vscode-editor-background, transparent));
    color: var(--vscode-errorForeground, #f14c4c);
    font-size: 9px; line-height: 1; cursor: pointer;
  }
  .m-out:hover { background: var(--vscode-errorForeground, #f14c4c); color: var(--vscode-editor-background, #fff); }
  .chip {
    font-size: 10px; padding: 0 5px; border-radius: 8px; border: 0; cursor: default;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    font-family: inherit;
  }
  .chip.act { cursor: pointer; }
  .chip.act:hover { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
</style>
</head>
<body>
  <div class="topbar">
    <button class="sounds-toggle" id="soundsToggle" title="${vscode.l10n.t('Toggle notification sounds')}"></button>
  </div>
  <section>
    <div class="sec-head" id="convHead">
      <span class="chevron" id="convChevron">▾</span>
      <h2>${vscode.l10n.t('Conversations')} <span class="count" id="convCount"></span></h2>
      <span class="spacer"></span>
      <select class="sort-select" id="sortSelect" title="${vscode.l10n.t('Sort conversations by')}">
        <option value="tabOrder">${vscode.l10n.t('Tab order')}</option>
        <option value="lastActivity">${vscode.l10n.t('Last activity')}</option>
        <option value="statusFirst">${vscode.l10n.t('Status first')}</option>
      </select>
    </div>
    <div class="sec-body" id="convBody">
      <div class="canary" id="canary">${vscode.l10n.t('⚠ Claude tabs not detected — viewType changed?')}</div>
      <div id="groups"></div>
      <div id="convs"></div>
      <div class="batch" id="batch">
        <div class="sec-head sub" id="newConvHead" title="${vscode.l10n.t('Open several conversations at once, each with its own prompt, model and effort.')}">
          <span class="chevron" id="newConvChevron">▾</span>
          <h3>${vscode.l10n.t('New conversation')}</h3>
          <span class="spacer"></span>
          <span class="tip-restore" id="newConvTipRestore" title="${vscode.l10n.t('Show this tip again')}" style="display:none">?</span>
        </div>
        <div class="sec-body" id="newConvBody">
          <div class="notice" id="batchNotice"></div>
          <div id="batchForm"></div>
        </div>
      </div>
    </div>
  </section>
  <section>
    <div class="sec-head" id="quotaHead">
      <span class="chevron" id="quotaChevron">▾</span>
      <h2>${vscode.l10n.t('Quota')}</h2>
    </div>
    <div class="sec-body" id="quotaBody">
      <div id="quota"></div>
    </div>
  </section>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  // Lot 15 : bundle actif de la locale VS Code, injecté par l'hôte
  // d'extension (renderHtml → vscode.l10n.bundle) — vide en anglais (source),
  // clé/valeur = texte source anglais → traduction sinon. t() est le pendant
  // local de vscode.l10n.t(), avec les mêmes placeholders {0}/{1}…
  const L10N_BUNDLE = ${bundleJson};
  function t(message) {
    const args = Array.prototype.slice.call(arguments, 1);
    const s = (L10N_BUNDLE && L10N_BUNDLE[message]) || message;
    return args.length ? s.replace(/\\{(\\d+)\\}/g, function (_, i) { return args[Number(i)] !== undefined ? args[Number(i)] : ''; }) : s;
  }
  const convsEl = document.getElementById('convs');
  const groupsEl = document.getElementById('groups');
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
  const newConvHeadEl = document.getElementById('newConvHead');
  const newConvChevronEl = document.getElementById('newConvChevron');
  const newConvBodyEl = document.getElementById('newConvBody');
  const newConvTipRestoreEl = document.getElementById('newConvTipRestore');

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
  // Lot 12 §1 : repli du lanceur unifié, persisté en workspaceState (comme les
  // groupes) — pas un setting global, ce serait le suivre d'un projet à l'autre.
  newConvHeadEl.addEventListener('click', function (e) {
    if (newConvTipRestoreEl.contains(e.target)) return;
    vscode.postMessage({ type: 'toggleCollapse', section: 'newConversation' });
  });
  newConvTipRestoreEl.addEventListener('click', function () {
    vscode.postMessage({ type: 'restoreBatchTip' });
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
    const collapsedNewConv = !!(ui && ui.collapsedNewConversation);
    newConvBodyEl.classList.toggle('collapsed', collapsedNewConv);
    newConvChevronEl.textContent = collapsedNewConv ? '▸' : '▾';
    const order = (ui && ui.sortOrder) || 'tabOrder';
    if (sortSelectEl.value !== order) sortSelectEl.value = order;
  }

  // Icône haut-parleur : reflète l'état réel du setting, pas un état local —
  // l'extension repousse le nouvel état à toutes les fenêtres après un clic
  // (onDidChangeConfiguration), y compris celle qui n'a pas cliqué.
  function renderSoundsToggle(enabled) {
    soundsToggleEl.textContent = enabled ? '🔊' : '🔇';
    soundsToggleEl.classList.toggle('on', !!enabled);
    soundsToggleEl.title = enabled ? t('Notification sounds: on (click to mute)') : t('Notification sounds: off (click to enable)');
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
    if (c.state === 'busy') return t('working…');
    if (c.state === 'waiting') return t('waiting for you');
    if (c.state === 'stale') return t('stale — no activity for a while');
    if (c.state === 'done') return c.acked ? t('done — read') : t('done — not read yet');
    if (c.state === 'interrupted') return t('interrupted — unfinished');
    return t('nothing running');
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

  // « opus · high » tel que demandé au lancement — n'est rendu que dans le
  // badge d'écart, jamais comme information principale.
  function askedLabel(c) {
    const a = c.asked || {};
    const parts = [];
    if (a.model) parts.push(a.model);
    if (a.effort) parts.push(a.effort);
    return parts.join(' · ');
  }

  function createRow() {
    const root = el('div', 'conv');
    const ico = el('span', 'ico');
    const body = el('div', 'body');
    const title = el('div', 'title');
    const meta = el('div', 'meta');
    const model = el('span', 'model');
    const ctx = el('span', 'ctx');
    const mismatch = el('div', 'mismatch');
    const ctxBar = bar('bar-ctx', 0);
    meta.appendChild(model);
    meta.appendChild(ctx);
    body.appendChild(title);
    body.appendChild(meta);
    body.appendChild(mismatch);
    body.appendChild(ctxBar);
    root.appendChild(ico);
    root.appendChild(body);
    const row = { root, ico, title, model, ctx, mismatch, ctxBar, fill: ctxBar.firstChild, data: null };
    root.addEventListener('click', function () {
      // tabTitle : titre RÉEL de l'onglet quand il diverge de celui du
      // transcript — sans lui, focus.js ne retrouve pas un onglet renommé.
      if (row.data) vscode.postMessage({ type: 'focusConv', id: row.data.id, title: row.data.title, tabTitle: row.data.tabTitle || null });
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
    setText(row.title, c.title || t('Untitled'));
    // Terminée · onglet fermé (lot 4 §5) : barré en plus du reste — découle de
    // tabOpen (member-truth), jamais d'une mémoire locale. Rouvrir l'onglet
    // repasse tabOpen à true et efface le barré tout seul au prochain rendu.
    row.title.classList.toggle('closed', c.state === 'done' && !c.tabOpen);
    // Modèle ET effort RÉELS, lus du transcript (décision 6 du plan). L'effort
    // manque sur les conversations qui n'en portent pas : on n'écrit alors rien
    // de plus, jamais une valeur supposée.
    setText(row.model, (c.model || '—') + (c.effort ? ' · ' + c.effort : ''));
    // Écart avec ce qui avait été demandé au lancement — la seule chose que le
    // panneau dit de l'intention, et seulement quand elle diverge du réel.
    const mm = c.mismatch;
    setText(row.mismatch, mm ? t('⚠ asked {0}', askedLabel(c)) : '');
    row.mismatch.classList.toggle('show', !!mm);
    setText(row.ctx, c.ctx ? t('ctx {0}%', Math.round(c.ctx.pct)) : '');
    row.ctxBar.style.display = c.ctx ? '' : 'none';
    if (c.ctx) {
      const w = Math.min(100, Math.max(1, c.ctx.pct)) + '%';
      if (row.fill.style.width !== w) row.fill.style.width = w;
    }
  }

  // Ne déplacer que ce qui est mal placé : réinsérer un nœud relance ses
  // animations CSS — exactement ce qu'on veut éviter pour le spinner. Vaut
  // aussi bien pour la liste plate que pour l'intérieur d'un groupe : une
  // conversation qui passe de l'une à l'autre change de parent une seule fois.
  function place(parent, index, node) {
    if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] || null);
  }

  // « total » compte TOUTES les conversations (groupées comprises) : le compteur
  // de l'en-tête et le message « aucune conversation » parlent de la section
  // entière, pas seulement de ce qui reste hors des groupes.
  function renderConvs(list, total, seen) {
    countEl.textContent = total ? String(total) : '';

    let empty = convsEl.querySelector('.empty');
    if (!total) {
      if (!empty) convsEl.appendChild(el('div', 'empty', t('No recent conversation here.')));
      return;
    }
    if (empty) empty.remove();

    list.forEach(function (c, i) {
      if (seen) seen.add(c.id);
      place(convsEl, i, rowFor(c).root);
    });
  }

  // Une ligne par conversation, créée une fois et réutilisée — c'est ce qui
  // permet à une conv de passer de la liste plate à un groupe (et retour) sans
  // que sa pastille d'activité ne reparte de zéro.
  function rowFor(c) {
    let row = rows.get(c.id);
    if (!row) { row = createRow(); rows.set(c.id, row); }
    updateRow(row, c);
    return row;
  }

  // Lignes de conversation devenues inutiles (conv disparue du snapshot) :
  // purgées APRÈS le rendu des groupes ET de la liste plate, car les deux
  // puisent dans la même table.
  function pruneRows(seen) {
    rows.forEach(function (row, id) {
      if (seen.has(id)) return;
      row.root.remove();
      rows.delete(id);
    });
  }

  // ── Groupes (lot 2) ──────────────────────────────────────────────────────
  // Nœuds conservés d'un rendu à l'autre, même raison que les lignes de conv :
  // un push d'état arrive toutes les 30 s au minimum, et bien plus souvent
  // pendant qu'une conversation travaille.
  const groupNodes = new Map();   // id → { root, dot, name, count, chev, body, members: Map }

  function createGroupNode(g) {
    const root = el('div', 'grp');
    const head = el('div', 'grp-head');
    const chev = el('span', 'chevron');
    const dot = el('span', 'grp-dot');
    const name = el('span', 'grp-name');
    const count = el('span', 'grp-count');
    const spacer = el('span', 'spacer');
    // Passage de vague (lot 4) : visible seulement quand le groupe a plus
    // d'une vague — inutile (et trompeur) avec une vague unique.
    const advA = el('button', '', t('auto'));
    advA.type = 'button';
    advA.title = t('Advance to the next wave automatically once this one is fully done');
    const advM = el('button', '', t('manual'));
    advM.type = 'button';
    advM.title = t('Only advance to the next wave when I click ▶');
    const adv = el('span', 'seg grp-adv');
    adv.appendChild(advA);
    adv.appendChild(advM);
    const add = el('button', 'gbtn', '+');
    add.type = 'button';
    add.title = t('Add an existing conversation to this group');
    // Conv maîtresse (lot 11) : la conversation d'où vient ce lot. Le bouton
    // reste là même quand elle est déjà désignée — c'est aussi le chemin pour
    // en changer (l'action « Unset » vit sur la ligne elle-même).
    const mas = el('button', 'gbtn', '⌂');
    mas.type = 'button';
    mas.title = t('Set / change / unlink the conversation this batch came from');
    const ren = el('button', 'gbtn', '✎');
    ren.type = 'button';
    ren.title = t('Rename this group');
    const dis = el('button', 'gbtn', '⨯');
    dis.type = 'button';
    dis.title = t('Dissolve this group (conversations are kept, nothing is closed)');
    head.appendChild(chev);
    head.appendChild(dot);
    head.appendChild(name);
    head.appendChild(count);
    head.appendChild(spacer);
    head.appendChild(adv);
    head.appendChild(mas);
    head.appendChild(add);
    head.appendChild(ren);
    head.appendChild(dis);
    // La conv maîtresse (volet C) vit ENTRE l'en-tête et le corps, HORS du
    // filet vertical du corps — pleine largeur, comme une ligne de la liste.
    const masterSlot = el('div', 'grp-master-slot');
    const body = el('div', 'grp-body');
    root.appendChild(head);
    root.appendChild(masterSlot);
    root.appendChild(body);

    // waveHeaders : un nœud par numéro de vague, réutilisé d'un rendu à
    // l'autre (même raison que members/rows — ne pas relancer d'animation).
    // waveCtrl : la zone « ▶ lancer la vague suivante » / bannière, une par
    // groupe, repositionnée juste après la vague courante à chaque rendu.
    // Ligne fantôme « + nouvelle vague » (plan ajout-tache 2026-07-24) :
    // TOUJOURS présente en fin de groupe, groupe fini compris (décision 2
    // du design) — un clic crée la vague max+1, jamais une vague existante.
    const ghostRow = el('div', 'wave-ghost', t('┄ + new wave ┄'));
    ghostRow.title = t('Add a task in a new wave after the last one');
    const node = {
      root, head, chev, dot, name, count, body, members: new Map(), id: g.id,
      advA, advM, waveHeaders: new Map(), waveAddRows: new Map(), waveCtrl: el('div', 'wave-ctrl'),
      masterSlot, masterOff: null, ghostRow,
    };
    head.addEventListener('click', function (e) {
      if (e.target !== head && head.contains(e.target) && (e.target.classList.contains('gbtn') || e.target.closest('.grp-adv'))) return;
      vscode.postMessage({ type: 'toggleGroupCollapse', id: node.id });
    });
    mas.addEventListener('click', function (e) { e.stopPropagation(); vscode.postMessage({ type: 'setGroupMaster', id: node.id }); });
    add.addEventListener('click', function (e) { e.stopPropagation(); vscode.postMessage({ type: 'addToGroup', id: node.id }); });
    ren.addEventListener('click', function (e) { e.stopPropagation(); vscode.postMessage({ type: 'renameGroup', id: node.id }); });
    dis.addEventListener('click', function (e) { e.stopPropagation(); vscode.postMessage({ type: 'dissolveGroup', id: node.id }); });
    advA.addEventListener('click', function (e) { e.stopPropagation(); if (!advA.classList.contains('on')) vscode.postMessage({ type: 'toggleGroupAdvance', id: node.id }); });
    advM.addEventListener('click', function (e) { e.stopPropagation(); if (!advM.classList.contains('on')) vscode.postMessage({ type: 'toggleGroupAdvance', id: node.id }); });
    ghostRow.addEventListener('click', function (e) { e.stopPropagation(); addTaskAtWave(node.id, null); });
    ghostRow.addEventListener('mouseenter', function () { highlightPromptField(true); });
    ghostRow.addEventListener('mouseleave', function () { highlightPromptField(false); });
    return node;
  }

  // Ligne de la conv maîtresse quand elle est HORS de la fenêtre du panneau
  // (pas de transcript+onglet suivis, ou au-delà de maxItems) — fabrique à
  // part de rowFor() car il n'y a alors aucun objet conv réel à rendre : juste
  // le titre persisté au moment du lien, grisé, sans état ni ctx. Dégradation
  // silencieuse (volet C) : un nœud par groupe, réutilisé d'un rendu à l'autre.
  function createMasterOffRow() {
    const root = el('div', 'conv off');
    const ico = el('span', 'ico');
    const body = el('div', 'body');
    const title = el('div', 'title');
    body.appendChild(title);
    root.appendChild(ico);
    root.appendChild(body);
    const node = { root, title, data: null };
    root.addEventListener('click', function () {
      if (!node.data || !node.data.convId) return;
      vscode.postMessage({ type: 'focusConv', id: node.data.convId, title: node.data.title, tabTitle: node.data.tabTitle || null });
    });
    return node;
  }

  // Enveloppe d'un membre : la ligne de conversation (ou, à défaut, le prompt
  // en attente) plus le pied d'actions propre au groupe.
  function createMemberNode(gid, key) {
    const root = el('div', 'member');
    // La ligne (conv réelle ou prompt en attente) et la croix rouge partagent
    // un flux flex (lot 5 §2bis) : l'ellipsis du titre s'arrête AVANT la
    // croix, jamais de superposition possible par construction — contraste
    // avec l'ancien .m-out en position: absolute qui recouvrait le texte.
    const head = el('div', 'm-head');
    const slot = el('div', 'm-slot');
    const foot = el('div', 'm-foot');
    const note = el('span', 'm-note');
    const linkChip = el('button', 'chip act', t('Link…'));
    linkChip.type = 'button';
    linkChip.title = t('Link this task to an existing conversation');
    // Croix rouge cerclée = SEULE action de sortie d'un membre (lot 5, décision
    // user ~15h, remplace la version contextuelle envisagée d'abord et le chip
    // vert « fermer & retirer ») : ferme l'onglet PUIS retire, dans tous les
    // cas — onglet déjà fermé ou tâche jamais lancée → rien à fermer, le
    // retrait seul. Le garde-fou (confirmation si la conv travaille encore)
    // vit côté extension.js, seul endroit qui connaît l'état réel.
    const outChip = el('button', 'm-out', '✕');
    outChip.type = 'button';
    outChip.title = t('Close the tab and remove it from the group');
    // Édition en cours de route (lot 4, décision 5) : déplacer une tâche PAS
    // ENCORE LANCÉE vers la vague voisine — une fois lancée, elle ne bouge
    // plus (groups.js moveQueuedMember refuse déjà le cas, ceci n'est que
    // l'affordance ; visible seulement pour status === 'queued'.
    const moveBack = el('button', 'chip act m-hover', t('◂ wave'));
    moveBack.type = 'button';
    moveBack.title = t('Move to the previous wave');
    const moveFwd = el('button', 'chip act m-hover', t('wave ▸'));
    moveFwd.type = 'button';
    moveFwd.title = t('Move to the next wave');
    foot.appendChild(note);
    foot.appendChild(linkChip);
    foot.appendChild(moveBack);
    foot.appendChild(moveFwd);
    head.appendChild(slot);
    head.appendChild(outChip);
    root.appendChild(head);
    root.appendChild(foot);

    const node = { root, slot, foot, note, linkChip, outChip, moveBack, moveFwd, conv: null };
    moveBack.addEventListener('click', function () { vscode.postMessage({ type: 'moveMemberWave', id: gid, key: key, delta: -1 }); });
    moveFwd.addEventListener('click', function () { vscode.postMessage({ type: 'moveMemberWave', id: gid, key: key, delta: 1 }); });
    linkChip.addEventListener('click', function () { vscode.postMessage({ type: 'linkMember', id: gid, key: key }); });
    outChip.addEventListener('click', function () {
      vscode.postMessage({
        type: 'closeAndRemoveMember', id: gid, key: key,
        title: node.conv ? node.conv.title : null,
        tabTitle: (node.conv && node.conv.tabTitle) || null,
      });
    });
    return node;
  }

  // Ligne d'un membre sans conversation rendue : le prompt tel qu'il a été
  // inséré, et rien d'emprunté. Le POURQUOI (jamais lancée, onglet ouvert sans
  // Entrée, terminée puis fermée, interrompue…) n'est plus déduit ici : il
  // arrive tout résolu dans m.hint, écrit par la table de vérité unique
  // (member-truth.js, lot 10). Une déduction locale de plus, c'était une
  // 5e occasion de dire l'inverse du reste du panneau.
  function pendingLine(m) {
    const wrap = el('div', 'm-pending');
    wrap.appendChild(el('span', 'ico-pending'));
    const body = el('div', 'm-body');
    body.appendChild(el('div', 'm-prompt', m.prompt || t('(no prompt)')));
    // Modèle · effort PRÉVUS (lot 4 §4) : ce qui a été demandé au lancement de
    // CETTE tâche (m.asked, même forme que le badge d'écart des convs réelles)
    // — jamais confondu avec mismatchOf, qui compare intent/réel APRÈS coup.
    const intent = askedLabel(m);
    if (intent) {
      const im = el('span', 'm-intent', intent);
      im.title = t('Launch intention — will be confirmed by the real conversation.');
      body.appendChild(im);
    }
    wrap.appendChild(body);
    wrap.title = m.hint || '';
    return wrap;
  }

  // Contenu de la zone sous la vague en cours (lot 4 §2 : plus de bouton ▶ ici,
  // le séparateur de la prochaine vague le remplace — ne restent que les
  // bannières, seule chose qu'aucun autre élément du panneau ne dit déjà).
  // blocked est calculé une fois par renderGroups et partagé avec le
  // séparateur cliquable, pour ne jamais dériver deux fois le même fait.
  function renderWaveCtrl(node, g, blocked) {
    node.waveCtrl.replaceChildren();
    if (g.waveNotice) node.waveCtrl.appendChild(el('div', 'banner info', g.waveNotice));
    if (g.nextWave == null) return;
    if (blocked) {
      node.waveCtrl.appendChild(el('div', 'banner err',
        t('A task in wave {0} will not finish on its own (interrupted, or its tab was closed before anything was sent) — auto advance is suspended. Use ▶ to force wave {1}.', g.launchedWave, g.nextWave)));
    }
  }

  function renderGroups(groups, convById, seen) {
    const live = new Set();
    groups.forEach(function (g, gi) {
      live.add(g.id);
      let node = groupNodes.get(g.id);
      if (!node) { node = createGroupNode(g); groupNodes.set(g.id, node); }
      node.id = g.id;

      // Comptages et vagues parlent le vocabulaire du moteur (waveStatus),
      // pas le statut d'affichage : « terminée, onglet fermé » compte comme
      // terminée — c'est précisément ce que le lot 10 rétablit.
      const done = g.members.filter(function (m) { return m.waveStatus === 'done'; }).length;
      // Titre d'en-tête = TOUJOURS le nom court du groupe (volet C, lot
      // allègement v2 2026-07-24 — renverse le choix 2.20.0) : la conv
      // maîtresse a désormais sa propre ligne, plus rien à afficher ici.
      setText(node.name, g.name);
      node.name.title = g.name;
      // Teinte stable dérivée du nom (groups.js) : la seule couleur libre du
      // panneau, tout le reste suit le thème.
      node.dot.style.background = 'hsl(' + g.hue + ', 60%, 58%)';
      node.body.style.borderLeftColor = 'hsl(' + g.hue + ', 45%, 55%)';
      // Cadre de la master (lot 5 §2ter, variante B) : MÊME couleur que le
      // filet du corps (jonction sans couture, décision explicite du plan) —
      // posé même quand g.master est absent (le slot est alors :empty,
      // invisible), pas de branchement de plus.
      node.masterSlot.style.borderColor = node.body.style.borderLeftColor;
      node.masterSlot.style.background = 'hsla(' + g.hue + ', 45%, 55%, .08)';
      setText(node.count, done + '/' + g.members.length + ' done');
      setText(node.chev, g.collapsed ? '▸' : '▾');
      node.body.classList.toggle('collapsed', !!g.collapsed);
      node.masterSlot.classList.toggle('collapsed', !!g.collapsed);

      // Conv maîtresse (volet C) : NŒUD DOM UNIQUE — la même fabrique que la
      // liste plate (rowFor), déplacée ici plutôt que dupliquée. Le filtrage
      // de la liste plate (handler de message, plus bas) garantit qu'un id de
      // conv ne se revendique jamais à deux endroits du DOM à la fois. Hors
      // de la fenêtre du panneau (g.master.listed faux) → fallback dégradé,
      // jamais de nœud manquant.
      if (g.master) {
        const ms = g.master;
        const mc = ms.listed ? convById[ms.convId] : null;
        if (mc) {
          seen.add(mc.id);
          place(node.masterSlot, 0, rowFor(mc).root);
        } else {
          if (!node.masterOff) node.masterOff = createMasterOffRow();
          node.masterOff.data = ms;
          setText(node.masterOff.title, ms.title || t('Master conversation'));
          node.masterOff.root.title = (ms.title || '') + (ms.hint ? ' — ' + ms.hint : '');
          node.masterOff.root.style.cursor = ms.convId ? 'pointer' : 'default';
          place(node.masterSlot, 0, node.masterOff.root);
        }
        while (node.masterSlot.children.length > 1) node.masterSlot.lastChild.remove();
      } else {
        node.masterSlot.replaceChildren();
        node.masterOff = null;
      }

      // Toggle auto/manuel (lot 4) : masqué avec une vague unique — rien à
      // ordonnancer, le montrer serait un contrôle sans effet.
      const waveNums = [...new Set(g.members.map(function (m) { return m.wave; }))].sort(function (a, b) { return a - b; });
      const multiWave = waveNums.length > 1;
      node.advA.parentElement.hidden = !multiWave;
      node.advA.classList.toggle('on', !!g.autoAdvance);
      node.advM.classList.toggle('on', !g.autoAdvance);

      // Calculé UNE fois, partagé entre la bannière de blocage (renderWaveCtrl)
      // et le séparateur-bouton de la prochaine vague (lot 4 §2) — même
      // sémantique que l'ancien bouton ▶ (dim = auto + pas bloqué), jamais
      // re-dérivée deux fois.
      const curMembers = g.members.filter(function (m) { return m.wave === g.launchedWave; });
      const blocked = curMembers.some(function (m) { return m.waveStatus === 'stale'; });
      const dim = g.autoAdvance && !blocked;

      const keys = new Set();
      let idx = 0;
      let ctrlPlaced = false;

      waveNums.forEach(function (w) {
        if (multiWave) {
          const hdr = node.waveHeaders.get(w) || (function () {
            const h = el('div', 'wave-hdr');
            const label = el('span', 'wave-hdr-label');
            h.appendChild(label);
            h._label = label;
            node.waveHeaders.set(w, h);
            return h;
          })();
          // Séparateur devenu bouton de lancement (lot 4 §2) : seule la
          // PROCHAINE vague à ouvrir (g.nextWave) porte le style cliquable —
          // vagues déjà lancées ou plus loin en file restent inertes, style
          // actuel. Fond bleu (primary) = le moteur attend l'humain (manuel,
          // ou bloqué — chemin de secours) ; transparent = pas le moment
          // (auto, non bloqué) mais cliquable = forcer, avec la même
          // confirmation modale que l'ancien bouton.
          const isLaunch = w === g.nextWave;
          setText(hdr._label, isLaunch ? t('▶ wave {0}', w) : (w > g.launchedWave ? t('wave {0} — queued', w) : t('wave {0}', w)));
          hdr.classList.toggle('launch', isLaunch);
          hdr.classList.toggle('pri', isLaunch && !dim);
          hdr.classList.toggle('dim', isLaunch && dim);
          hdr.title = (isLaunch && dim) ? t('Auto mode will open this wave by itself — click to force it now.') : '';
          hdr.onclick = isLaunch ? (function (wv, force) {
            return function (e) {
              e.stopPropagation();
              vscode.postMessage({ type: 'launchWave', id: node.id, wave: wv, force: force || undefined });
            };
          })(w, dim) : null;
          place(node.body, idx++, hdr);
        }
        // « + ajouter à cette vague » JAMAIS sur une vague déjà lancée ni la
        // vague en cours (design du plan ajout-tache) : seule une vague
        // strictement en file (w > launchedWave) le porte — y ajouter
        // reviendrait à la lancer aussitôt en mode auto, la surprise interdite.
        const queued = w > g.launchedWave;
        const addRow = node.waveAddRows.get(w) || (function () {
          const r = el('div', 'wave-ghost wave-add-row', t('┄ + add to this wave ┄'));
          r.addEventListener('click', function (e) { e.stopPropagation(); addTaskAtWave(g.id, w); });
          r.addEventListener('mouseenter', function () { highlightPromptField(true); });
          r.addEventListener('mouseleave', function () { highlightPromptField(false); });
          node.waveAddRows.set(w, r);
          return r;
        })();
        if (queued) addRow.title = t('Fill the prompt field above, then click here to queue it in this wave');
        g.members.filter(function (m) { return m.wave === w; }).forEach(function (m) {
          keys.add(m.key);
          let mn = node.members.get(m.key);
          if (!mn) { mn = createMemberNode(g.id, m.key); node.members.set(m.key, mn); }
          const c = m.convId ? convById[m.convId] : null;
          mn.conv = c || null;
          if (c) {
            seen.add(c.id);
            place(mn.slot, 0, rowFor(c).root);
            // La ligne de conv occupe la place : tout ce qui traîne d'un rendu
            // précédent (ligne « en attente ») doit partir.
            while (mn.slot.children.length > 1) mn.slot.lastChild.remove();
          } else {
            mn.slot.replaceChildren(pendingLine(m));
          }
          // Lot 10 — plus AUCUNE déduction de statut ici : canClose,
          // canLink et note viennent de member-truth.js, la table de
          // vérité unique. Le webview ne voit qu'une VUE (convById) ; c'est
          // elle qui a produit quatre bugs de suite (Link… fantôme,
          // « closed before sending », « done · closed » et stale au Create).
          // La croix rouge est désormais UNIFORME (lot 5) : plus de bascule
          // sur m.canClose, elle reste la seule action de sortie dans tous
          // les cas — canClose ne sert plus qu'à rien ici (member-truth.js
          // continue de l'exposer pour d'autres usages, non consommé côté
          // affichage du bouton).
          mn.linkChip.style.display = m.canLink ? '' : 'none';
          const noteText = m.note || '';
          setText(mn.note, noteText);
          mn.note.style.display = noteText ? '' : 'none';
          // Un bouton qui ne fait rien ment (cf. lot 1) : moveBack ne
          // s'affiche que si la vague précédente est ENCORE en file (au-delà
          // de launchedWave) — groups.js moveQueuedMember refuse sinon.
          const canMove = m.waveStatus === 'queued';
          mn.moveBack.style.display = canMove && w - 1 > g.launchedWave ? '' : 'none';
          mn.moveFwd.style.display = canMove && w < waveNums[waveNums.length - 1] ? '' : 'none';
          place(node.body, idx++, mn.root);
        });
        // Pleine largeur, centrée, APRÈS le dernier membre de la vague EN FILE
        // (jamais sur vague lancée/terminée — remplace l'ancien petit « + »
        // du séparateur, invisible/mal placé).
        if (queued) place(node.body, idx++, addRow);
        if (w === g.launchedWave) { renderWaveCtrl(node, g, blocked); place(node.body, idx++, node.waveCtrl); ctrlPlaced = true; }
      });
      // launchedWave hors des vagues connues (défensif — ne devrait pas
      // arriver, waves.js le calcule à partir de ces mêmes membres) : la zone
      // de contrôle n'a nulle part où s'accrocher au-dessus, elle vient en
      // fin de corps plutôt que de disparaître silencieusement.
      if (!ctrlPlaced) { renderWaveCtrl(node, g, blocked); place(node.body, idx++, node.waveCtrl); }
      // Ligne fantôme « + nouvelle vague » : TOUJOURS en fin de corps, y
      // compris groupe fini (décision 2 du design — en auto, la nouvelle
      // vague part au prochain battement du moteur, c'est assumé).
      place(node.body, idx++, node.ghostRow);
      // En-têtes de vague devenus inutiles (vague retirée par édition) — purge
      // avant de purger les membres, même logique.
      node.waveHeaders.forEach(function (hdr, w) {
        if (waveNums.indexOf(w) !== -1 && multiWave) return;
        hdr.remove();
        node.waveHeaders.delete(w);
      });
      node.waveAddRows.forEach(function (row, w) {
        if (waveNums.indexOf(w) !== -1) return;
        row.remove();
        node.waveAddRows.delete(w);
      });
      node.members.forEach(function (mn, key) {
        if (keys.has(key)) return;
        mn.root.remove();
        node.members.delete(key);
      });

      place(groupsEl, gi, node.root);
    });
    groupNodes.forEach(function (node, id) {
      if (live.has(id)) return;
      node.root.remove();
      groupNodes.delete(id);
    });
  }

  // ── Création groupée : formulaire (lot 1, toujours visible depuis le lot 12) ─
  // L'état du formulaire est LOCAL au webview et ne descend jamais de
  // l'extension : un push d'état (transition de conversation, tick quota)
  // écraserait la saisie en cours. Seul le message createBatch remonte, et
  // revalide tout (batch.js) — ce qui vient d'ici n'est pas fiable par nature.
  //
  // Les vagues sont SAISIES ici mais pas encore exécutées : au lot 1, « Create »
  // ouvre tout d'un coup. Le message de retour de l'extension le dit
  // explicitement plutôt que de laisser croire à un séquencement.
  //
  // Lot 12 : le formulaire n'est plus un panneau qu'on ouvre via « + New
  // batch » — « form » est TOUJOURS un objet, jamais « null ». Une seule tâche
  // = le lanceur simple (prompt + modèle/effort + Create), sans nom de groupe
  // ni vagues visibles ; le collage d'un texte multi-tâches ou « + Add task »
  // étend automatiquement l'affichage (décisions user 2026-07-23).
  const MODELS = ['haiku', 'sonnet', 'opus', 'fable'];
  const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
  const batchFormEl = document.getElementById('batchForm');
  const batchNoticeEl = document.getElementById('batchNotice');
  // batchState AVANT form (lot 14) : blankTask() lit désormais batchState.inherit
  // pour pré-sélectionner le défaut résolu — l'inverse lèverait une
  // ReferenceError (zone morte temporelle du let) au tout premier rendu.
  let batchState = { envConflict: [], busy: false, notice: null, inherit: { model: null, effort: null }, lastModel: null, lastEffort: null, tipDismissed: false };
  let form = { group: '', advance: 'auto', tasks: [blankTask(1)] };
  let createBtn = null;

  // Lot 14 : le bouton « inherit » disparaît, remplacé par une PRÉ-SÉLECTION
  // concrète. task.model/task.effort valent null tant que l'utilisateur n'a
  // rien cliqué — resolvedModel()/resolvedEffort() sont recalculées à CHAQUE
  // rendu (jamais mises en cache dans la tâche : « /effort dans n'importe
  // quelle conversation fait dériver ce défaut global », donc une tâche
  // encore sur le défaut doit suivre si le défaut change en cours de route).
  // effectiveModel()/effectiveEffort() donnent la valeur à la fois AFFICHÉE
  // (bouton allumé) et LANCÉE (Create) pour une tâche donnée — un clic
  // explicite de l'utilisateur (task.model = v) prime toujours sur le défaut.
  // Résolution impossible (settings illisibles/absents, valeur hors de
  // MODELS/EFFORTS) ⇒ null — aucun bouton n'est allumé, jamais une valeur
  // inventée ; refreshCreateBtn() désactive alors Create.
  function resolvedModel() {
    // Dernier choix explicite du formulaire (plan sélecteurs 2026-07-24) :
    // prime toujours sur le défaut global « inherit », qui ne sert plus que de
    // repli au tout premier usage (jamais renseigné en workspaceState).
    if (batchState.lastModel && MODELS.indexOf(batchState.lastModel) !== -1) return batchState.lastModel;
    const raw = batchState.inherit && batchState.inherit.model;
    if (!raw) return null;
    // « opus[1m] » → famille « opus » : les boutons segmentés n'ont que les
    // familles nues (lot 7/12), on pré-sélectionne dessus (écart assumé du
    // lot 14 — cf. batch.js resolveDefaultModel).
    const stripped = raw.replace(/\\[[^\\]]*\\]$/, '');
    if (MODELS.indexOf(stripped) !== -1) return stripped;
    // ID complet (« claude-fable-5 », « claude-opus-4-8 ») : le webview n'a
    // pas require() donc pas de hooks/model-id.js — extraction minimale du
    // schéma \`claude-<famille>-<chiffres>\`, même famille que batch.js
    // resolveDefaultModel (Node). Bug corrigé 2026-07-24 : le défaut persisté
    // (ID complet) n'allumait plus aucun bouton du formulaire.
    const m = stripped.match(/^claude-([a-z]+)-\\d/i);
    const family = m ? m[1].toLowerCase() : null;
    return family && MODELS.indexOf(family) !== -1 ? family : null;
  }
  function resolvedEffort(model) {
    // haiku n'a pas de notion d'effort dans Claude Code (constat user,
    // 2026-07-23) : jamais de pré-sélection d'effort pour ce modèle.
    if (model === 'haiku') return null;
    // Dernier choix explicite (même priorité que resolvedModel ci-dessus).
    if (batchState.lastEffort && EFFORTS.indexOf(batchState.lastEffort) !== -1) return batchState.lastEffort;
    const e = batchState.inherit && batchState.inherit.effort;
    return e && EFFORTS.indexOf(e) !== -1 ? e : null;
  }
  function effectiveModel(t) { return (t && t.model) || resolvedModel(); }
  function effectiveEffort(t) {
    const m = effectiveModel(t);
    if (m === 'haiku') return null;
    return (t && t.effort) || resolvedEffort(m);
  }
  function blankTask(wave) {
    return { prompt: '', model: null, effort: null, wave: wave || 1 };
  }

  // Ajout en file à un groupe existant (plan ajout-tache 2026-07-24) : le
  // « + » de chaque vague en file, ou la ligne fantôme « nouvelle vague »,
  // dépose le prompt COURANT du formulaire (tâche 1 — c'est « le » champ
  // prompt que le design retient, cf. plan) à l'endroit cliqué. Résolution
  // modèle/effort par le MÊME chemin que Create (resolvedModel/
  // resolvedEffort) — zéro logique dupliquée, même invariant haiku sans
  // effort. « wave: null » = nouvelle vague, calculée côté extension
  // (groups.js addTask). Prompt vide → aucun message, focus du champ
  // (invitation à taper) plutôt qu'un clic silencieux qui ne ferait rien.
  function promptTextarea() {
    return batchFormEl.querySelector('.task-top textarea.inp');
  }
  function highlightPromptField(on) {
    const ta = promptTextarea();
    if (ta) ta.classList.toggle('hl-target', !!on);
  }
  function addTaskAtWave(gid, wave) {
    const first = form.tasks[0];
    const prompt = (first && first.prompt) || '';
    if (!prompt.trim()) {
      const ta = promptTextarea();
      if (ta) ta.focus();
      return;
    }
    const model = resolvedModel();
    const effort = resolvedEffort(model);
    vscode.postMessage({ type: 'addTaskToGroup', id: gid, wave: wave, task: { prompt: prompt, model: model, effort: effort } });
    first.prompt = '';
    renderForm();
  }

  // Parseur strict du bloc claude-convs (lot 3) — copie du noyau de
  // batch.js (Node), dupliquée ici car le webview n'a pas de require() ; même
  // comportement, même messages d'erreur. Voir batch.js pour le commentaire
  // d'architecture complet. Zone unique (2026-07-23) : le champ prompt de
  // chaque tâche EST la zone de collage — un texte sans bloc reconnu reste un
  // prompt simple tel quel, il n'y a plus de découpage bête sur ligne vide.
  const FIELD_LINE_RE = /^(session|group|model|effort|stage)\\s*:\\s*(.*)$/i;
  // Séparateur « [---] » (3 tirets ou plus entre crochets) — legacy « --- » nu
  // encore accepté mais SEULEMENT si la ligne suivante est un champ reconnu
  // (blocs des anciens plans, sections toujours ouvertes par model:/effort:),
  // sinon un --- isolé dans un prompt redevient du texte normal. Copie du
  // garde-fou de batch.js.
  const SEPARATOR_RE = /^\\[-{3,}\\]$/;
  const LEGACY_SEPARATOR_RE = /^---$/;
  const BARE_SIGNAL_RE = /^\\[-{3,}\\]\\s*$/m;
  function findBareClaudeConvsBlock(text) {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const firstLine = trimmed.split(/\\r?\\n/)[0] || '';
    if (!BARE_SIGNAL_RE.test(trimmed) && !FIELD_LINE_RE.test(firstLine)) return null;
    return trimmed;
  }
  function findClaudeConvsBlock(text) {
    if (typeof text !== 'string') return null;
    const re = /\`\`\`claude-convs\\r?\\n([\\s\\S]*?)\`\`\`/g;
    let m;
    let last = null;
    while ((m = re.exec(text))) last = m[1];
    if (last != null) return last;
    return findBareClaudeConvsBlock(text);
  }
  function splitSections(lines) {
    const sections = [[]];
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (SEPARATOR_RE.test(trimmed)) { sections.push([]); continue; }
      if (LEGACY_SEPARATOR_RE.test(trimmed) && i + 1 < lines.length && FIELD_LINE_RE.test(lines[i + 1])) {
        sections.push([]);
        continue;
      }
      sections[sections.length - 1].push(lines[i]);
    }
    return sections;
  }
  function parseClaudeConvsBlock(text) {
    const body = findClaudeConvsBlock(text);
    if (body == null) return { found: false, tasks: null, group: null, session: null, error: null };
    const lines = body.replace(/\\r\\n/g, '\\n').split('\\n');
    const sections = splitSections(lines);
    let group = null;
    let session = null;
    const tasks = [];
    let error = null;
    sections.forEach(function (secLines, idx) {
      if (error) return;
      const fields = {};
      let i = 0;
      while (i < secLines.length) {
        const fm = secLines[i].match(FIELD_LINE_RE);
        if (!fm) break;
        const key = fm[1].toLowerCase();
        const value = fm[2].trim();
        // session: (lot 11) — jeton RECOPIÉ du contexte injecté par notre hook.
        // Aucune validation ici — il est revalidé côté extension contre les
        // transcripts (master.js), et un jeton faux ne doit jamais faire
        // rejeter un bloc par ailleurs correct.
        if (key === 'session') {
          if (idx !== 0) { error = t('session: only allowed at the top of the first section'); return; }
          if (session !== null) { error = t('session: given more than once'); return; }
          session = value; i++; continue;
        }
        if (key === 'group') {
          if (idx !== 0) { error = t('group: only allowed at the top of the first section'); return; }
          if (group !== null) { error = t('group: given more than once'); return; }
          group = value; i++; continue;
        }
        if (Object.prototype.hasOwnProperty.call(fields, key)) {
          error = t('{0}: given more than once in section {1}', key, idx + 1); return;
        }
        fields[key] = value; i++;
      }
      if (error) return;
      const prompt = secLines.slice(i).join('\\n').trim();
      if (!prompt) { error = t('section {0} has no prompt', idx + 1); return; }
      // Lot 14 : model:/effort: restent optionnels DANS LE BLOC — une section
      // qui ne les porte pas reste à null, résolue au RENDU (effectiveModel/
      // effectiveEffort), jamais figée ici ni affichée comme « inherit ».
      let model = null, effort = null, wave = 1;
      if (fields.model !== undefined) {
        const v = fields.model.toLowerCase();
        if (MODELS.indexOf(v) === -1) { error = t('section {0}: unknown model "{1}"', idx + 1, fields.model); return; }
        model = v;
      }
      if (fields.effort !== undefined) {
        const v = fields.effort.toLowerCase();
        if (EFFORTS.indexOf(v) === -1) { error = t('section {0}: unknown effort "{1}"', idx + 1, fields.effort); return; }
        effort = model === 'haiku' ? null : v;
      }
      if (fields.stage !== undefined) {
        const n = Number(fields.stage);
        if (!Number.isInteger(n) || n < 1) { error = t('section {0}: invalid stage "{1}"', idx + 1, fields.stage); return; }
        wave = n;
      }
      tasks.push({ prompt: prompt, model: model, effort: effort, wave: wave });
    });
    if (error) return { found: true, tasks: null, group: null, session: null, error: error };
    if (!tasks.length) return { found: true, tasks: null, group: null, session: null, error: t('no task found in block') };
    const waves = [...new Set(tasks.map(function (tk) { return tk.wave; }))].sort(function (a, b) { return a - b; });
    const contiguous = waves.every(function (w, i) { return w === i + 1; });
    if (!contiguous) {
      return { found: true, tasks: null, group: null, session: null, error: t('wave numbers are not contiguous ({0})', waves.join(', ')) };
    }
    return { found: true, tasks: tasks, group: group, session: session, error: null };
  }

  function activeTasks() {
    return form.tasks.filter(function (t) { return t.prompt.trim(); });
  }

  function taskCount() {
    return activeTasks().length;
  }

  // Lot 14 : plus de bouton « inherit » à afficher — mais tant qu'un défaut
  // ne s'est pas résolu (settings illisibles/absents, valeur exotique), une
  // tâche active reste sans modèle/effort concret (effectiveModel/
  // effectiveEffort rendent alors null). On ne lance JAMAIS sur une valeur
  // inventée : Create reste désactivé et le dit en une phrase courte.
  function unresolvedTask(t) {
    const m = effectiveModel(t);
    return !m || (m !== 'haiku' && !effectiveEffort(t));
  }

  function refreshCreateBtn() {
    if (!createBtn) return;
    const tasks = activeTasks();
    const n = tasks.length;
    setText(createBtn, n > 1 ? t('Create {0}', n) : t('Create'));
    const unresolved = n && tasks.some(unresolvedTask);
    createBtn.disabled = !n || batchState.busy || unresolved;
    createBtn.title = unresolved ? t('pick a model') : '';
  }

  function maxWave() {
    return form.tasks.reduce(function (m, t) { return Math.max(m, t.wave); }, 1);
  }

  // Vagues renumérotées en une suite contiguë : retirer la dernière tâche d'une
  // vague ne doit pas laisser un trou (le lot 4 déverrouille vague par vague).
  function compactWaves() {
    const waves = [...new Set(form.tasks.map(function (t) { return t.wave; }))].sort(function (a, b) { return a - b; });
    const renum = new Map(waves.map(function (w, i) { return [w, i + 1]; }));
    form.tasks.forEach(function (t) { t.wave = renum.get(t.wave); });
    form.tasks.sort(function (a, b) { return a.wave - b.wave; });
  }

  // Lot 14 : plus de bouton « inherit » à étiqueter (retiré des libellés) —
  // « current » peut être null (résolution impossible) : aucun bouton n'est
  // alors allumé, ce qui est exactement le WYSIWYG voulu.
  function segment(values, current, disabled, onPick) {
    const wrap = el('span', 'seg' + (disabled ? ' off' : ''));
    values.forEach(function (v) {
      const label = v === 'medium' ? 'med' : v;
      const b = el('button', v === current ? 'on' : '', label);
      b.type = 'button';
      b.title = v;
      if (disabled) b.disabled = true;
      else b.addEventListener('click', function () { onPick(v); });
      wrap.appendChild(b);
    });
    return wrap;
  }

  function button(cls, text, onClick) {
    const b = el('button', 'btn' + (cls ? ' ' + cls : ''), text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  // Bannière avec un × de fermeture — l'appelant décide de ce que « fermer »
  // veut dire (state éphémère, jamais un message vers l'extension).
  function dismissibleBanner(cls, text, onDismiss) {
    const wrap = el('div', cls);
    wrap.style.display = 'flex';
    wrap.style.alignItems = 'flex-start';
    wrap.style.gap = '6px';
    const body = el('span');
    body.style.flex = '1';
    body.textContent = text;
    wrap.appendChild(body);
    const dismiss = el('button', 'xdel', '×');
    dismiss.type = 'button';
    dismiss.title = t('Dismiss');
    dismiss.addEventListener('click', onDismiss);
    wrap.appendChild(dismiss);
    return wrap;
  }

  // Zone unique (2026-07-23) : le champ prompt de chaque tâche EST la zone de
  // collage — il n'y a plus de champ « paste » séparé. Sur paste/change
  // (jamais input, qui volerait le curseur à chaque frappe) : un bloc
  // claude-convs VALIDE remplace le formulaire ENTIER (tasks/group/session),
  // même sémantique que l'ancienne zone dédiée et même quand des tâches
  // existent déjà ; un bloc PRÉSENT mais invalide affiche la raison en
  // bannière et laisse le texte tel quel comme prompt simple ; aucun signal
  // reconnu → rien de spécial, le texte est déjà le prompt (via input).
  function applyBlockPaste(ta) {
    const text = ta.value;
    const parsed = parseClaudeConvsBlock(text);
    form.errorBanner = null;
    form.banner = null;
    if (parsed.found && !parsed.error) {
      form.tasks = parsed.tasks;
      if (parsed.group) form.group = parsed.group;
      // Conv maîtresse (lot 11) : mémorisé seulement pour la recherche au
      // « Create » — le webview ne lit aucun transcript ici.
      form.masterPaste = text;
      form.masterSession = parsed.session || null;
      form.banner = t('claude-convs block recognized — {0} task(s) prefilled (model, effort, waves).', parsed.tasks.length);
    } else {
      form.masterPaste = null;
      form.masterSession = null;
      if (parsed.found && parsed.error) {
        form.errorBanner = t('claude-convs block not recognized: {0} — kept as a plain prompt.', parsed.error);
      }
    }
    renderForm();
  }

  function taskCard(task, disabled) {
    const card = el('div', 'task');
    const top = el('div', 'task-top');
    const ta = el('textarea', 'inp');
    ta.rows = 2;
    ta.value = task.prompt;
    ta.placeholder = t('Prompt for this conversation — or paste a /handoffs block');
    // oninput n'appelle PAS renderForm : re-créer le nœud pendant la frappe
    // volerait le curseur. Seul le compteur du bouton Create bouge.
    ta.addEventListener('input', function () { task.prompt = ta.value; refreshCreateBtn(); });
    ta.addEventListener('paste', function () { setTimeout(function () { applyBlockPaste(ta); }, 0); });
    ta.addEventListener('change', function () { applyBlockPaste(ta); });
    const del = el('button', 'xdel', '×');
    del.type = 'button';
    del.title = t('Remove this task');
    del.addEventListener('click', function () {
      form.tasks.splice(form.tasks.indexOf(task), 1);
      if (!form.tasks.length) form.tasks.push(blankTask(1));
      compactWaves();
      renderForm();
    });
    top.appendChild(ta);
    top.appendChild(del);
    card.appendChild(top);

    const pair = function (label, node) {
      const p = el('span', 'pair');
      p.appendChild(el('span', 'lbl', label));
      p.appendChild(node);
      return p;
    };
    const row = el('div', 'task-row');
    const curModel = effectiveModel(task);
    // haiku n'a pas de notion d'effort dans Claude Code (constat user,
    // 2026-07-23) : choisir haiku désactive le sélecteur d'effort et l'éteint
    // (envForTask ne poserait de toute façon jamais la variable pour ce
    // modèle, cf. batch.js, mais un sélecteur qui reste allumé sur une valeur
    // ignorée mentirait). Le bouton affiché est la valeur EFFECTIVE (explicite
    // si choisie, sinon le défaut résolu recalculé à ce rendu, lot 14).
    row.appendChild(pair('model', segment(MODELS, curModel, disabled, function (v) {
      task.model = v;
      if (v === 'haiku') task.effort = null;
      // Écrit au clic, pas au Create (plan sélecteurs 2026-07-24) : le défaut
      // d'une tâche vierge doit refléter le dernier geste même sans lancement.
      vscode.postMessage({ type: 'setLastBatchChoice', field: 'model', value: v });
      renderForm();
    })));
    row.appendChild(pair('effort', segment(EFFORTS, effectiveEffort(task), disabled || curModel === 'haiku', function (v) {
      task.effort = v;
      vscode.postMessage({ type: 'setLastBatchChoice', field: 'effort', value: v });
      renderForm();
    })));
    // Contrôle « wave ◂ ▸ » (déplacer la tâche d'une vague à l'autre) : sans
    // objet dès qu'il n'y a qu'UNE tâche — il n'existe alors aucune notion de
    // vague, et le ▸ créerait une 2e vague vide autour d'un prompt unique. On
    // le gate donc sur 2+ tâches, exactement comme l'en-tête de vague (extended,
    // lot 15) : « pas plusieurs prompts = pas de wave » (retour user 2026-07-23,
    // le lot 15 avait gaté l'en-tête mais pas ce contrôle par carte).
    if (form.tasks.length > 1) {
      const moves = el('span', 'seg');
      const back = el('button', '', '◂');
      back.type = 'button';
      back.title = t('Move to the previous wave');
      back.disabled = task.wave <= 1;
      back.addEventListener('click', function () {
        if (task.wave <= 1) return;
        task.wave -= 1; compactWaves(); renderForm();
      });
      const fwd = el('button', '', '▸');
      fwd.type = 'button';
      fwd.title = t('Move to the next wave');
      fwd.addEventListener('click', function () { task.wave += 1; compactWaves(); renderForm(); });
      moves.appendChild(back);
      moves.appendChild(fwd);
      row.appendChild(pair('wave', moves));
    }
    card.appendChild(row);
    return card;
  }

  function renderForm() {
    batchFormEl.replaceChildren();
    createBtn = null;

    const disabled = !!(batchState.envConflict && batchState.envConflict.length);
    if (disabled) {
      batchFormEl.appendChild(el('div', 'banner',
        t('{0} set in claudeCode.environmentVariables — that setting is applied after ours, so it would override any choice made here. Model/effort selectors are disabled; remove it from VS Code settings to pick per-conversation values.', batchState.envConflict.join(' and '))));
    }

    // Lot 12 §2 : le formulaire simple (une tâche) n'affiche NI nom de groupe
    // NI vagues — « une seule tâche = pas de groupe » (lot 2). L'extension est
    // AUTOMATIQUE : « form.tasks.length > 1 » couvre les trois déclencheurs du
    // plan (collage multi-tâches, bloc claude-convs multi-sections, « + Add
    // task »/« + Add wave divider », qui poussent tous une 2e tâche). Retour à
    // une seule tâche (suppression) → retour au mode simple, même calcul.
    const extended = form.tasks.length > 1;

    // Nom de groupe (lot 2). Optionnel : sans lui, le groupe prend l'heure de
    // création. Deux tâches ou plus = un groupe ; une seule = juste une
    // conversation, aucun groupe n'est créé — le champ n'a alors pas lieu
    // d'être affiché du tout (pas seulement son placeholder).
    if (extended) {
      batchFormEl.appendChild(el('label', 'fld-label', t('Group name (optional)')));
      const gname = el('input', 'inp');
      gname.type = 'text';
      gname.value = form.group || '';
      gname.placeholder = t('e.g. Payment refactor');
      gname.addEventListener('input', function () { form.group = gname.value; });
      batchFormEl.appendChild(gname);
    }

    // Dismiss du feedback de collage (lot micro-allègements 2026-07-24) : état
    // ÉPHÉMÈRE local à cette tâche de formulaire, jamais persisté (pas de
    // pendant de dismissBatchTip) — un × qui referme la bannière courante ; elle
    // se remplace normalement au collage suivant et disparaît déjà au
    // Create/Cancel (form remis à zéro), ce × n'ajoute qu'un cas de fermeture
    // manuelle anticipée.
    if (form.errorBanner) batchFormEl.appendChild(dismissibleBanner('banner', form.errorBanner, function () { form.errorBanner = null; renderForm(); }));
    if (form.banner) batchFormEl.appendChild(dismissibleBanner('banner info', form.banner, function () { form.banner = null; renderForm(); }));

    // Astuce /handoffs (v2.18.13) : visible tant que l'user ne l'a pas
    // écartée. Le × la masque DÉFINITIVEMENT (globalState, par machine, survit
    // aux reloads) — « je suis déjà au courant » ne se dit qu'une fois. Le « ? »
    // de rappel vit dans l'en-tête « New conversation » (aligné à droite du
    // titre, cf. HTML statique #newConvTipRestore) — plus dans le corps du
    // formulaire, pour ne pas flotter tout seul au-dessus des tâches.
    newConvTipRestoreEl.style.display = batchState.tipDismissed ? '' : 'none';
    if (!batchState.tipDismissed) {
      const tip = el('div', 'hint tip-container');
      tip.style.display = 'flex';
      tip.style.gap = '6px';
      tip.style.alignItems = 'center';
      const tipText = el('span');
      tipText.style.flex = '1';
      tipText.textContent = t('Make Claude end its handoffs with this block — copy an instruction for your CLAUDE.md.');
      tip.appendChild(tipText);
      // Le texte copié DÉCRIT le format claude-convs (contrat invariant, décision
      // 5 du plan lot 15) : il reste en anglais quelle que soit la locale de
      // l'UI, comme commands/handoffs.md — seuls le texte, l'infobulle et le
      // bouton suivent la langue de VS Code.
      const copyBtn = button('', t('Copy'), function () {
        const instruction = 'When you propose follow-up conversations (handoffs), end your reply with a \`\`\`claude-convs code block: one section per task separated by a line of [---], optional fields model: <haiku|sonnet|opus|fable>, effort: <low|medium|high|xhigh|max>, stage: <wave number — same number = parallel, higher = waits for previous wave>; the rest of each section is the prompt. After the block, add a one-line readable summary of the ordering. If no follow-up work is warranted, say so and emit no block.';
        navigator.clipboard.writeText(instruction).catch(function () {
          console.error('Failed to copy to clipboard');
        });
      });
      copyBtn.style.fontSize = '12px';
      copyBtn.style.padding = '2px 8px';
      tip.appendChild(copyBtn);
      const dismiss = el('button', 'xdel', '×');
      dismiss.type = 'button';
      dismiss.title = t('Dismiss this tip — the ? above brings it back');
      dismiss.addEventListener('click', function () { vscode.postMessage({ type: 'dismissBatchTip' }); });
      tip.appendChild(dismiss);
      batchFormEl.appendChild(tip);
    }

    const waves = [...new Set(form.tasks.map(function (t) { return t.wave; }))].sort(function (a, b) { return a - b; });
    waves.forEach(function (w) {
      // En-tête de vague : seulement en mode étendu (lot 12) — le mode simple
      // à une seule tâche n'a rien à en dire. Vague unique en mode étendu =
      // TOUT part en parallèle, et l'en-tête le DIT (au lieu du muet « tasks »,
      // lot 10) : c'est la signature du cas d'échec le plus courant — un bloc
      // collé sans stage:, dont l'ordonnancement attendu a été perdu. Le voir
      // avant « Create » vaut mieux que le découvrir après.
      if (extended) {
        batchFormEl.appendChild(el('div', 'wave-hdr', waves.length > 1 ? t('wave {0}', w) : t('1 wave — all parallel')));
      }
      form.tasks.filter(function (tk) { return tk.wave === w; })
        .forEach(function (tk) { batchFormEl.appendChild(taskCard(tk, disabled)); });
    });

    const adders = el('div', 'task-row');
    adders.appendChild(button('', t('+ Add task'), function () {
      form.tasks.push(blankTask(maxWave()));
      compactWaves();
      renderForm();
    }));
    adders.appendChild(button('', t('+ Add wave divider'), function () {
      form.tasks.push(blankTask(maxWave() + 1));
      compactWaves();
      renderForm();
    }));
    batchFormEl.appendChild(adders);

    // Passage de vague (lot 4) : n'a de sens qu'avec plus d'une vague — le
    // toggle n'apparaît qu'à ce moment-là, exactement comme dans le groupe une
    // fois créé (renderGroups). Défaut 'auto' (mockup validé).
    if (waves.length > 1) {
      batchFormEl.appendChild(el('label', 'fld-label', t('Wave advance')));
      const advSeg = segment(['auto', 'manual'], form.advance || 'auto', false, function (v) {
        form.advance = v; renderForm();
      });
      batchFormEl.appendChild(advSeg);
    }

    const foot = el('div', 'form-foot');
    foot.appendChild(el('span', 'spacer'));
    // Lot 12 : « form » n'est plus jamais « null » (le lanceur est toujours
    // là) — Cancel remet le brouillon à zéro (une tâche vierge, mode simple)
    // plutôt que de fermer un panneau qui n'existe plus.
    foot.appendChild(button('', t('Cancel'), function () {
      form = { group: '', advance: 'auto', tasks: [blankTask(1)] };
      renderForm();
    }));
    createBtn = button('pri', t('Create'), function () {
      // Lot 14 : on envoie la valeur EFFECTIVE (explicite ou défaut résolu au
      // moment du clic), jamais le null interne d'une tâche encore sur le
      // défaut — refreshCreateBtn() garantit qu'on n'arrive ici que résolu.
      const tasks = form.tasks
        .filter(function (t) { return t.prompt.trim(); })
        .map(function (t) { return { prompt: t.prompt.trim(), model: effectiveModel(t), effort: effectiveEffort(t), wave: t.wave }; });
      if (!tasks.length) return;
      vscode.postMessage({
        type: 'createBatch',
        tasks,
        groupName: (form.group || '').trim(),
        advance: form.advance || 'auto',
        // Lot 11 : la matière de la recherche de conv maîtresse, non nulle
        // seulement si le dernier collage a été reconnu comme bloc valide.
        paste: form.masterPaste || null,
        session: form.masterSession || null,
      });
      form = { group: '', advance: 'auto', tasks: [blankTask(1)] };
      renderForm();
    });
    foot.appendChild(createBtn);
    batchFormEl.appendChild(foot);
    refreshCreateBtn();
  }

  function renderBatch(b) {
    const next = {
      envConflict: (b && b.envConflict) || [],
      busy: !!(b && b.busy),
      notice: (b && b.notice) || null,
      // Lot 12 §3 : { model, effort } résolus de ~/.claude/settings.json côté
      // extension, jamais mis en cache ici non plus — repoussé à chaque push.
      inherit: (b && b.inherit) || { model: null, effort: null },
      // Dernier choix explicite, par workspace (plan sélecteurs 2026-07-24) —
      // prime sur « inherit » dans resolvedModel()/resolvedEffort() ci-dessus.
      lastModel: (b && b.lastModel) || null,
      lastEffort: (b && b.lastEffort) || null,
      tipDismissed: !!(b && b.tipDismissed),
    };
    // Ne re-rendre le formulaire que si ce qui le CONDITIONNE a bougé : sinon,
    // chaque push d'état (30 s, transitions) écraserait la saisie en cours. Le
    // dismiss/restore de l'astuce ne bouge que sur un clic explicite de l'user,
    // jamais sur un tick — le re-rendre alors est voulu (la saisie survit sur
    // l'objet form, relue à chaque renderForm).
    const changed = next.envConflict.join(',') !== batchState.envConflict.join(',')
      || next.busy !== batchState.busy
      || next.inherit.model !== batchState.inherit.model
      || next.inherit.effort !== batchState.inherit.effort
      || next.lastModel !== batchState.lastModel
      || next.lastEffort !== batchState.lastEffort
      || next.tipDismissed !== batchState.tipDismissed;
    batchState = next;
    setText(batchNoticeEl, next.notice || '');
    batchNoticeEl.classList.toggle('show', !!next.notice);
    if (changed) renderForm(); else refreshCreateBtn();
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
      if (w.resetLabel) wrap.appendChild(el('div', 'q-sub', t('resets {0}', w.resetLabel)));
      quotaEl.appendChild(wrap);
    }
    if (!windows.length) quotaEl.appendChild(el('div', 'empty', t('No usage data yet.')));

    const foot = el('div', 'foot');
    const age = q.ageMin == null ? '' : (q.ageMin <= 1 ? t('just now') : t('{0} min ago', q.ageMin));
    foot.appendChild(el('span', 'age', age));
    const refresh = el('button', 'link', t('Refresh'));
    refresh.addEventListener('click', function () { vscode.postMessage({ type: 'refresh' }); });
    const usage = el('button', 'link', t('Usage page'));
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
    const convs = (msg.state && msg.state.conversations) || [];
    const groups = (msg.state && msg.state.groups) || [];
    // Une conversation groupée est rendue DANS son groupe, et nulle part
    // ailleurs : la liste plate ne garde que le reste. Idem pour la conv
    // maîtresse d'un groupe affiché (volet C) — elle n'est pas un membre
    // (groupId reste null côté extension) mais a désormais sa propre ligne
    // dans l'en-tête du groupe : le filtrage se fait ici, pas côté extension.
    const convById = {};
    convs.forEach(function (c) { convById[c.id] = c; });
    const masterIds = new Set();
    groups.forEach(function (g) { if (g.master && g.master.listed && g.master.convId) masterIds.add(g.master.convId); });
    const seen = new Set();
    renderGroups(groups, convById, seen);
    renderConvs(convs.filter(function (c) { return !c.groupId && !masterIds.has(c.id); }), convs.length, seen);
    pruneRows(seen);
    lastQuota = (msg.state && msg.state.quota) || {};
    renderQuota(lastQuota);
    renderSoundsToggle(!!(msg.state && msg.state.sounds && msg.state.sounds.enabled));
    renderUi(msg.state && msg.state.ui);
    canaryEl.classList.toggle('show', !!(msg.state && msg.state.canary));
    renderBatch(msg.state && msg.state.batch);
  });

  renderForm();
  if (!document.hidden) startTick();

  vscode.postMessage({ type: 'ready' });
}());
</script>
</body>
</html>`;
}

module.exports = { ClaudePanelProvider, VIEW_TYPE };
