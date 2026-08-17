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
//     tabsFrozen: boolean,   // plan gel-tabs 2026-08-17 : canal RPC des
//                             // onglets mort pour CETTE fenêtre (copie miroir
//                             // de l'hôte d'extension figée) — le surlignage
//                             // suit toujours un clic (l'acte prime), mais
//                             // l'auto-réparation par lecture fraîche ne joue
//                             // plus tant que la fenêtre n'est pas rechargée.
//     batch: {
//       envConflict: string[],  // nos env vars définies dans claudeCode.environmentVariables
//                               // → sélecteurs désactivés (elles écraseraient nos choix)
//       busy: boolean,          // un « Create » est en cours (lancements sérialisés)
//       notice: string|null,    // retour du dernier « Create »
//     },
//     groups: [{                // lot 2 — métadonnées ; lot 4 ajoute le moteur
//                               // de vagues (launchedWave, nextWave,
//                               // waveNotice, member.status) — toujours
//                               // automatique, pas de toggle manuel.
//       id, name, hue: number, collapsed: boolean,
//       launchedWave: number,   // vague la plus avancée déjà ouverte
//       nextWave: number|null,  // vague à proposer au ▶ manuel, null = aucune
//       waveNotice: string|null,// annonce transitoire (ouverture auto, échec)
//       nestedUnder: null | { groupId, memberKey },
//                               // filiation (plan arbre-filiation 2026-08-15,
//                               // nesting.js) : la maîtresse de ce lot EST le
//                               // membre `memberKey` du lot `groupId` — ce lot
//                               // se rend sous CETTE ligne, qui lui tient lieu
//                               // de tête (il ne rend donc pas sa propre ligne
//                               // maîtresse : un seul nœud, un seul endroit).
//                               // null = rendu classique, bloc frère.
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
    --busy: var(--vscode-charts-blue, #03a9f4);
    --busy-width: 3.5px;
    --busy-alpha: 30%;
    --busy-outset: 2.5px;
    --busy-length-min: 60deg;
    --busy-length-max: 260deg;
    --waiting: var(--vscode-charts-yellow, #cca700);
    --done: var(--vscode-charts-green, #89d185);
    --stale: var(--vscode-charts-yellow, #cca700);
    --muted: var(--vscode-descriptionForeground, #999);
    --pace-green: var(--vscode-charts-green, #89d185);
    --pace-yellow: var(--vscode-charts-yellow, #cca700);
    --pace-red: var(--vscode-charts-red, #f14c4c);
    /* ── Densité verticale (2026-08-09) : UN seul point de réglage ────────────
       Le panneau vit dans une sidebar haute et étroite : la ressource rare est
       la HAUTEUR, et elle partait en blancs de séparation — mesuré au banc, un
       séparateur de vague ou une ligne fantôme portait 14px de vide (10 au-
       dessus, 4 en dessous) pour une boîte de 13 à 22px, et un groupe complet
       dépensait ~40% de sa hauteur en séparateurs. Ces trois variables
       remplacent toutes les valeurs d'espacement vertical écrites en dur : un
       réglage de densité se fait ICI, jamais règle par règle (sinon elles
       divergent, c'est ce qui s'était produit). Elles ne touchent QUE le vide —
       aucune boîte porteuse d'information (ligne de conversation, barre de
       contexte, glyphe) n'est rétrécie : leur géométrie est prouvée au pixel
       par test-panel-render.js §16 et ne doit pas bouger.
         --sp-block : blanc AVANT un bloc de haut niveau (section, quota, form)
         --sp-sep   : blanc autour d'un séparateur interne (vague, fantôme)
         --sp-tight : blanc APRÈS un en-tête, ou entre deux éléments serrés */
    --sp-block: 6px;
    --sp-sep: 4px;
    --sp-tight: 2px;
    /* Décalage d'un sous-lot imbriqué (plan arbre-filiation 2026-08-15) : DEUX
       gouttières de 14px, l'axe des anneaux. Ce n'est pas un goût, c'est un
       minimum MESURÉ : le cadre d'un bloc déborde de --grp-bleed (5px) à
       gauche et le rail du parent a son bord droit à 15,5px — à 14px de
       décalage le cadre du sous-lot traverse le rail du parent (masqué sur
       21px au banc de la maquette). Axes qui en résultent : rail parent 14,5 ·
       rail enfant 42,5, chacun sous ses propres anneaux. */
    --nest-indent: 28px;
  }
  /* Enregistrée = le moteur interpole un <angle> en douceur (la longueur du
     serpentin croît/décroît au lieu de sauter) — condition pour l'animation
     "breathe" ci-dessous. */
  @property --busy-length {
    syntax: '<angle>';
    inherits: true;
    initial-value: 90deg;
  }
  body {
    padding: var(--sp-sep) 8px var(--sp-block);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    /* Explicite (étape 12, régression thème clair) : sans cette règle, le
       fond RÉEL du panneau vient d'un défaut du host webview jamais garanti
       identique à --vscode-sideBar-background — l'anneau qui « troue » le
       rail (plus bas, .grp-body .conv .ico::after) doit peindre EXACTEMENT
       cette même couleur pour être invisible sur le fond réel. Les deux
       endroits partagent maintenant la MÊME chaîne de variables : ils ne
       peuvent plus diverger, quel que soit le thème. */
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  }
  h2 {
    display: flex; align-items: center; gap: 6px;
    margin: var(--sp-block) 0 var(--sp-tight);
    font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase;
    color: var(--muted);
  }
  h2 .count {
    font-size: 10px; letter-spacing: 0;
    padding: 0 5px; border-radius: 8px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .empty { padding: var(--sp-sep) 2px; color: var(--muted); font-style: italic; }
  /* Canari viewType (lot 13 §1) et gel des onglets (plan gel-tabs 2026-08-17) :
     même famille de signal discret, jamais de popup — même règle pour les
     deux, teinte "attention" déjà en place, pas de couleur dédiée. */
  .canary {
    display: none;
    margin: 2px 2px var(--sp-sep); padding: 3px 6px; border-radius: 4px;
    font-size: 11px; color: var(--waiting);
    background: color-mix(in srgb, var(--waiting) 12%, transparent);
  }
  .canary.show { display: block; }

  /* ── Conversations ── */
  .conv {
    display: grid; grid-template-columns: 16px 1fr; gap: 8px;
    /* Vertical seul en --sp-tight (lot A, 2026-08-09) : la ligne est le poste
       dominant du panneau (une par conversation), c'est elle qui doit porter
       le gros de l'économie de densité. Horizontal inchangé — la gouttière ne
       fait pas partie du chantier vertical. */
    padding: var(--sp-tight) 6px; border-radius: 4px;
    cursor: pointer;
    /* Repère du bouton « rattacher » (.link-master, lot B 2026-08-09) — une
       ligne plate n'a AUCUN wrapper (rowFor() la place directement dans le
       flux), .conv est donc le seul ancêtre disponible pour un overlay qui
       respecte l'invariant « zéro emprise sur le flux » sans lui en inventer
       un. Grid n'est pas affecté par position:relative sur ses items enfants. */
    position: relative;
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
     (daltonisme + thèmes à contraste élevé).
     UN SEUL JEU DE SYMBOLES, quel que soit le contexte (2026-08-09) : une
     conversation interrompue montre le même carré dans un lot et hors lot.
     Ce qui l'interdisait était une TECHNIQUE de dessin, pas un besoin : une
     forme portée par la BORDURE de l'icône est avalée par l'anneau du rail
     (pseudo z-index:-1 à fond opaque, peint au-dessus de la bordure de son
     hôte). Toute forme d'état se dessine donc dans un pseudo POSITIONNÉ —
     il se peint après les z-négatifs (motif prouvé en CDP pour l'arc busy en
     2.28.2) — jamais dans la bordure de l'hôte. C'est ce qui permet de
     supprimer le jeu de symboles parallèle du groupe (⚠ commun à stale et
     interrupted, deux états rendus indiscernables). */
  .ico { margin-top: 4px; width: 10px; height: 10px; justify-self: center; }
  /* « En sommeil » : cercle pointillé. Le pseudo remplit la boîte (inset 0),
     donc le centrage suit la boîte icône sans compensation chiffrée. */
  .ico-stale { position: relative; }
  .ico-stale::before {
    content: ''; position: absolute; inset: 0; box-sizing: border-box;
    border-radius: 50%; background: transparent; border: 1.5px dashed var(--stale);
  }
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
  /* Écart creusé (2026-08-06, 8e signalement « le vif ne se voit pas ») : la
     différence ne tient plus à la SEULE teinte. Le non-lu prend du gras — un
     trait plus épais se lit même quand la teinte du thème est faible (le repli
     #89d185 est un vert clair, presque blanc sur fond clair) — et le lu descend
     de 45 % à 25 %. Deux dimensions au lieu d'une : intensité ET graisse. */
  .ico-done {
    color: var(--done); font-size: 11px; line-height: 10px; text-align: center;
    font-weight: 700;
  }
  /* Atténuation « déjà lue » : sur la COULEUR du glyphe, jamais sur l'opacité
     de la boîte (étape 13). La propriété opacity s'applique à l'élément
     ENTIER, pseudo-
     éléments compris — dans un groupe, elle rendait donc l'anneau ::after
     translucide et le rail transparaissait dedans (reproduit en CDP : anneau
     d'une master « ✓ lue » non opaque, celui d'un membre busy opaque). Le ✓
     n'a ni fond ni bordure : un alpha sur la couleur donne EXACTEMENT le même
     rendu qu'avant pour le glyphe, sans toucher au trou opaque de l'anneau. */
  .ico-done.read {
    color: color-mix(in srgb, var(--done) 25%, transparent);
    font-weight: 400;
  }
  /* Interruption manuelle (Stop / Échap) : le carré du « stop » universel, creux
     et muet. Une forme franche, pas une teinte de plus — la pastille voisine est
     un ✓ (« rien à faire ») alors qu'une interruption dit l'inverse : le travail
     est resté en plan. Muted et non coloré : c'est un fait à retrouver dans la
     liste, pas une alerte qui réclame quelque chose. Distinct du cercle pointillé
     de l'état stale par la forme comme par le trait. */
  .ico-interrupted { position: relative; }
  .ico-interrupted::before {
    content: ''; position: absolute; inset: 0.5px; box-sizing: border-box;
    border: 1.5px solid var(--muted);
    border-radius: 1px;
  }
  /* L'arc busy vit dans un ::before POSITIONNÉ, jamais dans la bordure de
     l'élément (2026-08-06, 4e signalement « pas de loading » — cause prouvée
     en CDP) : dans un groupe, l'anneau du rail est un ::after à z-index:-1,
     et l'ordre de peinture CSS met TOUT z-index négatif AU-DESSUS de la
     bordure de son élément hôte — le disque opaque de l'anneau avalait donc
     l'arc entier (le ✓ et le ⚠ survivaient : du texte se peint après). Un
     ::before positionné se peint après les z-négatifs : l'arc reste visible
     dans l'anneau, avec UNE seule définition pour lignes plates et groupes.
     Les trois bancs d'animation lisent désormais getAnimations({subtree:true})
     pour voir l'animation du pseudo. */
  .ico-busy { position: relative; }
  .ico-busy::before {
    /* inset négatif = le disque déborde de la boîte 10px (arc extérieur
       ~15px). Piste (disque translucide, calque du dessous) + serpentin
       (secteur plein, calque du dessus, longueur animée en degrés) — un
       masque radial ronge le centre pour ne garder qu'un anneau de
       --busy-width. Remplace l'ancienne technique à la bordure (2.28.2) :
       elle ne pouvait pas faire varier la longueur du secteur dans le temps. */
    content: ''; position: absolute; inset: calc(-1 * var(--busy-outset));
    border-radius: 50%;
    background:
      conic-gradient(from 0deg, var(--busy) 0deg, var(--busy) var(--busy-length), transparent var(--busy-length) 360deg),
      color-mix(in srgb, var(--busy) var(--busy-alpha), transparent);
    -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - var(--busy-width)), #000 calc(100% - var(--busy-width)));
            mask: radial-gradient(farthest-side, transparent calc(100% - var(--busy-width)), #000 calc(100% - var(--busy-width)));
    animation: spin .8s linear infinite, breathe 1.6s ease-in-out infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  /* Respiration : le serpentin s'allonge puis se rétracte pendant qu'il
     tourne (même principe que le spinner circulaire de Material Design),
     indépendamment de la rotation — deux animations sur le même pseudo. */
  @keyframes breathe {
    0%, 100% { --busy-length: var(--busy-length-min); }
    50% { --busy-length: var(--busy-length-max); }
  }
  /* PAS de @media (prefers-reduced-motion: reduce) ici, et c'est délibéré.
     Chromium — donc ce webview — dérive cette préférence de
     SPI_GETCLIENTAREAANIMATION, l'option Windows « Effets d'animation », que ce
     poste a sur OFF (mesuré le 2026-07-15 : reduce = true dans le moteur de
     rendu). La règle qui coupait l'animation ici était donc TOUJOURS active :
     c'est elle qui figeait l'arc busy. Ces deux animations ne sont pas
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
  .q { margin: var(--sp-sep) 0 var(--sp-block); }
  .q-head { display: flex; align-items: baseline; }
  .q-label { font-size: 11px; color: var(--muted); }
  .q-pct { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 600; }
  .q-sub { margin-top: var(--sp-tight); font-size: 11px; color: var(--muted); }

  /* ── Pied ── */
  .foot {
    display: flex; align-items: center; gap: 10px;
    margin-top: var(--sp-block); padding-top: var(--sp-block);
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
    margin: var(--sp-block) 0 var(--sp-tight); padding: 1px 2px;
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
  .sec-head.sub { margin: var(--sp-block) 0 var(--sp-tight); }
  .sec-head.sub h3 {
    margin: 0; font-size: 11px; font-weight: 600; letter-spacing: .06em;
    text-transform: uppercase; color: var(--muted);
  }

  /* ── Création groupée (lot 1) ─────────────────────────────────────────────
     Tout est bâti sur les variables de thème VS Code : le panneau doit rester
     lisible en clair, en sombre et en contraste élevé, sans une seule couleur
     en dur. Les boutons segmentés remplacent tout dropdown (décision 4 du
     plan) : le choix courant est visible sans ouvrir quoi que ce soit. */
  .batch { margin-top: var(--sp-block); }
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
  .hint { margin-top: var(--sp-sep); font-size: 11px; color: var(--muted); }
  .tip-restore {
    margin-left: 6px; cursor: pointer; opacity: .5; font-size: 10px;
    display: inline-flex; align-items: center; justify-content: center;
    width: 14px; height: 14px; border-radius: 50%;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.4));
  }
  .tip-restore:hover { opacity: 1; }
  .notice {
    display: none;
    margin: var(--sp-sep) 0; padding: 3px 6px; border-radius: 4px; font-size: 11px;
    background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
  }
  .notice.show { display: block; }
  .banner {
    margin: var(--sp-sep) 0; padding: 3px 6px; border-radius: 4px; font-size: 11px;
    background: color-mix(in srgb, var(--waiting) 12%, transparent); color: var(--waiting);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .banner.info { background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent); color: var(--muted); }
  .banner.err { background: color-mix(in srgb, var(--vscode-errorForeground, #f14c4c) 14%, transparent); color: var(--vscode-errorForeground, #f14c4c); }
  .fld-label { display: block; margin: var(--sp-block) 0 var(--sp-tight); font-size: 10px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
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
    margin: var(--sp-sep) 0 var(--sp-tight); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted);
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
  /* Depuis le constat user 2026-08-07 (« la pill mord sur le rail »), la boîte
     de la pill commence APRÈS l'axe du rail (margin-left, même repère 20px que
     les autres en-têtes de vague, cf. le groupe de sélecteurs plus bas) : le
     rail passe à sa gauche, intersection vide PAR GÉOMÉTRIE — prouvé au banc
     (§17f). Le z-index 1 de l'étape 19 est CONSERVÉ en ceinture : si une
     évolution future refait se croiser les deux boîtes (place() peut réordonner
     le rail après la pill, l'ordre du DOM ne tranche rien), c'est la pill qui
     repasse devant, jamais un trait en travers du CTA. */
  .wave-hdr.launch {
    position: relative; z-index: 1;
    cursor: pointer; justify-content: center;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
    border-radius: 12px; padding: var(--sp-tight) 10px;
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
    margin: var(--sp-sep) 0 var(--sp-tight); padding: var(--sp-tight) 4px; border-radius: 3px; cursor: pointer;
    font-size: 10px; letter-spacing: .06em; color: var(--muted);
    border-top: 1px dashed var(--vscode-panel-border, rgba(128,128,128,.35));
    overflow: hidden; white-space: nowrap;
  }
  .wave-ghost:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); }
  /* Ligne fantôme FINALE : UNE ligne, DEUX cibles (lot B densité, 2026-08-09).
     Un groupe se terminait par deux lignes pleine largeur empilées — « + add to
     this wave » (la dernière vague en file) puis « + new wave » — soit ~52 px
     de hauteur pour deux actions voisines, dans une sidebar où le pixel
     vertical est la ressource rare. Elles partagent maintenant la même rangée,
     chacune sur sa moitié : deux boîtes distinctes, deux bordures pointillées
     séparées par le gap, deux survols indépendants — donc deux cibles qu'on ne
     confond pas, alors qu'un seul bouton à deux zones se serait payé en clics
     ratés. Ce sont les MÊMES nœuds qu'avant (mêmes classes, mêmes écouteurs,
     mêmes garde-fous) : seule leur boîte parente change, aucune règle métier
     ne se rejoue ici. La cellule d'ajout n'est présente QUE lorsque la
     dernière vague est en file ; sinon elle n'existe pas dans le DOM (jamais
     masquée par un style — un enfant de flux coûte sa place même invisible),
     et « + new wave » occupe seule toute la ligne, exactement comme avant. */
  .ghost-line { display: flex; align-items: stretch; gap: 6px; margin: var(--sp-sep) 0 var(--sp-tight); }
  .ghost-line > .wave-ghost { flex: 1 1 0; min-width: 0; margin: 0; }
  .task {
    margin-bottom: var(--sp-sep); padding: 5px; border-radius: 4px;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
  }
  .task-top { display: flex; gap: 4px; align-items: flex-start; }
  .task-top textarea { flex: 1; min-width: 0; }
  .task-row { display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: center; margin-top: var(--sp-sep); }
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
  .form-foot { display: flex; gap: 6px; align-items: center; margin-top: var(--sp-block); }
  .form-foot .spacer { flex: 1; }
  /* Badge d'écart intention/réel : le seul endroit du panneau qui parle de ce
     qui a été DEMANDÉ. Discret et non cliquable — c'est un constat, pas une
     action (la correction se fait par /model dans la conversation). */
  .mismatch { color: var(--vscode-errorForeground, #f14c4c); font-size: 10px; }
  .conv .mismatch { display: none; }
  .conv .mismatch.show { display: block; }

  /* ── Groupes (lot 2, capsule v2 — plan repli-auto étape 9 2026-08-05) ──────
     La capsule teintée redevient une simple GRIP au-dessus du corps : chevron,
     compteur, seg auto/man, et le ⌂-focus quand aucune master n'est désignée
     — rien d'autre en nominal (décision actée sur maquette v5). Une master
     désignée n'est plus un texte dans l'en-tête : elle devient une ligne de
     CONVERSATION STANDARD (même fabrique rowFor() que la liste plate),
     premier enfant du corps — son anneau d'état rejoint le rail P1 comme
     n'importe quel autre nœud de groupe (cf. .grp-body .conv .ico plus bas,
     qui s'applique par construction : la master n'est qu'un .conv de plus). */
  /* --grp-bleed (étape 19) : de combien le CADRE déborde, à gauche comme à
     droite, de la colonne de contenu. Constat user : la croix de la ligne
     master chevauchait la bande droite du cadre — or la croix ne peut pas
     bouger (égalité au pixel avec les lignes plates, invariant de l'étape 13).
     C'est donc le cadre qui s'élargit : débord par marge négative, COMPENSÉ
     par un padding égal, si bien que la boîte de contenu ne bouge pas d'un
     pixel — seules les bandes sortent. Une seule valeur, partagée par la grip
     et la ligne master : elles ne peuvent pas diverger. */
  .grp { margin: 2px 0 var(--sp-block); --grp-bleed: 5px; }
  .grp-head {
    display: flex; align-items: center; gap: 5px;
    margin: 0 calc(-1 * var(--grp-bleed));
    padding: 4px calc(6px + var(--grp-bleed)); border-radius: 6px; border-bottom-left-radius: 0;
    border: 1.5px solid var(--grp-hue, var(--muted));
    background: var(--grp-tint, transparent);
    cursor: pointer; user-select: none;
    /* Teinte : --grp-hue/--grp-tint, posées en JS sur .grp (renderGroups,
       dépendent de g.hue) et partagées avec la ligne master, le rail et les
       anneaux — UNE seule source, elles ne peuvent plus diverger (même
       principe que le fond anneau/panneau unifié à l'étape 12). Coin
       bas-gauche à 0 pour que le rail (même teinte) parte de la grip sans
       couture. TOUJOURS visible (2026-08-07) : c'est elle, et elle seule, qui
       porte le chevron et le compteur du groupe — replier ne doit RIEN changer
       à l'apparence de la ligne master (cf. .grp-body.collapsed ci-dessous). */
  }
  /* Capsule ENGLOBANTE (étape 13) : avec une master, la grip n'est plus que la
     rangée HAUTE du cadre — elle perd sa bordure basse, la ligne master
     ci-dessous ferme le cadre. Sans master, la grip reste un cadre complet. */
  .grp.has-master > .grp-head {
    border-bottom-width: 0;
    border-bottom-right-radius: 0;
  }
  .grp-head:hover { background: var(--vscode-list-hoverBackground); }
  /* Identité du lot dans la grip (2026-08-15). L'espace entre le chevron et le
     compteur était vide alors que RIEN à l'écran ne disait de quel lot il
     s'agissait : le nom ne vivait qu'en infobulle, et seulement sur un lot sans
     maîtresse — donc jamais visible dans le cas nominal. Le libellé porte
     l'heure de création (stamp, posé par extension.js) et non le nom : deux
     lots peuvent porter le même nom, leur heure les sépare toujours.
     flex: 0 1 auto + ellipsis = c'est TOUJOURS ce libellé qui cède, jamais le
     compteur qui bouge. Prouvé au banc avant d'écrire cette règle (bord droit
     du compteur identique au pixel, libellé court comme libellé long, dans les
     deux thèmes) : sans cela un nom un peu long pousserait le compteur hors de
     la grip. Même typographie que les titres de section du panneau (h2) — un
     lot se lit comme le contenant qu'il est. */
  .grp-label {
    flex: 0 1 auto; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: 10px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase;
    color: var(--muted);
  }
  .grp-count { flex: none; font-size: 10px; color: var(--muted); font-variant-numeric: tabular-nums; }
  /* Chip « ce qui reste à faire » (étape 11) : même variable de thème que le
     glyphe ✓ done des membres. */
  .grp-done { flex: none; font-size: 10px; color: var(--done); font-weight: 600; margin-left: 4px; }
  .grp-head .spacer { flex: 1 1 auto; }
  .gbtn {
    flex: none; border: 0; background: none; cursor: pointer; padding: 1px 4px;
    border-radius: 3px; font-size: 11px; line-height: 1.2; color: var(--muted);
  }
  .gbtn:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); }
  /* Dissoudre le lot (2026-08-09) : révélé au survol de la grip, invisible au
     repos — la rangée nominale reste chevron + compteur. Contrairement aux
     boutons des LIGNES, il peut rester dans le flux : la grip ne porte aucune
     barre de contexte et son seul voisin élastique est le spacer, donc sa
     largeur ne rogne rien (l'invariant « au pixel » du dossier porte sur les
     lignes de conversation, jamais sur cette rangée). Aucune couleur d'alerte :
     le rouge a été banni des gestes du panneau, et la modale de dissolution
     porte déjà l'avertissement. Séparé du ⌂ par une gouttière propre — les
     deux peuvent s'afficher ensemble sur un lot sans maîtresse. */
  .g-kill { margin-left: 3px; opacity: 0; transition: opacity .1s; }
  .grp-head:hover .g-kill, .g-kill:focus-visible { opacity: 1; }
  /* Ligne master (plan repli-auto étape 9) : même wrapping que .m-head/.m-slot
     (défini plus bas) pour un membre — et, depuis 2026-08-07, même sortie de
     flux pour ses deux boutons (✕ de dissolution, chip « délier ») : aucun
     n'a plus d'emprise sur la largeur de la ligne, qui vaut donc celle d'une
     ligne plate au pixel, au repos comme au survol.
     Premier enfant DE FLUX du corps (avant les vagues/membres) : mêmes
     offsets horizontaux que .m-head (décision 2, alignement unifié), donc que
     la liste plate — rien à ajouter ici, .grp-master-head ne pose aucun
     padding/margin gauche. */
  /* La capsule teintée ENGLOBE la ligne master (étape 13 — constat user : elle
     flottait SOUS le cadre). Le cadre est peint en box-shadow INSET, jamais en
     border/padding : une bordure décalerait de 1,5px tout le contenu de la
     ligne et casserait l'égalité au pixel avec les lignes standard — la classe
     d'erreur même de ce lot. Les bandes tombent donc exactement sur les bords
     de la bordure de la grip au-dessus (même boîte, même teinte) : un seul
     cadre continu à l'œil, zéro géométrie modifiée. Le fond teinté, lui, est
     peint dans la couche des fonds de blocs — le rail (positionné) passe
     PAR-DESSUS, la master reste le premier nœud du rail comme à l'étape 9. */
  .grp-master-head {
    position: relative;
    display: flex; align-items: flex-start; gap: 4px; min-width: 0;
    margin: 0 calc(-1 * var(--grp-bleed)); padding: 0 var(--grp-bleed);
    background: var(--grp-tint, transparent);
    border-radius: 0 0 6px 6px;
  }
  /* ÉTAPE 19 — le cadre vit sur un CALQUE qu'aucun fond d'enfant ne peut
     recouvrir. Constat user : ligne master sélectionnée (ou survolée) → son
     fond (.conv.active / .conv:hover) passait PAR-DESSUS les bandes, peintes
     jusque-là en box-shadow inset sur le conteneur lui-même : un box-shadow
     inset appartient à la couche des fonds du parent, donc SOUS le fond de
     n'importe quel enfant. Le pseudo-élément, lui, se peint après tous les
     descendants non positionnés — la sélection ne peut plus l'atteindre, quel
     que soit son fond. pointer-events:none : purement décoratif, il ne vole
     aucun clic à la ligne en dessous. */
  .grp-master-head::after {
    content: ''; position: absolute; inset: 0; z-index: 2; pointer-events: none;
    border-radius: inherit;
    box-shadow:
      inset 1.5px 0 0 0 var(--grp-hue, transparent),
      inset -1.5px 0 0 0 var(--grp-hue, transparent),
      inset 0 -1.5px 0 0 var(--grp-hue, transparent);
  }
  .grp-master-slot { flex: 1; min-width: 0; }
  /* Fallback dégradé (master hors de la fenêtre du panneau — ni transcript ni
     onglet suivis) : réutilise le gabarit .conv/.ico/.title existants (grille
     16px+1fr déjà stylée plus bas) plutôt que d'inventer une mise en page —
     seuls titre + tooltip (hint member-truth) sont montrés, jamais de nœud
     manquant. */
  .grp-master-fallback.conv { cursor: pointer; }
  /* Corps du groupe : ALIGNÉ sur la colonne des conversations plates, aucune
     indentation propre (décision 2) — l'ancien filet (border-left + margin-
     left + padding-left) disparaît, remplacé par le rail P1 ci-dessous.
     position:relative SEUL (aucun padding) ancre le rail sans décaler son
     repère — l'anti-bug connu de la maquette v2 (rail pas centré parce que
     positionné dans un conteneur encore paddé). padding-top (lot 5 §2ter,
     conservé) : bloque le margin-collapse du 1er séparateur de vague. */
  .grp-body { position: relative; padding-top: 1px; }
  /* … sauf sous une capsule englobante (étape 13) : ce 1px laissait passer une
     ligne de fond du panneau ENTRE la grip et la ligne master, coupant le
     cadre en deux (mesuré : grip.bottom 91.14 / master.top 92.13). Il n'a plus
     rien à bloquer ici — le premier enfant du corps est alors la ligne master,
     qui n'a pas de marge à faire fusionner (le cas visé était le 1er
     séparateur de vague). */
  .grp.has-master > .grp-body { padding-top: 0; }
  /* Repli (plan repli-auto étape 2, révisé étape 9, RÉVISÉ 2026-08-07) : le
     repli masque les CONVERSATIONS DU GROUPE (membres, vagues, rail), rien
     d'autre. La grip reste la grip — chevron, compteur, cadre — et la ligne
     master reste STRICTEMENT identique à elle-même, dépliée comme repliée :
     mêmes coins, même cadre, aucune décoration qui apparaît ou disparaît.
     Constat user : replier « changeait l'apparence de la master » (elle
     héritait alors du chevron, du chip et d'un cadre refermé en haut parce que
     la grip s'effaçait) — c'était la grip qu'il fallait garder, pas déguiser
     la master en grip. */
  .grp-body.collapsed > *:not(.grp-master-head) { display: none; }

  /* ── Filiation des lots (plan arbre-filiation 2026-08-15, lot 2,
     AMENDÉ 2026-08-16 « canon de la maîtresse ») ─────────────────────────
     Un lot B dont la conversation maîtresse est MEMBRE d'un lot A se rend SOUS
     cette ligne, à l'intérieur du corps de A (nesting.js décide, panel.js
     range). La ligne, elle, ne bouge pas d'un pixel : elle reste un membre de
     A, sur le rail de A, au même axe que ses sœurs — c'est le modèle qui le
     dit (une maîtresse est un POINTEUR vers une conversation qui vit là où
     elle est). Elle devient simplement la TÊTE du sous-lot.
     Un lot sans filiation ne change RIEN : aucune de ces règles ne le touche
     (écart minimal avec le rendu publié — choix A du plan).
     Le sous-lot réemploie le vocabulaire d'un lot racine AVEC maîtresse
     (grip qui referme son bas, ligne encadrée sur 3 bords) plutôt que d'en
     inventer un nouveau : la grip du sous-lot (.grp-head.nest-grip) précède
     la ligne de tête — qui APPARTIENT au parent — et son corps
     (.grp-body.nest-body) la suit. Le bloc .grp de l'enfant n'est donc plus un
     conteneur unique : ses deux moitiés sont posées séparément dans le corps
     du parent (renderGroups), de part et d'autre d'une ligne qu'il ne possède
     pas. Le premier jet (chip « ▾ N/M done » dans la ligne .meta) est abandonné
     : il inventait une grip miniature là où le panneau en a déjà une — décidé
     par l'user sur planche de captures (« pourquoi pas le même canon que la
     master ? »). */
  .grp-head.nest-grip {
    /* Même cap que .grp.has-master > .grp-head (bas ouvert, coin bas-droit
       carré) : c'est la ligne du parent, juste en dessous, qui referme le
       cadre — un seul cadre continu, jamais deux bordures qui se touchent.
       Marge à 4 valeurs (haut/droite/bas/gauche) : le décalage à
       --nest-indent (28px) ET l'annulation du bleed s'écrivent en UNE
       déclaration, jamais deux règles qui pourraient diverger. Bleed annulé
       des DEUX côtés (pas seulement à gauche) : la capsule de la ligne de
       tête ci-dessous n'a elle-même jamais bledé (right:0, jamais un lot
       racine avec master), un bleed résiduel à droite désalignerait les deux
       bords du cadre — constat visé par le banc « bords gauche/droite
       alignés au pixel entre les deux ». */
    margin: 2px 0 0 var(--nest-indent);
    padding-left: 6px; padding-right: 6px;
    border-bottom-width: 0;
    border-bottom-right-radius: 0;
  }
  /* Corps du sous-lot : même décalage que sa grip, COLLÉ sous la capsule de
     tête (aucune marge haute — un interstice y laisse passer une bande du
     fond du panneau, bien visible en thème sombre) ; marge basse sp-block
     pour respirer avant ce qui suit dans le corps du parent. AUCUN
     border-left : le rail du parent longe déjà son flanc gauche (13px), à
     bonne distance de --nest-indent (28px) — un liseré le doublerait
     (constaté au banc de la maquette). */
  .grp-body.nest-body {
    margin: 0 0 var(--sp-block) var(--nest-indent);
    padding-top: 0;
  }

  /* Capsule de tête : la ligne du parent est ENCADRÉE à la couleur du sous-lot
     qu'elle ouvre, tout en gardant sa bulle et son anneau au parent (« couleur
     de bulle héritée du parent, encadrée de la couleur de ses enfants »).
     — Peinte en PSEUDO-élément, jamais en border/padding : une bordure
       décalerait tout le contenu de la ligne et casserait l'égalité au pixel
       avec les lignes plates (§16 du banc), qui est l'invariant même de ce
       panneau. Le pseudo se peint aussi APRÈS les fonds des descendants, donc
       la sélection/le survol de la ligne ne peut pas passer par-dessus —
       exactement la leçon de l'étape 19 sur le cadre de la ligne maîtresse.
     — Elle commence à --nest-indent : l'anneau reste DEHORS, sur le rail du
       parent. L'englober enfermerait le rail du parent dans le cadre de
       l'enfant, ce qui dirait le contraire de la structure.
     — 3 BORDS seulement (gauche/droite/bas), radius bas uniquement — le cadre
       de .grp-master-head à l'identique (amendement 2026-08-16) : le bord
       HAUT n'a plus lieu d'être puisque la grip, juste au-dessus, ferme déjà
       le cadre par le sien. Un 4e bord aurait dessiné une double ligne à la
       couture grip/tête. Toujours sans aucun fond : dans tout le panneau, une
       capsule n'encadre qu'un EN-TÊTE, jamais des lignes de conversation. */
  .member.nest-host > .m-head::after {
    content: ''; position: absolute; z-index: 2; pointer-events: none;
    top: 0; right: 0; bottom: 0; left: var(--nest-indent);
    border-radius: 0 0 6px 6px;
    box-shadow:
      inset 1.5px 0 0 0 var(--nest-hue, var(--grp-hue, var(--muted))),
      inset -1.5px 0 0 0 var(--nest-hue, var(--grp-hue, var(--muted))),
      inset 0 -1.5px 0 0 var(--nest-hue, var(--grp-hue, var(--muted)));
  }

  /* Rail P1 (« nœuds sur l'axe ») : trait vertical teinté du groupe, centré
     au pixel sur l'axe de la colonne des symboles d'état — le MÊME axe que
     les conversations plates (colonne grille 16px + padding gauche 6px de
     .conv/.m-pending ⇒ centre à 14px de leur bord gauche, qui vaut aussi le
     bord gauche de .grp-body puisqu'il n'a plus de padding). Hauteur posée en
     JS (renderGroups) : du haut du corps jusqu'au sommet de la ligne fantôme,
     jamais plus bas — measure sur node.ghostRow.offsetTop après placement.
     z-index bas : les anneaux ci-dessous peignent PAR-DESSUS pour le « trouer ». */
  .grp-rail {
    /* left:13px, pas 14 : la propriété left positionne le bord GAUCHE de
       l'élément, et le rail fait 2px de large — pour que son CENTRE tombe
       sur l'axe à 14px (mesuré au banc), le bord gauche doit être à 13px. */
    position: absolute; left: 13px; top: 0; width: 2px; z-index: 0;
    background: var(--grp-hue, var(--muted));
    pointer-events: none;
  }
  /* Anneau troué autour du symbole d'état d'une ligne DE GROUPE (membre lié
     OU ligne « en attente » avec son symbole queued) : cercle bordé teinte du
     groupe, fond OPAQUE = fond du panneau (c'est lui qui troue le rail), le
     glyphe garde sa couleur d'état. .ico/.ico-pending passent à z-index:1
     (position:relative) : leur PROPRE contexte d'empilement peint entièrement
     au-dessus du rail (z-index:0) ; à l'intérieur de ce contexte, l'anneau
     (z-index:-1, LOCAL à l'icône) reste sous le glyphe — jamais dépendant du
     z-index global du document, donc robuste peu importe l'ordre DOM. Centré
     via top/left 50% + margin négatif : le centre du cercle égale TOUJOURS le
     centre de la boîte icône, quelle que soit sa taille exacte (9px vs 10px
     selon l'état) — donc toujours sur l'axe de la colonne grille. */
  .grp-body .conv .ico, .grp-body .m-pending .ico-pending {
    position: relative; z-index: 1;
  }
  .grp-body .conv .ico::after, .grp-body .m-pending .ico-pending::after {
    content: ''; position: absolute; z-index: -1;
    top: 50%; left: 50%; width: 16px; height: 16px; margin: -8px 0 0 -8px;
    border-radius: 50%; box-sizing: border-box;
    border: 1.5px solid var(--grp-hue, var(--muted));
    /* Étape 12 (régression thème clair) : MÊME chaîne que le fond du body
       ci-dessus, jamais un littéral figé (l'ancien fallback #1e1e1e ne
       « troue » que sur fond sombre — en clair il peignait un disque sombre
       visible, lu comme « le rail traverse l'anneau »). Les deux endroits
       partagés = ne peuvent plus diverger. */
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  }
  /* Anneau de la ligne MASTER (étape 13) : elle est DANS la capsule, donc le
     fond réel derrière son anneau vaut « fond du panneau + teinte du groupe ».
     La teinte est ajoutée en background-image PAR-DESSUS le background-color
     hérité de la règle ci-dessus : exactement la même composition que la
     capsule elle-même (même couleur, même ordre) — les deux ne peuvent pas
     diverger, dans aucun thème. */
  .grp-master-head .conv .ico::after {
    background-image: linear-gradient(var(--grp-tint, transparent), var(--grp-tint, transparent));
  }
  /* Vie des bulles en attente (plan repli-auto étape 5) : un anneau ne reste
     JAMAIS vide. « inserted » (Entrée attendue de l'USER) : pulse lent, en
     intensité SEULE (jamais translate/scale — le glyphe, lui, ne bouge pas).
     « queued »/« not-linked »/tout le reste en attente : rien à faire pour
     l'instant → anneau statique atténué, jamais de pulse. Classe posée par
     pendingLine() sur .ico-pending, jamais déduite ici. PAS de @media
     (prefers-reduced-motion) — même raison que .ico-busy plus haut : ce poste
     a les animations Windows OFF en permanence, une @media rendrait le pulse
     invisible pour son propre auteur (choix documenté au CHANGELOG pour les
     tiers).
     ÉTAPE 13 — l'atténuation porte sur la seule BORDURE de l'anneau, plus sur
     son opacity : une opacité sur l'anneau rend aussi son FOND translucide,
     et le rail transparaît alors dans la bulle (« bulles perçues transparentes
     sur le rail », reproduit en CDP). Le trou opaque est un invariant de tous
     les anneaux ; seule l'intensité du cerclage dit l'attente. */
  .grp-body .m-pending .ico-pending-wait::after {
    animation: grp-wait-pulse 2.5s ease-in-out infinite;
  }
  .grp-body .m-pending .ico-pending-idle::after {
    border-color: color-mix(in srgb, var(--grp-hue, var(--muted)) 40%, transparent);
  }
  @keyframes grp-wait-pulse {
    0%, 100% { border-color: color-mix(in srgb, var(--grp-hue, var(--muted)) 45%, transparent); }
    50% { border-color: var(--grp-hue, var(--muted)); }
  }
  /* Amendement 2026-08-05 : une conv LISTÉE (rendue via rowFor, pas
     pendingLine) ne doit pas non plus laisser un anneau vide pendant qu'elle
     travaille — busy/waiting/interrupted/stale portent désormais un glyphe
     dans l'anneau, comme le ✓ done. « waiting » a déjà son « ? » (::before
     générique, hors groupe) ; « interrupted »/« stale » n'avaient encore
     aucun glyphe : « ⚠ » commun aux deux, dans leurs teintes respectives.
     ÉTAPE 16 (révoque l'amendement busy ci-dessus, 2026-08-05) : le premier
     jet figeait le spinner busy par crainte qu'un rail de spinners minuscules
     « se lise vide » — mais le pulse d'attente (étape 5, juste au-dessus) a
     déjà prouvé la parade : une animation SANS @media reduced-motion, sur ce
     poste où cette préférence est en permanence sur « reduce ». Pas de règle
     ici : la classe ico-busy de groupe retombe donc sur LA MÊME classe et
     les mêmes keyframes spin que les lignes plates — une seule définition,
     aucune divergence de teinte ni de cadence possible entre les contextes. */
  /* SUPPRIMÉ 2026-08-09 — le jeu de symboles parallèle du groupe.
     Il vivait ici : « interrupted » et « stale » perdaient leur forme propre
     (carré / cercle pointillé) pour un « ⚠ » commun, distingué par la seule
     teinte. Deux vocabulaires selon le contexte, et deux états rendus
     indiscernables l'un de l'autre dans un lot — signalé par l'user (« je ne
     veux pas deux listes de symboles »). La cause n'était pas un besoin de
     lisibilité mais la technique de dessin : ces deux formes-là étaient les
     seules portées par la BORDURE de l'icône, donc les seules avalées par
     l'anneau. Corrigé à la source (pseudos positionnés, cf. le bloc des
     pastilles) : il n'y a plus rien à redéfinir ici, et il ne doit plus jamais
     rien y avoir. Toute forme d'état ajoutée plus tard se dessine en pseudo
     positionné et vaut pour les DEUX contextes ; si elle disparaît dans un
     anneau, c'est le dessin qu'on corrige, pas le symbole qu'on remplace. */
  /* Séparateurs de vague, ligne fantôme, bannières (waveCtrl) ET pill de
     lancement : tout commence APRÈS l'axe du rail (14px + marge) pour ne pas
     le croiser. Étape 16 : waveCtrl ajouté à ce groupe de sélecteurs (pas de
     valeur recopiée ailleurs). 2026-08-07 : la pill .launch rejoint la règle —
     elle restait pleine largeur au-dessus du rail (étape 19), lu par l'user
     comme une morsure sur le trait ; margin-left (pas padding : c'est sa
     BOÎTE bordée qui doit s'écarter, pas son contenu). */
  .grp-body .wave-hdr:not(.launch), .grp-body .wave-ctrl { padding-left: 20px; }
  .grp-body .wave-hdr.launch { margin-left: 20px; }
  .grp-body .wave-ghost { margin-left: 20px; }
  /* La ligne fantôme finale porte l'écart pour ses DEUX cellules : c'est elle
     la boîte qui longe le rail, elles ne s'en écartent pas une seconde fois
     (sélecteur à trois classes = il prime sur la règle ci-dessus, quel que
     soit l'ordre des déclarations). */
  .grp-body .ghost-line { margin-left: 20px; }
  .grp-body .ghost-line > .wave-ghost { margin-left: 0; }
  /* Moteur de vagues (lot 4) : en-tête de vague identique à celui du formulaire,
     toggle auto/manuel dans l'en-tête de groupe, contrôle de vague suivante en
     bas de la vague courante. */
  .wave-ctrl { margin: 2px 0 var(--sp-block); }
  .wave-ctrl:empty { display: none; margin: 0; }
  .wave-ctrl .btn { margin-top: 3px; }
  /* 2026-08-07 — la ligne d'un membre n'a plus QU'un enfant de flux : sa
     conversation. Le bouton de retrait est sorti du flux (cf. .m-out plus
     bas), .m-slot occupe donc toute la largeur, exactement comme une ligne
     plate. position:relative fait de .m-head le repère de cet overlay :
     son bord droit vaut celui de la colonne de contenu, donc celui d'une
     ligne plate — le bouton ne peut pas se caler ailleurs. */
  .m-head { position: relative; display: flex; align-items: flex-start; gap: 4px; min-width: 0; }
  .m-slot { flex: 1; min-width: 0; }
  /* Titre d'un MEMBRE : un cran sous tout le reste (2026-08-06). Le rang se lit
     alors dans la typo autant que dans le rail — la maîtresse et les convs hors
     groupe gardent la taille de base, un membre est une ligne DANS quelque
     chose. 12px, exactement la taille de .m-prompt juste dessous : un membre
     lié et un membre encore en attente sont la même ligne à deux états, ils ne
     peuvent pas se rendre à deux tailles. Porté par .m-slot, jamais par
     .grp-body .conv (qui emporterait la ligne maîtresse) : celle-ci vit dans
     .grp-master-slot, la séparation est structurelle et non énumérée. */
  .m-slot .conv .title { font-size: 12px; }
  /* Ligne d'un membre PAS ENCORE lié à une conversation : le prompt, et
     l'aveu qu'on ne sait pas encore de quelle conv il s'agit. Jamais un état
     emprunté à une autre — un membre non lié n'a pas d'état. */
  .m-pending {
    display: grid; grid-template-columns: 16px 1fr; gap: 8px;
    /* Même resserrement que .conv (lot A) : une ligne en attente et une ligne
       lancée sont la même ligne à deux états (cf. .m-slot .conv .title
       ci-dessus), leur gabarit vertical ne peut pas diverger. */
    padding: var(--sp-tight) 6px; border-radius: 4px;
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
     8 px de gouttière). Le pied ne contient plus QUE des éléments réellement
     visibles (note, « Link… », « Relaunch ») — les boutons de survol ◂/▸ en
     sont sortis (cf. .m-move) : un enfant de flux coûte sa hauteur même à
     opacité 0, exactement comme il coûtait sa largeur sur la ligne master
     (étape 13) et sur la croix des membres (2026-08-07). C'est ce pied gonflé
     à 15,2 px pour un seul bouton invisible qui rendait les lignes EN FILE
     bien plus épaisses que les lignes lancées (mesuré en CDP, 2026-08-09).
     Le repli est piloté par panel.js (foot.style.display) et non par :empty :
     les chips existent toujours dans le DOM, masqués un par un — :empty
     n'était donc JAMAIS vrai, la règle mentait depuis le début. */
  .m-foot { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 0 0 3px 24px; }
  /* Déplacer une tâche EN FILE vers la vague voisine : overlay au survol, même
     patron et même gabarit que le bouton de sortie ⤴ (.m-out) qu'il jouxte —
     zéro emprise sur le flux, au repos comme au survol. Glyphes seuls : le
     texte « ◂ wave » ne tiendrait pas ici sans recouvrir la moitié du prompt,
     et l'infobulle dit déjà vers quelle vague on part. pointer-events désarmé
     au repos, sinon cette bande invisible avalerait les clics destinés à la
     ligne (le ⤴, lui, ne fait que 15 px et précède cette règle). */
  .m-move {
    /* Même calc que .m-out (lot A) : aligné sur l'axe de l'icône, suit
       --sp-tight tout seul. */
    position: absolute; top: calc(var(--sp-tight) - 1px); right: 19px; z-index: 3;
    display: flex; gap: 4px;
    opacity: 0; pointer-events: none; transition: opacity .1s;
  }
  .member:hover .m-move, .m-move:focus-within { opacity: 1; pointer-events: auto; }
  .m-note { font-size: 10px; color: var(--muted); }
  /* Le bouton de retrait est un OVERLAY (cf. .m-out) : le pointeur qui le vise
     SORT de .conv — il n'en est pas un enfant — et éteindrait son fond de
     survol, si bien que le fond du bouton (calé sur celui d'une ligne
     survolée) se détacherait en pastille au moment précis où on le vise. Le
     survol de la ligne ENTIÈRE le rallume. .active garde la main : une ligne
     sélectionnée ne repasse jamais en teinte de survol. */
  .member:hover .conv:not(.active), .grp-master-head:hover .conv:not(.active) {
    background: var(--vscode-list-hoverBackground);
  }
  /* Le chip texte « Délier » de la ligne maîtresse a disparu (2026-08-09) :
     son geste est devenu le ⤴ ci-dessous, celui-là même que porte tout membre.
     Avec lui s'en vont la classe .m-hover et sa règle de position — plus aucun
     élément ne les portait. L'acquis de l'étape 13 reste, lui, entièrement
     valable et vaut pour son remplaçant : un bouton de la ligne maîtresse
     n'est JAMAIS un enfant du flux flex (invisible, il coûterait quand même sa
     largeur — ~42px mesurés en CDP à l'époque, d'où la barre de contexte de la
     master plus courte que celle des autres lignes). */
  /* Sortie d'une conversation de son groupe (2026-08-07) — DEUX exigences que
     seul un overlay satisfait ensemble :
       1. « une ligne de groupe et une ligne plate sont strictement
          identiques » : même barre de contexte, mêmes offsets. Le moindre
          enfant de flux à droite (l'ancienne croix rouge, flex: none) rognait
          la ligne de ~19px — c'est très exactement ce que l'étape 13 avait
          déjà corrigé sur la ligne master en sortant son chip « délier » du
          flux. Ici, on applique le MÊME patron à toutes les lignes.
       2. « le panneau ne supprime jamais une ligne » : ce bouton ne touche
          QUE les métadonnées du groupe (removeMember) — la conversation et
          son onglet restent, elle repart simplement en liste plate. D'où la
          flèche et non plus une croix : plus aucune croix rouge sur une
          ligne, une croix se lit « fermer », ce que ce geste ne fait pas.
     Zéro emprise au repos (opacity 0, hors flux) et zéro emprise au survol :
     l'overlay ne pousse rien, la géométrie est la même dans les deux états.
     Le fond opaque masque la fin du titre qu'il recouvre au survol ; il est
     calé sur le fond de la ligne survolée, jamais sur celui du panneau. */
  /* Gabarit commun des pastilles d'action au survol d'une ligne (⤴ sortie, ◂/▸
     déplacement de vague) : un seul disque, une seule taille — deux gabarits
     voisins se verraient. Le positionnement, lui, reste propre à chacun (.m-out
     s'ancre à droite de .m-head, .m-mv vit dans le flex de .m-move). */
  .m-out, .m-mv {
    width: 15px; height: 15px; box-sizing: border-box; padding: 0;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: 50%; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
    background: var(--vscode-list-hoverBackground, var(--vscode-sideBar-background, var(--vscode-editor-background)));
    color: var(--muted);
    font-size: 10px; line-height: 1; cursor: pointer;
  }
  .m-out {
    /* top calé sur l'axe de l'icône (lot A, 2026-08-09) : le 4px d'origine
       était réglé à l'œil pour un padding-top de .conv fixé à 5px en dur.
       .conv est passé à var(--sp-tight) — l'icône remonte d'autant, cet
       overlay doit suivre exactement le même déplacement : (4 - (5 -
       --sp-tight)) = --sp-tight - 1. Si --sp-tight rebouge, ce calc suit tout
       seul plutôt que de redevenir un nombre à réajuster à l'œil. */
    position: absolute; top: calc(var(--sp-tight) - 1px); right: 0; z-index: 3;
    opacity: 0; transition: opacity .1s;
  }
  /* La ligne master vit dans une boîte qui DÉBORDE de la colonne de contenu
     (padding = --grp-bleed, pour que le cadre teinté sorte sans décaler quoi
     que ce soit) : sans ce rappel, right:0 collerait le bouton sur la bande
     du cadre au lieu du bord de la colonne — donc à un autre x que celui d'un
     membre, l'égalité même que ce lot doit tenir. */
  .grp-master-head .m-out { right: var(--grp-bleed); }
  .member:hover .m-out, .grp-master-head:hover .m-out, .m-out:focus-visible { opacity: 1; }
  .m-out:hover, .m-mv:hover { color: var(--vscode-foreground); border-color: var(--muted); }
  /* Ligne SÉLECTIONNÉE : son fond n'est pas celui du survol — le bouton suit,
     sinon il se détache en pastille sur la seule ligne active. :has() n'est
     pas indispensable (sans lui la règle saute et le repli reste correct). */
  .m-head:has(.conv.active) .m-out, .grp-master-head:has(.conv.active) .m-out {
    background: var(--vscode-list-inactiveSelectionBackground, var(--vscode-list-hoverBackground));
  }
  /* Rattacher une ligne plate à la maîtresse de l'onglet actif (lot B, plan
     « master conv isolée » 2026-08-09) — même porte que le ⌂ de l'en-tête de
     groupe (setGroupMaster) : aucune saisie, aucune liste, l'onglet VS Code
     actif tranche. Overlay DANS .conv (.conv est déjà position:relative,
     ci-dessus) — jamais un enfant du flux flex, même invisible (l'invariant
     du dossier, cf. CLAUDE.md : un enfant de flux coûte sa largeur et
     raccourcit la barre de contexte de la ligne). Opacité/transition PROPRES,
     jamais une classe de survol partagée (cf. panel.js createRow) : la ligne
     .conv vit SOUS .grp-master-head/.member selon le contexte, si bien qu'un
     sélecteur générique descendant de l'un des deux matcherait aussi ce
     bouton — c'est ce qui avait déjà piégé l'ancien chip « délier ». */
  /* top : même calc que .m-out (lot A) — aligné sur l'axe de l'icône, suit
     --sp-tight tout seul. */
  .link-master { position: absolute; top: calc(var(--sp-tight) - 1px); right: 0; opacity: 0; transition: opacity .1s; }
  .conv:hover .link-master, .link-master:focus-visible { opacity: 1; }
  /* Visible SEULEMENT sur une ligne plate vraie : le même gabarit .conv sert
     aussi la ligne master (.grp-master-slot) et chaque membre (.m-slot) —
     masqué par la structure DOM, jamais par un état JS à tenir à jour. */
  .m-slot .conv .link-master, .grp-master-slot .conv .link-master { display: none; }
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
      <div class="canary" id="tabsFrozenNotice">${vscode.l10n.t('VS Code stopped reporting tab changes — highlight may lag. Reloading the window fixes it.')}</div>
      <!-- Conteneur UNIQUE (2026-08-07) : blocs de groupe et lignes plates
           sont frères. Deux conteneurs (#groups puis #convs) rendaient l'ordre
           STRUCTUREL — un groupe passait forcément avant toute conversation
           hors groupe, quel que soit le rang de ses onglets. -->
      <div id="flow"></div>
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
  const flowEl = document.getElementById('flow');
  const quotaEl = document.getElementById('quota');
  const countEl = document.getElementById('convCount');
  const soundsToggleEl = document.getElementById('soundsToggle');
  const canaryEl = document.getElementById('canary');
  const tabsFrozenEl = document.getElementById('tabsFrozenNotice');
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
    // Rattacher (lot B, plan « master conv isolée » 2026-08-09) : overlay
    // hover-only, DANS .conv (cf. règle CSS .link-master) — createRow() sert
    // aussi bien les lignes plates que la ligne master ou un membre de groupe
    // (rowFor() est LA même fabrique partout), donc le bouton existe toujours
    // dans le DOM ; c'est la structure d'accueil (.m-slot/.grp-master-slot)
    // qui le masque là où il n'a pas de sens — jamais un état JS ici. Son
    // opacité et sa transition lui sont PROPRES (règle .link-master), jamais
    // une classe de survol partagée : la ligne .conv étant nichée SOUS
    // .grp-master-head (via .grp-master-slot), un sélecteur générique
    // descendant de .grp-master-head matcherait aussi ce bouton — c'est très
    // exactement ce qui cassait le clic « délier » de la ligne master
    // (querySelector prend le premier match dans
    // l'ordre du DOM), constaté par test-panel-render.js.
    const linkMaster = el('button', 'chip act link-master', '⌂');
    linkMaster.type = 'button';
    linkMaster.title = t('Link to the active tab’s conversation as master');
    root.appendChild(linkMaster);
    const row = { root, ico, title, model, ctx, mismatch, ctxBar, fill: ctxBar.firstChild, linkMaster, data: null };
    root.addEventListener('click', function () {
      // tabTitle : titre RÉEL de l'onglet quand il diverge de celui du
      // transcript — sans lui, focus.js ne retrouve pas un onglet renommé.
      if (row.data) vscode.postMessage({ type: 'focusConv', id: row.data.id, title: row.data.title, tabTitle: row.data.tabTitle || null });
    });
    linkMaster.addEventListener('click', function (e) {
      e.stopPropagation();
      if (row.data) vscode.postMessage({ type: 'linkConvToActiveMaster', id: row.data.id });
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

  // ── Flux unique : blocs de groupe et lignes plates, dans le MÊME ordre ────
  //
  // « total » compte TOUTES les conversations (groupées comprises) : le compteur
  // de l'en-tête et le message « aucune conversation » parlent de la section
  // entière, pas seulement de ce qui reste hors des groupes.
  //
  // MODE « ordre des onglets » (2026-08-07) : un bloc de groupe s'INTERCALE
  // dans le flux au rang du plus à gauche de ses onglets (maîtresse comprise) —
  // une conversation hors groupe dont l'onglet est plus à gauche s'affiche donc
  // AU-DESSUS du groupe. Le rang ne se re-dérive pas ici : c'est la position
  // dans la liste que l'extension a déjà triée par onglets (state.js, tabOrder),
  // seule source. Un groupe dont aucun membre listé n'a d'onglet matché →
  // Infinity, comme une conversation sans onglet : il retombe en fin de flux
  // sans bousculer l'ordre relatif de ses pareils (tri stable, via seq).
  //
  // AUTRES MODES (lastActivity / statusFirst) : inchangé — les groupes en tête,
  // puis les lignes plates. Le classement d'un bloc par « dernière activité »
  // ou par « état » demanderait de choisir laquelle de ses conversations parle
  // pour lui ; ce n'est pas ce lot.
  //
  // FILIATION (2026-08-15) : la liste des blocs ne contient que les RACINES — un
  // sous-lot imbriqué a déjà été rangé dans le corps de son parent, et son
  // rang est fondu dans celui de ce parent (renderGroups). layoutFlow n'a donc
  // rien de particulier à savoir de la filiation : il place des blocs, comme
  // avant, et il y en a simplement moins.
  function layoutFlow(blocks, flat, convs, order, seen) {
    countEl.textContent = convs.length ? String(convs.length) : '';

    const items = [];
    if (order === 'tabOrder') {
      const rankOf = new Map();
      convs.forEach(function (c, i) { rankOf.set(c.id, i); });
      const rankOfId = function (id) { return rankOf.has(id) ? rankOf.get(id) : Infinity; };
      blocks.forEach(function (b, i) {
        let r = Infinity;
        b.convIds.forEach(function (id) { const v = rankOfId(id); if (v < r) r = v; });
        items.push({ rank: r, seq: i, node: b.root });
      });
      flat.forEach(function (c, i) {
        seen.add(c.id);
        items.push({ rank: rankOfId(c.id), seq: blocks.length + i, node: rowFor(c).root });
      });
      // Infinity - Infinity vaut NaN : le rang se compare d'abord à l'identique
      // (l'ordre d'origine tranche alors), jamais par soustraction seule.
      items.sort(function (a, b) { return a.rank === b.rank ? a.seq - b.seq : a.rank - b.rank; });
    } else {
      blocks.forEach(function (b) { items.push({ node: b.root }); });
      flat.forEach(function (c) {
        seen.add(c.id);
        items.push({ node: rowFor(c).root });
      });
    }

    items.forEach(function (it, i) { place(flowEl, i, it.node); });

    // « Aucune conversation » : en FIN de flux, jamais à la place d'un groupe —
    // un groupe dont aucune tâche n'est encore lancée n'a aucune conversation
    // à montrer et doit quand même se rendre.
    let empty = flowEl.querySelector('.empty');
    if (!convs.length) {
      if (!empty) empty = el('div', 'empty', t('No recent conversation here.'));
      place(flowEl, items.length, empty);
    } else if (empty) {
      empty.remove();
    }
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

  // ── Groupes (lot 2, capsule v2 — plan repli-auto étape 9) ─────────────────
  // Nœuds conservés d'un rendu à l'autre, même raison que les lignes de conv :
  // un push d'état arrive toutes les 30 s au minimum, et bien plus souvent
  // pendant qu'une conversation travaille.
  const groupNodes = new Map();   // id → { root, count, chev, body, members: Map, … }

  // Rail P1 : hauteur mesurée via ghostRow.offsetTop (§3 du plan). Une seule
  // mesure synchrone AU MOMENT du rendu ne suffit pas : après un reload de
  // fenêtre, VS Code restaure la largeur de la barre latérale APRÈS le tout
  // premier push d'état (le webview peut mesurer à une largeur transitoire,
  // avant que la restauration ne stabilise le texte des titres) — la hauteur
  // posée à cet instant reste alors fausse (déjà vue à 0) jusqu'au push
  // suivant, potentiellement longtemps. measureRail() est donc appelée à la
  // fois APRÈS layoutFlow() (un passage sur tous les groupes, une fois les
  // blocs posés dans le flux — un nœud détaché mesure 0) ET par un
  // ResizeObserver sur <body> : toute largeur qui change (restauration,
  // redimensionnement de la sidebar) re-mesure sans attendre un postMessage.
  function measureRail(node) {
    // ÉTAPE 19 — le rail ne se dessine JAMAIS À L'INTÉRIEUR du cadre de la
    // capsule : quand une master est rendue, il part du bord BAS de sa ligne.
    // L'anneau de la master reste le nœud de tête visuel (il est dans la
    // capsule), mais le trait ne sort qu'avec elle. Sans master, le corps
    // commence sous la grip : rien à retrancher, le rail part de son haut.
    // offsetTop/offsetHeight se lisent dans le repère de .grp-body (seul
    // ancêtre positionné), comme ghostRow.offsetTop juste en dessous — les
    // deux bouts du trait sont mesurés dans LE MÊME repère, par construction.
    const head = node.masterHead.parentElement === node.body ? node.masterHead : null;
    const top = head ? head.offsetTop + head.offsetHeight : 0;
    node.rail.style.top = top + 'px';
    node.rail.style.height = Math.max(0, node.ghostRow.offsetTop - top) + 'px';
  }
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(function () {
      groupNodes.forEach(measureRail);
    }).observe(document.body);
  }

  // Point d'état du fallback dégradé de la master (hors de la fenêtre du
  // panneau — ni transcript ni onglet suivis) : memberTruth() renvoie le même
  // vocabulaire de statuts qu'un membre lié (busy/waiting/done/done-closed/
  // stale/unsent-lost/interrupted/idle…), mappé sur les MÊMES formes que la
  // liste plate (icoClass). Quand la master EST listée, c'est rowFor() qui
  // rend son icône réelle — ces deux fonctions ne servent plus qu'au repli.
  function masterIcoClass(status) {
    if (status === 'busy' || status === 'inserted') return 'ico ico-busy';
    if (status === 'waiting') return 'ico ico-waiting';
    if (status === 'interrupted') return 'ico ico-interrupted';
    if (status === 'done' || status === 'done-closed' || status === 'idle') return 'ico ico-done read';
    return 'ico ico-stale'; // stale, unsent-lost, not-linked, queued, inconnu
  }
  function masterIcoText(status) {
    return (status === 'done' || status === 'done-closed' || status === 'idle') ? '✓' : '';
  }

  // Ligne dégradée d'une master DÉSIGNÉE mais absente de la vue (titre
  // persisté, aucun transcript/onglet suivi) — réutilise le gabarit .conv
  // (grille icône+corps déjà stylée) plutôt que la fabrique rowFor(), qui
  // exige un objet conversation complet (ctx, mismatch…) qu'on n'a pas ici.
  function createMasterFallback() {
    const root = el('div', 'conv grp-master-fallback');
    const ico = el('span', 'ico');
    const title = el('div', 'title');
    root.appendChild(ico);
    root.appendChild(title);
    const node = { root, ico, title, data: null };
    root.addEventListener('click', function () {
      if (node.data) vscode.postMessage({ type: 'focusConv', id: node.data.id, title: node.data.title, tabTitle: node.data.tabTitle || null });
    });
    return node;
  }

  function createGroupNode(g) {
    const root = el('div', 'grp');
    // La grip : chevron, compteur, seg auto/man, ⌂-focus conditionnel — rien
    // d'autre en nominal (décision actée sur maquette v5).
    const head = el('div', 'grp-head');
    const chev = el('span', 'chevron');
    // Identité du lot (2026-08-15) : « BATCH 14:12 », l'heure de création que
    // extension.js a déjà formatée (stamp). Elle occupe la place restée vide
    // entre le chevron et le compteur — le seul endroit de la grip qui ne
    // portait aucune information.
    const label = el('span', 'grp-label');
    const count = el('span', 'grp-count');
    // « Ce qui reste à faire » (étape 11) : visible dès que tous les MEMBRES
    // (pas forcément la maîtresse) sont finis, onglet fermé — un groupe où
    // seuls les membres sont finis n'a plus que sa capsule (maîtresse) à
    // montrer ; un groupe où la maîtresse l'est AUSSI ne se rend plus du tout
    // (renderGroups filtre g.done en amont), ce chip n'a alors plus
    // l'occasion de s'afficher.
    const done = el('span', 'grp-done', t('✓ done'));
    done.style.display = 'none';
    const spacer = el('span', 'spacer');
    // ⌂-focus (plan repli-auto étape 9) : visible UNIQUEMENT sans master
    // désignée (toggle en JS, renderGroups) — un clic lie directement
    // l'onglet VS Code actif, plus de QuickPick set/change/unlink.
    const mas = el('button', 'gbtn', '⌂');
    mas.type = 'button';
    mas.title = t('Link the active VS Code tab as this batch’s master conversation');
    // ✕ = DISSOLUTION du lot, portée par la GRIP et non plus par la ligne
    // maîtresse (2026-08-09) : un bouton agit sur l'objet qui le porte. Posé
    // sur une ligne de conversation, il disait « détruis tout le bloc » à
    // l'emplacement exact où le même geste, sur un membre, ne retire QUE cette
    // ligne — deux sens opposés au même endroit, d'où l'hésitation signalée à
    // chaque usage. Révélé au survol de la grip seulement : la rangée nominale
    // reste chevron + compteur (décision maquette v5), zéro encre au repos.
    // Classe .gbtn : le handler de repli ci-dessous ignore déjà les clics qui
    // la portent, rien à ajouter pour que le clic ne replie pas le groupe.
    const kill = el('button', 'gbtn g-kill', '✕');
    kill.type = 'button';
    kill.title = t('Dissolve this group (conversations are kept, nothing is closed)');
    // Ordre de la grip (2026-08-15) : chevron, identité du lot, PUIS le vide
    // élastique, PUIS le compteur et les boutons. Le compteur passe donc à
    // droite, où sa colonne de chiffres s'aligne d'une grip à l'autre au lieu
    // de flotter au milieu. Réalisé par l'ordre DOM seul — aucune règle CSS
    // order, qui ferait diverger l'ordre lu du fichier de l'ordre vu à l'écran
    // et piégerait la prochaine lecture.
    head.appendChild(chev);
    head.appendChild(label);
    head.appendChild(spacer);
    head.appendChild(count);
    head.appendChild(done);
    head.appendChild(mas);
    head.appendChild(kill);
    const body = el('div', 'grp-body');
    // Rail P1 : un seul nœud par groupe, jamais recréé — sa position CSS est
    // absolute (le désordre DOM que place() peut lui infliger en replaçant
    // les autres enfants du corps par index est donc sans effet visuel). Sa
    // hauteur est mesurée après chaque rendu complet, cf. renderGroups.
    const rail = el('div', 'grp-rail');
    body.appendChild(rail);

    // Ligne master (plan repli-auto étape 9) : conteneur toujours créé, mais
    // placé dans .grp-body SEULEMENT quand g.master est désigné (renderGroups)
    // — premier enfant de flux, avant les vagues/membres, pour que son anneau
    // d'état soit le premier nœud du rail. slot = rowFor(conv réelle) si
    // listée, sinon createMasterFallback() (paresseux, ci-dessous).
    const masterHead = el('div', 'grp-master-head');
    const masterSlot = el('div', 'grp-master-slot');
    // ⤴ = RETRAIT de la ligne maîtresse — exactement le glyphe, le gabarit et
    // le sens du bouton des membres (2026-08-09) : « cette ligne sort du
    // bloc », partout pareil. C'est l'ancien chip texte « Dissocier » : même
    // unlinkGroupMaster, toujours sans confirmation (geste réversible, le ⌂
    // réapparaît aussitôt pour relier la bonne conversation), et il produit
    // bien le même effet visible qu'un retrait de membre — la maîtresse quitte
    // le bloc et redevient une ligne plate. Sa seule utilité réelle reste de
    // réparer un ⌂ posé sur le mauvais onglet ; il ne méritait pas pour autant
    // un bouton à lui, juxtaposé au ✕ (parti sur la grip) avec qui il partage,
    // dans un lot terminé, jusqu'au résultat à l'écran.
    const masterOut = el('button', 'm-out', '⤴');
    masterOut.type = 'button';
    masterOut.title = t('Remove from this batch (the batch keeps its tasks — it just forgets where it came from)');
    masterHead.appendChild(masterSlot);
    masterHead.appendChild(masterOut);

    root.appendChild(head);
    root.appendChild(body);

    // waveHeaders : un nœud par numéro de vague, réutilisé d'un rendu à
    // l'autre (même raison que members/rows — ne pas relancer d'animation).
    // waveCtrl : la zone « ▶ lancer la vague suivante » / bannière, une par
    // groupe, repositionnée juste après la vague courante à chaque rendu.
    // Ligne fantôme « + nouvelle vague » (plan ajout-tache 2026-07-24) :
    // présente en fin de groupe, groupe fini compris (décision 2 du design)
    // — un clic crée la vague max+1, jamais une vague existante. Masquée par
    // défaut : elle dépose le prompt COURANT du formulaire (activeTasks(),
    // cf. refreshGhostVisibility) — sans texte à déposer, le clic ne ferait
    // que rendre le focus au champ (addTaskAtWave), donc rien à proposer ni
    // à faire briller à l'œil (constat user 2026-08-15). Le rail continue de
    // mesurer sa hauteur sur ghostRow.offsetTop, jamais masqué lui : ghostRow
    // reste dans le flux, seuls ses enfants (ghostNew, addRow) basculent.
    // Lot B densité (2026-08-09) : ghostRow n'est plus la cellule elle-même
    // mais la RANGÉE qui l'accueille — la ligne d'ajout de la dernière vague
    // en file vient s'y ranger à sa gauche (renderGroups) au lieu d'occuper
    // une deuxième rangée pleine largeur juste au-dessus.
    const ghostRow = el('div', 'ghost-line');
    const ghostNew = el('div', 'wave-ghost wave-new', t('+ new wave'));
    ghostNew.title = t('Add a task in a new wave after the last one');
    ghostNew.style.display = 'none';
    ghostRow.appendChild(ghostNew);
    const node = {
      root, head, chev, label, count, done, body, members: new Map(), id: g.id,
      mas, kill, waveHeaders: new Map(), waveAddRows: new Map(), waveCtrl: el('div', 'wave-ctrl'),
      rail, masterConvId: null, masterTitle: null, masterTabTitle: null, ghostRow, ghostNew,
      masterHead, masterSlot, masterOut, masterFallback: null,
    };
    head.addEventListener('click', function (e) {
      if (e.target !== head && head.contains(e.target) && e.target.classList.contains('gbtn')) return;
      vscode.postMessage({ type: 'toggleGroupCollapse', id: node.id });
    });
    mas.addEventListener('click', function (e) { e.stopPropagation(); vscode.postMessage({ type: 'setGroupMaster', id: node.id }); });
    kill.addEventListener('click', function (e) {
      e.stopPropagation();
      vscode.postMessage({ type: 'dissolveGroup', id: node.id });
    });
    masterOut.addEventListener('click', function (e) { e.stopPropagation(); vscode.postMessage({ type: 'unlinkGroupMaster', id: node.id }); });
    ghostNew.addEventListener('click', function (e) { e.stopPropagation(); addTaskAtWave(node.id, null); });
    ghostNew.addEventListener('mouseenter', function () { highlightPromptField(true); });
    ghostNew.addEventListener('mouseleave', function () { highlightPromptField(false); });
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
    // Lien MORT-NÉ (plan lien-mort-né 2026-08-04) : le process suivi est mort
    // sans qu'un octet soit parti. Si l'onglet est encore ouvert, un Entrée
    // suffit (l'étage 2 re-lie tout seul) ; s'il est vraiment parti, ce chip
    // rouvre la tâche avec son prompt, son modèle et son effort. Visible sur ce
    // SEUL statut — member-truth.js tranche, le webview n'en déduit rien.
    const relaunchChip = el('button', 'chip act', t('Relaunch'));
    relaunchChip.type = 'button';
    relaunchChip.title = t('Reopen a conversation for this task, with the same prompt, model and effort');
    // Flèche de RETRAIT = SEULE action de sortie d'un membre (lot 5, révisée
    // par le plan repli-auto étape 15 : le panneau agit sur les métadonnées,
    // jamais sur les onglets VS Code) — retrait du groupe SEUL, l'onglet n'est
    // plus touché ; la conv redevient une ligne plate si elle a transcript+
    // onglet. Aucun garde-fou busy/waiting : retirer des métadonnées est
    // inoffensif, la conversation elle-même continue sans interruption.
    // 2026-08-07 — c'était une croix rouge : elle disait « fermer », alors que
    // rien ne se ferme et qu'aucune ligne ne disparaît jamais par le panneau.
    // La flèche dit ce qui se passe vraiment : elle SORT du groupe.
    const outChip = el('button', 'm-out', '⤴');
    outChip.type = 'button';
    outChip.title = t('Remove from this group (the conversation and its tab are kept)');
    // Édition en cours de route (lot 4, décision 5) : déplacer une tâche PAS
    // ENCORE LANCÉE vers la vague voisine — une fois lancée, elle ne bouge
    // plus (groups.js moveQueuedMember refuse déjà le cas, ceci n'est que
    // l'affordance ; visible seulement pour status === 'queued'.
    // ◂/▸ vivent SUR la ligne, en overlay au survol (2026-08-09), plus dans le
    // pied : dans le flux ils réservaient 15 px de hauteur sous CHAQUE tâche en
    // file — les seules à les afficher —, d'où des lignes en file visiblement
    // plus épaisses que les lignes lancées. Même leçon que la croix des membres
    // et le chip « délier » de la master, appliquée cette fois à la hauteur.
    // Glyphe seul : l'infobulle porte le sens, la place manque à côté du ⤴.
    const move = el('div', 'm-move');
    const moveBack = el('button', 'm-mv', '◂');
    moveBack.type = 'button';
    moveBack.title = t('Move to the previous wave');
    const moveFwd = el('button', 'm-mv', '▸');
    moveFwd.type = 'button';
    moveFwd.title = t('Move to the next wave');
    move.appendChild(moveBack);
    move.appendChild(moveFwd);
    foot.appendChild(note);
    foot.appendChild(linkChip);
    foot.appendChild(relaunchChip);
    head.appendChild(slot);
    head.appendChild(move);
    head.appendChild(outChip);
    root.appendChild(head);
    root.appendChild(foot);

    const node = { root, slot, foot, note, linkChip, relaunchChip, outChip, move, moveBack, moveFwd, conv: null };
    moveBack.addEventListener('click', function () { vscode.postMessage({ type: 'moveMemberWave', id: gid, key: key, delta: -1 }); });
    moveFwd.addEventListener('click', function () { vscode.postMessage({ type: 'moveMemberWave', id: gid, key: key, delta: 1 }); });
    linkChip.addEventListener('click', function () { vscode.postMessage({ type: 'linkMember', id: gid, key: key }); });
    relaunchChip.addEventListener('click', function () { vscode.postMessage({ type: 'relaunchMember', id: gid, key: key }); });
    outChip.addEventListener('click', function () {
      vscode.postMessage({ type: 'removeMember', id: gid, key: key });
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
    // Vie de l'anneau (plan repli-auto étape 5) : « inserted » = Entrée
    // attendue de l'USER → pulse ; tout le reste (queued, not-linked,
    // unsent-lost…) = rien à faire pour l'instant → statique atténué. m.status
    // vient de member-truth.js (lot 10), jamais re-déduit ici.
    const ico = el('span', 'ico-pending ' + (m.status === 'inserted' ? 'ico-pending-wait' : 'ico-pending-idle'));
    wrap.appendChild(ico);
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
  // blocked/hardBlocked sont calculés une fois par renderGroups et partagés avec
  // le séparateur cliquable, pour ne jamais dériver deux fois le même fait.
  //
  // DEUX blocages, deux gravités (plan lien-mort-né 2026-08-04) : le rouge est
  // réservé au VRAI stale — une conversation interrompue à mi-travail, qu'il
  // faut aller voir. Une vague bloquée par le seul unsent-lost (lien mort-né,
  // rien n'a jamais démarré) a un remède immédiat et sans perte : c'est une
  // info, pas une alerte. Peindre les deux en rouge, c'était le bandeau que
  // l'incident a rendu mensonger.
  // (Pas de backtick dans ce commentaire : on est DANS le template literal du
  // webview — cf. CLAUDE.md du dossier.)
  function renderWaveCtrl(node, g, blocked, hardBlocked) {
    node.waveCtrl.replaceChildren();
    if (g.waveNotice) node.waveCtrl.appendChild(el('div', 'banner info', g.waveNotice));
    if (g.nextWave == null) return;
    if (!blocked) return;
    node.waveCtrl.appendChild(hardBlocked
      ? el('div', 'banner err',
        t('A task in wave {0} will not finish on its own (interrupted) — auto advance is suspended. Use ▶ to force wave {1}.', g.launchedWave, g.nextWave))
      : el('div', 'banner info',
        t('A task in wave {0} lost its link before sending — press Enter in its tab to relink it, or use “Relaunch”. Auto advance is suspended; ▶ forces wave {1}.', g.launchedWave, g.nextWave)));
  }

  // « Ce qui reste à faire » (étape 11) : un groupe ENTIER terminé (membres ET
  // maîtresse, si désignée — g.done, group-done.js) n'a plus rien à montrer,
  // pas même une capsule. Filtré ICI, en amont de la boucle — même principe
  // que le filtre !c.groupId appliqué à la liste plate. Le store, lui, GARDE
  // le groupe : rien n'est muté, prune() le nettoiera plus tard (cf. CLAUDE.md).
  //
  // NE PLACE PLUS RIEN dans le DOM (2026-08-07) : la fonction construit et met
  // à jour les nœuds, puis rend la liste des BLOCS (dans l'ordre du store) avec
  // les conversations que chacun affiche. C'est layoutFlow() qui décide où ils
  // tombent — sans quoi les groupes seraient toujours au-dessus, par structure.
  //
  // FILIATION (plan arbre-filiation 2026-08-15, lot 2) : un lot imbriqué
  // ne produit PAS de bloc de flux — il est rangé dans le corps de son parent,
  // juste après la ligne qui lui sert de tête, à CHAQUE rendu. Rien n'est
  // « déplacé une fois pour toutes » : place() ne bouge que ce qui est mal
  // placé, donc l'idempotence est structurelle (la maquette, elle, opérait une
  // chirurgie one-shot et fabriquait des chimères au deuxième rendu).
  function renderGroups(groups, convById, seen) {
    const live = new Set();
    const blocks = [];
    const rendered = groups.filter(function (g) { return !g.done; });
    const byId = new Map();
    rendered.forEach(function (g) { byId.set(g.id, g); });
    // Tous les nœuds AVANT la boucle : un sous-lot est placé par son parent,
    // qui peut le précéder dans la liste — son nœud doit donc déjà exister
    // quand le parent le range. createGroupNode ne lit que g.id, aucune donnée
    // de rendu n'est figée ici.
    rendered.forEach(function (g) {
      if (!groupNodes.has(g.id)) groupNodes.set(g.id, createGroupNode(g));
    });
    // Sous-lots par ligne d'accueil. Le champ nestedUnder arrive tout résolu de
    // nesting.js (côté extension) : le webview ne DÉDUIT aucune filiation, il
    // range. Le garde sur byId n'est qu'une ceinture — un parent fini n'a
    // aucun membre à rendre, donc nesting.js ne lui donne jamais d'enfant ;
    // sans lui, un sous-lot partirait dans un nœud détaché du document.
    // Clé = groupId du parent + un séparateur NUL + memberKey (le NUL ne peut
    // apparaître dans ni l'un ni l'autre, donc aucune collision possible).
    const kidsOf = new Map();

    const nestedIds = new Set();
    rendered.forEach(function (g) {
      const n = g.nestedUnder;
      if (!n || !n.groupId || !n.memberKey || !byId.has(n.groupId)) return;
      nestedIds.add(g.id);
      const k = n.groupId + '\\u0000' + n.memberKey;
      if (!kidsOf.has(k)) kidsOf.set(k, []);
      kidsOf.get(k).push(g);
    });
    const convIdsOf = new Map();       // groupId → convIds affichés par CE lot
    rendered.forEach(function (g) {
      live.add(g.id);
      // Conversations RÉELLEMENT affichées par ce bloc (maîtresse listée +
      // membres liés encore rendus) : c'est sur elles, et rien d'autre, que se
      // calcule son rang d'onglet.
      const convIds = [];
      convIdsOf.set(g.id, convIds);
      const node = groupNodes.get(g.id);
      node.id = g.id;
      // Imbriqué (canon de la maîtresse, amendement 2026-08-16) : la grip et
      // le corps sont deux moitiés posées SÉPARÉMENT dans le corps du parent
      // (plus bas, boucle des membres de A) — la ligne de tête, elle,
      // appartient au parent, un seul nœud de conversation à un seul endroit
      // du DOM. .grp n'est alors plus le conteneur des deux moitiés.
      const nested = nestedIds.has(g.id);
      node.root.classList.toggle('nested', nested);
      node.head.classList.toggle('nest-grip', nested);
      node.body.classList.toggle('nest-body', nested);
      // Un lot qui redevient autonome (filiation tombée) recompose son propre
      // .grp : appendChild réclame head/body où qu'ils soient partis (le
      // rendu du parent d'hier les avait placés dans SON corps), sans effet
      // s'ils y sont déjà — l'idempotence structurelle du lot 2 vaut aussi
      // dans ce sens.
      if (!nested) {
        node.root.appendChild(node.head);
        node.root.appendChild(node.body);
      } else {
        // node.root n'est plus qu'une coquille (ses deux enfants viennent
        // d'en être — ou d'y avoir été — extraits) : si un rendu PRÉCÉDENT
        // l'avait placé tel quel dans le flux (le lot venait de perdre sa
        // filiation, ou n'en avait encore aucune), il y traînerait vide sans
        // ce retrait — un second « bloc racine » fantôme, jamais repris par
        // layoutFlow puisqu'il n'est plus dans blocks[]. remove() est un
        // no-op sûr s'il est déjà détaché.
        node.root.remove();
      }

      // Comptages et vagues parlent le vocabulaire du moteur (waveStatus),
      // pas le statut d'affichage : « terminée, onglet fermé » compte comme
      // terminée — c'est précisément ce que le lot 10 rétablit. Le compteur
      // porte sur le store COMPLET (g.members, jamais filtré) : « ce qui
      // reste à faire » exige un dénominateur vrai (étape 11, décision 5).
      const doneCount = g.members.filter(function (m) { return m.waveStatus === 'done'; }).length;
      // Tous les membres sont finis (onglet fermé) : plus rien à montrer sous
      // la capsule, même quand la maîtresse, elle, est encore ouverte (auquel
      // cas g.done reste false et le groupe continue de se rendre — cf.
      // filtre ci-dessus). Simple agrégat des status déjà résolus par
      // member-truth.js, comme doneCount : rien de nouveau à déduire ici.
      const allMembersDone = g.members.length > 0 && g.members.every(function (m) { return m.status === 'done-closed'; });
      // Teinte du groupe : DEUX variables posées une seule fois sur le nœud du
      // groupe (étape 13) — la grip, la ligne master, le rail et les anneaux y
      // puisent tous. Avant, la grip portait la teinte en style inline et le
      // corps une variable : deux sources pour la même couleur, donc deux
      // façons de diverger (la classe d'erreur corrigée à l'étape 12 sur le
      // fond anneau/panneau).
      const hueBorder = 'hsl(' + g.hue + ', 45%, 55%)';
      const tint = 'hsla(' + g.hue + ', 45%, 55%, .08)';
      // Posée sur la grip ET le corps (2026-08-16), jamais seulement sur
      // .grp : un sous-lot imbriqué sort ses deux moitiés du DOM de node.root
      // (ci-dessus), qui perdrait alors la teinte si elle n'était posée que là.
      node.head.style.setProperty('--grp-hue', hueBorder);
      node.head.style.setProperty('--grp-tint', tint);
      node.body.style.setProperty('--grp-hue', hueBorder);
      node.body.style.setProperty('--grp-tint', tint);
      setText(node.count, doneCount + '/' + g.members.length + ' done');
      // Identité du lot : absente sur un groupe legacy sans createdAt
      // (extension.js envoie alors null) — on masque le nœud plutôt que
      // d'afficher une heure inventée ou un libellé vide qui mangerait une
      // gouttière de la grip.
      setText(node.label, g.stamp ? t('batch {0}', g.stamp) : '');
      node.label.style.display = g.stamp ? '' : 'none';
      node.done.style.display = allMembersDone ? '' : 'none';
      setText(node.chev, g.collapsed ? '▸' : '▾');
      node.body.classList.toggle('collapsed', !!g.collapsed);

      // Ligne master (plan repli-auto étape 9) : conversation STANDARD (même
      // fabrique rowFor() que la liste plate) quand elle est listée, fallback
      // dégradé sinon (titre persisté + tooltip, jamais de nœud manquant) —
      // toujours le premier enfant de flux du corps. Sans master : le
      // conteneur est simplement absent du DOM, la grip seule porte le ⌂-focus.
      // … et JAMAIS quand le lot est imbriqué : sa maîtresse est déjà rendue,
      // en tant que MEMBRE de son parent, sur la ligne qui lui sert de tête.
      // La rendre ici en ferait un second nœud pour la même conversation —
      // très exactement le bug que la filiation corrige (l'un des deux blocs
      // gardait un emplacement vide, emptySlots:1 au banc de la maquette).
      const hasMaster = !!g.master && !nested;
      // ⌂ masqué pour un sous-lot (amendement 2026-08-16) : il propose de lier
      // l'onglet actif comme maîtresse, or le sous-lot EN A une — c'est la
      // ligne juste en dessous de sa grip (défaut vu sur capture, variante C).
      node.mas.style.display = (hasMaster || nested) ? 'none' : '';
      // Nom du lot en infobulle TOUJOURS (2026-08-15) : il n'apparaît plus
      // nulle part à l'écran depuis que la grip affiche l'heure de création à
      // sa place. Le conditionner à l'absence de maîtresse, comme avant, le
      // rendait introuvable dans le cas nominal — pour une information que
      // l'utilisateur a lui-même écrite dans son bloc collé.
      node.head.title = g.name;
      // Capsule englobante (étape 13) : avec une master, la grip n'est que la
      // rangée haute du cadre — c'est la ligne master qui le referme en bas
      // (CSS .grp.has-master). Sans master, la grip EST le cadre entier.
      node.root.classList.toggle('has-master', hasMaster);
      if (hasMaster) {
        const ms = g.master;
        node.masterConvId = ms.convId || null;
        node.masterTitle = ms.title || t('Master conversation');
        node.masterTabTitle = ms.tabTitle || null;
        place(node.body, 0, node.masterHead);
        const conv = (ms.listed && ms.convId) ? convById[ms.convId] : null;
        if (conv) {
          seen.add(conv.id);
          convIds.push(conv.id);
          place(node.masterSlot, 0, rowFor(conv).root);
          while (node.masterSlot.children.length > 1) node.masterSlot.lastChild.remove();
        } else {
          if (!node.masterFallback) node.masterFallback = createMasterFallback();
          const fb = node.masterFallback;
          place(node.masterSlot, 0, fb.root);
          while (node.masterSlot.children.length > 1) node.masterSlot.lastChild.remove();
          fb.data = { id: node.masterConvId, title: node.masterTitle, tabTitle: node.masterTabTitle };
          setClass(fb.ico, masterIcoClass(ms.status));
          setText(fb.ico, masterIcoText(ms.status));
          setText(fb.title, node.masterTitle);
          fb.title.classList.toggle('closed', ms.status === 'done-closed');
          fb.root.title = node.masterTitle + (ms.hint ? ' — ' + ms.hint : '');
        }
        // Rien à faire de plus au repli (2026-08-07) : la ligne master est la
        // MÊME ligne, repliée ou dépliée — la grip reste au-dessus et garde le
        // chevron, le compteur et le chip « ✓ done » du groupe. Le repli
        // n'agit que sur les conversations du groupe, via la classe CSS
        // .collapsed posée plus haut sur le corps.
      } else {
        node.masterConvId = null;
        node.masterTitle = null;
        node.masterTabTitle = null;
        if (node.masterHead.parentElement) node.masterHead.remove();
      }

      // Vagues à RENDRE (étape 11) : un membre fini (onglet fermé) n'a plus de
      // ligne (cf. boucle plus bas) — une vague dont TOUS les membres sont
      // dans ce cas n'a donc plus rien sous son en-tête « VAGUE n » ; jamais
      // d'en-tête vide, elle disparaît avec eux. waves.js/launchedWave
      // (extension.js) continuent de raisonner sur le store COMPLET
      // (g.members) — seule cette liste de RENDU est restreinte.
      const visibleMembers = g.members.filter(function (m) { return m.status !== 'done-closed'; });
      const waveNums = [...new Set(visibleMembers.map(function (m) { return m.wave; }))].sort(function (a, b) { return a - b; });
      const multiWave = waveNums.length > 1;

      // Calculé UNE fois, partagé entre la bannière de blocage (renderWaveCtrl)
      // et le séparateur-bouton de la prochaine vague (lot 4 §2) — même
      // sémantique que l'ancien bouton ▶ (dim = pas bloqué, l'enchaînement est
      // toujours automatique), jamais re-dérivée deux fois.
      const curMembers = g.members.filter(function (m) { return m.wave === g.launchedWave; });
      const blockers = curMembers.filter(function (m) { return m.waveStatus === 'stale'; });
      const blocked = blockers.length > 0;
      // Le statut CANONIQUE, pas sa projection : stale et unsent-lost
      // suspendent tous deux l'auto (même waveStatus), mais un seul des deux
      // est une mauvaise nouvelle. Un mélange des deux dans la même vague →
      // rouge, la conv interrompue prime.
      const hardBlocked = blockers.some(function (m) { return m.status === 'stale'; });
      const dim = !blocked;

      const keys = new Set();
      // La ligne master (si présente) occupe déjà l'index 0 (placée plus
      // haut) : le reste du corps (en-têtes de vague, membres, ligne fantôme)
      // s'empile à partir de l'index suivant.
      let idx = hasMaster ? 1 : 0;
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
          const r = el('div', 'wave-ghost wave-add-row', t('+ this wave'));
          r.style.display = 'none';
          r.addEventListener('click', function (e) { e.stopPropagation(); addTaskAtWave(g.id, w); });
          r.addEventListener('mouseenter', function () { highlightPromptField(true); });
          r.addEventListener('mouseleave', function () { highlightPromptField(false); });
          node.waveAddRows.set(w, r);
          return r;
        })();
        if (queued) addRow.title = t('Fill the prompt field above, then click here to queue it in this wave');
        // Filtre done-closed (étape 11) : un membre fini dont l'onglet est
        // fermé n'a plus de ligne — keys ne le reçoit alors pas, la purge
        // plus bas (node.members.forEach) retire son nœud DOM comme pour un
        // membre retiré du groupe. Rouvrir l'onglet le fait redevenir done
        // (member-truth.js, sur tabOpen) : il repasse le filtre au rendu
        // suivant et se recrée normalement, sans état à réconcilier ici.
        g.members.filter(function (m) { return m.wave === w && m.status !== 'done-closed'; }).forEach(function (m) {
          keys.add(m.key);
          let mn = node.members.get(m.key);
          if (!mn) { mn = createMemberNode(g.id, m.key); node.members.set(m.key, mn); }
          const c = m.convId ? convById[m.convId] : null;
          mn.conv = c || null;
          let rw = null;
          if (c) {
            seen.add(c.id);
            convIds.push(c.id);
            rw = rowFor(c);
            place(mn.slot, 0, rw.root);
            // La ligne de conv occupe la place : tout ce qui traîne d'un rendu
            // précédent (ligne « en attente ») doit partir.
            while (mn.slot.children.length > 1) mn.slot.lastChild.remove();
          } else {
            mn.slot.replaceChildren(pendingLine(m));
          }
          // Filiation : les sous-lots dont CETTE ligne est la tête. La capsule
          // n'est posée que maintenant, après rowFor() — c'est lui qui remet
          // la ligne à nu (updateRow), et il ne sait rien des lots. La teinte
          // de la capsule est celle du PREMIER enfant : une ligne qui ouvre
          // deux sous-lots (deux lots lancés depuis la même conversation, cas
          // rare mais constructible) porte alors une seule couture, à la
          // couleur du premier — chacun garde sa propre grip/corps, à sa
          // couleur, juste au-dessus/en-dessous d'elle.
          const kids = kidsOf.get(g.id + '\\u0000' + m.key) || null;
          mn.root.classList.toggle('nest-host', !!kids);
          if (kids) mn.root.style.setProperty('--nest-hue', 'hsl(' + kids[0].hue + ', 45%, 55%)');
          else mn.root.style.removeProperty('--nest-hue');
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
          mn.relaunchChip.style.display = m.canRelaunch ? '' : 'none';
          const noteText = m.note || '';
          setText(mn.note, noteText);
          mn.note.style.display = noteText ? '' : 'none';
          // Un bouton qui ne fait rien ment (cf. lot 1) : moveBack ne
          // s'affiche que si la vague précédente est ENCORE en file (au-delà
          // de launchedWave) — groups.js moveQueuedMember refuse sinon.
          const canMove = m.waveStatus === 'queued';
          mn.moveBack.style.display = canMove && w - 1 > g.launchedWave ? '' : 'none';
          mn.moveFwd.style.display = canMove && w < waveNums[waveNums.length - 1] ? '' : 'none';
          // Le pied ne réserve de hauteur que s'il a vraiment quelque chose à
          // dire (2026-08-09) : ses trois enfants sont masqués un par un, donc
          // il n'est jamais :empty au sens CSS — c'est ici, où l'on SAIT ce qui
          // est visible, que son repli se décide. Sans ça, une ligne de membre
          // reste plus haute qu'une ligne plate même quand elle n'affiche rien.
          mn.foot.style.display = (noteText || m.canLink || m.canRelaunch) ? '' : 'none';
          // Canon de la maîtresse (amendement 2026-08-16) : grip du sous-lot
          // → ligne d'accueil → corps du sous-lot, même vocabulaire qu'un lot
          // racine avec master (grip → ligne → corps) — jamais un conteneur
          // qui engloberait la ligne de A. Le rail du parent continue de
          // longer le tout (il va du premier au dernier de SES anneaux, un
          // bloc imbriqué entre deux membres ne l'interrompt pas).
          if (kids) kids.forEach(function (child) {
            place(node.body, idx++, groupNodes.get(child.id).head);
          });
          place(node.body, idx++, mn.root);
          if (kids) kids.forEach(function (child) {
            place(node.body, idx++, groupNodes.get(child.id).body);
          });
        });
        // APRÈS le dernier membre de la vague EN FILE (jamais sur vague
        // lancée/terminée — remplace l'ancien petit « + » du séparateur,
        // invisible/mal placé).
        //
        // Lot B densité (2026-08-09) — la ligne de la DERNIÈRE vague rendue ne
        // prend plus de rangée à elle : elle rejoint la ligne fantôme finale,
        // à gauche de « + new wave ». C'est le seul cas fusionnable, et il
        // couvre celui qu'on voit tout le temps : « queued » vaut
        // w > launchedWave sur une liste triée, donc dès qu'une vague est en
        // file la DERNIÈRE l'est aussi — et c'est elle qui se retrouvait
        // collée sous la ligne fantôme. Les vagues en file intermédiaires
        // gardent leur rangée : leur ligne d'ajout doit rester au contact des
        // membres de LEUR vague, pas migrer en fin de groupe.
        const isLastWave = w === waveNums[waveNums.length - 1];
        if (queued && isLastWave) place(node.ghostRow, 0, addRow);
        else if (queued) place(node.body, idx++, addRow);
        if (w === g.launchedWave) { renderWaveCtrl(node, g, blocked, hardBlocked); place(node.body, idx++, node.waveCtrl); ctrlPlaced = true; }
      });
      // launchedWave absente des vagues RENDUES : soit défensif (ne devrait
      // pas arriver, waves.js la calcule à partir de ces mêmes membres), soit
      // — cas normal depuis l'étape 11 — la vague en cours vient de finir et
      // tous ses membres sont déjà finis, onglet fermé (plus d'en-tête pour elle).
      // Dans les deux cas, la zone de contrôle n'a nulle part où s'accrocher
      // au-dessus, elle vient en fin de corps plutôt que de disparaître
      // silencieusement.
      if (!ctrlPlaced) { renderWaveCtrl(node, g, blocked, hardBlocked); place(node.body, idx++, node.waveCtrl); }
      // Ligne fantôme finale : TOUJOURS en fin de corps, y compris groupe fini
      // (décision 2 du design — en auto, la nouvelle vague part au prochain
      // battement du moteur, c'est assumé). Depuis le lot B densité elle porte
      // aussi, à sa gauche, la ligne d'ajout de la dernière vague en file
      // quand il y en a une.
      place(node.body, idx++, node.ghostRow);
      // En-têtes de vague devenus inutiles (vague retirée par édition) — purge
      // avant de purger les membres, même logique.
      node.waveHeaders.forEach(function (hdr, w) {
        if (waveNums.indexOf(w) !== -1 && multiWave) return;
        hdr.remove();
        node.waveHeaders.delete(w);
      });
      node.waveAddRows.forEach(function (row, w) {
        // Miroir du critère de placement (queued, ligne ~1329) : la ligne
        // n'est posée dans le corps QUE pour une vague strictement en file.
        // La purger seulement quand sa vague a disparu de waveNums laissait
        // une orpheline collée à sa dernière position DOM dès qu'une vague en
        // file passait à lancée (w reste dans waveNums, juste plus queued) —
        // constat user 2026-08-05. launchedWave ne redescend jamais, une
        // vague lancée n'a plus jamais besoin de sa ligne d'ajout.
        // remove() couvre les DEUX parents possibles depuis le lot B densité
        // (corps du groupe, ou ligne fantôme finale) : le critère de purge est
        // le même, il ne dépend pas de l'endroit où la ligne est rangée.
        if (waveNums.indexOf(w) !== -1 && w > g.launchedWave) return;
        row.remove();
        node.waveAddRows.delete(w);
      });
      node.members.forEach(function (mn, key) {
        if (keys.has(key)) return;
        mn.root.remove();
        node.members.delete(key);
      });

      // Un lot imbriqué ne produit PAS de bloc de flux : son parent l'a déjà
      // rangé dans son corps. L'y laisser en produirait un second, et
      // layoutFlow le remonterait aussitôt dans le flux général — le sous-lot
      // sauterait d'un rendu à l'autre.
      if (!nested) blocks.push({ id: g.id, root: node.root, convIds: convIds });
    });
    // Rang d'un bloc dans le flux : il parle pour TOUT ce qu'il affiche,
    // sous-lots compris — sans quoi un onglet rendu à l'intérieur d'un
    // sous-lot ne compterait pour personne et le bloc entier pourrait passer
    // derrière une ligne plate pourtant plus à droite. On remonte la chaîne de
    // filiation jusqu'au bloc racine (chaîne finie : nesting.js a déjà cassé
    // les cycles, la borne n'est qu'une ceinture).
    const blockById = new Map();
    blocks.forEach(function (b) { blockById.set(b.id, b); });
    rendered.forEach(function (g) {
      if (!nestedIds.has(g.id)) return;
      let cur = g;
      for (let hop = 0; cur && nestedIds.has(cur.id) && hop < 100; hop++) {
        cur = byId.get(cur.nestedUnder.groupId);
      }
      const root = cur ? blockById.get(cur.id) : null;
      if (!root) return;
      (convIdsOf.get(g.id) || []).forEach(function (id) { root.convIds.push(id); });
    });
    groupNodes.forEach(function (node, id) {
      if (live.has(id)) return;
      // Un groupe dissous peut avoir ses deux moitiés détachées de node.root
      // (imbriqué au rendu précédent, placées dans le corps de son parent) —
      // retirer head et body explicitement, node.root seul ne suffit plus
      // (amendement 2026-08-16). remove() est un no-op sûr sur un nœud déjà
      // détaché, l'ordre ne compte pas.
      node.head.remove();
      node.body.remove();
      node.root.remove();
      groupNodes.delete(id);
    });
    return blocks;
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
  let form = { group: '', tasks: [blankTask(1)] };
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
  // Bloc claude-convs multi-tâches reconnu dans le champ (étape 10 du plan
  // repli-auto) : plus de « supprimer la tâche transférée, quatre fois » —
  // « + nouvelle vague » transfère TOUT le bloc d'un coup, après confirmation
  // (bannière, pas de modale VS Code — la confirmation ne dépend d'aucun état
  // que seule l'extension connaîtrait : effectif/vagues viennent déjà du
  // formulaire). « + ajouter à cette vague » (wave non nul) refuse : ce
  // bouton ne connaît qu'UNE vague cible, il ne peut pas honorer la topologie
  // du bloc (pas de télescopage silencieux). Un prompt SIMPLE (une seule
  // tâche active, quelle que soit son origine) garde le comportement d'avant.
  function multiWaveTransferMessage(gid, tasks) {
    const waveCount = new Set(tasks.map(function (tk) { return tk.wave; })).size;
    let msg = t('Add {0} task(s) ({1} wave(s)) after this group?', tasks.length, waveCount);
    if (form.group) msg += '\\n' + t('The block’s group name “{0}” is ignored — this group keeps its own.', form.group);
    if (form.masterSession) msg += '\\n' + t('The block’s master conversation token is ignored — this group keeps its own.');
    return {
      gid: gid,
      message: msg,
      tasks: tasks.map(function (tk) {
        return { prompt: tk.prompt, model: effectiveModel(tk), effort: effectiveEffort(tk), wave: tk.wave };
      }),
    };
  }
  function confirmPendingTransfer() {
    const pending = form.pendingTransfer;
    if (!pending) return;
    vscode.postMessage({ type: 'addTasksToGroup', id: pending.gid, tasks: pending.tasks });
    form = { group: '', tasks: [blankTask(1)] };
    renderForm();
  }
  function cancelPendingTransfer() {
    form.pendingTransfer = null;
    renderForm();
  }
  function addTaskAtWave(gid, wave) {
    const tasks = activeTasks();
    if (tasks.length > 1) {
      if (wave != null) {
        form.errorBanner = t('This is a multi-wave block — use “+ new wave” to add all of it at once.');
        renderForm();
        return;
      }
      form.pendingTransfer = multiWaveTransferMessage(gid, tasks);
      renderForm();
      return;
    }
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

  // Visibilité des lignes fantômes « + new wave » / « + this wave » (2026-08-15) :
  // les deux déposent le prompt courant du formulaire (addTaskAtWave) — sans
  // tâche active à déposer, un clic ne fait rien d'autre que rendre le focus
  // au champ. Les masquer économise l'espace ET n'attire plus l'œil vers un
  // bouton inutile tant qu'aucun texte n'est tapé. Même critère que Create
  // (activeTasks().length), pour rester cohérent avec ce qui serait réellement
  // envoyé. Appelée à chaque changement de saisie (refreshCreateBtn) et à
  // chaque (re)création de nœud de groupe, où les deux naissent masqués.
  function refreshGhostVisibility() {
    const has = activeTasks().length > 0;
    groupNodes.forEach(function (node) {
      node.ghostNew.style.display = has ? '' : 'none';
      node.waveAddRows.forEach(function (r) { r.style.display = has ? '' : 'none'; });
    });
  }

  function refreshCreateBtn() {
    refreshGhostVisibility();
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

  // Bannière à deux actions (étape 10 du plan repli-auto) — pas une modale
  // VS Code : la confirmation ne dépend que de ce que le formulaire sait déjà
  // (nombre de tâches/vagues, nom de bloc ignoré), donc rien à demander à
  // l'extension avant de la montrer. Multi-ligne (retour à la ligne) affiché tel quel.
  function confirmBanner(text, confirmLabel, onConfirm, onCancel) {
    const wrap = el('div', 'banner info');
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.gap = '6px';
    const body = el('div');
    body.style.whiteSpace = 'pre-line';
    body.textContent = text;
    wrap.appendChild(body);
    const row = el('div', 'form-foot');
    row.appendChild(el('span', 'spacer'));
    row.appendChild(button('', t('Cancel'), onCancel));
    row.appendChild(button('pri', confirmLabel, onConfirm));
    wrap.appendChild(row);
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
    // Transfert multi-vagues en attente (étape 10) : bannière à deux actions,
    // au-dessus du reste du formulaire (les tâches restent visibles pendant
    // la confirmation).
    if (form.pendingTransfer) {
      batchFormEl.appendChild(confirmBanner(form.pendingTransfer.message, t('Add'), confirmPendingTransfer, cancelPendingTransfer));
    }

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

    // Rangée unique adders + pied (constat user 2026-08-06, liste étape 19) :
    // les « + » à gauche, Annuler/Créer poussés à droite par le spacer — une
    // ligne de formulaire gagnée. Les deux classes se complètent : task-row
    // apporte le flex-wrap (sidebar étroite → retour à la ligne, jamais de
    // débordement), form-foot le spacer et l'espacement (elle est définie
    // APRÈS task-row dans la feuille, ses gap/margin priment).
    const foot = el('div', 'task-row form-foot');
    foot.appendChild(button('', t('+ Add task'), function () {
      form.tasks.push(blankTask(maxWave()));
      compactWaves();
      renderForm();
    }));
    foot.appendChild(button('', t('+ Add wave divider'), function () {
      form.tasks.push(blankTask(maxWave() + 1));
      compactWaves();
      renderForm();
    }));
    foot.appendChild(el('span', 'spacer'));
    // Lot 12 : « form » n'est plus jamais « null » (le lanceur est toujours
    // là) — Cancel remet le brouillon à zéro (une tâche vierge, mode simple)
    // plutôt que de fermer un panneau qui n'existe plus.
    foot.appendChild(button('', t('Cancel'), function () {
      form = { group: '', tasks: [blankTask(1)] };
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
        // Lot 11 : la matière de la recherche de conv maîtresse, non nulle
        // seulement si le dernier collage a été reconnu comme bloc valide.
        paste: form.masterPaste || null,
        session: form.masterSession || null,
      });
      form = { group: '', tasks: [blankTask(1)] };
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
      // Disclaimer du menu officiel (plan repli-auto étape 6) : tooltip
      // seulement, plus jamais concaténé au texte courant du notice.
      noticeHint: (b && b.noticeHint) || null,
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
    if (batchNoticeEl.title !== (next.noticeHint || '')) batchNoticeEl.title = next.noticeHint || '';
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
    // !g.done : même filtre que renderGroups (étape 11) — un groupe entier
    // terminé n'est plus rendu DU TOUT (ni sa master), donc ne doit plus
    // exclure son ex-master de la liste plate non plus. Sans ce garde, une
    // conv encore listée pouvait disparaître des DEUX vues à la fois (exclue
    // ici par masterIds, mais son groupe déjà filtré côté renderGroups).
    const masterIds = new Set();
    groups.forEach(function (g) { if (!g.done && g.master && g.master.listed && g.master.convId) masterIds.add(g.master.convId); });
    const seen = new Set();
    // renderUi AVANT le flux : le mode de tri qu'il reflète est celui que
    // layoutFlow applique — une seule lecture de ui.sortOrder pour les deux,
    // jamais un select qui dit un ordre et un DOM qui en rend un autre.
    renderUi(msg.state && msg.state.ui);
    const order = (msg.state && msg.state.ui && msg.state.ui.sortOrder) || 'tabOrder';
    const blocks = renderGroups(groups, convById, seen);
    // Rails P1 : mesurés en UN SEUL passage, APRÈS layoutFlow — cf. l'appel
    // plus bas. Le mesurer par groupe, en fin de sa propre boucle, était juste
    // tant que chaque bloc ne contenait que ses propres lignes ; depuis la
    // filiation, un lot peut recevoir un sous-lot APRÈS avoir été mesuré (rien
    // n'ordonne le parent avant l'enfant dans la liste), et son rail resterait
    // alors à la hauteur d'avant.
    // Nœuds de groupe (re)créés à l'instant : ghostNew/addRow naissent masqués
    // (cf. createGroupNode) — les remettre à l'état courant du champ, sinon un
    // groupe qui apparaît pendant que l'user a déjà tapé un prompt affiche des
    // boutons masqués à tort jusqu'à la prochaine frappe.
    refreshGhostVisibility();
    const flat = convs.filter(function (c) { return !c.groupId && !masterIds.has(c.id); });
    layoutFlow(blocks, flat, convs, order, seen);
    // … ici, et pas avant : les blocs viennent seulement d'être posés dans le
    // flux. offsetTop/offsetHeight d'un nœud DÉTACHÉ du document valent 0 —
    // au tout premier rendu, mesurer depuis renderGroups posait donc un rail
    // de hauteur nulle, que seul le ResizeObserver rattrapait après coup.
    groupNodes.forEach(measureRail);
    pruneRows(seen);
    lastQuota = (msg.state && msg.state.quota) || {};
    renderQuota(lastQuota);
    renderSoundsToggle(!!(msg.state && msg.state.sounds && msg.state.sounds.enabled));
    canaryEl.classList.toggle('show', !!(msg.state && msg.state.canary));
    tabsFrozenEl.classList.toggle('show', !!(msg.state && msg.state.tabsFrozen));
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
