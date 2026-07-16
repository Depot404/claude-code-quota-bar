const vscode = require('vscode');
const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync, execFile } = require('child_process');
const WebSocket = require('ws');
const { ClaudePanelProvider } = require('./panel');
const { createStateEngine, DEFAULTS: STATE_DEFAULTS } = require('./state');
const { focusConversation, createFocusRelay } = require('./focus');
const { createTabTracker } = require('./tabs');
const { createAckTracker } = require('./ack');
const { labelMatches } = require('./labels');
const { createSoundPlayer } = require('./sounds');
// Purge d'une conv fermée (lot 5) et accusé de lecture (lot 6). On require la
// lib des hooks au lieu de réécrire l'accès : sessions-state.json est écrit par
// N process (les hooks) et nous, c'est un vrai read-modify-write concurrent → le
// lock de cette lib est exactement ce qu'il faut. Même sens de dépendance que
// model-id/transcript.
const { removeSession, updateSession } = require('./hooks/sessions-state.js');

const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const CACHE_PATH = path.join(os.homedir(), '.claude', 'usage-cache.json');
const ORG_ID_CACHE_PATH = path.join(os.homedir(), '.claude', 'quota-org-id.json');
const BRAVE_PID_PATH = path.join(os.homedir(), '.claude', 'quota-brave-pid.json');
const USAGE_URL = 'https://claude.ai/settings/usage';
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;
const CDP_HOST = '127.0.0.1';
// Brave Octopus (port 9223) instead of Brave principal (9222): keeps the user's
// main Brave free of tabs, and tabs we open survive offscreen invisibly.
// Lifecycle is bound to this extension (spawn at activate, kill at deactivate).
const CDP_PORT = 9223;
const BRAVE_EXE_CANDIDATES = [
  process.env.BRAVE_EXE,
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
].filter(Boolean);

let timer;
let panelProvider;
let stateEngine;
let tabTracker;
let ackTracker;
let soundPlayer;
let lastSource = null;

// Settings VS Code natifs qui font aussi sonner une fin de tour / une
// question — risque de double son avec les nôtres (lot 1 §5). Un seul
// message proposant de les couper, une seule fois par machine (refus mémorisé
// dans le globalState de l'extension, pas dans les settings user).
const ACCESSIBILITY_SIGNALS = ['chatResponseReceived', 'chatUserActionRequired'];
const ACCESSIBILITY_PROMPT_DISMISSED_KEY = 'soundsAccessibilityPromptDismissed';

// Lot 9 : dernier état connu par conv, pour ne détecter que de VRAIES
// transitions (busy→done, busy→waiting…). renderKey() de state.js notifie
// aussi sur un ctx% qui bouge ou un acked qui change sans transition d'état —
// sans ce suivi, chaque recompute pendant un run busy tirerait le throttle
// pour rien (cf. plan lot 9, point 4).
let lastConvStates = new Map();
let lastEventFetchAt = 0;
// Couture de test (comme CLAUDE_QUOTA_PANEL_DEMO) : un banc ne peut pas
// attendre 45 s en conditions réelles pour prouver le throttle.
const EVENT_FETCH_THROTTLE_MS = Number(process.env.CLAUDE_QUOTA_EVENT_FETCH_THROTTLE_MS) || 45 * 1000;

// Lot 13 §2 : N fenêtres VS Code sur le même workspace font chacune leur poll
// 5 min + leurs fetchs événementiels (lot 9) sur les MÊMES transitions (elles
// lisent le même sessions-state.json) — sans dédup, N fenêtres = N× les appels
// claude.ai pour la même info. `usage-cache.json` est déjà partagé entre
// fenêtres (lu par quotaState()) : s'il vient d'être écrit par une AUTRE
// fenêtre, on consomme ce cache au lieu de refaire l'appel réseau. Fenêtre
// courte (30 s) délibérément : assez pour absorber des polls/fetchs
// concurrents à quelques secondes d'écart, pas assez pour retarder un vrai
// refresh (bouton Refresh, nouveau poll 5 min).
const FETCH_DEDUP_MS = Number(process.env.CLAUDE_QUOTA_FETCH_DEDUP_MS) || 30 * 1000;

// Lot 13 §1 : tout le matching onglet↔conv (clic-focus, retrait à la
// fermeture, ack) dépend de `viewType.includes('claudeVSCodePanel')`
// (labels.js). Si l'extension officielle le renomme, ces chemins dégradent
// SANS erreur ni exception — juste un panneau qui n'entend plus les onglets.
// Canari : une conv `busy`/`waiting` du workspace ET zéro onglet Claude détecté
// pendant plus de CANARY_MS d'affilée est un signal de dérive (pas une preuve
// à coup sûr : un utilisateur qui a simplement fermé l'onglet et travaille en
// CLI produit le même symptôme — d'où le délai, pour ne pas hurler sur ce cas
// normal).
const CANARY_MS = Number(process.env.CLAUDE_QUOTA_CANARY_MS) || 2 * 60 * 1000;
// Cadence du tick lui-même (couture de test séparée : un banc ne peut pas
// attendre 30 s réelles pour prouver un canari raccourci à quelques centaines
// de ms — sans ce 2e override, le tick réel resterait le facteur limitant).
const CANARY_TICK_MS = Number(process.env.CLAUDE_QUOTA_CANARY_TICK_MS) || 30 * 1000;
let canaryTablessSince = null;
let canaryActive = false;
let canaryTicker = null;

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('claudeCodeQuotaBar');
  return {
    refreshMs: Math.max(1, cfg.get('refreshIntervalMinutes', 5)) * 60 * 1000,
    // Défauts alignés sur la sémantique voulue : rouge = la projection dépasse
    // le quota. pace > 1 ⇒ à ce rythme la fenêtre est épuisée avant son reset,
    // donc rouge dès 1.0 (pas 1.2, qui laissait « orange » une projection à 120 %).
    burnRate: {
      greenMax: cfg.get('burnRateGreenMax', 0.85),
      yellowMax: cfg.get('burnRateYellowMax', 1.0),
    },
    // Défaut false : un utilisateur marketplace ne doit jamais avoir un son
    // surprise à l'installation (plan 2026-07-16).
    soundsEnabled: cfg.get('sounds.enabled', false),
    // Défaut vide (plan 2026-07-16, lot 2 §1) : un utilisateur marketplace n'a
    // pas de profil Brave Octopus, donc pas de chemin en dur — la voie cookie
    // se désactive proprement (aucun spawn, aucune erreur bruyante) et le
    // fallback OAuth prend le relais directement.
    braveUserDataDir: (cfg.get('braveUserDataDir', '') || '').trim(),
  };
}

function activate(context) {
  const { refreshMs } = getConfig();

  context.subscriptions.push(
    vscode.commands.registerCommand('claude-code-quota-bar.open', () => {
      vscode.env.openExternal(vscode.Uri.parse(USAGE_URL));
    }),
    vscode.commands.registerCommand('claude-code-quota-bar.refresh', () => fetchAndUpdate(true)),
    vscode.commands.registerCommand('claude-code-quota-bar.installHooks', () => installHooks(context))
  );

  // Sons de notification (plan 2026-07-16, lot 1) : branché plus bas sur le
  // même signal de transition que le fetch événementiel (maybeFetchOnTransition),
  // jamais sur un recompute qui ne change rien.
  soundPlayer = createSoundPlayer({ isEnabled: () => getConfig().soundsEnabled });
  context.subscriptions.push({ dispose: () => soundPlayer.dispose() });
  // Le toggle peut déjà être `true` (settings.json édité à la main, ou profil
  // repris d'une machine où on l'avait activé) — pas seulement via l'icône.
  maybeWarnAccessibilityConflict(context);

  // Panneau sidebar secondaire (droite). retainContextWhenHidden : l'état est
  // poussé par événement ; sans ça, un panneau masqué se réveille vide jusqu'au
  // prochain push (le poll quota est à 5 min, l'attente serait visible).
  panelProvider = new ClaudePanelProvider(context, {
    ready: () => pushPanelState(),
    refresh: () => fetchAndUpdate(true),
    openUsage: () => vscode.env.openExternal(vscode.Uri.parse(USAGE_URL)),
    // Clic = acte observé explicite (lot 10c), même si l'onglet est déjà actif
    // — c'est le seul cas où aucune bascule/transition ne peut jamais se
    // produire, donc le seul chemin d'ack possible en mono-onglet.
    focusConv: (msg) => { focusConversation(msg); ackConversationById(msg && msg.id); },
    toggleSounds: () => toggleSounds(),
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ClaudePanelProvider.viewType, panelProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Moteur d'état des conversations (lot 2) : réactif par fs.watch, aucun poll
  // pour l'état — seul le quota réseau reste sur le timer refreshMs.
  const workspacePath = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]
    ? vscode.workspace.workspaceFolders[0].uri.fsPath
    : null;
  // Suivi des onglets (lot 5) : c'est LUI qui décide qu'une conv a disparu, plus
  // le hook SessionEnd. Créé avant le moteur, qui lui demande la présence des
  // onglets à chaque snapshot.
  tabTracker = createTabTracker({
    onChange: () => { if (stateEngine) stateEngine.refresh(); },
    onTabsClosed: (labels) => closeConversations(labels),
  });
  context.subscriptions.push({ dispose: () => tabTracker.dispose() });

  // Accusé de lecture (lot 6) : consulter l'onglet éteint le ✓ vif. Créé avant
  // le moteur, qui l'interroge à chaque snapshot.
  ackTracker = createAckTracker({ onDwell: () => ackConversations() });
  context.subscriptions.push({ dispose: () => ackTracker.dispose() });

  stateEngine = createStateEngine({
    workspacePath,
    ...STATE_DEFAULTS,
    tabs: () => tabTracker.getTabs(),
    // L'ack APRÈS le push : la conv apparaît terminée tout de suite, l'accusé
    // suit. Ici passe le cas « l'onglet était déjà sous les yeux quand Claude a
    // fini » — aucune bascule d'onglet ne se produira, c'est donc l'arrivée du
    // `done` qui doit aller consulter le séjour en cours.
    onChange: (snap) => { pushPanelState(); ackConversations(); maybeFetchOnTransition(snap); },
  });
  context.subscriptions.push({ dispose: () => stateEngine.dispose() });
  // Amorce lastConvStates avec le snapshot initial : createStateEngine le
  // construit à la construction SANS appeler onChange (celui-ci ne tire que
  // sur un recompute déclenché ensuite). Sans amorçage, une conv déjà `busy`
  // à l'activation qui passe `done` avant le premier recompute intermédiaire
  // aurait `before === undefined` → transition invisible, fetch manqué.
  for (const c of stateEngine.getSnapshot().conversations) lastConvStates.set(c.sessionId, c.state);

  // Relais de focus inter-fenêtres (lot 4) : le panneau liste les convs du
  // workspace, dont certaines ont leur onglet dans une AUTRE fenêtre VS Code.
  // Chaque instance écoute les requêtes ; celle qui possède l'onglet répond.
  context.subscriptions.push(createFocusRelay());

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeCodeQuotaBar')) {
        restartTimer();
        // Synchronise l'icône haut-parleur si le setting change ailleurs qu'un
        // clic sur elle (settings.json édité à la main, sync de profil…).
        pushPanelState();
        if (e.affectsConfiguration('claudeCodeQuotaBar.sounds.enabled')) {
          maybeWarnAccessibilityConflict(context);
        }
      }
    })
  );

  // Couture de test : en mode démo, le panneau se révèle seul — on peut le
  // capturer sans piloter la fenêtre ni voler le focus à l'utilisateur.
  if (process.env.CLAUDE_QUOTA_PANEL_DEMO === '1') {
    vscode.commands.executeCommand('claudeCodeQuotaBar.panel.focus');
  }

  fetchAndUpdate();
  startTimer(refreshMs);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  // Canari viewType (lot 13 §1) : tick indépendant du moteur d'état — la
  // dérive à détecter, c'est justement l'ABSENCE d'événement (plus aucun
  // onglet Claude ne matche jamais), donc rien ne la déclencherait via
  // onChange (qui ne tire que sur un rendu qui change).
  canaryTicker = setInterval(checkTabCanary, CANARY_TICK_MS);
  context.subscriptions.push({ dispose: () => clearInterval(canaryTicker) });
}

function startTimer(ms) {
  clearInterval(timer);
  timer = setInterval(fetchAndUpdate, ms);
}

function restartTimer() {
  const { refreshMs } = getConfig();
  startTimer(refreshMs);
}

function deactivate() {
  clearInterval(timer);
}

// `force` (commande Refresh / bouton du panneau, lot 13 §2) court-circuite la
// dédup multi-fenêtres : c'est un acte explicite de l'user, il doit toujours
// déclencher un vrai appel réseau, même si une autre fenêtre vient de
// rafraîchir le cache partagé il y a quelques secondes.
async function fetchAndUpdate(force = false) {
  // `usage-cache.json` est partagé entre TOUTES les fenêtres VS Code du
  // poste — si une autre fenêtre vient de le rafraîchir il y a moins de
  // FETCH_DEDUP_MS, refaire l'appel réseau ici (poll 5 min ou fetch
  // événementiel du lot 9) n'apporterait rien de plus frais. On ne casse pas
  // le repli existant : quand les deux chemins réseau échouent, quotaState()
  // lit ce même cache indépendamment de ce court-circuit.
  if (!force) {
    const fresh = readCache();
    if (fresh && fresh.timestamp && Date.now() - fresh.timestamp < FETCH_DEDUP_MS) {
      pushPanelState();
      return;
    }
  }

  let data = null;
  let source = null;
  let cookieErr = null;
  let oauthErr = null;

  // Primary path: raw fetch with cached sessionKey (~0 RAM, no browser).
  // Endpoint claude.ai/api/organizations/{id}/usage uses a different rate-limit
  // bucket than api.anthropic.com/oauth/usage (issues #31021, #31637).
  try {
    data = await fetchUsageWithSessionKey();
    source = 'cookie';
  } catch (e) {
    cookieErr = e;
    // Refresh sessionKey via ephemeral Brave Octopus when:
    //  - cache empty (first run, cleared)
    //  - session expired (401/403)
    //  - org_id discovery failed (likely auth issue)
    // braveUserDataDir vide (défaut marketplace, lot 2 §1) : pas de profil
    // Brave à lire → on saute la voie cookie sans tenter de spawn ni logguer
    // quoi que ce soit, direct au fallback OAuth ci-dessous.
    if (getConfig().braveUserDataDir && /no cached sessionKey|session_invalid|HTTP 40[13]|no org_id/.test(e.message)) {
      try {
        await refreshSessionKeyViaCdp();
        data = await fetchUsageWithSessionKey();
        source = 'cookie-refreshed';
      } catch (e2) {
        cookieErr = e2;
      }
    }
  }

  if (!data) {
    try {
      const token = readToken();
      if (!token) throw new Error('no token');
      data = await fetchUsageViaOAuth(token);
      source = 'oauth';
    } catch (e) {
      oauthErr = e;
    }
  }

  if (data) {
    saveCache(data);
    lastSource = source;
    pushPanelState();
    return;
  }

  pushPanelState();
}

// ── État du panneau ────────────────────────────────────────────────────────
// buildPanelState() est l'UNIQUE source du webview (contrat décrit en tête de
// panel.js). Le webview ne lit aucun fichier : tout passe par ici.

// Jeu de démo : valide le rendu des 5 états sans attendre qu'ils se produisent.
// Couture de test (env var) — aucun impact en usage normal.
const DEMO_CONVERSATIONS = [
  { id: 'd1', title: 'Implémenter le lot 1 du panneau sidebar', model: 'Opus 4.8', ctx: { pct: 34, tokens: 340000, denom: 1000000 }, state: 'busy', acked: true, active: true },
  { id: 'd2', title: 'Refonte du digest mail', model: 'Sonnet 5', ctx: { pct: 71, tokens: 142000, denom: 200000 }, state: 'waiting', acked: true, active: false },
  { id: 'd3', title: 'Watchdog Jeedom Z-Wave', model: 'Haiku 4.5', ctx: { pct: 12, tokens: 24000, denom: 200000 }, state: 'done', acked: false, active: false },
  { id: 'd4', title: 'Portage web PlanningTP', model: 'Opus 4.8', ctx: { pct: 88, tokens: 880000, denom: 1000000 }, state: 'stale', acked: true, active: false },
  { id: 'd5', title: 'Tri des scans', model: null, ctx: null, state: 'idle', acked: true, active: false },
  { id: 'd6', title: 'Sondage BBQ Cloudflare Pages', model: 'Sonnet 5', ctx: { pct: 22, tokens: 44000, denom: 200000 }, state: 'done', acked: true, active: false },
];

// Onglet(s) Claude fermé(s) → les convs correspondantes quittent le panneau.
// Deux temps, dans cet ordre :
//  1) markClosed : retrait immédiat à l'écran (l'exigence est « < 1 s »), sans
//     dépendre de l'étape 2 qui prend un lock inter-process ;
//  2) removeSession : purge de sessions-state.json — sinon l'entrée `busy`
//     ressusciterait la conv au prochain snapshot, ET les AUTRES fenêtres, qui
//     n'ont pas notre marque de fermeture, continueraient de l'afficher.
function closeConversations(labels) {
  if (!stateEngine || !labels || !labels.length) return;
  const ids = stateEngine.getSnapshot().conversations
    .filter((c) => labels.some((l) => labelMatches(l, c.title)))
    .map((c) => c.sessionId);
  if (!ids.length) return;
  stateEngine.markClosed(ids);
  for (const id of ids) {
    try { removeSession(id); } catch {}
  }
}

// Conv terminée dont l'onglet est consulté depuis assez longtemps → on pose
// l'accusé de lecture (lot 6a). Écriture via updateSession : l'extension est le
// SECOND écrivain de sessions-state.json (les hooks étaient seuls), et c'est un
// read-modify-write partagé — le lock de la lib des hooks est obligatoire ici,
// une écriture maison écraserait l'état posé par un hook concurrent.
//
// Pas de boucle : l'écriture déclenche un recompute, qui rend `acked` vrai, donc
// la condition ci-dessous devient fausse et plus rien n'est écrit.
//
// ACK STRICT (lot 10) — incident 2026-07-15 (conv « Déboguer tbid 44220 ») :
// ✓ passé « lu » sans jamais avoir été consulté. Cause : le dwell (actif +
// focus + 2 s) était satisfait par un onglet posé là depuis AVANT le
// lancement du run, pendant qu'on travaillait ailleurs dans la même fenêtre —
// ack.js ne voit qu'un séjour ininterrompu, pas quand ce séjour a commencé
// relativement au run. Fix : n'acquitter que si le séjour a débuté APRÈS
// `busySince` de la conv (venir regarder travailler est un acte observé ;
// « j'y étais déjà » ne l'est plus). `busySince` absent (conv d'avant ce lot,
// ou hooks pas encore redéployés) → on ne peut rien exclure, le doute profite
// à l'affichage (même logique que `tabs.known:false` au lot 5).
function ackConversations() {
  if (!stateEngine || !ackTracker) return;
  const label = ackTracker.dwellLabel();
  if (!label) return;
  const dwellSince = ackTracker.dwellSince();
  for (const c of stateEngine.getSnapshot().conversations) {
    if (c.state !== 'done' || c.acked) continue;
    if (!labelMatches(label, c.title)) continue;
    if (c.busySince != null && dwellSince != null && dwellSince <= c.busySince) continue;
    try { updateSession(c.sessionId, { ack_ts: Date.now() }); } catch {}
  }
}

// Clic explicite sur la ligne panneau (lot 10, point 1c) : le clic EST l'acte
// observé, inconditionnellement — y compris quand l'onglet est déjà actif, cas
// où aucune transition ne peut jamais se produire (le mono-onglet n'a sinon
// aucune porte de sortie pour son ✓ vif).
function ackConversationById(sessionId) {
  if (!stateEngine || !sessionId) return;
  const c = stateEngine.getSnapshot().conversations.find((x) => x.sessionId === sessionId);
  if (!c || c.state !== 'done' || c.acked) return;
  try { updateSession(sessionId, { ack_ts: Date.now() }); } catch {}
}

// Constat user (2026-07-15, burn 5h en cours) : le panneau affichait 85 %
// alors que le quota réel était à 90 % — le poll réseau 5 min traîne pendant
// un burn rapide. Fix event-driven (pas un raccourcissement du poll, qui
// reste le filet de fond inchangé) : quand une conv bascule vers `done` ou
// `waiting`, un gros paquet d'usage vient d'être comptabilisé → on va le
// chercher tout de suite, throttlé pour absorber une rafale de fins de tour.
function maybeFetchOnTransition(snapshot) {
  const prev = lastConvStates;
  const next = new Map();
  let transitioned = false;
  for (const c of snapshot.conversations) {
    next.set(c.sessionId, c.state);
    const before = prev.get(c.sessionId);
    // `before === undefined` = conv jamais vue par ce process (premier
    // snapshot, activation de l'extension) : pas une transition observée.
    if (before !== undefined && before !== c.state) {
      // Même signal que le fetch événementiel ci-dessous, jamais un recompute
      // qui ne change rien — le son se branche ici, pas ailleurs.
      if (soundPlayer) soundPlayer.onTransition(c.sessionId, c.state, c.since);
      if (c.state === 'done' || c.state === 'waiting') transitioned = true;
    }
  }
  lastConvStates = next;
  if (!transitioned) return;
  if (panelProvider && !panelProvider.isVisible()) return;
  const now = Date.now();
  if (now - lastEventFetchAt < EVENT_FETCH_THROTTLE_MS) return;
  lastEventFetchAt = now;
  fetchAndUpdate();
}

// Lot 13 §1 — voir le commentaire de CANARY_MS. `tabs.known: false` (tracker
// mort/API absente) n'est PAS un signal de dérive : on ne sait rien, donc on
// ne conclut rien (même logique que isGone() dans state.js).
function checkTabCanary() {
  if (!stateEngine || !tabTracker) return;
  const tabs = tabTracker.getTabs();
  if (!tabs.known) {
    canaryTablessSince = null;
    if (canaryActive) { canaryActive = false; pushPanelState(); }
    return;
  }
  const hasBusyOrWaiting = stateEngine.getSnapshot().conversations
    .some((c) => c.state === 'busy' || c.state === 'waiting');
  const noClaudeTabs = tabs.labels.length === 0;

  if (hasBusyOrWaiting && noClaudeTabs) {
    if (canaryTablessSince == null) canaryTablessSince = Date.now();
    if (!canaryActive && Date.now() - canaryTablessSince > CANARY_MS) {
      canaryActive = true;
      console.log('[QuotaBar] canary: conversation(s) busy/waiting but zero Claude tab detected for over %d min — viewType renamed by the official extension?', Math.round(CANARY_MS / 60000));
      pushPanelState();
    }
    return;
  }

  canaryTablessSince = null;
  if (canaryActive) { canaryActive = false; pushPanelState(); }
}

// Adapte le snapshot de state.js au contrat du webview (panel.js).
function conversationsState() {
  if (process.env.CLAUDE_QUOTA_PANEL_DEMO === '1') return DEMO_CONVERSATIONS;
  if (!stateEngine) return [];
  return stateEngine.getSnapshot().conversations.map((c) => ({
    id: c.sessionId,
    title: c.title,
    model: c.model,
    ctx: c.ctx,
    state: c.state,
    acked: c.acked !== false,
    active: c.isActive,
  }));
}

// % de la fenêtre déjà écoulé au moment présent. Null si le reset est trop
// proche/trop loin pour être un signal fiable (division instable) — mêmes
// gardes que burnRatePace, dont c'est exactement le dénominateur : on ne
// réécrit pas une 2e formule pour la flèche du lot 7, on expose celle-ci.
function windowElapsedPct(resetsAt, windowMs) {
  if (!resetsAt) return null;
  const remainMs = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(remainMs) || remainMs <= 0 || remainMs >= windowMs) return null;
  return ((windowMs - remainMs) / windowMs) * 100;
}

// pace = %utilisé / %de la fenêtre déjà écoulé. > 1 = on consomme plus vite
// que le temps ne passe (déplète la fenêtre avant le reset).
function burnRatePace(pct, resetsAt, windowMs) {
  const elapsedPct = windowElapsedPct(resetsAt, windowMs);
  if (elapsedPct == null || elapsedPct <= 1) return null;
  return pct / elapsedPct;
}

function paceColor(pace, thresholds) {
  if (pace == null) return null;
  if (pace <= thresholds.greenMax) return 'green';
  if (pace <= thresholds.yellowMax) return 'yellow';
  return 'red';
}

// Fenêtre de quota rendue par le panneau (lot 7 : le duo figé fiveHour/sevenDay
// devient une liste, pour accueillir les barres hebdo scopées par modèle sans
// toucher au contrat). pace/elapsedPct sont calculés ici pour le premier
// rendu ; le webview les ré-évalue localement toutes les 30 s (resetsAt +
// windowMs + burnRate suffisent, aucun I/O) — cf. panel.js.
function mkWindow(label, pct, resetsAt, windowMs, burnRate) {
  const elapsedPct = windowElapsedPct(resetsAt, windowMs);
  return {
    label,
    pct: Math.round(pct),
    resetsAt: resetsAt || null,
    resetLabel: reset(resetsAt),
    windowMs,
    pace: paceColor(burnRatePace(pct, resetsAt, windowMs), burnRate),
    elapsedPct: elapsedPct == null ? null : Math.min(100, Math.max(0, elapsedPct)),
  };
}

function quotaState() {
  const cached = readCache();
  const { burnRate } = getConfig();
  if (!cached || !cached.data) return { windows: [], burnRate, ageMin: null, source: null };
  const windows = [];
  const fh = cached.data.five_hour;
  if (fh && fh.utilization != null) windows.push(mkWindow('5h window', fh.utilization, fh.resets_at, FIVE_HOUR_MS, burnRate));
  const sd = cached.data.seven_day;
  if (sd && sd.utilization != null) windows.push(mkWindow('7d window', sd.utilization, sd.resets_at, SEVEN_DAY_MS, burnRate));
  // Barres hebdo scopées par modèle (ex. Fable 50 % de l'hebdo jusqu'au
  // 19/07) : AUCUNE référence en dur à un modèle ni une date — toute entrée
  // limits[] avec group:"weekly" et un scope produit sa barre, et disparaît
  // d'elle-même quand l'API cesse de l'envoyer.
  const limits = Array.isArray(cached.data.limits) ? cached.data.limits : [];
  for (const l of limits) {
    if (l.group !== 'weekly' || !l.scope || !l.scope.model) continue;
    const name = l.scope.model.display_name || 'scoped';
    windows.push(mkWindow(`${name} (7d)`, l.percent, l.resets_at, SEVEN_DAY_MS, burnRate));
  }
  return { windows, burnRate, ageMin: Math.round((Date.now() - cached.timestamp) / 60000), source: lastSource };
}

function buildPanelState() {
  return {
    conversations: conversationsState(),
    quota: quotaState(),
    sounds: { enabled: getConfig().soundsEnabled },
    // Lot 13 §1 : indicateur discret, jamais de popup — voir checkTabCanary().
    canary: canaryActive,
  };
}

// Commande « Claude Convs: Install Hooks » (plan 2026-07-16, lot 2 §2) : porte
// install.ps1, jamais sans consentement explicite — l'installeur écrit hors du
// dossier de l'extension (~/.claude/scripts/, ~/.claude/settings.json). Sans
// hooks, le panneau reste utilisable en mode dégradé : les conversations
// s'affichent quand même (transcripts seuls) mais restent en `idle`, faute
// d'état busy/waiting/done — voir state.js `readSessionsState`/`idle` et le
// tableau des états du README.
async function installHooks(context) {
  const scriptPath = path.join(context.extensionPath, 'install.ps1');
  if (!fs.existsSync(scriptPath)) {
    vscode.window.showErrorMessage('Claude Convs: install.ps1 not found in the extension folder.');
    return;
  }

  const choice = await vscode.window.showWarningMessage(
    'This will deploy Claude Code hooks so the panel can show live conversation state (busy/waiting/done) instead of idle only. It writes to:\n' +
    '• ~/.claude/scripts/ (copies the hook scripts)\n' +
    '• ~/.claude/settings.json (adds a statusLine entry and UserPromptSubmit/Stop/Notification/SessionEnd hooks — a timestamped backup is made first, and only missing entries are added)\n\n' +
    'Continue?',
    { modal: true },
    'Install hooks'
  );
  if (choice !== 'Install hooks') return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Claude Convs: installing hooks…' },
    () => new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { windowsHide: true, timeout: 30000 },
        (err, stdout, stderr) => {
          if (err) {
            vscode.window.showErrorMessage(`Claude Convs: hook installation failed — ${(stderr || err.message || '').trim().slice(0, 500)}`);
          } else {
            vscode.window.showInformationMessage('Claude Convs: hooks installed. Reload the window for the panel to pick up live conversation state.', 'Reload Window')
              .then((pick) => { if (pick === 'Reload Window') vscode.commands.executeCommand('workbench.action.reloadWindow'); });
          }
          resolve();
        }
      );
    })
  );
}

// Icône haut-parleur du panneau (lot 1, point 6) : bascule le setting user en
// un clic. `onDidChangeConfiguration` (activate()) repousse ensuite l'état à
// TOUTES les fenêtres, y compris celle qui n'a pas cliqué.
async function toggleSounds() {
  const cfg = vscode.workspace.getConfiguration('claudeCodeQuotaBar');
  const current = cfg.get('sounds.enabled', false);
  try { await cfg.update('sounds.enabled', !current, vscode.ConfigurationTarget.Global); } catch {}
}

// Conflit avec les signaux d'accessibilité natifs de VS Code (lot 1, point 5)
// — `accessibility.signals.chatResponseReceived`/`chatUserActionRequired` à
// `sound: "on"` ferait sonner deux fois la même fin de tour. Un message
// unique par machine (globalState, pas un fichier) ; le refus est respecté et
// mémorisé au même titre qu'un accord — on ne redemande jamais.
async function maybeWarnAccessibilityConflict(context) {
  if (!getConfig().soundsEnabled) return;
  if (context.globalState.get(ACCESSIBILITY_PROMPT_DISMISSED_KEY)) return;

  const signalsCfg = vscode.workspace.getConfiguration('accessibility.signals');
  const conflicting = ACCESSIBILITY_SIGNALS.filter((name) => {
    const v = signalsCfg.get(name);
    return v && v.sound === 'on';
  });
  if (!conflicting.length) return;

  let choice;
  try {
    choice = await vscode.window.showInformationMessage(
      'Claude Convs plays its own notification sound. VS Code also has an accessibility sound enabled for chat responses / questions — turn those off to avoid hearing both?',
      'Turn off VS Code sounds', 'Keep both'
    );
  } catch { choice = undefined; }

  if (choice === 'Turn off VS Code sounds') {
    for (const name of conflicting) {
      const v = signalsCfg.get(name) || {};
      try { await signalsCfg.update(name, { ...v, sound: 'off' }, vscode.ConfigurationTarget.Global); } catch {}
    }
  }
  try { context.globalState.update(ACCESSIBILITY_PROMPT_DISMISSED_KEY, true); } catch {}
}

function pushPanelState() {
  if (!panelProvider) return;
  try { panelProvider.update(buildPanelState()); } catch {}
}

function reset(isoStr) {
  if (!isoStr) return '?';
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return '?';
  const now = new Date();
  const t = hhmm(d);
  if (d.toDateString() === now.toDateString()) return t;
  const day = d.toLocaleDateString(undefined, { weekday: 'short' }).replace('.', '');
  return `${day} ${t}`;
}

function readToken() {
  try { return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'))?.claudeAiOauth?.accessToken ?? null; }
  catch { return null; }
}

function saveCache(data) {
  try { fs.writeFileSync(CACHE_PATH, JSON.stringify({ timestamp: Date.now(), data })); } catch {}
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch { return null; }
}

function fetchUsageViaOAuth(token) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'api.anthropic.com',
      path: '/api/oauth/usage',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      timeout: 8000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ============================================================================
// Brave Octopus is spawned EPHEMERALLY only when the cached claude.ai
// sessionKey is missing or expired. It is killed immediately after cookie
// extraction. Steady-state RAM cost is ~0 (no persistent browser).
// See Tools/BrowserAutomation/CLAUDE.md.
// ============================================================================

function findBraveExe() {
  for (const p of BRAVE_EXE_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

function cleanupSingletonLocks(userDataDir) {
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.unlinkSync(path.join(userDataDir, f)); } catch {}
  }
}

function pingOctopusCDP(timeoutMs = 1000) {
  return new Promise((resolve) => {
    const req = http.get(`http://${CDP_HOST}:${CDP_PORT}/json/version`, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function startOctopusBrave(userDataDir) {
  const exe = findBraveExe();
  if (!exe) throw new Error('brave.exe not found (set BRAVE_EXE env var)');
  cleanupSingletonLocks(userDataDir);
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    `--profile-directory=Default`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-features=ChromeWhatsNewUI',
    '--window-position=-32000,-32000',
    '--window-size=1280,900',
  ];
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true });
  if (child.pid) {
    try { fs.writeFileSync(BRAVE_PID_PATH, JSON.stringify({ pid: child.pid, ts: Date.now() })); } catch {}
  }
  child.unref();
}

// Synchronous, deterministic kill of Brave Octopus tree via the saved root PID.
// Done by spawning a detached PowerShell so VSCode's extension host doesn't
// block on the taskkill round-trip, but the kill is fire-and-forget from our
// side — the OS guarantees the tree is reaped.
function closeOctopusBrave(userDataDir) {
  let pid = null;
  try { pid = JSON.parse(fs.readFileSync(BRAVE_PID_PATH, 'utf8'))?.pid; } catch {}
  try { fs.unlinkSync(BRAVE_PID_PATH); } catch {}

  // First: targeted kill on the saved PID + descendants. Catches the normal case.
  if (pid) {
    try { execSync(`taskkill /PID ${pid} /T /F`, { timeout: 4000, windowsHide: true, stdio: 'ignore' }); } catch {}
  }

  // Defense in depth: kill any leftover brave.exe whose command line matches
  // our user-data-dir (covers stale PIDs from a previous crashed run). Matched
  // on the configured dir's basename, not a hardcoded string — braveUserDataDir
  // is now a user setting (lot 2 §1).
  const marker = path.basename(userDataDir || '').replace(/'/g, "''");
  if (!marker) return;
  try {
    const psCmd = `Get-CimInstance Win32_Process -Filter "Name='brave.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    execSync(`powershell -NoProfile -Command "${psCmd.replace(/"/g, '\\"')}"`, { timeout: 4000, windowsHide: true, stdio: 'ignore' });
  } catch {}
}

// ============================================================================
// Lightweight path: raw fetch() with cached claude.ai sessionKey cookie.
// Anthropic accepts sessionKey alone (verified empirically: cf_clearance,
// __cf_bm, etc. are not required on /api/organizations/{id}/usage — tested
// 2026-05-25 from a residential IP). No browser, no TLS spoof, ~0 RAM.
// On 401/403, refreshSessionKeyViaCdp() spawns Brave Octopus ephemerally,
// extracts the sessionKey via browser-level Storage.getCookies, and kills it.
// ============================================================================

function httpGetJson(url, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('CDP ping timeout')); });
  });
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 0;
    this.pending = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl, { perMessageDeflate: false });
      const t = setTimeout(() => reject(new Error('CDP connect timeout')), 5000);
      this.ws.on('open', () => { clearTimeout(t); resolve(); });
      this.ws.on('error', (e) => { clearTimeout(t); reject(e); });
      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id && this.pending.has(msg.id)) {
            const { res, rej } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) rej(new Error(msg.error.message || 'CDP error'));
            else res(msg.result);
          }
        } catch {}
      });
    });
  }
  send(method, params = {}, sessionId = null) {
    const id = ++this.nextId;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

const SESSION_KEY_PATH = path.join(os.homedir(), '.claude', 'quota-session-key.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

function readSessionKey() {
  try { return JSON.parse(fs.readFileSync(SESSION_KEY_PATH, 'utf8'))?.sessionKey || null; }
  catch { return null; }
}

function saveSessionKey(sessionKey) {
  try { fs.writeFileSync(SESSION_KEY_PATH, JSON.stringify({ sessionKey, ts: Date.now() })); } catch {}
}

function httpsGetJson(url, headers = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { 'user-agent': UA, accept: 'application/json', ...headers },
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchUsageWithSessionKey() {
  const sessionKey = readSessionKey();
  if (!sessionKey) throw new Error('no cached sessionKey');

  let orgId = readOrgIdCache();
  if (!orgId) {
    orgId = await discoverOrgIdWithSessionKey(sessionKey);
    if (orgId) writeOrgIdCache(orgId);
  }
  if (!orgId) throw new Error('no org_id');

  let r = await httpsGetJson(
    `https://claude.ai/api/organizations/${orgId}/usage`,
    { cookie: `sessionKey=${sessionKey}` }
  );
  if (r.status === 404) {
    // org_id stale — re-discover once
    const fresh = await discoverOrgIdWithSessionKey(sessionKey);
    if (fresh && fresh !== orgId) {
      writeOrgIdCache(fresh);
      r = await httpsGetJson(
        `https://claude.ai/api/organizations/${fresh}/usage`,
        { cookie: `sessionKey=${sessionKey}` }
      );
    }
  }
  if (r.status === 401 || r.status === 403) throw new Error('session_invalid');
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return JSON.parse(r.body);
}

async function discoverOrgIdWithSessionKey(sessionKey) {
  const r = await httpsGetJson('https://claude.ai/api/organizations', { cookie: `sessionKey=${sessionKey}` });
  if (r.status !== 200) return null;
  const orgs = JSON.parse(r.body);
  if (!Array.isArray(orgs) || !orgs.length) return null;
  const pick = orgs.find(o => !o.archived_at) || orgs[0];
  return pick?.uuid || null;
}

async function refreshSessionKeyViaCdp() {
  const { braveUserDataDir } = getConfig();
  if (!braveUserDataDir) throw new Error('braveUserDataDir not configured');
  const wasUp = await pingOctopusCDP();
  if (!wasUp) {
    startOctopusBrave(braveUserDataDir);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (await pingOctopusCDP()) break;
      await new Promise(r => setTimeout(r, 250));
    }
    if (!await pingOctopusCDP()) throw new Error('Brave Octopus failed to start');
  }

  const version = await httpGetJson(`http://${CDP_HOST}:${CDP_PORT}/json/version`, 1500);
  const cdp = new CdpClient(version.webSocketDebuggerUrl);
  await cdp.connect();
  try {
    const { cookies } = await cdp.send('Storage.getCookies');
    const sk = cookies.find(c => c.name === 'sessionKey' && /(^|\.)claude\.ai$/.test(c.domain));
    if (!sk) throw new Error('sessionKey absent in Brave Octopus — claude.ai not logged in');
    saveSessionKey(sk.value);
  } finally {
    cdp.close();
    // Only kill if we spawned it — never kill a Brave Octopus a Playwright
    // script may currently be using.
    if (!wasUp) closeOctopusBrave(braveUserDataDir);
  }
}

function readOrgIdCache() {
  try { return JSON.parse(fs.readFileSync(ORG_ID_CACHE_PATH, 'utf8'))?.org_id || null; }
  catch { return null; }
}

function writeOrgIdCache(orgId) {
  try { fs.writeFileSync(ORG_ID_CACHE_PATH, JSON.stringify({ org_id: orgId, ts: Date.now() })); } catch {}
}

function hhmm(d) { return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }

module.exports = { activate, deactivate };
