const vscode = require('vscode');
const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync, execFile } = require('child_process');
const WebSocket = require('ws');
const { ClaudePanelProvider } = require('./panel');
const { createStateEngine, DEFAULTS: STATE_DEFAULTS, projectDirFor, readSessionsState } = require('./state');
const { focusConversation, closeConversationTab, createFocusRelay } = require('./focus');
const { createTabTracker } = require('./tabs');
const { createAckTracker, DWELL_MS: ACK_DWELL_MS } = require('./ack');
const { convMatchesLabel } = require('./labels');
const { createSessionTitles } = require('./session-titles');
const { createSoundPlayer } = require('./sounds');
// Fenêtre de stabilisation du tout premier rendu (lot micro-allègements
// 2026-07-24) — cf. warmup.js pour le pourquoi (flash de conv fantôme post-reload).
const { createBootSettler } = require('./warmup');
// Création groupée de conversations (lot 1) : le métier est en Node pur dans
// batch.js, l'orchestration du lancement dans launcher.js — ici, que du câblage.
const { normalizeTasks, conflictingEnvVars, createIntentStore, mismatchOf, readInheritSettings, MODELS, EFFORTS } = require('./batch');
const { createBatchLauncher } = require('./launcher');
// Recalcul du message de « Create » (lot 6, correctif §3) : un membre lancé
// mais dont aucun hook n'a encore tiré n'a pas d'entrée dans le snapshot de
// state.js (le premier hook n'écrit qu'au premier Entrée) — le seul signal
// disponible pour dire « l'onglet est toujours là, en attente » est le
// registre des process CLI vivants, déjà utilisé par le rattachement étage 1.
const { liveSessionIds } = require('./live-sessions.js');
// Groupes (lot 2) : le store est du Node pur (persistance injectée), le
// rattachement par préfixe de prompt aussi — les deux se testent sans VS Code.
const { createGroupStore, hueOf } = require('./groups');
const { matchPending } = require('./attach');
const { firstUserText } = require('./hooks/transcript.js');
// Moteur de vagues (lot 4) : Node pur, ne connaît que `{wave, status}` — le
// statut RÉEL de chaque membre (queued/launched/done/stale) est résolu ici,
// à partir de la conversation qu'il pointe (ou de son absence).
const { launchedWave, waveToAutoLaunch, canForceLaunch } = require('./waves');
// Table de vérité UNIQUE du statut d'un membre (lot 10) : le rendu des lignes,
// le moteur de vagues et le bandeau de batch la consomment TOUS — plus une
// seule déduction locale à partir de « la conversation est-elle dans la liste
// affichée ». Sources injectées ici (registre des sessions, transcripts,
// sessions-state.json, vue), logique dans member-truth.js, Node pur.
const { memberTruth } = require('./member-truth');
// Conversation maîtresse d'un groupe (lot 11) : la résolution est du Node pur
// (normalisation + « exactement un transcript contient ce bloc »), les lectures
// de transcripts restent ici — et sont PONCTUELLES, déclenchées par un Create,
// jamais en tâche de fond (le cadrage a rejeté toute détection permanente).
const { resolveMaster } = require('./master');
const { readSlice, parseSlice } = require('./hooks/transcript.js');
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
let ackRecheckTimer = null;
let soundPlayer;
let lastSource = null;
// Ce qui a été DEMANDÉ à la création, par sessionId (lot 1). En mémoire : le
// lot 2 le persistera avec les groupes. Sert UNIQUEMENT au badge d'écart —
// jamais à décider quoi que ce soit sur la conversation.
let intentStore;
let batchLauncher;
// Racine du workspace (lot 9) : posée dans activate(), lue par
// composeBatchNotice() pour situer le transcript d'une session — module-level
// exprès, sinon le prédicat `hasTranscript` planterait (ReferenceError) hors
// de la portée locale d'activate().
let workspacePath;
// Groupes persistés dans le workspaceState (lot 2) — un groupe appartient au
// workspace, comme les conversations qu'il contient.
let groupStore;
const GROUPS_KEY = 'batchGroups';
// Repli de la section « New conversation » (lot 12) — workspaceState comme les
// groupes (décision du plan) : propre à l'espace de travail, jamais un setting
// global qui suivrait l'utilisateur d'un projet à l'autre. Pas de canal de
// notification inter-fenêtres pour workspaceState (contrairement aux settings
// `collapsedConversations`/`collapsedQuota` via onDidChangeConfiguration) — le
// même filet que les groupes : chaque fenêtre relit sa propre valeur à chaque
// push, jamais de désynchronisation durable.
let workspaceStateRef;
let globalStateRef;
const NEW_CONV_COLLAPSED_KEY = 'newConversationCollapsed';
// Astuce du champ paste écartée : par MACHINE (globalState, comme les prompts
// sons/accessibilité) — « je suis déjà au courant » ne dépend pas du workspace.
const BATCH_TIP_DISMISSED_KEY = 'batchTipDismissed';
// Dernier modèle/effort choisis EXPLICITEMENT dans le formulaire (plan
// sélecteurs 2026-07-24) — workspaceState comme les groupes : le formulaire
// doit retomber sur le dernier geste de CE workspace après un Create, jamais
// sauter sur le défaut global (`inherit`, réglage Claude Code au sens large)
// qui ne sert plus que de repli au tout premier usage (jamais renseigné).
const LAST_BATCH_MODEL_KEY = 'lastBatchModel';
const LAST_BATCH_EFFORT_KEY = 'lastBatchEffort';
// Ménage de stockage à l'activation : un groupe plus vieux que ça ET dont
// aucune conversation n'est encore connue du panneau ne représente plus rien.
// Jamais en continu : c'est du nettoyage, pas une règle d'affichage.
const GROUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Étage 2 du rattachement : on relit le premier message user des transcripts
// candidats, donc pas à chaque écriture d'un transcript occupé.
const ATTACH_RETRY_MS = 2000;
let lastAttachTry = 0;
// Retour visible d'un « Create » : compteur pendant, message après. Jamais de
// popup pour le cas nominal (le panneau EST la surface).
let batchStatus = { busy: false, notice: null };
// Dernier lot lancé avec succès, pour recalculer le message d'ouverture à
// chaque push d'état plutôt que de le figer au moment du « Create » (lot 6,
// correctif §3 — un member envoyé/fermé rendait l'ancien message faux).
// `trackedSessionIds` ne porte que les membres RATTACHÉS (étage 1) : les
// tâches jamais identifiées restent dans le texte statique `staticSuffix`,
// inchangé, comme avant ce lot.
let batchLastLaunch = null;
// Annonce d'ouverture de vague (lot 4, décision 5 : « une ouverture auto est
// annoncée dans le panneau »). En mémoire, par groupe — un texte transitoire,
// pas une donnée à survivre au reload (contrairement aux groupes eux-mêmes).
let waveNotices = new Map();

// Settings VS Code natifs qui font aussi sonner une fin de tour / une
// question — risque de double son avec les nôtres (lot 1 §5). Un seul
// message proposant de les couper, une seule fois par machine (refus mémorisé
// dans le globalState de l'extension, pas dans les settings user).
const ACCESSIBILITY_SIGNALS = ['chatResponseReceived', 'chatUserActionRequired'];
const ACCESSIBILITY_PROMPT_DISMISSED_KEY = 'soundsAccessibilityPromptDismissed';

// Sons sans hooks (signalé par l'user 2026-07-17) : sans les hooks, aucune
// conversation ne quitte jamais `idle` (README § Setup) — donc aucune
// transition busy→done/waiting ne se produit jamais, et le son activé via le
// toggle 🔈 ne joue jamais, sans un mot d'explication. Même refus mémorisé
// qu'ACCESSIBILITY_PROMPT_DISMISSED_KEY : si les hooks arrivent plus tard,
// hooksAppearInstalled() redevient vrai et ce garde-fou ne se déclenche plus
// de toute façon, donc mémoriser le refus ne bloque rien de durable.
const HOOKS_MARKER_PATH = path.join(os.homedir(), '.claude', 'scripts', 'hook-session-state.js');
const NO_HOOKS_SOUNDS_PROMPT_DISMISSED_KEY = 'soundsNoHooksPromptDismissed';

// Lot 9 : dernier état connu par conv, pour ne détecter que de VRAIES
// transitions (busy→done, busy→waiting…). renderKey() de state.js notifie
// aussi sur un ctx% qui bouge ou un acked qui change sans transition d'état —
// sans ce suivi, chaque recompute pendant un run busy tirerait le throttle
// pour rien (cf. plan lot 9, point 4).
let lastConvStates = new Map();
let lastEventFetchAt = 0;
// Circuit breaker de la voie cookie : quand refreshSessionKeyViaCdp échoue
// (cas le plus courant : le profil Brave n'est PAS loggué claude.ai, donc aucun
// sessionKey à en extraire — constaté 2026-07-22), relancer Brave à chaque fetch
// est du pur gaspillage (le refresh rééchouera à l'identique). On retombe sur
// OAuth et on ne retente le spawn qu'après ce délai. Un Refresh manuel (force)
// court-circuite le breaker — l'utilisateur vient peut-être de se logger.
let cookieRefreshBlockedUntil = 0;
const COOKIE_REFRESH_BACKOFF_MS = 60 * 60 * 1000;
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
    // Décision user 2026-07-22 : défaut = ordre des onglets VS Code (le plus à
    // gauche en tête), pas lastActivity — changement de comportement assumé
    // par rapport aux versions précédentes du panneau.
    sortOrder: cfg.get('conversationSortOrder', 'tabOrder'),
    collapsedConversations: !!cfg.get('collapsedConversations', false),
    collapsedQuota: !!cfg.get('collapsedQuota', false),
  };
}

function activate(context) {
  const { refreshMs } = getConfig();

  context.subscriptions.push(
    vscode.commands.registerCommand('claude-code-quota-bar.open', () => {
      vscode.env.openExternal(vscode.Uri.parse(USAGE_URL));
    }),
    vscode.commands.registerCommand('claude-code-quota-bar.refresh', () => fetchAndUpdate(true)),
    vscode.commands.registerCommand('claude-code-quota-bar.installHooks', () => installHooks(context)),
    // Le panneau est un container à vue unique dans la sidebar secondaire :
    // fermé (X sur l'onglet), VS Code n'offre aucun moyen évident de le
    // rouvrir (pas d'icône activity bar, "View: Open View..." le noie dans une
    // liste de dizaines d'entrées). La commande auto-générée <viewId>.focus
    // réaffiche à la fois le container et la vue — on l'expose sous un nom
    // explicite en Palette plutôt que de laisser l'utilisateur chercher
    // "Focus on Conversations & quota View".
    vscode.commands.registerCommand('claude-code-quota-bar.showPanel', () => {
      vscode.commands.executeCommand('claudeCodeQuotaBar.panel.focus');
    })
  );

  // Bouton barre de statut : accès permanent au panneau, qu'il soit fermé,
  // masqué derrière une autre vue, ou juste jamais ouvert (2026-07-22, plainte
  // user sur la découvrabilité). Toujours visible, pas seulement quand le
  // panneau est fermé — évite de dépendre d'un signal de visibilité fiable.
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(comment-discussion) Claude Convs';
  statusBarItem.tooltip = 'Afficher le panneau Claude Convs (conversations & quota)';
  statusBarItem.command = 'claude-code-quota-bar.showPanel';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Sons de notification (plan 2026-07-16, lot 1) : branché plus bas sur le
  // même signal de transition que le fetch événementiel (maybeFetchOnTransition),
  // jamais sur un recompute qui ne change rien.
  soundPlayer = createSoundPlayer({ isEnabled: () => getConfig().soundsEnabled });
  context.subscriptions.push({ dispose: () => soundPlayer.dispose() });
  // Le toggle peut déjà être `true` (settings.json édité à la main, ou profil
  // repris d'une machine où on l'avait activé) — pas seulement via l'icône.
  maybeWarnAccessibilityConflict(context);
  maybeWarnNoHooksForSounds(context);

  // Panneau sidebar secondaire (droite). retainContextWhenHidden : l'état est
  // poussé par événement ; sans ça, un panneau masqué se réveille vide jusqu'au
  // prochain push (le poll quota est à 5 min, l'attente serait visible).
  panelProvider = new ClaudePanelProvider(context, {
    // Le tout premier push attend la stabilisation (warmup.js) ; tous les
    // suivants restent immédiats (pushPanelState direct, inchangé partout
    // ailleurs dans ce fichier).
    ready: () => pushPanelStateSettled(),
    refresh: () => fetchAndUpdate(true),
    openUsage: () => vscode.env.openExternal(vscode.Uri.parse(USAGE_URL)),
    // Clic = acte observé explicite (lot 10c), même si l'onglet est déjà actif
    // — c'est le seul cas où aucune bascule/transition ne peut jamais se
    // produire, donc le seul chemin d'ack possible en mono-onglet.
    focusConv: (msg) => { focusConversation(msg); ackConversationById(msg && msg.id); },
    toggleSounds: () => toggleSounds(context),
    toggleCollapse: (msg) => toggleCollapse(msg && msg.section),
    setSortOrder: (msg) => setSortOrder(msg && msg.order),
    createBatch: (msg) => createBatch(msg),
    // Actions de groupe (lot 2). Renommer / dissoudre / lier passent par les
    // boîtes NATIVES de VS Code (InputBox, QuickPick, modale) plutôt que par des
    // champs dans le webview : un push d'état (transition de conv, tick quota)
    // re-rend le panneau, et une saisie en cours y serait perdue — le
    // formulaire de lot est déjà tout ce qu'on peut se permettre de protéger.
    renameGroup: (msg) => renameGroup(msg && msg.id),
    dissolveGroup: (msg) => dissolveGroup(msg && msg.id),
    toggleGroupCollapse: (msg) => toggleGroupCollapse(msg && msg.id),
    removeMember: (msg) => removeMember(msg && msg.id, msg && msg.key),
    linkMember: (msg) => linkMember(msg && msg.id, msg && msg.key),
    addToGroup: (msg) => addToGroup(msg && msg.id),
    closeConvTab: (msg) => closeConversationTab(msg),
    // Chip unique « fermer & retirer » (lot micro-allègements 2026-07-24) :
    // ferme l'onglet PUIS retire le membre, retrait non conditionné au succès
    // de la fermeture — un onglet qui refuse de se fermer reste visible dans la
    // barre, rien ne se perd côté groupe.
    closeAndRemoveMember: (msg) => closeAndRemoveMember(msg),
    // Moteur de vagues (lot 4).
    toggleGroupAdvance: (msg) => toggleGroupAdvance(msg && msg.id),
    launchWave: (msg) => handleLaunchWave(msg),
    moveMemberWave: (msg) => moveMemberWave(msg && msg.id, msg && msg.key, Number(msg && msg.delta)),
    // Ajout en file à un groupe existant (plan ajout-tache 2026-07-24) : « + »
    // par vague en file / ligne fantôme « nouvelle vague » du panneau.
    addTaskToGroup: (msg) => addTaskToGroup(msg),
    // Conversation maîtresse (lot 11) : étage 2 (édition manuelle) du même
    // mécanisme — QuickPick natif, comme le lien d'un membre. Le gbtn ⌂ de
    // l'en-tête est le point d'entrée unique (set / changer / dissocier,
    // lot allègement 2026-07-24) — dissocier est une entrée du même QuickPick,
    // plus un message dédié.
    setGroupMaster: (msg) => setGroupMaster(msg && msg.id),
    // Astuce du champ paste (2026-07-23) : le × la masque définitivement, le
    // « ? » du label la ramène. Persisté par machine (globalState), push manuel.
    dismissBatchTip: () => setBatchTipDismissed(true),
    restoreBatchTip: () => setBatchTipDismissed(false),
    // Dernier choix explicite modèle/effort (plan sélecteurs 2026-07-24).
    setLastBatchChoice: (msg) => setLastBatchChoice(msg && msg.field, msg && msg.value),
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ClaudePanelProvider.viewType, panelProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Moteur d'état des conversations (lot 2) : réactif par fs.watch, aucun poll
  // pour l'état — seul le quota réseau reste sur le timer refreshMs.
  workspacePath = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]
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
  context.subscriptions.push({
    dispose: () => { clearTimeout(ackRecheckTimer); ackRecheckTimer = null; ackTracker.dispose(); },
  });

  // Titres d'onglet RÉELS (2026-07-22) : seul l'hôte d'extension peut situer le
  // state.vscdb du workspace, d'où ce câblage ici plutôt qu'un défaut dans
  // state.js. Absent (pas de workspace, layout VS Code différent) → table vide,
  // comportement d'avant ce lot.
  const sessionTitles = createSessionTitles(resolveStateDbPath(context));

  stateEngine = createStateEngine({
    workspacePath,
    ...STATE_DEFAULTS,
    tabs: () => tabTracker.getTabs(),
    sessionTitles: () => sessionTitles.get(),
    sortOrder: () => getConfig().sortOrder,
    // L'ack APRÈS le push : la conv apparaît terminée tout de suite, l'accusé
    // suit. Ici passe le cas « l'onglet était déjà sous les yeux quand Claude a
    // fini » — aucune bascule d'onglet ne se produira, c'est donc l'arrivée du
    // `done` qui doit aller consulter le séjour en cours.
    onChange: (snap) => { attachPendingMembers(); maybeAdvanceWaves(); pushPanelState(); ackConversations(); maybeFetchOnTransition(snap); },
  });
  context.subscriptions.push({ dispose: () => stateEngine.dispose() });
  // Amorce lastConvStates avec le snapshot initial : createStateEngine le
  // construit à la construction SANS appeler onChange (celui-ci ne tire que
  // sur un recompute déclenché ensuite). Sans amorçage, une conv déjà `busy`
  // à l'activation qui passe `done` avant le premier recompute intermédiaire
  // aurait `before === undefined` → transition invisible, fetch manqué.
  for (const c of stateEngine.getSnapshot().conversations) lastConvStates.set(c.sessionId, c.state);

  // Création groupée (lot 1) : lanceur sérialisé, dépendances VS Code
  // injectées (le module se teste sans VS Code). `workspacePath` filtre le diff
  // du registre des sessions — une conversation ouverte au même instant dans
  // une AUTRE fenêtre ne doit pas être prise pour la nôtre.
  intentStore = createIntentStore();
  // Groupes (lot 2) : workspaceState, pas globalState — un groupe n'a de sens
  // que là où vivent ses conversations. La persistance rend aussi au badge
  // d'écart ce que le lot 1 perdait au reload : les intentions de lancement,
  // réamorcées ici depuis les membres déjà rattachés.
  groupStore = createGroupStore({
    load: () => context.workspaceState.get(GROUPS_KEY, []),
    save: (groups) => { context.workspaceState.update(GROUPS_KEY, groups); },
  });
  workspaceStateRef = context.workspaceState;
  globalStateRef = context.globalState;
  {
    const known = new Set(stateEngine.getSnapshot().conversations.map((c) => c.sessionId));
    const dropped = groupStore.prune(GROUP_MAX_AGE_MS, known);
    if (dropped) console.log('[QuotaBar] pruned %d stale conversation group(s) from workspace storage', dropped);
    for (const i of groupStore.intents()) intentStore.record(i.sessionId, i);
  }
  batchLauncher = createBatchLauncher({
    executeCommand: (...args) => vscode.commands.executeCommand(...args),
    listCommands: () => vscode.commands.getCommands(true),
    env: process.env,
    workspacePath,
    writeClipboard: (text) => vscode.env.clipboard.writeText(text),
    showMessage: (text) => vscode.window.showWarningMessage(text),
    // Colonne active = les onglets du lot s'empilent là où l'utilisateur
    // travaille. `undefined` si l'enum n'est pas là (mock de banc, API future) :
    // editor.open reprend alors son propre défaut — dégradation silencieuse.
    viewColumn: vscode.ViewColumn ? vscode.ViewColumn.Active : undefined,
    t: (...args) => vscode.l10n.t(...args),
  });

  // Avance de vague AU BOOT (lot 3 du plan bug-chip 2026-07-24) : `onChange` du
  // moteur d'état ne tire QUE sur un recompute qui CHANGE le rendu (cf. amorçage
  // de lastConvStates plus haut). Quand la dernière vague d'un groupe auto se
  // termine autour d'un reload — CLI tués, entrées hooks purgées —, la
  // transition busy→done n'est portée par AUCUN `onChange` : au boot suivant, le
  // tout premier snapshot montre déjà la vague `done` et la suivante `queued`,
  // état STABLE qui ne fera plus jamais tirer `onChange`. Résultat observé : une
  // vague en file jamais lancée toute seule. Il manquait simplement le chemin qui
  // RÉÉVALUE les groupes au premier snapshot post-boot — le voici, une fois,
  // maintenant que groupStore + stateEngine + batchLauncher sont prêts.
  // Idempotent : launchWaveForGroup ne relance que les membres `launchedAt==null`,
  // donc rejouer l'évaluation sur un état déjà avancé ne fait rien.
  maybeAdvanceWaves();

  // Relais de focus inter-fenêtres (lot 4) : le panneau liste les convs du
  // workspace, dont certaines ont leur onglet dans une AUTRE fenêtre VS Code.
  // Chaque instance écoute les requêtes ; celle qui possède l'onglet répond.
  context.subscriptions.push(createFocusRelay());

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      // Réglage officiel de l'extension Claude, pas le nôtre : il décide si nos
      // sélecteurs modèle/effort servent à quelque chose (cf. envConflict).
      if (e.affectsConfiguration('claudeCode.environmentVariables')) pushPanelState();
      if (e.affectsConfiguration('claudeCodeQuotaBar')) {
        restartTimer();
        // Le tri est un champ du snapshot mis en cache par stateEngine
        // (buildPanelState relit getConfig() mais pas l'ordre déjà calculé) :
        // sans ce refresh explicite, un changement de tri via le dropdown
        // n'apparaîtrait qu'au prochain événement fs / tick 30 s.
        if (e.affectsConfiguration('claudeCodeQuotaBar.conversationSortOrder') && stateEngine) {
          stateEngine.refresh();
        }
        // Synchronise l'icône haut-parleur / le repli des sections si le
        // setting change ailleurs qu'un clic dans le panneau (settings.json
        // édité à la main, sync de profil…).
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

// Chemin du state.vscdb du workspace courant — la table sessionId → titre
// d'onglet réel (session-titles.js) y vit, sous la clé agentSessions.model.cache.
//
// VS Code ne l'expose pas : on le déduit de `context.storageUri`, qui vaut
// `…/workspaceStorage/<hash>/<publisher.extension>`. Le state.vscdb est le
// VOISIN de ce dossier d'extension, c.-à-d. un cran au-dessus
// (`…/workspaceStorage/<hash>/state.vscdb`) — vérifié sur cette machine, contre
// deux crans dans le plan initial. On tolère quand même le cran suivant : c'est
// un internal, et le seul coût d'une mauvaise devinette serait de perdre les
// titres d'onglets sans rien dire. `storageUri` absent (aucun dossier ouvert)
// → null → dégradation silencieuse.
function resolveStateDbPath(context) {
  try {
    const base = context && context.storageUri && context.storageUri.fsPath;
    if (!base) return null;
    let dir = path.dirname(base);
    for (let i = 0; i < 2; i++) {
      const candidate = path.join(dir, 'state.vscdb');
      if (fs.existsSync(candidate)) return candidate;
      dir = path.dirname(dir);
    }
  } catch {}
  return null;
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
  clearTimeout(ackRecheckTimer);
  ackRecheckTimer = null;
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
    // `force` (Refresh manuel) court-circuite le circuit breaker ci-dessous.
    if (getConfig().braveUserDataDir && (force || Date.now() >= cookieRefreshBlockedUntil)
        && /no cached sessionKey|session_invalid|HTTP 40[13]|no org_id/.test(e.message)) {
      try {
        await refreshSessionKeyViaCdp();
        data = await fetchUsageWithSessionKey();
        source = 'cookie-refreshed';
        cookieRefreshBlockedUntil = 0;   // succès → breaker réarmé
      } catch (e2) {
        cookieErr = e2;
        // Échec (profil non loggué, Brave qui ne démarre pas…) : ne pas
        // respawner Brave à chaque fetch — on retombe sur OAuth et on ferme le
        // breaker pour COOKIE_REFRESH_BACKOFF_MS.
        cookieRefreshBlockedUntil = Date.now() + COOKIE_REFRESH_BACKOFF_MS;
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
  { id: 'd1', title: 'Implémenter le lot 1 du panneau sidebar', model: 'Opus 4.8', effort: 'high', ctx: { pct: 34, tokens: 340000, denom: 1000000 }, state: 'busy', acked: true, active: true, groupId: 'demo-g' },
  { id: 'd2', title: 'Refonte du digest mail', model: 'Sonnet 5', effort: 'medium', ctx: { pct: 71, tokens: 142000, denom: 200000 }, state: 'waiting', acked: true, active: false },
  { id: 'd3', title: 'Watchdog Jeedom Z-Wave', model: 'Haiku 4.5', effort: 'low', ctx: { pct: 12, tokens: 24000, denom: 200000 }, state: 'done', acked: false, active: false, groupId: 'demo-g', tabOpen: true },
  { id: 'd4', title: 'Portage web PlanningTP', model: 'Opus 4.8', effort: 'high', ctx: { pct: 88, tokens: 880000, denom: 1000000 }, state: 'stale', acked: true, active: false },
  { id: 'd5', title: 'Tri des scans', model: null, effort: null, ctx: null, state: 'idle', acked: true, active: false },
  // Écart intention/réel (lot 1) : demandé en opus·high au lancement, servi en
  // sonnet·medium — le badge est le SEUL mécanisme qui le signale.
  { id: 'd6', title: 'Sondage BBQ Cloudflare Pages', model: 'Sonnet 5', effort: 'medium', ctx: { pct: 22, tokens: 44000, denom: 200000 }, state: 'done', acked: true, active: false, asked: { model: 'opus', effort: 'high' }, mismatch: { model: { asked: 'opus', real: 'sonnet' }, effort: { asked: 'high', real: 'medium' } } },
  { id: 'd7', title: 'Migration des scripts PowerShell', model: 'Opus 4.8', effort: 'high', ctx: { pct: 47, tokens: 470000, denom: 1000000 }, state: 'interrupted', acked: true, active: false },
];

// Groupe de démonstration (lot 2), rendu en mode CLAUDE_QUOTA_PANEL_DEMO : les
// trois cas qu'un groupe peut afficher — un membre au travail, un membre
// terminé dont l'onglet est encore ouvert (badge ⨯), et un membre pas encore
// rattaché à une conversation.
const DEMO_GROUPS = [{
  id: 'demo-g',
  name: 'Refonte du paiement',
  hue: hueOf('Refonte du paiement'),
  collapsed: false,
  // Moteur de vagues (lot 4) : vague 1 en cours (d1 busy, d3 done), vague 2
  // encore `queued` — le cas type de « unlocks when wave 1 is fully done ».
  autoAdvance: true,
  launchedWave: 1,
  nextWave: 2,
  waveNotice: null,
  // Démo : les champs dérivés de la table de vérité (lot 10) sont écrits à la
  // main ici — aucune source réelle derrière une conversation fictive.
  members: [
    { key: 'm1', prompt: 'Implémenter le lot 1 du panneau sidebar', wave: 1, asked: { model: 'opus', effort: 'high' }, convId: 'd1', status: 'busy', waveStatus: 'launched', canLink: false, canClose: false, note: '', hint: '' },
    { key: 'm2', prompt: 'Watchdog Jeedom Z-Wave', wave: 1, asked: { model: 'haiku', effort: 'low' }, convId: 'd3', status: 'done', waveStatus: 'done', canLink: false, canClose: true, note: '', hint: '' },
    { key: 'm3', prompt: 'Mettre à jour la doc une fois les deux autres terminées', wave: 2, asked: { model: 'sonnet', effort: 'medium' }, convId: null, status: 'queued', waveStatus: 'queued', canLink: false, canClose: false, note: '', hint: 'Queued — opens when this wave starts.' },
  ],
}];

// Onglet(s) Claude fermé(s) → les convs correspondantes quittent le panneau.
// Deux temps, dans cet ordre :
//  1) markClosed : retrait immédiat à l'écran (l'exigence est « < 1 s »), sans
//     dépendre de l'étape 2 qui prend un lock inter-process ;
//  2) removeSession : purge de sessions-state.json — sinon l'entrée `busy`
//     ressusciterait la conv au prochain snapshot, ET les AUTRES fenêtres, qui
//     n'ont pas notre marque de fermeture, continueraient de l'afficher.
function closeConversations(labels) {
  if (!stateEngine || !labels || !labels.length) return;
  const convs = stateEngine.getSnapshot().conversations;
  const ids = [];
  for (const l of labels) {
    const matches = convs.filter((c) => convMatchesLabel(l, c));
    // Libellé ambigu (deux titres voisins tronqués sur le même préfixe, cf.
    // labelMatches) : impossible de savoir laquelle des deux a VRAIMENT fermé
    // son onglet — fermer les deux purgerait une conversation encore ouverte
    // ailleurs. Même invariant que tabs.js : le doute profite à l'affichage,
    // on ne ferme AUCUNE des deux plutôt qu'une mauvaise.
    if (matches.length !== 1) continue;
    ids.push(matches[0].sessionId);
  }
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
//
// LE SEUIL COURT APRÈS LA FIN DU TOUR (2026-07-22) — le lot 10 comparait le
// séjour au DÉBUT du run (`busySince`) : « être venu regarder travailler »
// valait donc « avoir lu le résultat », alors que le résultat n'était pas encore
// écrit. Combiné au `rename_tab` de fin de tour (cf. ack.js), ça posait l'accusé
// ~2,3 s après le `done` sans le moindre acte de l'utilisateur. Le séjour doit
// désormais couvrir DWELL_MS ENTIÈREMENT POSTÉRIEURES à `since` — les yeux sur
// l'onglet pendant que le résultat est à l'écran, pas avant. Le garde-fou
// `busySince` du lot 10 reste en place par-dessus.
//
// Un re-check est programmé quand le seuil n'est pas encore atteint : sans lui,
// une conv qui finit sous les yeux de l'user ne serait jamais acquittée, faute
// d'événement ultérieur pour rappeler cette fonction.
function ackConversations() {
  if (!stateEngine || !ackTracker) return;
  clearTimeout(ackRecheckTimer);
  ackRecheckTimer = null;
  const label = ackTracker.stayLabel();
  if (!label) return;
  const dwellSince = ackTracker.dwellSince();
  const now = Date.now();
  let soonest = Infinity;
  for (const c of stateEngine.getSnapshot().conversations) {
    if (c.state !== 'done' || c.acked) continue;
    if (!convMatchesLabel(label, c)) continue;
    if (c.busySince != null && dwellSince != null && dwellSince <= c.busySince) continue;
    const watchedSince = Math.max(dwellSince || 0, c.since || 0);
    const remaining = ACK_DWELL_MS - (now - watchedSince);
    if (remaining > 0) { soonest = Math.min(soonest, remaining); continue; }
    try { updateSession(c.sessionId, { ack_ts: Date.now() }); } catch {}
  }
  if (soonest !== Infinity) {
    ackRecheckTimer = setTimeout(() => { ackRecheckTimer = null; ackConversations(); }, soonest + 20);
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

// ── Supplantation husk→successeur (supersede.js / snapshot.supersededBy) ─────
// Un reload peut relancer une conversation restaurée sous un NOUVEAU sessionId ;
// un membre de groupe (ou la conv maîtresse) rattaché à l'ANCIEN id doit
// résoudre son statut, son chip et sa cible de fermeture contre le successeur
// VIVANT, jamais contre le husk mort. On ne réécrit RIEN dans le store (un lien
// deviné ne se persiste pas — cf. groups.js) : on redirige au rendu. `superseded`
// absent/vide = identité inchangée (dégradation silencieuse).
function currentSuperseded() {
  try { return (stateEngine && stateEngine.getSnapshot().supersededBy) || {}; }
  catch { return {}; }
}
function resolveConvId(id, superseded) {
  return (id && superseded && superseded[id]) || id;
}
// Copie superficielle du membre avec son sessionId redirigé (launchedAt / prompt
// / wave préservés) — l'original du store n'est jamais muté.
function redirectMember(m, superseded) {
  const to = m && m.sessionId && superseded && superseded[m.sessionId];
  return to ? { ...m, sessionId: to } : m;
}
// Reverse : successeur → husks qu'il supplante. Sert à rattacher au bon groupe
// une conversation resumée dont le membre stocké pointe encore l'ancien id
// (sinon elle réapparaîtrait, orpheline, dans la liste plate).
function husksBySuccessor(superseded) {
  const out = {};
  for (const h of Object.keys(superseded || {})) {
    const s = superseded[h];
    (out[s] || (out[s] = [])).push(h);
  }
  return out;
}

// Adapte le snapshot de state.js au contrat du webview (panel.js).
function conversationsState() {
  if (process.env.CLAUDE_QUOTA_PANEL_DEMO === '1') return DEMO_CONVERSATIONS;
  if (!stateEngine) return [];
  const snap = stateEngine.getSnapshot();
  const husksOf = husksBySuccessor(snap.supersededBy || {});
  // Un groupe revendique une conv soit par son sessionId propre, soit parce
  // qu'elle est le successeur resumé d'un de ses membres (husk) — sans ça, la
  // conv reprise se retrouverait à la fois DANS son groupe (via la redirection
  // des membres) ET dans la liste plate.
  const groupIdFor = (id) => {
    if (!groupStore) return null;
    const direct = groupStore.groupIdOf(id);
    if (direct) return direct;
    for (const h of husksOf[id] || []) {
      const g = groupStore.groupIdOf(h);
      if (g) return g;
    }
    return null;
  };
  return snap.conversations.map((c) => {
    // VÉRITÉ AFFICHÉE = TRANSCRIPT (décision 6 du plan). `model`/`effort` sont
    // ce qui tourne réellement ; `asked`/`mismatch` ne sont qu'un commentaire
    // posé dessus quand on a lancé la conv nous-mêmes ET que le réel diffère.
    const intent = intentStore ? intentStore.get(c.sessionId) : null;
    return {
      id: c.sessionId,
      title: c.title,
      tabTitle: c.tabTitle || null,
      model: c.model,
      effort: c.effort || null,
      ctx: c.ctx,
      state: c.state,
      acked: c.acked !== false,
      active: c.isActive,
      asked: intent ? { model: intent.model, effort: intent.effort } : null,
      mismatch: mismatchOf(intent, { modelId: c.modelId, effort: c.effort }),
      // Membre d'un groupe (lot 2) : le webview la rend DANS la section du
      // groupe et la retire de la liste plate. `null` = conversation ordinaire.
      groupId: groupIdFor(c.sessionId),
      // Onglet encore ouvert : conditionne le badge « terminé → fermable ».
      tabOpen: !!c.tabOpen,
    };
  });
}

// Groupes tels que rendus par le panneau. Le webview ne reçoit QUE des
// métadonnées : l'état, le modèle, le contexte d'un membre viennent de la
// conversation correspondante (conversations[], appariée par `convId`) — un
// membre n'a pas d'état propre, il pointe une conversation qui, elle, en a un.
// SEULE EXCEPTION : `status` (lot 4 — queued/launched/done/stale), calculé ici
// une fois pour le rendu des en-têtes de vague ET pour waves.js, plutôt que de
// faire au webview un second calcul potentiellement divergent.
//
// `convs` = sortie de conversationsState(), déjà calculée par buildPanelState
// — un seul passage sur stateEngine, pas un second par groupe.
function groupsState(convs, sources, superseded) {
  if (process.env.CLAUDE_QUOTA_PANEL_DEMO === '1') return DEMO_GROUPS;
  if (!groupStore) return [];
  const sup = superseded || currentSuperseded();
  const convById = new Map((convs || []).map((c) => [c.id, c]));
  const src = sources || memberSources((id) => convById.get(id));
  return groupStore.all().map((g) => {
    // UNE résolution par membre (lot 10), partagée par le moteur de vagues et
    // par le rendu : le webview ne re-déduit plus rien de « la conversation
    // est-elle dans la liste » — il affiche ce que la table a conclu.
    // `rm` = membres à sessionId redirigé (husk→successeur après un reload) :
    // statut, chip et cible de fermeture visent la conv VIVANTE, pas le husk.
    const rm = g.members.map((m) => redirectMember(m, sup));
    const truths = rm.map((m) => memberTruth(m, src));
    const abstract = rm.map((m, i) => ({ wave: m.wave, status: truths[i].waveStatus }));
    return {
      id: g.id,
      name: g.name,
      hue: hueOf(g.name),
      collapsed: !!g.collapsed,
      autoAdvance: !!g.autoAdvance,
      // Conv maîtresse (lot 11) : un POINTEUR vers une conversation qui vit sa
      // vie ailleurs — elle n'est pas un membre, ne compte dans aucune vague, et
      // n'est pas retirée de la liste plate. Son statut passe par la MÊME table
      // de vérité que les membres (lot 10) : la vue ne décide de rien, ici non
      // plus. `title` = celui de la conv si elle est listée, sinon celui qui a
      // été persisté au moment du lien.
      master: masterState(g, src, convById, sup),
      launchedWave: launchedWave(abstract),
      nextWave: canForceLaunch(abstract),
      waveNotice: waveNotices.get(g.id) || null,
      members: g.members.map((m, i) => ({
        key: m.key,
        prompt: m.prompt,
        wave: m.wave,
        asked: { model: m.model, effort: m.effort },
        // Redirigé (husk→successeur) : le chip de fermeture et le clic ciblent
        // la conversation VIVANTE, jamais le husk mort d'avant le reload.
        convId: rm[i].sessionId || null,
        // Statut canonique (affichage) et sa projection sur le vocabulaire du
        // moteur de vagues (comptages, en-têtes) — cf. member-truth.js.
        status: truths[i].status,
        waveStatus: truths[i].waveStatus,
        canLink: truths[i].canLink,
        canClose: truths[i].canClose,
        // NOTES/HINTS (member-truth.js) sont du Node pur, sans vscode — le
        // texte anglais qu'elles rendent sert de CLÉ à la traduction ici, au
        // seul point où le résultat part vers l'affichage.
        note: truths[i].note ? vscode.l10n.t(truths[i].note) : truths[i].note,
        hint: truths[i].hint ? vscode.l10n.t(truths[i].hint) : truths[i].hint,
      })),
    };
  });
}

// Pointeur vers la conv maîtresse d'un groupe (lot 11). `null` quand aucune
// maîtresse n'est désignée — rien d'inerte à l'écran, comme partout ailleurs
// dans ce chantier. Dans la fenêtre du panneau (listed) → le webview rend la
// conv au format STANDARD via son propre objet (convById), ce pointeur ne lui
// sert alors qu'à la retrouver et l'exclure de la liste plate (volet C, lot
// allègement v2 2026-07-24) ; model/effort/état ne sont donc plus renvoyés
// ici. Hors de la vue → fallback dégradé, seuls title/hint sont montrés.
function masterState(g, src, convById, superseded) {
  if (!g.masterSessionId) return null;
  // Redirigée comme un membre : après un reload, la conv maîtresse peut avoir
  // repris sous un nouvel id — la ligne de tête doit pointer le successeur.
  const sid = resolveConvId(g.masterSessionId, superseded || {});
  const conv = convById.get(sid) || null;
  const t = memberTruth({ sessionId: sid, launchedAt: 1 }, src);
  return {
    convId: sid,
    // Titre vivant tant que la conv est dans la fenêtre du panneau, titre
    // persisté ensuite : une ligne qui deviendrait un uuid nu quand la conv
    // vieillit hors de la vue ne servirait plus à rien.
    title: (conv && conv.title) || g.masterTitle || vscode.l10n.t('Master conversation'),
    listed: !!conv,
    tabTitle: (conv && conv.tabTitle) || null,
    hint: t.hint ? vscode.l10n.t(t.hint) : t.hint,
  };
}

// Étage 2 du rattachement (attach.js) : pour les membres qu'aucun fichier de
// session n'a su nommer, on cherche notre prompt en PREMIER message user d'un
// transcript non encore rattaché. Ne tourne que s'il reste des membres en
// attente, et pas plus d'une fois toutes les ATTACH_RETRY_MS — on lit la tête
// des transcripts candidats, ce n'est pas gratuit.
const firstUserCache = new Map();          // `${transcript}:${mtime}` → texte|null

function attachPendingMembers() {
  if (!groupStore || !stateEngine) return false;
  const pending = groupStore.pending();
  if (!pending.length) return false;
  const now = Date.now();
  if (now - lastAttachTry < ATTACH_RETRY_MS) return false;
  lastAttachTry = now;

  const taken = groupStore.attachedIds();
  const candidates = [];
  for (const c of stateEngine.getSnapshot().conversations) {
    if (!c.transcript || taken.has(c.sessionId)) continue;
    const key = `${c.transcript}:${c.mtime || 0}`;
    let text;
    if (firstUserCache.has(key)) text = firstUserCache.get(key);
    else {
      try { text = firstUserText(c.transcript); } catch { text = null; }
      firstUserCache.set(key, text);
      if (firstUserCache.size > 200) firstUserCache.clear();
    }
    if (text) candidates.push({ sessionId: c.sessionId, firstUser: text, mtime: c.mtime || 0 });
  }

  let changed = false;
  for (const p of matchPending(pending, candidates)) {
    if (!groupStore.attach(p.groupId, p.key, p.sessionId)) continue;
    changed = true;
    const g = groupStore.get(p.groupId);
    const m = g && g.members.find((x) => x.key === p.key);
    if (m) intentStore.record(p.sessionId, { model: m.model, effort: m.effort });
    console.log('[QuotaBar] group member %s/%s linked to session %s by prompt prefix (stage 2)', p.groupId, p.key, p.sessionId);
  }
  return changed;
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
  if (fh && fh.utilization != null) windows.push(mkWindow(vscode.l10n.t('5h window'), fh.utilization, fh.resets_at, FIVE_HOUR_MS, burnRate));
  const sd = cached.data.seven_day;
  if (sd && sd.utilization != null) windows.push(mkWindow(vscode.l10n.t('7d window'), sd.utilization, sd.resets_at, SEVEN_DAY_MS, burnRate));
  // Barres hebdo scopées par modèle (ex. Fable 50 % de l'hebdo jusqu'au
  // 19/07) : AUCUNE référence en dur à un modèle ni une date — toute entrée
  // limits[] avec group:"weekly" et un scope produit sa barre, et disparaît
  // d'elle-même quand l'API cesse de l'envoyer.
  const limits = Array.isArray(cached.data.limits) ? cached.data.limits : [];
  for (const l of limits) {
    if (l.group !== 'weekly' || !l.scope || !l.scope.model) continue;
    const name = l.scope.model.display_name || vscode.l10n.t('scoped');
    windows.push(mkWindow(vscode.l10n.t('{0} (7d)', name), l.percent, l.resets_at, SEVEN_DAY_MS, burnRate));
  }
  return { windows, burnRate, ageMin: Math.round((Date.now() - cached.timestamp) / 60000), source: lastSource };
}

function buildPanelState() {
  const cfg = getConfig();
  // Une seule lecture de la redirection husk→successeur pour tout ce push, lue
  // du MÊME snapshot que les conversations (cf. supersede.js).
  const superseded = currentSuperseded();
  const convs = conversationsState();
  // Une seule résolution de vérité par push (lot 10) : le bandeau de batch et
  // les groupes lisent le MÊME registre de sessions et le MÊME sessions-state,
  // dans le même instant — deux lectures ne pourraient que se contredire.
  const convById = new Map(convs.map((c) => [c.id, c]));
  const sources = memberSources((id) => convById.get(id));
  return {
    conversations: convs,
    quota: quotaState(),
    sounds: { enabled: cfg.soundsEnabled },
    ui: {
      collapsedConversations: cfg.collapsedConversations,
      collapsedQuota: cfg.collapsedQuota,
      sortOrder: cfg.sortOrder,
      collapsedNewConversation: !!(workspaceStateRef && workspaceStateRef.get(NEW_CONV_COLLAPSED_KEY, false)),
    },
    // Lot 13 §1 : indicateur discret, jamais de popup — voir checkTabCanary().
    canary: canaryActive,
    // Formulaire de création groupée (lot 1). `notice` est recalculé à CHAQUE
    // push (lot 6, correctif §3) plutôt que figé au moment du « Create » : sans
    // ça, le message restait affiché après que tous les onglets aient été
    // envoyés, fermés ou rouverts.
    batch: {
      envConflict: envConflictVars(),
      busy: batchStatus.busy,
      notice: batchStatus.busy ? batchStatus.notice : composeBatchNotice(convs, sources),
      // Lot 12 §3, pré-sélection au lot 14 : relu à CHAQUE push, jamais mis en
      // cache — /effort dans n'importe quelle conversation fait dériver ce
      // défaut global (NOTES). { model: null, effort: null } si le fichier est
      // illisible/absent ou le champ manquant : le webview n'allume alors
      // aucun bouton et désactive Create (jamais une valeur inventée).
      inherit: readInheritSettings(),
      // Dernier choix explicite du formulaire, par workspace (plan sélecteurs
      // 2026-07-24) — prime sur `inherit` côté webview ; `null` tant que rien
      // n'a jamais été cliqué (repli sur `inherit`, premier usage seulement).
      lastModel: (workspaceStateRef && workspaceStateRef.get(LAST_BATCH_MODEL_KEY, null)) || null,
      lastEffort: (workspaceStateRef && workspaceStateRef.get(LAST_BATCH_EFFORT_KEY, null)) || null,
      // Astuce écartée ? (globalState, par machine) — le webview montre alors
      // seulement le « ? » de restauration sur le label.
      tipDismissed: !!(globalStateRef && globalStateRef.get(BATCH_TIP_DISMISSED_KEY, false)),
    },
    // Groupes persistés (lot 2), vagues résolues (lot 4).
    groups: groupsState(convs, sources, superseded),
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
    vscode.window.showErrorMessage(vscode.l10n.t('Claude Convs: install.ps1 not found in the extension folder.'));
    return;
  }

  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t('This will deploy Claude Code hooks so the panel can show live conversation state (busy/waiting/done) instead of idle only. It writes to:\n') +
    vscode.l10n.t('• ~/.claude/scripts/ (copies the hook scripts)\n') +
    vscode.l10n.t('• ~/.claude/settings.json (adds a statusLine entry and UserPromptSubmit/Stop/Notification/SessionEnd hooks — a timestamped backup is made first, and only missing entries are added)\n\n') +
    vscode.l10n.t('Continue?'),
    { modal: true },
    vscode.l10n.t('Install hooks')
  );
  if (choice !== vscode.l10n.t('Install hooks')) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Claude Convs: installing hooks…') },
    () => new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { windowsHide: true, timeout: 30000 },
        (err, stdout, stderr) => {
          if (err) {
            vscode.window.showErrorMessage(vscode.l10n.t('Claude Convs: hook installation failed — {0}', (stderr || err.message || '').trim().slice(0, 500)));
          } else {
            vscode.window.showInformationMessage(vscode.l10n.t('Claude Convs: hooks installed. Reload the window for the panel to pick up live conversation state.'), vscode.l10n.t('Reload Window'))
              .then((pick) => { if (pick === vscode.l10n.t('Reload Window')) vscode.commands.executeCommand('workbench.action.reloadWindow'); });
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
async function toggleSounds(context) {
  const cfg = vscode.workspace.getConfiguration('claudeCodeQuotaBar');
  const current = cfg.get('sounds.enabled', false);
  const next = !current;
  try { await cfg.update('sounds.enabled', next, vscode.ConfigurationTarget.Global); } catch {}
  // Seulement au moment où ça s'ALLUME : pas d'intérêt à avertir en éteignant.
  if (next && context) maybeWarnNoHooksForSounds(context);
}

// Clic sur l'en-tête d'une section (lot repli/tri) : bascule son setting.
// onDidChangeConfiguration (activate()) repousse l'état à toutes les fenêtres,
// même pattern que toggleSounds.
async function toggleCollapse(section) {
  // Section « New conversation » (lot 12) : workspaceState, pas un setting —
  // pas de onDidChangeConfiguration pour la repousser aux autres fenêtres,
  // donc un push manuel juste après (même filet que createBatch/groupStore).
  if (section === 'newConversation') {
    if (!workspaceStateRef) return;
    const current = !!workspaceStateRef.get(NEW_CONV_COLLAPSED_KEY, false);
    try { await workspaceStateRef.update(NEW_CONV_COLLAPSED_KEY, !current); } catch {}
    pushPanelState();
    return;
  }
  const key = section === 'conversations' ? 'collapsedConversations'
    : section === 'quota' ? 'collapsedQuota' : null;
  if (!key) return;
  const cfg = vscode.workspace.getConfiguration('claudeCodeQuotaBar');
  const current = cfg.get(key, false);
  try { await cfg.update(key, !current, vscode.ConfigurationTarget.Global); } catch {}
}

// Astuce du champ paste : écartée/restaurée, persisté par machine (globalState).
// Push manuel comme la section « New conversation » — le globalState n'a pas
// d'événement de propagation type onDidChangeConfiguration.
async function setBatchTipDismissed(dismissed) {
  if (!globalStateRef) return;
  try { await globalStateRef.update(BATCH_TIP_DISMISSED_KEY, !!dismissed); } catch {}
  pushPanelState();
}

// Dernier choix explicite modèle/effort du formulaire (plan sélecteurs
// 2026-07-24) — écrit à CHAQUE clic sur un bouton segmenté, pas seulement au
// Create : le défaut d'une tâche vierge doit refléter le dernier geste même
// sans lancement. `field`/`value` reviennent d'un webview qui n'a pas require
// (copie locale de MODELS/EFFORTS) : on revalide contre la liste canonique de
// batch.js avant d'écrire, jamais une valeur exotique en workspaceState.
async function setLastBatchChoice(field, value) {
  if (!workspaceStateRef) return;
  if (field === 'model') {
    if (!MODELS.includes(value)) return;
    try { await workspaceStateRef.update(LAST_BATCH_MODEL_KEY, value); } catch {}
  } else if (field === 'effort') {
    if (!EFFORTS.includes(value)) return;
    try { await workspaceStateRef.update(LAST_BATCH_EFFORT_KEY, value); } catch {}
  } else {
    return;
  }
  pushPanelState();
}

// Lot 2 (avenant 2026-07-24) : pure, testable sans mock vscode — calcule ce
// qu'un Create réussi doit mémoriser depuis la DERNIÈRE tâche du batch entier
// (toutes vagues, pas seulement la vague 1 lancée à la création). Invariant
// haiku conservé : `effort` reste `null` (rien à persister) quand la dernière
// tâche est haiku, même si `task.effort` porte une valeur héritée.
function computeLastChoiceFromTasks(tasks) {
  const last = tasks[tasks.length - 1];
  return {
    model: last.model,
    effort: last.model !== 'haiku' && EFFORTS.includes(last.effort) ? last.effort : null,
  };
}

// « Create » du formulaire de lot (lot 1, exécution des vagues au lot 4). Le
// webview n'envoie que des intentions : c'est ici qu'on valide (normalizeTasks
// — le webview n'est pas une source fiable), qu'on lance, et qu'on enregistre
// ce qui a été demandé.
//
// SEULE LA VAGUE 1 PART À LA CRÉATION (décision 5 du plan) : les vagues
// suivantes naissent `queued` dans le groupe (groups.js memberOfTask) et
// s'ouvrent au fil des `done` (maybeAdvanceWaves, auto) ou du bouton ▶
// (launchWaveForGroup, manuel).
async function createBatch(msg) {
  if (!batchLauncher || batchStatus.busy) return;
  // Filet défensif (lot 14) : le formulaire a déjà résolu chaque tâche, mais
  // une tâche mal formée (msg trafiqué, ancien webview en cache) retombe ici
  // sur le défaut résolu plutôt que sur une valeur inventée.
  const tasks = normalizeTasks(msg && msg.tasks, readInheritSettings());
  if (!tasks.length) return;

  const waveCount = new Set(tasks.map((t) => t.wave)).size;
  const wave1 = tasks.filter((t) => t.wave === 1);
  batchStatus = { busy: true, notice: vscode.l10n.t('Opening {0} conversation(s)…', wave1.length) };

  // LE FORMULAIRE EST LE GROUPE (décision 3 du plan) — sauf pour une tâche
  // unique : un groupe d'un seul membre n'apporte que du chrome, et le parcours
  // utilisateur du plan le dit explicitement (« une seule tâche = pas de groupe
  // créé, juste une conv »).
  //
  // Le groupe est créé AVANT le lancement, avec TOUTES les tâches (vagues à
  // venir comprises) : les ouvertures sont sérialisées et prennent une seconde
  // chacune, l'utilisateur doit voir tout de suite ce qu'il vient de demander.
  // Ses membres de la vague 1 naissent sans sessionId (« pas encore lancé »)
  // et se rattachent au fil des étages 1 puis 2 ; ceux des vagues suivantes
  // naissent `queued` (groups.js) tant que leur vague n'est pas ouverte.
  const group = tasks.length > 1 && groupStore
    ? groupStore.create(msg && msg.groupName, tasks, msg && msg.advance)
    : null;
  // Conversation maîtresse (lot 11) : cherchée ICI, à la naissance du groupe —
  // c'est le seul instant où elle a un sens (un groupe pour la porter, un
  // collage tout frais pour la désigner). Le webview ne transmet le texte collé
  // QUE lorsqu'il a reconnu un bloc claude-convs valide (plan : « au collage
  // d'un bloc VALIDE ») ; sans lui, aucune recherche n'a lieu.
  const master = group ? resolveMasterForGroup(group.id, msg && msg.paste, msg && msg.session) : null;
  pushPanelState();

  let result = null;
  try {
    result = await batchLauncher.launch(wave1);
  } catch (e) {
    batchLastLaunch = null;
    batchStatus = { busy: false, notice: vscode.l10n.t('Batch failed: {0}', (e && e.message) || vscode.l10n.t('unknown error')) };
    pushPanelState();
    return;
  }

  // Lot 2 (avenant 2026-07-24) : un Create réussi — bloc collé compris — compte
  // comme choix explicite.
  const lastChoice = computeLastChoiceFromTasks(tasks);
  setLastBatchChoice('model', lastChoice.model);
  if (lastChoice.effort) setLastBatchChoice('effort', lastChoice.effort);

  for (let i = 0; i < result.launched.length; i++) {
    const r = result.launched[i];
    if (!r.sessionId) continue;
    intentStore.record(r.sessionId, { model: r.task.model, effort: r.task.effort });
    // Étage 1 : launcher.js rend ses résultats dans l'ordre des tâches de la
    // vague 1, qui sont aussi les premiers membres du groupe (normalizeTasks
    // trie par vague — la vague 1 est toujours en tête).
    if (group) groupStore.attachByIndex(group.id, i, r.sessionId);
  }

  const unlinked = result.launched.filter((r) => !r.sessionId).length;
  // Partie FIXE du message (ce qui ne dépend d'aucun état vivant) : nom de
  // groupe, annonce de vague, non-identifiés, repli — la partie « N/M ouverts,
  // Entrée dans chaque onglet » est recalculée à chaque push par
  // composeBatchNotice(), cf. déclaration de batchLastLaunch.
  let staticSuffix = '';
  if (group) staticSuffix += vscode.l10n.t(' Grouped as “{0}”.', group.name);
  if (master) {
    staticSuffix += master.title
      ? vscode.l10n.t(' Master conversation: “{0}”.', master.title)
      : vscode.l10n.t(' Master conversation linked.');
  }
  if (waveCount > 1) {
    staticSuffix += vscode.l10n.t(' Wave 1 of {0} opened — the rest will follow (auto) or wait for ▶ (manual).', waveCount);
  }
  // Depuis le lot 2, « pas de fichier de session » n'est plus un cul-de-sac :
  // l'étage 2 réessaie par le prompt dès que la conversation a démarré, et
  // l'étage 3 (« Link… ») reste disponible dans le groupe.
  if (unlinked) {
    staticSuffix += group
      ? vscode.l10n.t(' {0} not identified yet — they will link themselves once started, or use “Link…” in the group.', unlinked)
      : vscode.l10n.t(' {0} could not be identified (no session file) — model/effort mismatch badge unavailable for those.', unlinked);
  }
  if (result.fallbackAt != null) staticSuffix += vscode.l10n.t(' Stopped at task {0} — see the message above.', result.fallbackAt + 1);
  // Hint discret (lot 7, livrable 3) : la limite cosmétique du menu officiel
  // (son sélecteur d'effort se cale sur le modèle par défaut PERSISTÉ tant que
  // le premier tour n'a pas tourné, cf. README « Known limitations »). Lot 14 :
  // un modèle sélectionné est TOUJOURS explicite désormais — ANTHROPIC_MODEL
  // est posée à CHAQUE lancement (plus de cas « lot 100% inherit » où rien
  // n'aurait été posé) — donc le hint s'affiche systématiquement.
  staticSuffix += vscode.l10n.t(' (The official menu may briefly show the wrong model/effort until the first turn — this panel’s model · effort badges are the real state.)');

  batchLastLaunch = {
    total: result.total,
    trackedSessionIds: result.launched.filter((r) => r.sessionId).map((r) => r.sessionId),
    staticSuffix,
  };
  batchStatus = { busy: false, notice: composeBatchNotice(conversationsState()) };
  pushPanelState();
}

// Recalcule la partie vivante du message de « Create » : combien de membres du
// dernier lot restent « insérés » (onglet ouvert, rien envoyé — le process CLI
// tourne mais aucun hook n'a encore écrit d'entrée dans le snapshot), combien
// ont été envoyés (une entrée existe désormais), combien ont fermé leur onglet
// SANS avoir rien envoyé (le process a disparu du registre des sessions
// vivantes sans jamais avoir laissé de trace dans le snapshot). Rend `null`
// quand il n'y a plus rien à signaler — le bandeau disparaît alors du panneau
// (cf. panel.js renderBatch).
//
// Fonction PURE (`launch`/`convs`/`aliveIds`/`hasTranscript` injectés, aucun
// état de module) : testable directement, sans mock VS Code — cf.
// test/test-batch-notice.js. `fallback` = ce qui s'affiche quand il n'y a rien
// à recalculer (batch jamais lancé, ou 100% en repli presse-papier).
//
// `hasTranscript(sessionId)` (lot 9) : « a envoyé » est un fait IRRÉVERSIBLE —
// une session dont le transcript `~/.claude/projects/<ws>/<sessionId>.jsonl`
// existe (il naît au premier envoi, jamais avant) n'est JAMAIS reclassée
// « closed before sending », qu'elle soit encore dans `convs` (la VUE, volatile
// — aged-out du snapshot, capped par maxItems) ou non. Sans ce prédicat
// (paramètre omis, comme les bancs existants), le comportement d'avant ce lot
// est inchangé — dégradation silencieuse.
// Sources de la table de vérité (member-truth.js), assemblées UNE fois par
// recompute et partagées par ses trois consommateurs — rendu des groupes,
// moteur de vagues, bandeau de batch. Deux lectures disque au plus (registre
// des sessions, sessions-state.json), toutes deux PARESSEUSES : un panneau sans
// groupe ni lot en cours ne lit rien du tout. Et surtout : une seule et même
// réponse à « où en est ce membre ? », quel que soit l'affichage qui la pose.
//
// `getConv` vient de l'appelant : la vue n'a pas la même forme selon qu'on
// parte du snapshot de state.js (`sessionId`) ou de conversationsState()
// (`id`) — memberTruth n'y lit de toute façon que `state` et `tabOpen`.
function memberSources(getConv) {
  let live = null;
  let hooks = null;
  let dir;
  return {
    getConv: typeof getConv === 'function' ? getConv : () => null,
    isLive(id) {
      if (!live) { try { live = liveSessionIds(); } catch { live = new Set(); } }
      return live.has(id);
    },
    // « A envoyé » est un fait durable (lot 9) : le transcript naît au premier
    // envoi et ne disparaît plus.
    hasTranscript(id) {
      if (dir === undefined) dir = workspacePath ? projectDirFor(workspacePath) : null;
      if (!dir) return false;
      try { return fs.existsSync(path.join(dir, id + '.jsonl')); } catch { return false; }
    },
    // État posé par les hooks — il survit à la sortie de la vue, ce qui
    // distingue une conversation terminée dont on a fermé l'onglet (`done`)
    // d'une conversation vraiment interrompue.
    hookState(id) {
      if (!hooks) { try { hooks = readSessionsState() || {}; } catch { hooks = {}; } }
      const e = hooks[id];
      return (e && e.state) || null;
    },
  };
}

function computeBatchNoticeFromLaunch(launch, convs, aliveIds, fallback, hasTranscript) {
  if (!launch) return fallback;
  const { total, trackedSessionIds, staticSuffix } = launch;
  // Aucun membre rattaché à suivre (tout non identifié dès le départ, ou lot
  // 100% en repli presse-papier) : rien à recalculer, le texte d'origine reste
  // affiché tel quel — dégradation silencieuse, pas de régression.
  if (!trackedSessionIds.length) return fallback;

  // `sessionId` (snapshot de state.js) OU `id` (conversationsState, ce que
  // reçoit réellement buildPanelState) : indexer sur le seul `sessionId`
  // fabriquait une Map à clé `undefined` — la vue ne comptait donc jamais, et
  // seul le transcript du lot 9 sauvait le calcul.
  const byId = new Map((convs || []).map((c) => [c.sessionId || c.id, c]));
  // `aliveIds` accepte un Set (appel historique, bancs) ou un prédicat — les
  // sources partagées de memberSources() exposent une fonction.
  const isLive = aliveIds && typeof aliveIds.has === 'function'
    ? (id) => aliveIds.has(id)
    : (typeof aliveIds === 'function' ? aliveIds : () => false);
  const sources = {
    isLive,
    hasTranscript: typeof hasTranscript === 'function' ? hasTranscript : () => false,
    getConv: (id) => byId.get(id),
  };

  // Classement par la table de vérité (lot 10), plus par une chaîne de `if`
  // locale : « en attente d'Entrée » = statut `inserted`, « fermé sans rien
  // envoyer » = `unsent-closed`, tout le reste a envoyé. Les trois autres
  // consommateurs répondent exactement pareil.
  let sent = 0, pending = 0, closed = 0;
  for (const id of trackedSessionIds) {
    const t = memberTruth({ sessionId: id, launchedAt: 1 }, sources);
    if (t.status === 'inserted') pending++;
    else if (t.status === 'unsent-closed') closed++;
    else sent++;
  }

  if (pending === 0) {
    // Plus aucun membre « inserted » : tout est parti, ou ce qui reste a fermé
    // sans jamais avoir été envoyé — le message change de nature (décision du
    // plan) plutôt que de continuer à réclamer un Entrée qui ne viendra plus.
    if (!closed) return null;
    return closed > 1
      ? vscode.l10n.t('{0} tabs closed before sending — reopen them and press Enter to link them to a conversation.', closed)
      : vscode.l10n.t('{0} tab closed before sending — reopen it and press Enter to link it to a conversation.', closed);
  }

  let notice = vscode.l10n.t('{0}/{1} conversation(s) opened — press Enter in each tab.', sent, total);
  if (closed) {
    notice += closed > 1
      ? vscode.l10n.t(' {0} tabs closed before sending.', closed)
      : vscode.l10n.t(' {0} tab closed before sending.', closed);
  }
  return notice + staticSuffix;
}

// `sources` = celles du recompute en cours (buildPanelState) quand il y en a —
// sinon on en fabrique : ce chemin sert aussi juste après un « Create », hors
// de tout push.
function composeBatchNotice(convs, sources) {
  const s = sources || memberSources();
  return computeBatchNoticeFromLaunch(
    batchLastLaunch,
    convs,
    (id) => s.isLive(id),
    batchStatus.notice,
    (id) => s.hasTranscript(id)
  );
}

// ── Moteur de vagues (lot 4), statuts résolus par la table de vérité (lot 10) ─
//
// Jusqu'au lot 10, un membre dont la conversation n'apparaissait plus dans la
// LISTE du panneau était déclaré `stale` — donc au Create, où rien n'a encore
// de transcript et où RIEN n'est listé, toute la vague 1 naissait « interrompue »
// (bandeau rouge, auto suspendu). Le statut vient désormais de member-truth.js,
// qui interroge d'abord la VIVACITÉ (registre des sessions) : onglet ouvert +
// rien d'envoyé = `inserted`, pas `stale`.

// Ouvre la vague `waveNumber` d'un groupe : filtre les membres pas encore
// lancés (défense contre un double appel — auto + clic manuel simultanés),
// les marque `launched` AVANT l'attente réseau/CLI (pour que markLaunched
// serve de verrou synchrone), puis lance et rattache comme launchBatch.
async function launchWaveForGroup(id, waveNumber, opts = {}) {
  if (!groupStore || !batchLauncher || !Number.isFinite(waveNumber)) return;
  const g = groupStore.get(id);
  if (!g) return;
  const members = groupStore.membersOfWave(id, waveNumber).filter((m) => m.launchedAt == null);
  if (!members.length) return;

  const at = Date.now();
  for (const m of members) groupStore.markLaunched(id, m.key, at);
  waveNotices.delete(id);
  pushPanelState();

  const tasks = members.map((m) => ({ prompt: m.prompt, model: m.model, effort: m.effort, wave: waveNumber }));
  let result;
  try {
    result = await batchLauncher.launch(tasks);
  } catch (e) {
    waveNotices.set(id, vscode.l10n.t('Wave {0}: could not open — {1}.', waveNumber, (e && e.message) || vscode.l10n.t('unknown error')));
    pushPanelState();
    return;
  }

  for (let i = 0; i < result.launched.length; i++) {
    const r = result.launched[i];
    if (!r.sessionId) continue;
    intentStore.record(r.sessionId, { model: r.task.model, effort: r.task.effort });
    groupStore.attach(id, members[i].key, r.sessionId);
  }

  pushPanelState();
}

// Le webview n'envoie `force: true` que pour le bouton atténué (mode auto,
// vague pas encore bloquée) — chemin bloqué et mode manuel n'envoient jamais
// `force`, donc jamais de modale ici.
async function handleLaunchWave(msg) {
  const waveNumber = Number(msg && msg.wave);
  if (msg && msg.force) {
    const forceLabel = vscode.l10n.t('Force');
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t('Auto mode will open wave {0} by itself once the current wave finishes. Force it now?', waveNumber),
      { modal: true },
      forceLabel
    );
    if (choice !== forceLabel) return;
  }
  await launchWaveForGroup(msg && msg.id, waveNumber, { auto: false });
}

// Appelé à chaque recompute de state.js (transitions busy→done incluses) :
// pour chaque groupe en mode auto dont la vague courante vient de se
// terminer ENTIÈREMENT, ouvre la suivante. `waveToAutoLaunch` (waves.js)
// garantit structurellement de ne jamais sauter plus d'une vague d'avance.
function maybeAdvanceWaves() {
  if (!groupStore || !stateEngine) return;
  const snap = stateEngine.getSnapshot();
  const convs = snap.conversations;
  const superseded = snap.supersededBy || {};
  const byId = new Map(convs.map((c) => [c.sessionId, c]));
  const sources = memberSources((id) => byId.get(id));
  for (const g of groupStore.all()) {
    // Membres redirigés (husk→successeur) : une vague ne se déclare pas
    // « terminée » sur un husk mort alors que la conv a repris et travaille.
    const members = g.members.map((m) => ({ wave: m.wave, status: memberTruth(redirectMember(m, superseded), sources).waveStatus }));
    const w = waveToAutoLaunch(members, g.autoAdvance);
    if (w == null) continue;
    launchWaveForGroup(g.id, w, { auto: true, fromWave: launchedWave(members) });
  }
}

function toggleGroupAdvance(id) {
  const g = groupStore && groupStore.get(id);
  if (!g) return;
  if (groupStore.setAutoAdvance(id, !g.autoAdvance)) pushPanelState();
}

function moveMemberWave(id, key, delta) {
  if (!groupStore || (delta !== 1 && delta !== -1)) return;
  if (groupStore.moveQueuedMember(id, key, delta)) pushPanelState();
}

// ── Actions de groupe (lot 2) ───────────────────────────────────────────────
// Aucune n'agit sur une conversation : un groupe n'est QUE des métadonnées.
// Dissoudre, retirer un membre, délier — rien de tout cela ne ferme un onglet
// ni n'interrompt un travail en cours (seul le badge ⨯, explicite, ferme un
// onglet, et seulement quand la conversation est terminée).

async function renameGroup(id) {
  const g = groupStore && groupStore.get(id);
  if (!g) return;
  const name = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('Rename this conversation group'),
    value: g.name,
    validateInput: (v) => (v && v.trim() ? null : vscode.l10n.t('The name cannot be empty')),
  });
  if (!name) return;
  if (groupStore.rename(id, name)) pushPanelState();
}

async function dissolveGroup(id) {
  const g = groupStore && groupStore.get(id);
  if (!g) return;
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t('Dissolve “{0}”?\n\nThe {1} conversation(s) stay exactly as they are — open tabs are not closed and nothing is interrupted. Only the grouping disappears.', g.name, g.members.length),
    { modal: true },
    vscode.l10n.t('Dissolve')
  );
  if (choice !== vscode.l10n.t('Dissolve')) return;
  if (groupStore.dissolve(id)) pushPanelState();
}

function toggleGroupCollapse(id) {
  const g = groupStore && groupStore.get(id);
  if (!g) return;
  if (groupStore.setCollapsed(id, !g.collapsed)) pushPanelState();
}

function removeMember(id, key) {
  if (!groupStore) return;
  if (groupStore.removeMember(id, key)) pushPanelState();
}

// Ajout d'une tâche EN FILE à un groupe existant (plan ajout-tache
// 2026-07-24) — le « + » d'une vague en file ou sa ligne fantôme « nouvelle
// vague » du panneau. Filet défensif (même invariant que createBatch) : le
// webview n'est pas fiable, normalizeTasks résout modèle/effort au défaut si
// besoin — sa renumérotation de vague (pensée pour un batch complet) ne sert
// pas ici, la vague CIBLÉE vient de `msg.wave` (ou `null` = nouvelle vague,
// calculée par groupStore.addTask). Aucun lancement : le membre naît
// `queued`, cas déjà normal du moteur (waveToAutoLaunch/launchWaveForGroup
// l'ouvriront à son tour).
function addTaskToGroup(msg) {
  if (!groupStore) return;
  const id = msg && msg.id;
  if (!groupStore.get(id)) return;
  const kept = normalizeTasks([msg && msg.task], readInheritSettings());
  if (!kept.length) return;
  const wave = msg && msg.wave != null ? Number(msg.wave) : null;
  if (wave != null && !Number.isInteger(wave)) return;
  if (!groupStore.addTask(id, kept[0], wave)) return;
  // Même raison que linkMember (rattachement manuel) : une vague déjà `done`
  // en entier ne se relance JAMAIS toute seule sans ce recompute — sans lui,
  // la tâche ajoutée à un groupe auto terminé reste `queued` pour toujours.
  maybeAdvanceWaves();
  pushPanelState();
}

// Croix rouge = seule action de sortie d'un membre, UNIFORME (lot 5, décision
// user ~15h) : ferme l'onglet PUIS retire, dans tous les cas de figure — un
// onglet déjà fermé ou une tâche jamais lancée n'ont rien à fermer, seul le
// retrait s'exécute. `removeMember` s'exécute même si la fermeture échoue
// (Escape géré par closeConversationTab lui-même — jamais de throw qui
// bloquerait le retrait). Seul garde-fou : conversation encore EN COURS DE
// TRAVAIL (busy/waiting) → confirmation modale native avant d'agir (protège
// du clic accidentel sans rompre l'uniformité de l'action).
async function closeAndRemoveMember(msg) {
  if (isMemberBusy(msg && msg.id, msg && msg.key)) {
    const closeLabel = vscode.l10n.t('Close & remove');
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t('This conversation is still working — close its tab and remove it from the group?'),
      { modal: true },
      closeLabel
    );
    if (choice !== closeLabel) return;
  }
  try { await closeConversationTab(msg); } catch (e) { console.log('[QuotaBar] closeAndRemoveMember: close failed: %s', e && e.message); }
  removeMember(msg && msg.id, msg && msg.key);
}

// Verdict busy/waiting d'un membre, résolu sur la conversation VIVANTE (redirection
// husk→successeur incluse, même logique que groupsState/maybeAdvanceWaves) — la
// seule condition qui déclenche la confirmation ci-dessus.
function isMemberBusy(id, key) {
  if (!groupStore || !stateEngine) return false;
  const g = groupStore.get(id);
  const m = g && g.members.find((x) => x.key === key);
  if (!m || !m.sessionId) return false;
  const sid = resolveConvId(m.sessionId, currentSuperseded());
  const conv = stateEngine.getSnapshot().conversations.find((c) => c.sessionId === sid);
  return !!conv && (conv.state === 'busy' || conv.state === 'waiting');
}

// Conversations du panneau qui n'appartiennent à aucun groupe — la matière des
// deux actions manuelles (étage 3 du rattachement, et « ajouter un membre »).
// « Revendiquée » inclut les conversations maîtresses (lot 11) : une maîtresse
// n'est pas disponible pour être rattachée comme membre.
function ungroupedConversations() {
  if (!stateEngine || !groupStore) return [];
  const taken = groupStore.claimedIds();
  return stateEngine.getSnapshot().conversations.filter((c) => !taken.has(c.sessionId));
}

async function pickConversation(placeHolder, convs = ungroupedConversations()) {
  if (!convs.length) {
    vscode.window.showInformationMessage(vscode.l10n.t('Claude Convs: no ungrouped conversation to pick from.'));
    return null;
  }
  const pick = await vscode.window.showQuickPick(
    convs.map((c) => ({
      label: c.title || vscode.l10n.t('Untitled'),
      description: [c.model, c.effort].filter(Boolean).join(' · '),
      detail: c.state,
      id: c.sessionId,
    })),
    { placeHolder, matchOnDescription: true }
  );
  return pick ? pick.id : null;
}

// Étage 3 du rattachement : ni le registre des sessions (étage 1) ni le préfixe
// de prompt (étage 2) n'ont su nommer ce membre — l'utilisateur tranche
// lui-même. C'est le SEUL chemin qui reste : on ne devine jamais.
async function linkMember(id, key) {
  const g = groupStore && groupStore.get(id);
  const m = g && g.members.find((x) => x.key === key);
  if (!m) return;
  const sessionId = await pickConversation(vscode.l10n.t('Link this task to an existing conversation'));
  if (!sessionId) return;
  if (!groupStore.attach(id, key, sessionId)) return;
  intentStore.record(sessionId, { model: m.model, effort: m.effort });
  // Rattachement manuel (étage 3) : la conversation choisie peut déjà être
  // `done` — c'est peut-être exactement ce qui manquait pour compléter la
  // vague courante (lot 4).
  maybeAdvanceWaves();
  pushPanelState();
}

async function addToGroup(id) {
  if (!(groupStore && groupStore.get(id))) return;
  const sessionId = await pickConversation(vscode.l10n.t('Add a conversation to this group'));
  if (!sessionId) return;
  const conv = stateEngine.getSnapshot().conversations.find((c) => c.sessionId === sessionId);
  if (groupStore.addExisting(id, sessionId, (conv && conv.title) || '')) pushPanelState();
}

// ── Conversation maîtresse (lot 11) ─────────────────────────────────────────
// Étage 2 : édition manuelle. Couvre tout ce que la recherche automatique ne
// peut pas conclure — bloc écrit à la main, collage non retrouvé (l'utilisateur
// a édité le bloc), changement d'avis. Contrairement au lien d'un membre, la
// liste proposée n'exclut PAS les conversations déjà groupées ailleurs : la
// conv qui propose des handoffs est très souvent elle-même le membre d'un lot
// précédent. Seuls les membres de CE groupe sont hors-jeu.
async function setGroupMaster(id) {
  const g = groupStore && groupStore.get(id);
  if (!g || !stateEngine) return;
  const mine = new Set(g.members.map((m) => m.sessionId).filter(Boolean));
  const convs = stateEngine.getSnapshot().conversations.filter((c) => !mine.has(c.sessionId));
  const items = convs.map((c) => ({
    label: c.title || vscode.l10n.t('Untitled'),
    description: [c.model, c.effort].filter(Boolean).join(' · '),
    detail: c.state,
    id: c.sessionId,
  }));
  // Étage unique de dissociation (lot allègement 2026-07-24) : la ligne
  // d'en-tête dédiée qui portait l'action « Unset » a disparu, ce QuickPick
  // (déjà le point d'entrée pour poser/changer la maîtresse) devient aussi
  // celui pour l'oublier.
  if (g.masterSessionId) {
    items.unshift({ label: vscode.l10n.t('Unlink (forget where this batch came from)'), id: null, unlink: true });
  }
  if (!items.length) {
    vscode.window.showInformationMessage(vscode.l10n.t('Claude Convs: no ungrouped conversation to pick from.'));
    return;
  }
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: vscode.l10n.t('Set the conversation this batch came from'),
    matchOnDescription: true,
  });
  if (!pick) return;
  if (pick.unlink) {
    if (groupStore.unsetMaster(id)) pushPanelState();
    return;
  }
  const conv = convs.find((c) => c.sessionId === pick.id);
  if (groupStore.setMaster(id, pick.id, (conv && conv.title) || '')) pushPanelState();
}


// Recherche PONCTUELLE de la conv d'où vient le bloc collé (lot 11, étages 0
// et 1). Appelée UNE fois, au « Create » qui suit le collage — jamais en tâche
// de fond, jamais rejouée : le cadrage a explicitement rejeté toute détection
// permanente dans les transcripts.
//
// Bornée à la fenêtre du panneau (les conversations que state.js liste déjà) et
// à une QUEUE de chaque transcript : le bloc de handoffs est, par construction,
// dans les derniers tours de la conversation qui vient de le produire. Un
// transcript de plusieurs Mo n'est donc jamais lu en entier.
const MASTER_TAIL_BYTES = 256 * 1024;

function masterCandidates() {
  if (!stateEngine) return [];
  const out = [];
  for (const c of stateEngine.getSnapshot().conversations) {
    if (!c.transcript) continue;
    let texts = [];
    try {
      for (const e of parseSlice(readSlice(c.transcript, MASTER_TAIL_BYTES, 'tail'))) {
        if (e.type !== 'assistant' || !e.message) continue;
        const content = e.message.content;
        if (typeof content === 'string') { texts.push(content); continue; }
        if (!Array.isArray(content)) continue;
        for (const b of content) if (b && b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
      }
    } catch { continue; }
    if (texts.length) out.push({ sessionId: c.sessionId, text: texts.join('\n') });
  }
  return out;
}

function resolveMasterForGroup(groupId, paste, token) {
  if (!groupStore || !paste) return null;
  let res;
  try { res = resolveMaster({ pasted: paste, token, candidates: masterCandidates() }); }
  catch { return null; }
  if (!res.sessionId) {
    console.log('[QuotaBar] no master conversation for group %s (%s, %d match(es))', groupId, res.reason, res.matches);
    return null;
  }
  const conv = stateEngine.getSnapshot().conversations.find((c) => c.sessionId === res.sessionId);
  if (!groupStore.setMaster(groupId, res.sessionId, (conv && conv.title) || '')) return null;
  console.log('[QuotaBar] group %s master conversation = %s (via %s)', groupId, res.sessionId, res.via);
  return { sessionId: res.sessionId, title: (conv && conv.title) || '', via: res.via };
}

// Le réglage OFFICIEL `claudeCode.environmentVariables` est appliqué APRÈS
// process.env par l'extension Claude (fonction Lp(), cf. NOTES) : s'il définit
// nos deux variables, tout choix modèle/effort d'ici serait écrasé sans un mot.
// On désactive alors les sélecteurs et on dit pourquoi (garde-fou du plan).
function envConflictVars() {
  try {
    const raw = vscode.workspace.getConfiguration('claudeCode').get('environmentVariables');
    return conflictingEnvVars(raw);
  } catch { return []; }
}

// Choix explicite dans le dropdown du panneau (tabOrder/lastActivity/statusFirst).
async function setSortOrder(order) {
  if (order !== 'tabOrder' && order !== 'lastActivity' && order !== 'statusFirst') return;
  const cfg = vscode.workspace.getConfiguration('claudeCodeQuotaBar');
  try { await cfg.update('conversationSortOrder', order, vscode.ConfigurationTarget.Global); } catch {}
}

// hook-session-state.js est le fichier que install.ps1 déploie pour Stop/
// Notification/SessionEnd (README § Setup) — sa présence est un signal fiable
// que les hooks ont tourné au moins une fois avec succès. Pas besoin de parser
// settings.json : si ce fichier manque, aucune conversation ne peut jamais
// sortir d'`idle`, donc aucun son ne jouera jamais, quoi que dise le setting.
function hooksAppearInstalled() {
  try { return fs.existsSync(HOOKS_MARKER_PATH); } catch { return false; }
}

// Sans hooks, le toggle 🔈 s'allume pour rien : aucune transition busy→done/
// waiting ne se produit jamais (state.js rend tout en `idle`), donc le son ne
// joue jamais — silencieusement, sans que rien ne le dise. Même style de
// garde-fou qu'maybeWarnAccessibilityConflict : un message, une fois par
// machine tant que les hooks manquent, jamais de re-demande une fois accepté
// ou les hooks installés.
async function maybeWarnNoHooksForSounds(context) {
  if (!getConfig().soundsEnabled) return;
  if (hooksAppearInstalled()) return;
  if (context.globalState.get(NO_HOOKS_SOUNDS_PROMPT_DISMISSED_KEY)) return;

  let choice;
  try {
    choice = await vscode.window.showWarningMessage(
      vscode.l10n.t('Notification sounds are on, but the Claude Code hooks aren\'t installed — without them, conversations never leave the "idle" state, so the sound will never actually play. Install the hooks now?'),
      vscode.l10n.t('Install hooks'), vscode.l10n.t('Enable anyway'), vscode.l10n.t('Turn sounds back off')
    );
  } catch { choice = undefined; }

  if (choice === vscode.l10n.t('Install hooks')) {
    await installHooks(context);
  } else if (choice === vscode.l10n.t('Turn sounds back off')) {
    const cfg = vscode.workspace.getConfiguration('claudeCodeQuotaBar');
    try { await cfg.update('sounds.enabled', false, vscode.ConfigurationTarget.Global); } catch {}
    return; // pas de dismissal permanent : rien à mémoriser, le setting est déjà retombé à false.
  }
  try { context.globalState.update(NO_HOOKS_SOUNDS_PROMPT_DISMISSED_KEY, true); } catch {}
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
      vscode.l10n.t('Claude Convs plays its own notification sound. VS Code also has an accessibility sound enabled for chat responses / questions — turn those off to avoid hearing both?'),
      vscode.l10n.t('Turn off VS Code sounds'), vscode.l10n.t('Keep both')
    );
  } catch { choice = undefined; }

  if (choice === vscode.l10n.t('Turn off VS Code sounds')) {
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

// Signature comparable de ce que le tout premier rendu afficherait — juste les
// sessionId du snapshot, triés (peu importe l'ordre d'origine, seul l'ENSEMBLE
// compte pour détecter un flash).
const bootSettler = createBootSettler();
function pushPanelStateSettled() {
  bootSettler.run(
    () => (stateEngine ? stateEngine.getSnapshot().conversations.map((c) => c.sessionId).sort().join(',') : ''),
    () => { if (stateEngine) stateEngine.refresh(); },
    () => pushPanelState()
  );
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
    // Démarre SANS fenêtre : le process et son endpoint CDP vivent, mais aucune
    // fenêtre « Nouvel onglet – Brave » n'apparaît — donc plus de vol de focus
    // (mesuré 2026-07-22 : sans ce flag, la fenêtre Brave capte le foreground
    // ~230 ms à chaque spawn, ce qui coupait l'utilisateur en pleine frappe à
    // chaque question/fin de tour, cf. maybeFetchOnTransition). Storage.getCookies
    // est browser-level et fonctionne sans fenêtre (vérifié : 122 cookies lus).
    '--no-startup-window',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-features=ChromeWhatsNewUI',
    // Filet si --no-startup-window venait à ne pas s'appliquer : la fenêtre
    // éventuelle reste hors écran.
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

module.exports = { activate, deactivate, computeBatchNoticeFromLaunch, computeLastChoiceFromTasks };
