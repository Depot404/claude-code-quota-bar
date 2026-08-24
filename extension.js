const vscode = require('vscode');
const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');
const WebSocket = require('ws');
const { ClaudePanelProvider } = require('./panel');
const { createStateEngine, DEFAULTS: STATE_DEFAULTS, projectDirFor, readSessionsState } = require('./state');
// Installeur des hooks (portage Node de install.ps1, lot onboarding
// 2026-08-19) : pure Node, aucune dépendance à `vscode` — appelé directement
// par installHooks() ci-dessous, plus de process PowerShell enfant.
// installClaudeHooks() jette SettingsParseError (sous-classe d'Error) quand
// settings.json existe et n'a pas pu être parsé : err.message porte déjà le
// « quoi faire », pas besoin de la distinguer ici.
const { installClaudeHooks } = require('./hooks-install');
// Dépôt de la « philosophie de lot » (lot onboarding 4, 2026-08-19) : même
// doctrine, module Node pur — cf. philosophy-install.js pour le pourquoi
// (statut FACULTATIF/CONSEILLÉ, jamais le même consentement que les hooks).
// Renommé à l'import pour ne jamais entrer en collision avec le nom de la
// fonction qui l'enrobe ici (promptBatchPhilosophy, plus bas) — même relation
// que installHooks()/installClaudeHooks() ci-dessus.
const { installBatchPhilosophy: applyBatchPhilosophy, PHILOSOPHY_FILE: BATCH_PHILOSOPHY_FILE, IMPORT_LINE: BATCH_PHILOSOPHY_IMPORT_LINE } = require('./philosophy-install');
// Lecteur de coût : un SEUL accumulateur pour deux consommateurs — le montant
// par conversation (via state.js) et celui d'une fenêtre de quota (timeline
// globale). Il vit ici, et non dans le moteur d'état, parce que la ligne de
// quota le consulte hors de tout snapshot.
const { createCostReader } = require('./cost.js');
const { focusConversation, createFocusRelay } = require('./focus');
const { createTabTracker, localActiveLabel } = require('./tabs');
const { createAckTracker } = require('./ack');
// Journal d'instrumentation du chemin d'ack (étape 18 phase 1, 5e récidive des
// ✓ acquittés sans consultation) : une trace, jamais une décision — cf.
// ack-journal.js pour le pourquoi de la méthode.
const { logEvent: logAckEvent } = require('./ack-journal');
const { convMatchesLabel } = require('./labels');
const { createSessionTitles } = require('./session-titles');
const { createSoundPlayer } = require('./sounds');
// Fenêtre de stabilisation du tout premier rendu (lot micro-allègements
// 2026-07-24) — cf. warmup.js pour le pourquoi (flash de conv fantôme post-reload).
const { createBootSettler } = require('./warmup');
// Création groupée de conversations (lot 1) : le métier est en Node pur dans
// batch.js, l'orchestration du lancement dans launcher.js — ici, que du câblage.
const { normalizeTasks, appendTasksAfterWave, conflictingEnvVars, createIntentStore, mismatchOf, readInheritSettings, MODELS, EFFORTS } = require('./batch');
const { createBatchLauncher, OPEN_COMMAND: LAUNCH_OPEN_COMMAND, NEW_CONVERSATION_COMMAND: LAUNCH_NEW_CONVERSATION_COMMAND } = require('./launcher');
// Recalcul du message de « Create » (lot 6, correctif §3) : un membre lancé
// mais dont aucun hook n'a encore tiré n'a pas d'entrée dans le snapshot de
// state.js (le premier hook n'écrit qu'au premier Entrée) — le seul signal
// disponible pour dire « l'onglet est toujours là, en attente » est le
// registre des process CLI vivants, déjà utilisé par le rattachement étage 1.
const { liveSessionIds } = require('./live-sessions.js');
// Groupes (lot 2) : le store est du Node pur (persistance injectée), le
// rattachement par préfixe de prompt aussi — les deux se testent sans VS Code.
const { createGroupStore, hueOf } = require('./groups');
const { createPinStore } = require('./pins');
const { matchPending, pendingForRelink } = require('./attach');
const { firstUserText } = require('./hooks/transcript.js');
// Moteur de vagues (lot 4) : Node pur, ne connaît que `{wave, status}` — le
// statut RÉEL de chaque membre (queued/launched/done/stale) est résolu ici,
// à partir de la conversation qu'il pointe (ou de son absence).
const { launchedWave, waveToAutoLaunch, canForceLaunch, advanceGate, WAVE_STABLE_MS } = require('./waves');
// Table de vérité UNIQUE du statut d'un membre (lot 10) : le rendu des lignes,
// le moteur de vagues et le bandeau de batch la consomment TOUS — plus une
// seule déduction locale à partir de « la conversation est-elle dans la liste
// affichée ». Sources injectées ici (registre des sessions, transcripts,
// sessions-state.json, vue), logique dans member-truth.js, Node pur.
const { memberTruth } = require('./member-truth');
// « Ce qui reste à faire » (plan repli-auto étape 11) : plie le statut déjà
// tranché par member-truth.js en une condition de non-rendu du groupe entier,
// ne re-déduit rien — cf. group-done.js.
const { groupDone } = require('./group-done');
// Filiation des lots (plan arbre-filiation 2026-08-15) : quel groupe se rend
// SOUS la ligne d'un membre d'un autre — le cas nominal du lot N qui propose
// les handoffs du lot N+1. Node pur, et il consomme la forme déjà envoyée au
// webview : aucune seconde résolution, cf. nesting.js en tête.
const { computeNesting } = require('./nesting');
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
let costReader = null;
let stateEngine;
let tabTracker;
let ackTracker;
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
// Marques « à relire » (lot 1, PLAN_marque_a_relire_2026-08-22.md) —
// workspaceState comme les groupes : la marque n'a de sens que là où vit la
// conversation qu'elle désigne.
let pinStore;
const PINS_KEY = 'pinnedConversations';
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

// Commande /handoffs (lot onboarding 2026-08-19) : raccourci de frappe
// déployé par installClaudeHooks() EN MÊME TEMPS que les hooks (hooks-
// install.js), mais un fichier INDÉPENDANT — un poste où seul l'un des deux
// manque (une version antérieure à son ajout, un fichier supprimé à la main)
// existe, donc les deux signaux se testent et se rapportent séparément dans
// le bandeau du panneau (buildPanelState() `setup`), jamais fondus en un seul
// booléen.
const HANDOFFS_COMMAND_PATH = path.join(os.homedir(), '.claude', 'commands', 'handoffs.md');

// Philosophie de découpage en lots (lot onboarding 4, 2026-08-19) — statut
// DIFFÉRENT des deux marqueurs ci-dessus : ni un hook ni /handoffs, un
// fichier FACULTATIF que promptBatchPhilosophy() (plus bas) propose d'ajouter
// au CLAUDE.md PERSONNEL de l'utilisateur, jamais sans un consentement
// DISTINCT de celui des hooks — l'extension fonctionne entièrement sans.
// Refusable sans conséquence : le refus n'est mémorisé que pour ne plus
// RE-proposer automatiquement après un installHooks() (maybeOfferBatchPhilosophy),
// jamais pour retirer la commande de la Palette.
const BATCH_PHILOSOPHY_MARKER_PATH = path.join(os.homedir(), '.claude', BATCH_PHILOSOPHY_FILE);
const BATCH_PHILOSOPHY_PROMPT_DISMISSED_KEY = 'batchPhilosophyPromptDismissed';

// Clés de contexte VS Code (setContext, cf. updateSetupContext() plus bas) —
// exposées pour un lot FUTUR : un walkthrough natif (contributes.walkthroughs)
// dont chaque étape se coche via `completionEvents: ["onContext:<clé>"]`. Une
// clé par signal, jamais une seule clé combinée : les deux manques sont
// indépendants (cf. commentaire HANDOFFS_COMMAND_PATH), donc les deux étapes
// d'un futur walkthrough doivent pouvoir se cocher l'une sans l'autre.
const CTX_HOOKS_INSTALLED = 'claudeCodeQuotaBar.hooksInstalled';
const CTX_HANDOFFS_INSTALLED = 'claudeCodeQuotaBar.handoffsInstalled';
let lastHooksCtx = null;
let lastHandoffsCtx = null;

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
    // Barre de contexte (%ctx) : seuils DIRECTS sur le pourcentage, pas un
    // ratio comme burnRate — décision user 2026-08-17, comparée sur maquette.
    ctxThresholds: {
      redMin: cfg.get('ctxRedMin', 50),
      yellowMin: cfg.get('ctxYellowMin', 40),
    },
    // Coût par conversation : seuils ABSOLUS en dollars (décision user
    // 2026-08-17, comparée sur maquette contre une coloration relative au plus
    // gourmand — le relatif repeint tout dès qu'une conv grossit, donc ne dit
    // rien de stable). Même motif que ctxRedMin/ctxYellowMin.
    costThresholds: {
      redMin: cfg.get('costRedDollars', 5),
      yellowMin: cfg.get('costYellowDollars', 2),
    },
    // Rythme (B3, 2026-08-18) : la couleur de la ligne suit désormais le coût
    // du DERNIER TOUR COMPLET, pas le cumul — costThresholds ci-dessus reste
    // lu (settings existants, retrait possible plus tard) mais ne colore plus
    // rien.
    costTurnThresholds: {
      redMin: cfg.get('costTurnRedDollars', 2),
      yellowMin: cfg.get('costTurnYellowDollars', 0.5),
    },
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
    // Proposition SÉPARÉE de la philosophie de lot (lot onboarding 4) —
    // jamais fusionnée à la commande ci-dessus : statut différent (requis vs
    // facultatif-conseillé), donc consentement différent. Toujours disponible
    // à la demande, même après un refus (cf. commentaire de
    // BATCH_PHILOSOPHY_PROMPT_DISMISSED_KEY).
    vscode.commands.registerCommand('claude-code-quota-bar.installBatchPhilosophy', () => promptBatchPhilosophy(context)),
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
    // Première ouverture VISIBLE du panneau : c'est SEULEMENT ici qu'on arme le
    // scan global des transcripts, dont le premier passage n'est pas gratuit
    // (cf. armGlobalCostScan). Tirer à chaque retour de visibilité est sans
    // effet — la fonction est idempotente.
    visible: () => armGlobalCostScan(),
    refresh: () => fetchAndUpdate(true),
    openUsage: () => vscode.env.openExternal(vscode.Uri.parse(USAGE_URL)),
    // Clic = acte observé explicite (lot 10c), même si l'onglet est déjà actif
    // — c'est le seul cas où aucune bascule/transition ne peut jamais se
    // produire, donc le seul chemin d'ack possible en mono-onglet.
    //
    // `reportActivation` (2026-08-17, plan gel-tabs) : focusConversation()
    // retourne le libellé RÉELLEMENT activé quand l'onglet est chez nous — on
    // le rapporte au tracker AVANT de redemander un recompute, pour que le
    // surlignage suive le clic même si la copie miroir des onglets de l'hôte
    // d'extension est gelée (lecture fraîche qui relirait alors le gel).
    // `null` (onglet ailleurs, relayé) → rien à rapporter ICI : c'est la
    // fenêtre qui répondra au relais qui le fera, sur SON tracker.
    focusConv: (msg) => {
      focusConversation(msg).then((label) => {
        if (label && tabTracker) tabTracker.reportActivation(label);
        if (stateEngine) stateEngine.refresh();
      }).catch(() => {});
      ackConversationById(msg && msg.id);
    },
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
    // Marque « à relire » (lot 1, plan marque-a-relire) : pose/retrait 100 %
    // manuels (décision 7 du plan) — seul écrivain de PINS_KEY.
    togglePinConv: (msg) => togglePinConv(msg && msg.id),
    // Clic sur une ligne marquée dont l'onglet est fermé (lot 3) : le webview
    // n'envoie ce message QUE sur une ligne `tabGone` — c'est lui qui sait ce
    // qu'il a rendu, et le rendu dit déjà « onglet fermé ».
    reopenConv: (msg) => reopenConv(msg && msg.id),
    removeMember: (msg) => removeMember(msg && msg.id, msg && msg.key),
    linkMember: (msg) => linkMember(msg && msg.id, msg && msg.key),
    // Remède du lien mort-né (plan lien-mort-né 2026-08-04) : rouvrir une
    // conversation pour la tâche, quand son onglet, lui, est vraiment parti.
    relaunchMember: (msg) => relaunchMember(msg && msg.id, msg && msg.key),
    // « + » (adopter une conv existante) retiré du webview (plan repli-auto
    // étape 9 — l'ajout de tâches passe par « + ajouter à cette vague/nouvelle
    // vague ») : le handler reste câblé, inoffensif, aucun bouton ne l'appelle
    // plus (convention du projet, cf. CLAUDE.md de ce dossier).
    addToGroup: (msg) => addToGroup(msg && msg.id),
    // PAS de `closeConvTab` ici, et c'est structurel (2026-08-07) : le panneau
    // ne ferme plus aucun onglet depuis le plan repli-auto étape 15, et il ne
    // supprime jamais une ligne — le seul moyen de faire disparaître une
    // conversation de la liste reste de fermer son onglet dans VS Code. Un
    // handler resté câblé aurait rouvert cette porte au premier bouton qui
    // aurait cru pouvoir s'en servir.
    // Porte de sortie d'un ⌂ posé par erreur (survol de la ligne master,
    // hover-only) : dissocier sans confirmation, geste réversible (on peut
    // relier tout de suite après) — même esprit que `unsetMaster` côté store.
    unlinkGroupMaster: (msg) => unlinkGroupMaster(msg && msg.id),
    // Moteur de vagues (lot 4).
    launchWave: (msg) => handleLaunchWave(msg),
    moveMemberWave: (msg) => moveMemberWave(msg && msg.id, msg && msg.key, Number(msg && msg.delta)),
    // Ajout en file à un groupe existant (plan ajout-tache 2026-07-24) : « + »
    // par vague en file / ligne fantôme « nouvelle vague » du panneau.
    addTaskToGroup: (msg) => addTaskToGroup(msg),
    // Transfert d'un bloc claude-convs multi-tâches collé, À LA SUITE d'un
    // groupe existant (plan repli-auto étape 10) : le webview a déjà confirmé
    // avec l'user et résolu modèle/effort par section ; les vagues envoyées
    // sont RELATIVES (1..M), décalées ICI sur l'état à jour du groupe.
    addTasksToGroup: (msg) => addTasksToGroup(msg),
    // Conversation maîtresse : ⌂-focus (plan repli-auto étape 9) — visible
    // SEULEMENT quand le groupe n'a pas encore de master, un clic lie
    // directement l'onglet VS Code ACTIF de cette fenêtre (plus de QuickPick :
    // ambiguïté ou onglet non-Claude → no-op + message, jamais un lien deviné).
    setGroupMaster: (msg) => setGroupMaster(msg && msg.id),
    // Rattachement d'une ligne PLATE déjà lancée (lot B, plan « master conv
    // isolée » 2026-08-09) — bouton overlay hover-only, symétrique du ⌂
    // ci-dessus : ici c'est la conversation SOUS le survol qui devient
    // membre, la maîtresse est l'onglet VS Code actif. Même doctrine : aucune
    // saisie, aucune liste, échec propre sur toute ambiguïté.
    linkConvToActiveMaster: (msg) => linkConvToActiveMaster(msg && msg.id),
    // Bouton du bandeau d'onboarding (lot 2026-08-19) : MÊME chemin que la
    // commande Palette « Claude Convs: Install Hooks » — même confirmation
    // modale, même écriture, même proposition de reload. Le bandeau ne
    // court-circuite rien, il ouvre juste le même geste en un clic depuis le
    // panneau plutôt que depuis la Palette.
    installHooksNow: () => installHooks(context),
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
  //
  // Borne de session dans le journal d'ack (étape 18 phase 1) : toutes les
  // fenêtres VS Code écrivent le MÊME fichier — sans cette ligne, impossible de
  // rattacher un `ack-post` à sa fenêtre, à son workspace ni à la version qui
  // l'a produit. C'est aussi elle qui date un reload (nouveau pid).
  logAckEvent('window-start', {
    workspace: workspacePath,
    version: (context.extension && context.extension.packageJSON && context.extension.packageJSON.version) || null,
  });
  // Sans `onDwell` depuis 2026-08-06 : le séjour sur un onglet n'acquitte plus
  // rien (cf. le bloc « L'ACCUSÉ DE LECTURE N'EST PLUS JAMAIS AUTOMATIQUE »).
  // Le tracker reste branché pour ce qu'il sait faire sans rien décider :
  // alimenter le journal et fournir le contexte de séjour aux lignes d'ack.
  ackTracker = createAckTracker({});
  context.subscriptions.push({ dispose: () => ackTracker.dispose() });

  // Titres d'onglet RÉELS (2026-07-22) : seul l'hôte d'extension peut situer le
  // state.vscdb du workspace, d'où ce câblage ici plutôt qu'un défaut dans
  // state.js. Absent (pas de workspace, layout VS Code différent) → table vide,
  // comportement d'avant ce lot.
  const sessionTitles = createSessionTitles(resolveStateDbPath(context));

  // Un seul lecteur pour les deux montants (ligne de conversation et ligne de
  // quota) : il porte l'octet où chaque transcript a été lu, et relire deux
  // fois les mêmes centaines de Mo pour la seconde question serait absurde.
  costReader = createCostReader();

  // Marques « à relire » (plan marque-a-relire) — AVANT le moteur d'état, et
  // pas plus bas avec les autres stores : depuis le lot 3 une marque décide de
  // la PRÉSENCE d'une ligne (`pinnedSessions` ci-dessous), et le moteur
  // construit un premier snapshot dès sa construction. Le store construit
  // après, ce tout premier snapshot naissait sans les marques et une
  // conversation marquée à onglet fermé manquait à l'affichage jusqu'au premier
  // recompute.
  pinStore = createPinStore({
    load: () => context.workspaceState.get(PINS_KEY, []),
    save: (ids) => { context.workspaceState.update(PINS_KEY, ids); },
  });

  stateEngine = createStateEngine({
    workspacePath,
    ...STATE_DEFAULTS,
    readCost: costReader,
    // Ce que l'utilisateur a marqué « à relire » : state.js s'en sert pour
    // GARDER la ligne quand l'onglet s'est fermé ou que le transcript a vieilli
    // (lot 3) — la seule source du panneau qui soit une intention déclarée, et
    // non un fait observé.
    pinnedSessions: () => new Set(pinStore ? pinStore.list() : []),
    tabs: () => tabTracker.getTabs(),
    sessionTitles: () => sessionTitles.get(),
    sortOrder: () => getConfig().sortOrder,
    // Ce que les GROUPES affichent, ajouté à la clé de changement du moteur
    // (cf. state.js `extraKey`) : sans elle, une bascule de statut qui ne
    // touche aucune conversation de la liste n'était jamais poussée au webview.
    // Le gel des onglets (2026-08-17) rejoint la même clé, MÊME RAISON : ni la
    // liste ni les groupes ne bougent quand le canal RPC des onglets meurt ou
    // reparle — sans lui ici, la bascule gel/dégel ne pousserait qu'au
    // prochain changement sans rapport.
    extraKey: () => groupsRenderKey() + '|' + tabsFrozenKey(),
    // L'ack APRÈS le push : la conv apparaît terminée tout de suite, l'accusé
    // suit. Ici passe le cas « l'onglet était déjà sous les yeux quand Claude a
    // fini » — aucune bascule d'onglet ne se produira, c'est donc l'arrivée du
    // `done` qui doit aller consulter le séjour en cours.
    onChange: (snap) => { attachPendingMembers(); maybeAdvanceWaves(); pushPanelState(); maybeFetchOnTransition(snap); },
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
    // Point d'accrochage unique (récidive n°4, 2026-08-05) : les deux
    // commandes qui font naître/activer un onglet Claude PROGRAMMATIQUEMENT
    // (jamais un clic) sont marquées ICI, juste avant exécution — c'est le
    // seul chemin par lequel launcher.js ouvre un onglet, batch initial comme
    // moteur de vagues. ack.js s'en sert pour ne jamais confondre cette
    // activation avec un acte utilisateur (cf. ack.js, en-tête du fichier).
    executeCommand: (...args) => {
      if (ackTracker && (args[0] === LAUNCH_OPEN_COMMAND || args[0] === LAUNCH_NEW_CONVERSATION_COMMAND)) {
        ackTracker.markProgrammaticOpen();
      }
      return vscode.commands.executeCommand(...args);
    },
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
  // `onActivated` (2026-08-17, plan gel-tabs) : SYMÉTRIQUE du câblage de
  // `focusConv` ci-dessus — c'est ICI, dans la fenêtre qui possède réellement
  // l'onglet, que l'acte doit être rapporté à SON tracker.
  context.subscriptions.push(createFocusRelay({
    onActivated: (label) => {
      if (tabTracker) tabTracker.reportActivation(label);
      if (stateEngine) stateEngine.refresh();
    },
  }));

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

// Scan global des transcripts (coût par fenêtre de quota). Armé à la première
// ouverture VISIBLE du panneau, jamais à l'activation : le premier passage
// coûte quelques centaines de ms, et chaque fenêtre VS Code a son propre hôte
// d'extension — six fenêtres ouvertes feraient six scans. Une fenêtre dont le
// panneau reste fermé ne lit donc rien.
const COST_SCAN_DELAY_MS = 1500;      // après le premier rendu, jamais pendant
const COST_SCAN_INTERVAL_MS = 60000;  // ensuite : incrémental, quelques ms
let costScanTimer = null;
let costScanKick = null;

function runGlobalCostScan() {
  if (!costReader) return;
  try { if (costReader.scanAll()) pushPanelState(); } catch {}
}

function armGlobalCostScan() {
  if (costScanTimer) return;
  costScanKick = setTimeout(runGlobalCostScan, COST_SCAN_DELAY_MS);
  costScanTimer = setInterval(runGlobalCostScan, COST_SCAN_INTERVAL_MS);
}

function stopGlobalCostScan() {
  if (costScanKick) { clearTimeout(costScanKick); costScanKick = null; }
  if (costScanTimer) { clearInterval(costScanTimer); costScanTimer = null; }
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
  if (waveGateTimer) { clearTimeout(waveGateTimer); waveGateTimer = null; }
  stopGlobalCostScan();
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
// Titres 100 % FICTIFS et en anglais (règle « données publiques = maquette ») :
// ce jeu est lisible dans le source publié et sert les captures de la fiche
// store (test/make-store-shots.js) — jamais un titre réel ici.
const DEMO_CONVERSATIONS = [
  { id: 'd1', title: 'Extract the billing client into packages/billing', model: 'Opus 4.8', effort: 'high', ctx: { pct: 34, tokens: 340000, denom: 1000000 }, state: 'busy', acked: true, active: true, groupId: 'demo-g' },
  { id: 'd2', title: 'Add pagination to the orders API', model: 'Sonnet 5', effort: 'medium', ctx: { pct: 71, tokens: 142000, denom: 200000 }, state: 'waiting', acked: true, active: false },
  { id: 'd3', title: 'Add a PDF export button to the invoice page', model: 'Haiku 4.5', effort: 'low', ctx: { pct: 12, tokens: 24000, denom: 200000 }, state: 'done', acked: false, active: false, groupId: 'demo-g', tabOpen: true },
  { id: 'd4', title: 'Investigate memory leak in worker pool', model: 'Opus 4.8', effort: 'high', ctx: { pct: 88, tokens: 880000, denom: 1000000 }, state: 'stale', acked: true, active: false },
  { id: 'd5', title: 'Write onboarding docs for the CLI', model: null, effort: null, ctx: null, state: 'idle', acked: true, active: false },
  // Écart intention/réel (lot 1) : demandé en opus·high au lancement, servi en
  // sonnet·medium — le badge est le SEUL mécanisme qui le signale.
  { id: 'd6', title: 'Fix flaky checkout integration test', model: 'Sonnet 5', effort: 'medium', ctx: { pct: 22, tokens: 44000, denom: 200000 }, state: 'done', acked: true, active: false, asked: { model: 'opus', effort: 'high' }, mismatch: { model: { asked: 'opus', real: 'sonnet' }, effort: { asked: 'high', real: 'medium' } } },
  { id: 'd7', title: 'Migrate legacy cron jobs to queues', model: 'Opus 4.8', effort: 'high', ctx: { pct: 47, tokens: 470000, denom: 1000000 }, state: 'interrupted', acked: true, active: false },
  // Sous-lot imbriqué (plan arbre-filiation) : les membres du lot dont d3 —
  // elle-même membre de demo-g — est la maîtresse.
  { id: 'd8', title: 'Wire the new billing client into checkout', model: 'Sonnet 5', effort: 'medium', ctx: { pct: 41, tokens: 82000, denom: 200000 }, state: 'busy', acked: true, active: false, groupId: 'demo-g2' },
  { id: 'd9', title: 'Add smoke tests for invoice PDFs', model: 'Haiku 4.5', effort: 'low', ctx: { pct: 9, tokens: 18000, denom: 200000 }, state: 'done', acked: false, active: false, groupId: 'demo-g2', tabOpen: true },
];

// Groupe de démonstration (lot 2), rendu en mode CLAUDE_QUOTA_PANEL_DEMO : les
// trois cas qu'un groupe peut afficher — un membre au travail, un membre
// terminé dont l'onglet est encore ouvert (badge ⨯), et un membre pas encore
// rattaché à une conversation.
const DEMO_GROUPS = [{
  id: 'demo-g',
  name: 'Payment refactor',
  stamp: '14:07',
  hue: hueOf('Payment refactor'),
  collapsed: false,
  // Moteur de vagues (lot 4) : vague 1 en cours (d1 busy, d3 done), vague 2
  // encore `queued` — le cas type de « unlocks when wave 1 is fully done ».
  launchedWave: 1,
  nextWave: 2,
  waveNotice: null,
  // Démo : les champs dérivés de la table de vérité (lot 10) sont écrits à la
  // main ici — aucune source réelle derrière une conversation fictive.
  members: [
    { key: 'm1', prompt: 'Extract the billing client into packages/billing', wave: 1, asked: { model: 'opus', effort: 'high' }, convId: 'd1', status: 'busy', waveStatus: 'launched', canLink: false, canClose: false, canRelaunch: false, note: '', hint: '' },
    { key: 'm2', prompt: 'Add a PDF export button to the invoice page', wave: 1, asked: { model: 'haiku', effort: 'low' }, convId: 'd3', status: 'done', waveStatus: 'done', canLink: false, canClose: true, canRelaunch: false, note: '', hint: '' },
    { key: 'm3', prompt: 'Update the docs once the other two land', wave: 2, asked: { model: 'sonnet', effort: 'medium' }, convId: null, status: 'queued', waveStatus: 'queued', canLink: false, canClose: false, canRelaunch: false, note: '', hint: 'Queued — opens when this wave starts.' },
  ],
}, {
  // Sous-lot IMBRIQUÉ (plan arbre-filiation) : sa maîtresse d3 est membre m2 de
  // demo-g. La filiation n'est PAS écrite ici — le retour démo de groupsState
  // passe par computeNesting comme le réel : la démo exerce la dérivation,
  // elle n'en recopie jamais la sortie.
  id: 'demo-g2',
  name: 'Billing rollout',
  stamp: '15:32',
  hue: hueOf('Billing rollout'),
  collapsed: false,
  launchedWave: 1,
  nextWave: null,
  waveNotice: null,
  master: { convId: 'd3', title: 'Add a PDF export button to the invoice page', tabTitle: null, listed: true, status: 'done', hint: '' },
  members: [
    { key: 'm1', prompt: 'Wire the new billing client into checkout', wave: 1, asked: { model: 'sonnet', effort: 'medium' }, convId: 'd8', status: 'busy', waveStatus: 'launched', canLink: false, canClose: false, canRelaunch: false, note: '', hint: '' },
    { key: 'm2', prompt: 'Add smoke tests for invoice PDFs', wave: 1, asked: { model: 'haiku', effort: 'low' }, convId: 'd9', status: 'done', waveStatus: 'done', canLink: false, canClose: true, canRelaunch: false, note: '', hint: '' },
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

// L'ACCUSÉ DE LECTURE N'EST PLUS JAMAIS AUTOMATIQUE (décision user, 2026-08-06).
//
// Ce qui existait ici : « onglet actif + fenêtre au premier plan, tenu 2 s »
// valait « tu as lu ». Quatre incidents successifs ont montré que ce signal ne
// décrit pas la lecture — onglet posé là depuis avant le run, rename_tab de fin
// de tour, onglet ouvert par le moteur de vagues, et enfin (8e signalement,
// 2026-08-06) une fenêtre qui revient au premier plan avec cette conversation
// déjà active : 2 s plus tard, ✓ éteint sans que personne ait rien lu. Chaque
// fois la parade fut un garde-fou de plus SUR le chemin (busySince, seuil
// postérieur au done, identité d'onglet, marque programmatique) ; le chemin
// lui-même restait une DEVINETTE sur une intention humaine.
//
// On ne devine plus : le ✓ ne s'éteint QUE sur un acte explicite — le clic sur
// la ligne du panneau (ackConversationById ci-dessous), seul endroit du code qui
// écrive encore ack_ts. Le dwell de ack.js continue de tourner pour le JOURNAL
// (ack-journal.js) : il observe, il ne décide plus rien.

// Clic explicite sur la ligne panneau : le clic EST l'acte observé,
// inconditionnellement — et, depuis 2026-08-06, le SEUL. Y compris quand
// l'onglet est déjà actif, cas où aucune transition ne peut jamais se produire.
function ackConversationById(sessionId) {
  if (!stateEngine || !sessionId) return;
  const c = stateEngine.getSnapshot().conversations.find((x) => x.sessionId === sessionId);
  if (!c || c.state !== 'done' || c.acked) return;
  // Journalisé : c'est desormais la SEULE origine possible d'un ack — une
  // ligne ack-click par ✓ éteint, et rien d'autre ne doit jamais en éteindre un.
  logAckEvent('ack-click', {
    sessionId, title: c.title, convSince: c.since, busySince: c.busySince,
    ...(ackTracker && ackTracker.journalContext ? ackTracker.journalContext() : {}),
  });
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
      // `busySince` = démarrage du run demandé par l'utilisateur : c'est LUI qui
      // identifie le tour, pas `since` (réarmé à chaque Stop, donc deux fois par
      // tour dès qu'un hook Stop à feedback relance Claude) — cf. sounds.js.
      if (soundPlayer) soundPlayer.onTransition(c.sessionId, c.state, c.since, c.busySince);
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
      // Coût estimé ($) depuis le début de la conv (cost.js, via state.js) —
      // null quand le transcript ne porte encore aucune donnée d'usage : le
      // panneau n'affiche alors RIEN, jamais un 0,00 $ supposé.
      cost: c.cost || null,
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
      // Onglet PROUVÉ fermé, ligne retenue par la seule marque (lot 3) : le
      // titre est barré et le clic ROUVRE au lieu de chercher un onglet. À ne
      // pas confondre avec `tabOpen: false`, qui peut n'être qu'un manque de
      // matching passager (state.js resolveTabOpen).
      tabGone: !!c.tabGone,
      // Groupe où l'appariement conv↔onglet est arbitraire (mêmes titres
      // tronqués, lot 2/3 du plan d'appariement) : signe discret + infobulle
      // côté webview, jamais de surlignage sur cette ligne (state.js).
      tabAmbiguous: !!c.tabAmbiguous,
      // Marque « à relire » (lot 1, plan marque-a-relire) : posée/retirée à la
      // main, aucun lien avec l'état du moteur (cf. CLAUDE.md du dossier —
      // « un seul jeu de symboles d'état »). Le rendu arrive au lot 2.
      pinned: pinStore ? pinStore.isPinned(c.sessionId) : false,
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
  if (process.env.CLAUDE_QUOTA_PANEL_DEMO === '1') {
    // Le jeu de démo passe par la MÊME dérivation de filiation et de rôle de
    // maîtresse que le chemin réel : la démo doit EXERCER computeNesting, pas
    // recopier sa sortie à la main (deux écritures d'un même fait divergent —
    // classe d'erreur documentée en tête de member-truth.js). Copie
    // superficielle d'abord : DEMO_GROUPS est un const de module, le
    // post-traitement ne doit pas le muter d'un appel à l'autre.
    const demo = DEMO_GROUPS.map((g) => ({ ...g, master: g.master ? { ...g.master } : g.master }));
    const { nestedUnder, masterRole } = computeNesting(demo);
    for (const g of demo) {
      g.nestedUnder = nestedUnder[g.id] || null;
      const role = (g.master && masterRole[g.id]) || { role: 'host' };
      g.done = groupDone(g.members.map((m) => m.status));
      if (role.role === 'ceded') g.master = null;
    }
    return demo;
  }
  if (!groupStore) return [];
  const sup = superseded || currentSuperseded();
  const convById = new Map((convs || []).map((c) => [c.id, c]));
  const src = sources || memberSources((id) => convById.get(id));
  // Statuts des membres, gardés de côté pour le calcul de `done` : il se fait
  // désormais APRÈS la résolution inter-groupes (plus bas), parce qu'il dépend
  // du rôle de la maîtresse — or ce rôle se décide entre PLUSIEURS groupes, ce
  // que le map ci-dessous ne peut pas voir.
  const memberStatuses = new Map();
  const rendered = groupStore.all().map((g) => {
    // UNE résolution par membre (lot 10), partagée par le moteur de vagues et
    // par le rendu : le webview ne re-déduit plus rien de « la conversation
    // est-elle dans la liste » — il affiche ce que la table a conclu.
    // `rm` = membres à sessionId redirigé (husk→successeur après un reload) :
    // statut, chip et cible de fermeture visent la conv VIVANTE, pas le husk.
    const rm = g.members.map((m) => redirectMember(m, sup));
    const truths = rm.map((m) => memberTruth(m, src));
    const abstract = rm.map((m, i) => ({ wave: m.wave, status: truths[i].waveStatus }));
    const master = masterState(g, src, convById, sup);
    memberStatuses.set(g.id, truths.map((t) => t.status));
    return {
      id: g.id,
      name: g.name,
      // Identité courte du lot, affichée dans la grip (« BATCH 14:12 »).
      // L'heure de création plutôt que le nom : deux lots peuvent porter le
      // même group: dans leur bloc collé (ou aucun, et tomber tous deux sur le
      // repli), leur heure de création les sépare toujours. Formatée ICI comme
      // tout autre libellé d'heure du panneau — hhmm(), celui du reset de
      // quota : le webview affiche ce qui a été conclu, il ne dérive pas une
      // heure locale de son côté. Groupe legacy sans createdAt (repli 0 du
      // sanitize) → null, et la grip n'affiche alors aucun libellé plutôt
      // qu'une heure inventée (dégradation silencieuse, comme partout ici).
      stamp: g.createdAt ? hhmm(new Date(g.createdAt)) : null,
      hue: hueOf(g.name),
      collapsed: !!g.collapsed,
      // « Ce qui reste à faire » (étape 11) : groupe ENTIER terminé (membres
      // ET maîtresse, si désignée) → le webview ne le rend plus DU TOUT (rien
      // n'est muté ici, group-done.js ne fait que plier des statuts déjà
      // tranchés — panel.js filtre au rendu, cf. CLAUDE.md du dossier).
      // POSÉ PLUS BAS : la maîtresse ne bloque que le lot qui la rend en tête.
      done: false,
      // Conv maîtresse (lot 11) : un POINTEUR vers une conversation qui vit sa
      // vie ailleurs — elle n'est pas un membre, ne compte dans aucune vague, et
      // n'est pas retirée de la liste plate. Son statut passe par la MÊME table
      // de vérité que les membres (lot 10) : la vue ne décide de rien, ici non
      // plus. `title` = celui de la conv si elle est listée, sinon celui qui a
      // été persisté au moment du lien.
      master,
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
        canRelaunch: truths[i].canRelaunch,
        // NOTES/HINTS (member-truth.js) sont du Node pur, sans vscode — le
        // texte anglais qu'elles rendent sert de CLÉ à la traduction ici, au
        // seul point où le résultat part vers l'affichage.
        note: truths[i].note ? vscode.l10n.t(truths[i].note) : truths[i].note,
        hint: truths[i].hint ? vscode.l10n.t(truths[i].hint) : truths[i].hint,
      })),
    };
  });

  // Filiation (plan arbre-filiation, lot 1) — calculée SUR CE QUI PART AU
  // WEBVIEW, une fois tous les groupes résolus : c'est une relation ENTRE
  // groupes, elle ne peut pas se décider dans le map ci-dessus, qui n'en voit
  // qu'un à la fois. `nestedUnder` porté par CHAQUE groupe (null compris) :
  // le webview lit un champ, il n'a jamais à déduire une absence.
  const { nestedUnder, masterRole } = computeNesting(rendered);
  for (const g of rendered) {
    g.nestedUnder = nestedUnder[g.id] || null;
    // Rôle de la maîtresse (plan « la maîtresse n'engage que son dernier lot ») :
    // repli sur le comportement d'avant si nesting.js n'a rien à en dire —
    // dégradation silencieuse, comme partout ici.
    const role = (g.master && masterRole[g.id]) || { role: 'host' };
    // Le lot n'existe que pour ses MEMBRES : tous finis et fermés, il se
    // retire, que sa maîtresse soit encore ouverte ou non (2026-08-18,
    // group-done.js) — la conv de cadrage retrouve alors sa ligne plate au
    // lieu de garder sa tête de lot indéfiniment.
    g.done = groupDone(memberStatuses.get(g.id));
    // Lot qui a CÉDÉ sa maîtresse à plus récent que lui : le webview reçoit
    // `null` et emprunte sa branche sans-maîtresse (grip seule) — celle-là
    // même qu'utilise un lot qui n'en a jamais eu. Aucun rendu nouveau, et
    // surtout AUCUNE écriture dans le store : la relation reste dérivée, comme
    // la filiation, et le lien historique reste lisible (l'user peut toujours
    // relier ailleurs, ce qui rebasculera la tête).
    if (role.role === 'ceded') g.master = null;
  }
  return rendered;
}

// Signature de ce que les GROUPES affichent — la moitié de la clé de rendu que
// `renderKey` (state.js) ne peut pas voir, puisqu'elle ne décrit que la liste
// des conversations. Injectée dans le moteur (`extraKey`) pour que TOUT ce qui
// est à l'écran participe à la décision « faut-il repousser un état ? ».
//
// LA MÊME RÉSOLUTION QUE LE RENDU, jamais une seconde : on appelle `groupsState`
// — exactement ce que `buildPanelState` enverra — et on n'en garde que les
// champs qui se voient. Recalculer ici une vérité « équivalente » serait la
// classe d'erreur que member-truth.js documente en tête.
//
// Coût : nul sans groupe (sortie immédiate). Avec des groupes, une lecture du
// registre des sessions + une de sessions-state.json par recompute (mutualisées
// par memberSources), soit l'ordre de grandeur de ce que le recompute fait déjà.
function groupsRenderKey() {
  if (!stateEngine || !groupStore) return '';
  try {
    if (!groupStore.all().length) return '';
    return JSON.stringify(groupsState(conversationsState()).map((g) => [
      g.id, g.name, g.done, g.collapsed,
      // La filiation change la STRUCTURE du rendu (un lot passe de bloc frère
      // à sous-arbre) sans qu'aucun autre champ ne bouge : sans elle dans la
      // clé, le passage se ferait au prochain recompute qui change autre
      // chose — jamais à l'instant où il devient vrai.
      g.nestedUnder && [g.nestedUnder.groupId, g.nestedUnder.memberKey],
      g.launchedWave, g.nextWave, g.waveNotice,
      g.master && [g.master.convId, g.master.title, g.master.listed, g.master.status],
      g.members.map((m) => [m.key, m.convId, m.status, m.canLink, m.canRelaunch]),
    ]));
  } catch { return ''; }
}

// Signature du gel des onglets (2026-08-17, plan gel-tabs) — même doctrine que
// `groupsRenderKey` ci-dessus : `renderKey` (state.js) ne décrit que la liste
// des conversations, or le bandeau de gel (panel.js) est à l'écran sans être
// dérivé d'AUCUNE conv. La MÊME lecture que buildPanelState enverra
// (`tabTracker.getTabs().frozen`), jamais une résolution « équivalente ».
function tabsFrozenKey() {
  return tabTracker && tabTracker.getTabs().frozen ? 'F' : '';
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
    // Instant du lien (groups.js) : il ne s'affiche nulle part, il ARBITRE —
    // quand plusieurs lots revendiquent cette même conversation, nesting.js
    // donne la tête au plus récemment lié. Il doit donc circuler jusqu'à la
    // forme rendue, seule chose que nesting.js consomme (il ne lit pas le
    // store, cf. son en-tête).
    linkedAt: Number.isFinite(g.masterLinkedAt) ? g.masterLinkedAt : 0,
    tabTitle: (conv && conv.tabTitle) || null,
    hint: t.hint ? vscode.l10n.t(t.hint) : t.hint,
    // Statut canonique (member-truth.js) de la maîtresse — exposé pour que
    // `groupsState`/`maybeAutoCollapseGroups` partagent la MÊME résolution
    // que ce qui est affiché ici, jamais un second calcul divergent (plan
    // repli-auto, décision « UNE seule résolution partagée »).
    status: t.status,
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
  const now = Date.now();
  if (now - lastAttachTry < ATTACH_RETRY_MS) return false;

  const snap = stateEngine.getSnapshot();
  const byId = new Map(snap.conversations.map((c) => [c.sessionId, c]));
  // Deux populations, un seul appariement (fix « fermée avant envoi »
  // 2026-08-04) : les membres jamais liés, et ceux dont le lien est MORT-NÉ —
  // process mort sans qu'un octet soit parti, donc rien qui ait commencé sous
  // cet identifiant (cf. attach.js pendingForRelink). Les mélanger avant
  // matchPending est volontaire : son principe « ambiguïté = aucun
  // rattachement » doit voir les deux d'un coup, sinon un même transcript
  // pourrait être revendiqué deux fois.
  const src = memberSources((id) => byId.get(id));
  const pending = groupStore.pending()
    .concat(pendingForRelink(groupStore.all(), (m) => memberTruth(m, src)));
  if (!pending.length) return false;
  lastAttachTry = now;

  const taken = groupStore.attachedIds();
  const candidates = [];
  for (const c of snap.conversations) {
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
function mkWindow(label, pct, resetsAt, windowMs, burnRate, cost) {
  const elapsedPct = windowElapsedPct(resetsAt, windowMs);
  return {
    label,
    pct: Math.round(pct),
    resetsAt: resetsAt || null,
    resetLabel: reset(resetsAt),
    windowMs,
    pace: paceColor(burnRatePace(pct, resetsAt, windowMs), burnRate),
    elapsedPct: elapsedPct == null ? null : Math.min(100, Math.max(0, elapsedPct)),
    // Coût MESURÉ sur la période exacte de la fenêtre (cost.js), pas une
    // projection : `null` tant que le scan global n'a pas eu lieu, ou quand
    // rien de mesurable n'y tombe — la ligne garde alors sa tête d'avant.
    cost: typeof cost === 'number' && isFinite(cost) ? cost : null,
  };
}

// Bornes exactes de la fenêtre : début = reset − durée. Aucune heuristique de
// date, aucune horloge locale dans le calcul du début — c'est l'API qui date le
// reset. `modelName` non vide = fenêtre scopée par famille de modèle.
function windowCost(resetsAt, windowMs, modelName) {
  if (!costReader || !resetsAt) return null;
  const end = Date.parse(resetsAt);
  if (!Number.isFinite(end)) return null;
  try { return costReader.windowCost(end - windowMs, modelName || null); } catch { return null; }
}

function quotaState() {
  const cached = readCache();
  const { burnRate } = getConfig();
  if (!cached || !cached.data) return { windows: [], burnRate, ageMin: null, source: null };
  const windows = [];
  const fh = cached.data.five_hour;
  if (fh && fh.utilization != null) windows.push(mkWindow(vscode.l10n.t('5h window'), fh.utilization, fh.resets_at, FIVE_HOUR_MS, burnRate, windowCost(fh.resets_at, FIVE_HOUR_MS)));
  const sd = cached.data.seven_day;
  if (sd && sd.utilization != null) windows.push(mkWindow(vscode.l10n.t('7d window'), sd.utilization, sd.resets_at, SEVEN_DAY_MS, burnRate, windowCost(sd.resets_at, SEVEN_DAY_MS)));
  // Barres hebdo scopées par modèle (ex. Fable 50 % de l'hebdo jusqu'au
  // 19/07) : AUCUNE référence en dur à un modèle ni une date — toute entrée
  // limits[] avec group:"weekly" et un scope produit sa barre, et disparaît
  // d'elle-même quand l'API cesse de l'envoyer.
  const limits = Array.isArray(cached.data.limits) ? cached.data.limits : [];
  for (const l of limits) {
    if (l.group !== 'weekly' || !l.scope || !l.scope.model) continue;
    const name = l.scope.model.display_name || vscode.l10n.t('scoped');
    // Le filtre par famille part du display_name, seul champ renseigné : dans
    // le cache réel, `scope.model.id` vaut null. Aucun match → aucun montant
    // sur cette ligne, jamais un chiffre faux (cf. cost.js modelMatcher).
    windows.push(mkWindow(vscode.l10n.t('{0} (7d)', name), l.percent, l.resets_at, SEVEN_DAY_MS, burnRate,
      windowCost(l.resets_at, SEVEN_DAY_MS, l.scope.model.display_name)));
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
  // Point d'accrochage unique du cycle de vie du notice de batch (plan
  // repli-auto étape 6) : AVANT composeBatchNotice()/composeBatchNoticeHint()
  // ci-dessous, pour que les deux voient le MÊME batchLastLaunch déjà purgé
  // si son groupe a disparu — jamais une seconde résolution divergente.
  if (shouldPurgeBatchLaunch(batchLastLaunch, (id) => !!(groupStore && groupStore.get(id)))) {
    batchLastLaunch = null;
    // ...ET le texte de repli qui décrivait CE lot : sans lui, la ligne
    // `if (!launch) return fallback` de computeBatchNoticeFromLaunch le
    // réaffiche pour toujours, alors qu'il n'y a plus rien à recalculer.
    if (!batchStatus.busy && batchStatus.notice) batchStatus = { busy: false, notice: null };
  }
  return {
    conversations: convs,
    quota: quotaState(),
    sounds: { enabled: cfg.soundsEnabled },
    ui: {
      collapsedConversations: cfg.collapsedConversations,
      collapsedQuota: cfg.collapsedQuota,
      sortOrder: cfg.sortOrder,
      collapsedNewConversation: !!(workspaceStateRef && workspaceStateRef.get(NEW_CONV_COLLAPSED_KEY, false)),
      ctxThresholds: cfg.ctxThresholds,
      costThresholds: cfg.costThresholds,
      costTurnThresholds: cfg.costTurnThresholds,
    },
    // Lot 13 §1 : indicateur discret, jamais de popup — voir checkTabCanary().
    canary: canaryActive,
    // Plan gel-tabs (2026-08-17) : canal RPC des onglets mort pour CETTE
    // fenêtre — cf. tabs.js `reportActivation`/`noteTabsEventReceived`. Lu à
    // chaque push, jamais mis en cache (même doctrine que `canary` ci-dessus).
    tabsFrozen: !!(tabTracker && tabTracker.getTabs().frozen),
    // Formulaire de création groupée (lot 1). `notice` est recalculé à CHAQUE
    // push (lot 6, correctif §3) plutôt que figé au moment du « Create » : sans
    // ça, le message restait affiché après que tous les onglets aient été
    // envoyés, fermés ou rouverts.
    batch: {
      envConflict: envConflictVars(),
      busy: batchStatus.busy,
      notice: batchStatus.busy ? batchStatus.notice : composeBatchNotice(convs, sources),
      // Disclaimer du menu officiel (plan repli-auto étape 6) : tooltip du
      // notice, jamais concaténé au texte courant — `null` tant qu'il n'y a
      // pas de dernier lot à décrire (busy, ou aucun Create depuis l'ouverture
      // du panneau).
      noticeHint: batchStatus.busy ? null : (batchLastLaunch ? batchLastLaunch.hint : null),
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
    },
    // Groupes persistés (lot 2), vagues résolues (lot 4).
    groups: groupsState(convs, sources, superseded),
    // Bandeau d'onboarding (lot 2026-08-19) : deux booléens INDÉPENDANTS,
    // recalculés à CHAQUE push (fs.existsSync, pas de cache) — le webview
    // masque le bandeau tout seul dès que l'un puis l'autre repasse à true,
    // sans attendre un reload de fenêtre. Même appel que updateSetupContext()
    // pousse aux clés `setContext` : une seule lecture du disque pour les deux
    // consommateurs (webview + contexte VS Code), jamais deux résolutions
    // divergentes.
    setup: updateSetupContext(),
  };
}

// Commande « Claude Convs: Install Hooks » (plan 2026-07-16, lot 2 §2 ;
// portage Node lot onboarding 2026-08-19) : jamais sans consentement
// explicite — l'installeur écrit hors du dossier de l'extension
// (~/.claude/scripts/, ~/.claude/settings.json). Sans hooks, le panneau reste
// utilisable en mode dégradé : les conversations s'affichent quand même
// (transcripts seuls) mais restent en `idle`, faute d'état busy/waiting/done —
// voir state.js `readSessionsState`/`idle` et le tableau des états du README.
//
// Portage Node (2026-08-19) : install.ps1 n'était lancé que via
// execFile('powershell.exe', ...) — absent sur macOS/Linux, le bouton
// échouait purement et simplement sur ces plateformes, pour une extension
// publiée au Marketplace pour tout le monde (poste tiers signalé sans hooks
// ni /handoffs, sans le moindre message). hooks-install.js fait EXACTEMENT ce
// que faisait install.ps1, en Node pur, appelé ici EN PROCESS — plus de
// process enfant, plus d'hypothèse PowerShell. install.ps1 reste dans le
// dossier pour l'usage manuel/scripté (README § Setup) mais n'est plus le
// chemin par défaut de ce bouton.
async function installHooks(context) {
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t('This will deploy Claude Code hooks so the panel can show live conversation state (busy/waiting/done) instead of idle only. It writes to:\n') +
    vscode.l10n.t('• ~/.claude/scripts/ (copies the hook scripts)\n') +
    vscode.l10n.t('• ~/.claude/settings.json (adds a statusLine entry and UserPromptSubmit/Stop/Notification/SessionEnd hooks — a timestamped backup is made first, and only missing entries are added)\n\n') +
    vscode.l10n.t('Continue?'),
    { modal: true },
    vscode.l10n.t('Install hooks')
  );
  if (choice !== vscode.l10n.t('Install hooks')) return;

  let installed = false;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Claude Convs: installing hooks…') },
    async () => {
      try {
        installClaudeHooks({ extensionRoot: context.extensionPath });
        // Le bandeau d'onboarding disparaît tout seul dès la réparation
        // constatée (test principal de la maquette) : hook-session-state.js et
        // handoffs.md existent déjà sur disque à cet instant, pas besoin
        // d'attendre le reload proposé ci-dessous pour que le panneau arrête
        // de dire qu'il manque quelque chose.
        pushPanelState();
        installed = true;
      } catch (err) {
        // SettingsParseError comme toute autre défaillance (fichier source
        // manquant, écriture invalide relue) partagent le même message : dans
        // les deux cas err.message dit déjà quoi faire, cf. hooks-install.js.
        vscode.window.showErrorMessage(vscode.l10n.t('Claude Convs: hook installation failed — {0}', ((err && err.message) || String(err)).trim().slice(0, 500)));
      }
    }
  );
  if (!installed) return;

  // Proposition SÉPARÉE de la philosophie de lot (lot onboarding 4) — APRÈS
  // la fin de la barre de progression des hooks, jamais dedans, jamais dans
  // la même modale : statut différent (requis vs facultatif-conseillé), donc
  // consentement différent. Ne (re)demande jamais toute seule au-delà de la
  // première fois — cf. maybeOfferBatchPhilosophy().
  await maybeOfferBatchPhilosophy(context);

  const pick = await vscode.window.showInformationMessage(
    vscode.l10n.t('Claude Convs: hooks installed. Reload the window for the panel to pick up live conversation state.'),
    vscode.l10n.t('Reload Window')
  );
  if (pick === vscode.l10n.t('Reload Window')) vscode.commands.executeCommand('workbench.action.reloadWindow');
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

// Règle de création d'un groupe (lot A, plan « master conv isolée »
// 2026-08-09) — PURE, testable sans mock vscode (cf. test-batch-notice.js).
// `tasks.length > 1` groupe toujours (décision 3 du plan groupes) ; pour une
// tâche unique, un groupe ne naît que s'il a une RAISON (décision 5 du plan
// isolée) : nom de groupe explicite, ou maîtresse résolue. Une tâche unique
// tapée à la main sans l'un ou l'autre reste une ligne plate.
function shouldCreateGroup(taskCount, groupName, hasMasterCandidate) {
  if (taskCount > 1) return true;
  if (taskCount !== 1) return false;
  return !!groupName || !!hasMasterCandidate;
}

// Décision de chaînage (lot 3, plan gel-tabs) — PURE, testable sans mock
// vscode (même style que `shouldCreateGroup`) : étant donné les groupes déjà
// RENDUS (sortie de `groupsState` — `done` et `master` déjà résolus par
// nesting.js, rôle inter-groupes compris) et le sessionId candidat, quel
// groupe vivant, s'il existe, doit accueillir ce Create au lieu d'en fonder
// un nouveau. Un groupe qui a CÉDÉ sa maîtresse à plus récent que lui rend
// `master: null` (canon « une maîtresse n'engage que son dernier lot ») et ne
// peut donc jamais matcher ici — un seul groupe vivant peut revendiquer la
// tête d'une conversation donnée à un instant donné.
function findChainTarget(renderedGroups, sessionId) {
  if (!sessionId) return null;
  return (renderedGroups || []).find((g) => !g.done && g.master && g.master.convId === sessionId) || null;
}

// Même dérivation que `buildPanelState`, recalculée à la demande pour un état
// forcément à jour : createBatch tourne avant tout push.
function findLiveMasterGroup(sessionId) {
  if (!groupStore || !stateEngine || !sessionId) return null;
  const superseded = currentSuperseded();
  const convs = conversationsState();
  const convById = new Map(convs.map((c) => [c.id, c]));
  const sources = memberSources((id) => convById.get(id));
  const rendered = groupsState(convs, sources, superseded);
  return findChainTarget(rendered, sessionId);
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

  // Conversation maîtresse (lot 11, résolution détachée de l'enregistrement
  // depuis le plan « master conv isolée » 2026-08-09) : cherchée ICI, AVANT la
  // création du groupe — un batch d'une seule tâche n'a pas encore de groupe
  // à ce stade, et c'est justement elle qui peut décider d'en créer un (lot
  // A). Le webview ne transmet le texte collé QUE lorsqu'il a reconnu un bloc
  // claude-convs valide (plan : « au collage d'un bloc VALIDE ») ; sans lui,
  // aucune recherche n'a lieu.
  const masterCandidate = resolveMasterCandidate(msg && msg.paste, msg && msg.session);

  // Lot 3 (plan gel-tabs, 2026-08-17) : une maîtresse déjà en tête d'un
  // groupe VIVANT n'en fonde jamais un second, concurrent — c'est ce que
  // faisait 2.39.0 depuis qu'il a remplacé le refus de double revendication
  // par « le dernier lié prend la tête » (`masterLinkedAt`, canon plus haut) :
  // correct pour le RENDU d'un store multi-revendiqué, pas pour un CREATE, qui
  // fabriquait un batch concurrent volant la maîtresse au batch précédent. Le
  // bloc s'enchaîne à la suite de ce groupe à la place, mêmes garanties que
  // le « + nouvelle vague » (`addTasksToGroup`) ; le cas SANS maîtresse ou
  // avec un groupe déjà DONE retombe sur le comportement normal ci-dessous.
  const chainGroup = masterCandidate ? findLiveMasterGroup(masterCandidate.sessionId) : null;
  if (chainGroup) {
    const rawGroup = groupStore.get(chainGroup.id);
    if (rawGroup) {
      const appendAfter = rawGroup.members.reduce((max, m) => Math.max(max, m.wave), 0);
      const remapped = appendTasksAfterWave(tasks, appendAfter);
      let added = false;
      for (const task of remapped) {
        if (groupStore.addTask(chainGroup.id, task, task.wave)) added = true;
      }
      if (added) {
        // Rien ne se lance ici : les tâches naissent `queued` (groups.js), le
        // moteur de vagues existant les ouvre à son rythme — décision 2 du
        // plan (« une vague déjà finie → prochain battement »).
        maybeAdvanceWaves();
        batchStatus = {
          busy: false,
          notice: chainGroup.stamp
            ? vscode.l10n.t('Added after batch {0}.', chainGroup.stamp)
            : vscode.l10n.t('Added to the existing batch.'),
        };
        pushPanelState();
        return;
      }
    }
  }

  const wave1 = tasks.filter((t) => t.wave === 1);
  batchStatus = { busy: true, notice: vscode.l10n.t('Opening {0} conversation(s)…', wave1.length) };

  // LE FORMULAIRE EST LE GROUPE (décision 3 du plan) — sauf pour une tâche
  // unique, où un groupe n'apporte que du chrome SANS RAISON : il ne naît
  // que si le formulaire porte un nom de groupe explicite OU qu'une maîtresse
  // a été résolue (plan « master conv isolée » 2026-08-09, décision 5). Une
  // tâche unique tapée à la main sans l'un ou l'autre reste une ligne plate,
  // comme avant ce lot.
  //
  // Le groupe est créé AVANT le lancement, avec TOUTES les tâches (vagues à
  // venir comprises) : les ouvertures sont sérialisées et prennent une seconde
  // chacune, l'utilisateur doit voir tout de suite ce qu'il vient de demander.
  // Ses membres de la vague 1 naissent sans sessionId (« pas encore lancé »)
  // et se rattachent au fil des étages 1 puis 2 ; ceux des vagues suivantes
  // naissent `queued` (groups.js) tant que leur vague n'est pas ouverte.
  const groupName = msg && msg.groupName;
  const group = shouldCreateGroup(tasks.length, groupName, masterCandidate) && groupStore
    ? groupStore.create(groupName, tasks)
    : null;
  // Enregistrement (effet de bord seul, plus de résolution ici) : la capsule
  // d'en-tête (étape 3 du plan repli-auto) montre déjà titre + point d'état
  // de la maîtresse, pas besoin de relire son retour.
  if (group && masterCandidate) groupStore.setMaster(group.id, masterCandidate.sessionId, masterCandidate.title);
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
  const staticSuffix = buildBatchStaticSuffix({ unlinked, grouped: !!group, fallbackAt: result.fallbackAt });

  batchLastLaunch = {
    total: result.total,
    trackedSessionIds: result.launched.filter((r) => r.sessionId).map((r) => r.sessionId),
    staticSuffix,
    // Hint discret (lot 7, livrable 3 ; déplacé en tooltip par le plan
    // repli-auto étape 6) : la limite cosmétique du menu officiel (son
    // sélecteur d'effort se cale sur le modèle par défaut PERSISTÉ tant que
    // le premier tour n'a pas tourné, cf. README « Known limitations »). N'est
    // plus jamais concaténé au texte courant — panel.js le pose en `title`
    // du notice, jamais en texte visible en permanence.
    hint: vscode.l10n.t('The official menu may briefly show the wrong model/effort until the first turn — this panel’s model · effort badges are the real state.'),
    // Identité du groupe décrit par ce notice (plan repli-auto étape 6,
    // « cycle de vie ») : sans elle, un groupe dissous/purgé laisse son
    // texte affiché pour un objet qui n'existe plus — purgeStaleBatchLaunch()
    // la relit à chaque push pour effacer le notice au bon moment. `null`
    // pour un batch sans groupe (tâche unique) : rien à surveiller.
    groupId: group ? group.id : null,
  };
  // Le texte VIVANT (« appuyez sur Entrée », « lien perdu ») est recalculé à
  // chaque push par composeBatchNotice, juste en dessous — le FIGER ici en
  // faisait un zombie : dès que la source du calcul disparaît (lot purgé avec
  // son groupe, ou aucune session tracée), computeBatchNoticeFromLaunch
  // retombe sur ce `fallback` et prescrit « appuyez sur Entrée dans son
  // onglet » pour une conversation qui a envoyé depuis des heures — constat
  // user 2026-08-18, exactement la classe d'erreur que member-truth.js
  // documente déjà six fois (un état posé une fois, jamais réconcilié).
  // `batchStatus.notice` ne garde donc plus que le CONSTAT statique, celui
  // qu'aucun recompute ne saurait reproduire (tâches jamais identifiées,
  // arrêt en cours de lot) : un constat périmé est muet, une prescription
  // périmée envoie l'utilisateur chercher un onglet qui n'existe pas.
  batchStatus = { busy: false, notice: staticSuffix.trim() || null };
  pushPanelState();
}

// Partie STATIQUE du message de « Create » (plan repli-auto étape 6) :
// réduite à l'ACTIONNABLE — nom de groupe, maîtresse et progression des
// vagues sont déjà montrés par la capsule d'en-tête (étape 3) ; les répéter
// ici serait le même doublon d'affichage que l'anti-doublon des NOTES de
// member-truth.js. Ne restent que les faits qu'aucun autre élément du
// panneau ne dit déjà : tâches jamais identifiées, arrêt en cours de lot.
// Pure (aucun état de module) : testable directement, cf. test-batch-notice.js.
function buildBatchStaticSuffix({ unlinked, grouped, fallbackAt }) {
  let s = '';
  // Depuis le lot 2, « pas de fichier de session » n'est plus un cul-de-sac :
  // l'étage 2 réessaie par le prompt dès que la conversation a démarré, et
  // l'étage 3 (« Link… ») reste disponible dans le groupe.
  if (unlinked) {
    s += grouped
      ? vscode.l10n.t(' {0} not identified yet — they will link themselves once started, or use “Link…” in the group.', unlinked)
      : vscode.l10n.t(' {0} could not be identified (no session file) — model/effort mismatch badge unavailable for those.', unlinked);
  }
  if (fallbackAt != null) s += vscode.l10n.t(' Stopped at task {0} — see the message above.', fallbackAt + 1);
  return s;
}

// Un groupe dissous ou purgé ne doit plus porter le notice qui le décrivait
// (plan repli-auto étape 6, « cycle de vie ») — classe d'erreur connue du
// projet : un état d'affichage posé une fois, jamais invalidé par la
// disparition de son objet (member-truth.js en documente 5 précédents). Le
// cas « tout est parti » (plus aucun membre pending/lost) s'efface déjà tout
// seul via computeBatchNoticeFromLaunch (pending === 0 && !lost → null) —
// celui-ci couvre le cas RESTANT : le groupe disparaît alors que des membres
// sont encore trackés. `groupExists` est injecté (jamais `groupStore` lu
// directement) pour rester testable sans mock vscode.
//
// Étape 14 — CARTOGRAPHIE des sorties de `batchLastLaunch` (le constat était :
// « 0/2 conversation(s) opened — press Enter » qui persiste sur des onglets
// qui n'existent plus). Toutes les façons dont le monde change sous ce
// notice, et ce qui les couvre déjà :
//   1. Un membre envoie son premier message → `sent` monte (hasTranscript/vue),
//      couvert par le recompte de computeBatchNoticeFromLaunch à chaque push.
//   2. Tous les membres ont envoyé → `pending === 0 && lost === 0` → `null`
//      (déjà couvert, cf. tests 5/10).
//   3. Le groupe qui portait ce lot est dissous ou purgé (⨯ explicite) →
//      `shouldPurgeBatchLaunch` (ci-dessous) → `batchLastLaunch = null`.
//   4. Un membre retiré via ✕ vide le groupe de son dernier membre →
//      `groups.js` `removeMember` dissout lui-même (`dissolve(id)`) → même
//      chemin que le cas 3, rien de plus à coder ici.
//   5. Un onglet `inserted` (prompt jamais envoyé) se ferme et son process CLI
//      meurt → le membre devient `unsent-lost` (member-truth.js) : il sort de
//      `pending`, entre dans `lost`. AVANT ce lot, le texte affiché pour ce
//      cas restait « press Enter in its tab (if still open) » — une
//      prescription sur un onglet dont on ne sait justement plus rien une
//      fois `pending === 0` (aucun membre n'est plus PROUVÉ `inserted`/vivant).
//   6. Un lot SANS groupe (tâche unique, `groupId === null`) dont l'unique
//      tâche devient `unsent-lost` : `relaunchMember`/`linkMember`
//      (panel.js, relaunchChip/linkChip) et le ré-appariement automatique
//      (`attachPendingMembers` ci-dessus, qui ne lit QUE `groupStore.pending()`
//      /`pendingForRelink(groupStore.all(), …)`) sont des mécanismes DE
//      GROUPE — un lot ungrouped n'a ni bouton ni ré-appariement pour un lien
//      mort-né. Avant ce lot, le texte promettait quand même « use Relaunch »
//      dans ce cas : une action qui n'existe nulle part dans l'UI.
//
// Les cas 5 et 6 n'avaient pas de case dédiée : ils partageaient la branche
// « pending === 0 && lost > 0 » du texte, qui écrivait une prescription fixe
// sans vérifier si elle restait possible. Invariant qui les remplace (voir
// computeBatchNoticeFromLaunch) : chaque PHRASE du notice n'apparaît que si
// l'action qu'elle prescrit est encore possible — « press Enter » exige un
// membre PROUVÉ `inserted` (pending > 0, cas 5 exclu) ; « lien perdu » exige
// en plus un groupe pour porter le remède (lost > 0 && groupId, cas 6 exclu).
// Aucune action possible du tout → aucune phrase → `null`, le notice
// disparaît au lieu de prescrire dans le vide.
function shouldPurgeBatchLaunch(launch, groupExists) {
  return !!(launch && launch.groupId && !groupExists(launch.groupId));
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
    // Onglet PROUVÉ fermé (étape 17) : `stateEngine` le sait EN DIRECT — c'est
    // lui qui pose `closedAt` dès l'événement d'onglet (closeConversations →
    // markClosed), avant même que le registre des sessions ou les hooks aient
    // eu le temps de purger leur propre trace. Sans ce signal, member-truth
    // retombe sur la course hooks/registre (bug n°6, cf. member-truth.js).
    // …complété par l'onglet prouvé ABSENT du dernier snapshot (2026-08-24) :
    // `isTabClosed` ne connaît que les fermetures observées EN DIRECT, donc ni
    // celles faites pendant que la fenêtre était éteinte, ni le cas du process
    // orphelin (un CLI survit à son onglet — cf. CLAUDE.md du dossier). Sans
    // ça, un membre de lot restait « ouverte » indéfiniment et retenait son lot
    // à l'écran alors que la conversation, elle, avait bien quitté la liste.
    tabClosed(id) {
      if (!stateEngine) return false;
      if (typeof stateEngine.isTabClosed === 'function' && stateEngine.isTabClosed(id)) return true;
      return !!(typeof stateEngine.isTabGone === 'function' && stateEngine.isTabGone(id));
    },
  };
}

function computeBatchNoticeFromLaunch(launch, convs, aliveIds, fallback, hasTranscript) {
  if (!launch) return fallback;
  // `total` n'est plus lu depuis 2026-08-15 (le texte compte le reste à faire,
  // pas une progression) — le champ reste posé par launchBatch, personne ne le
  // déstructure plus ici.
  const { trackedSessionIds, staticSuffix, groupId } = launch;
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
  // locale : « en attente d'Entrée » = statut `inserted`, « lien perdu sans
  // rien envoyer » = `unsent-lost`, tout le reste a envoyé (et n'est plus
  // compté depuis 2026-08-15, cf. le segment « pas encore envoyée » ci-dessous).
  // Les trois autres consommateurs répondent exactement pareil.
  let pending = 0, lost = 0;
  for (const id of trackedSessionIds) {
    const t = memberTruth({ sessionId: id, launchedAt: 1 }, sources);
    if (t.status === 'inserted') pending++;
    else if (t.status === 'unsent-lost') lost++;
  }

  // Invariant (étape 14, cf. commentaire de shouldPurgeBatchLaunch juste
  // au-dessus pour la cartographie complète) : chaque segment du notice
  // n'est écrit que si l'action qu'il prescrit est encore possible. Deux
  // segments indépendants, jamais une chaîne de `if` qui statue sur le
  // message ENTIER à la place d'une seule phrase à la fois.
  const segments = [];
  // « press Enter » : exige un membre PROUVÉ `inserted` (live && !sent). Un
  // `unsent-lost` n'en fait plus partie par définition (son process est
  // mort) — pending === 0 signifie qu'aucun onglet n'est plus prouvé ouvert,
  // donc plus aucune raison d'écrire cette phrase.
  //
  // Ce que la phrase COMPTE (2026-08-15, demande user) : le RESTE À FAIRE,
  // jamais une progression « sent/total ». Un « 0/1 » posait une devinette là
  // où il n'y a qu'une action — et son total, figé au lancement de la vague 1,
  // devenait faux dès qu'une vague suivante ouvrait ses propres onglets
  // (cf. mergeLaunchedWaveMembers). `pending` est le seul nombre que le
  // panneau puisse prouver à l'instant : des onglets vivants qui n'ont rien
  // envoyé. Singulier/pluriel séparés, comme le segment « lien perdu ».
  if (pending > 0) {
    segments.push(pending > 1
      ? vscode.l10n.t('{0} conversations not sent yet — press Enter in their tabs.', pending)
      : vscode.l10n.t('{0} conversation not sent yet — press Enter in its tab.', pending));
  }
  // « lien perdu » : exige au moins un `unsent-lost` ET un groupe pour porter
  // son remède — relaunchChip/linkChip (panel.js) et le ré-appariement
  // automatique (attachPendingMembers, groupStore.pending()/pendingForRelink)
  // sont tous les trois des mécanismes DE GROUPE. Un lot ungrouped
  // (`groupId === null`, tâche unique) n'a rien de tout ça : mentionner
  // « Relancer » y promettrait un bouton qui n'existe nulle part.
  if (lost > 0 && groupId) {
    segments.push(lost > 1
      ? vscode.l10n.t('{0} tasks lost their link before sending — use “Relaunch”.', lost)
      : vscode.l10n.t('{0} task lost its link before sending — use “Relaunch”.', lost));
  }
  // Rien d'actionnable du tout (ex. lot ungrouped entièrement unsent-lost) :
  // aucun segment, aucun texte — le notice s'efface au lieu de prescrire dans
  // le vide, exactement le symptôme constaté (onglets qui n'existent plus).
  if (!segments.length) return null;
  // `staticSuffix` ne décrit que ce qui accompagne « press Enter » (non
  // identifiés, arrêt en cours de lot, cf. buildBatchStaticSuffix) — il ne
  // s'accroche donc qu'à ce segment, comme avant ce lot.
  return segments.join(' ') + (pending > 0 ? staticSuffix : '');
}

// Un lot à plusieurs vagues OUVRE des conversations longtemps après son
// « Create » : `trackedSessionIds` est figé sur la vague 1 (launchBatch), et
// launchWaveForGroup rattache les vagues suivantes au GROUPE sans jamais les y
// ajouter. Le bandeau décrivait donc une vague révolue pendant qu'un onglet
// fraîchement ouvert attendait son Entrée — constat user 2026-08-15 : « une
// nouvelle conv "non envoyé" apparaît, mais le label ne se met pas à jour ».
//
// Même classe d'erreur que les cinq déjà documentées en tête de
// shouldPurgeBatchLaunch : un état posé une fois, jamais réconcilié avec le
// monde qui bouge dessous. La parade est de ne plus jamais faire confiance à
// la liste de naissance : les membres LANCÉS du groupe (`launchedAt != null`,
// posé par markLaunched avant même l'ouverture) sont la seule source qui suive
// le lot dans le temps. On les UNIT à la liste d'origine plutôt que de la
// remplacer — un lot sans groupe (tâche unique) n'a que celle-là.
//
// Pure et injectée (jamais `groupStore` lu ici) : testable sans VS Code.
function mergeLaunchedWaveMembers(launch, members) {
  if (!launch) return launch;
  const ids = new Set(launch.trackedSessionIds || []);
  const before = ids.size;
  for (const m of members || []) {
    if (m && m.sessionId && m.launchedAt != null) ids.add(m.sessionId);
  }
  // Même jeu d'identifiants → on rend l'objet d'origine (pas de copie inutile
  // à chaque push, et l'identité de `batchLastLaunch` reste comparable).
  if (ids.size === before) return launch;
  return { ...launch, trackedSessionIds: [...ids] };
}

// `sources` = celles du recompute en cours (buildPanelState) quand il y en a —
// sinon on en fabrique : ce chemin sert aussi juste après un « Create », hors
// de tout push.
function composeBatchNotice(convs, sources) {
  const s = sources || memberSources();
  const g = batchLastLaunch && batchLastLaunch.groupId && groupStore
    ? groupStore.get(batchLastLaunch.groupId)
    : null;
  return computeBatchNoticeFromLaunch(
    mergeLaunchedWaveMembers(batchLastLaunch, g && g.members),
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
// pour chaque groupe dont la vague courante vient de se terminer ENTIÈREMENT,
// ouvre la suivante — toujours automatique (pas de toggle manuel).
// `waveToAutoLaunch` (waves.js) garantit structurellement de ne jamais sauter
// plus d'une vague d'avance.
//
// Verrou de stabilisation (incident 2026-08-17, cf. advanceGate dans waves.js) :
// plus de lancement sur une lecture instantanée — la vague doit rester prête
// WAVE_STABLE_MS d'affilée, toute rechute désarme. Les recomputes sont
// événementiels (fs.watch) : une fois la vague vraiment finie, plus rien
// n'écrit et plus rien ne tire — d'où le timer d'échéance, qui rappelle cette
// fonction quand l'armement le plus proche arrive à maturité.
const waveGates = new Map(); // groupId → { wave, since }
let waveGateTimer = null;
function maybeAdvanceWaves() {
  if (!groupStore || !stateEngine) return;
  const snap = stateEngine.getSnapshot();
  const convs = snap.conversations;
  const superseded = snap.supersededBy || {};
  const byId = new Map(convs.map((c) => [c.sessionId, c]));
  const sources = memberSources((id) => byId.get(id));
  const now = Date.now();
  let nextDue = null;
  for (const g of groupStore.all()) {
    // Membres redirigés (husk→successeur) : une vague ne se déclare pas
    // « terminée » sur un husk mort alors que la conv a repris et travaille.
    const members = g.members.map((m) => ({ wave: m.wave, status: memberTruth(redirectMember(m, superseded), sources).waveStatus }));
    const gate = advanceGate(waveGates.get(g.id), waveToAutoLaunch(members), now);
    if (gate.pending) {
      waveGates.set(g.id, gate.pending);
      const due = gate.pending.since + WAVE_STABLE_MS - now;
      nextDue = nextDue == null ? due : Math.min(nextDue, due);
    } else {
      waveGates.delete(g.id);
    }
    if (gate.launch != null) launchWaveForGroup(g.id, gate.launch, { auto: true, fromWave: launchedWave(members) });
  }
  // Armements orphelins (groupe supprimé entre deux passes) : purge.
  for (const id of [...waveGates.keys()]) if (!groupStore.get(id)) waveGates.delete(id);
  if (waveGateTimer) { clearTimeout(waveGateTimer); waveGateTimer = null; }
  if (nextDue != null) {
    waveGateTimer = setTimeout(() => { waveGateTimer = null; maybeAdvanceWaves(); }, Math.max(250, nextDue + 50));
  }
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

// Bascule la marque « à relire » d'une conversation (lot 1, plan
// marque-a-relire). Aucune extinction automatique : le seul chemin est ce
// message, déclenché par un clic dans le panneau.
function togglePinConv(id) {
  if (!pinStore || !id) return;
  pinStore.toggle(id);
  // Recompute AVANT le push (lot 3) : la marque ne décore plus seulement une
  // ligne, elle décide de sa PRÉSENCE (state.js `pinnedSessions`). Retirer la
  // marque d'une conversation dont l'onglet est fermé doit la faire
  // disparaître tout de suite ; sans ce refresh, `pushPanelState` republierait
  // le snapshot en cache — celui d'avant — et la ligne resterait à l'écran
  // jusqu'au prochain événement sans rapport.
  if (stateEngine) stateEngine.refresh();
  pushPanelState();
}

// Rouvrir une conversation dont l'onglet est fermé — le clic sur une ligne
// retenue par sa seule marque (`tabGone`, lot 3). `focusConv` ne peut rien pour
// elle : il cherche un onglet par libellé, ici il n'y en a plus AUCUN, et le
// clic était un no-op silencieux. `claude-vscode.editor.open(sessionId)` est la
// seule commande de l'extension officielle qui accepte un identifiant de
// session (NOTES_api_claude_code_extension.md) ; elle rouvre la conversation
// telle quelle, sans prompt inséré.
//
// PAS de `markProgrammaticOpen` ici, à la différence du lanceur de lots : cette
// ouverture EST un clic de l'utilisateur (ack.js ne doit la confondre avec rien
// d'autre — cf. le commentaire du hook `executeCommand` de batchLauncher, « les
// commandes qui ouvrent un onglet PROGRAMMATIQUEMENT, jamais un clic »).
function reopenConv(id) {
  if (!id) return;
  Promise.resolve(vscode.commands.executeCommand(LAUNCH_OPEN_COMMAND, id))
    .then(() => { if (stateEngine) stateEngine.refresh(); })
    .catch((e) => console.log('[QuotaBar] reopen %s failed: %s', id, e && e.message));
  ackConversationById(id);
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

// Transfert d'un bloc claude-convs multi-tâches DANS un groupe existant (plan
// repli-auto étape 10) : équivalent de cliquer « + nouvelle vague » une fois
// par tâche du bloc, sans les suppressions manuelles que ça demandait avant
// (constat du plan — 4 tâches/4 vagues = 4 allers-retours). Le webview a déjà
// affiché la confirmation et résolu modèle/effort par section (`group:`/
// `session:` du bloc y sont déjà ignorés, le groupe cible a les siens) ; il
// envoie des vagues RELATIVES (1..M, contiguës, mêmes garanties que
// createBatch) — normalizeTasks les redéfend (modèle/effort, jamais la vague :
// une suite déjà contiguë depuis 1 ne bouge pas sous son renumérotage), puis
// appendTasksAfterWave les décale sur le SEUL état à jour du groupe (le
// webview a pu recevoir un state périmé entre son rendu et ce clic).
function addTasksToGroup(msg) {
  if (!groupStore) return;
  const id = msg && msg.id;
  const g = groupStore.get(id);
  if (!g) return;
  const kept = normalizeTasks(msg && msg.tasks, readInheritSettings());
  if (!kept.length) return;
  const appendAfter = g.members.reduce((max, m) => Math.max(max, m.wave), 0);
  const remapped = appendTasksAfterWave(kept, appendAfter);
  let added = false;
  for (const task of remapped) {
    if (groupStore.addTask(id, task, task.wave)) added = true;
  }
  if (!added) return;
  maybeAdvanceWaves();
  pushPanelState();
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

// Chip « Relancer » (plan lien-mort-né 2026-08-04) : le remède quand le lien
// est mort-né ET que l'onglet, lui, est vraiment parti — le re-lien automatique
// de l'étage 2 attend un Entrée qui ne viendra jamais. Tout ce qu'il faut pour
// rouvrir la tâche est dans le store (prompt, modèle, effort, vague), donc on
// rejoue exactement le chemin d'une vague : launch → attach → intention.
//
// LA GARDE : la vérité est recalculée ICI, à l'instant, sur des sources
// fraîches. Le webview a pu être rendu il y a plusieurs secondes ; entre-temps
// l'utilisateur a très bien pu appuyer sur Entrée dans l'onglet orphelin (le
// re-lien s'est alors fait tout seul). Relancer là-dessus ouvrirait un doublon
// et écraserait un lien vivant — exactement le genre de faute que ce chantier
// supprime.
async function relaunchMember(id, key) {
  if (!groupStore || !batchLauncher) return;
  const g = groupStore.get(id);
  const m = g && g.members.find((x) => x.key === key);
  if (!m) return;

  const convs = stateEngine ? stateEngine.getSnapshot().conversations : [];
  const byId = new Map(convs.map((c) => [c.sessionId, c]));
  const truth = memberTruth(redirectMember(m, currentSuperseded()), memberSources((sid) => byId.get(sid)));
  if (truth.status !== 'unsent-lost') return;

  const at = Date.now();
  if (!groupStore.rearm(id, key, at)) return;
  waveNotices.delete(id);
  pushPanelState();

  let result;
  try {
    result = await batchLauncher.launch([{ prompt: m.prompt, model: m.model, effort: m.effort, wave: m.wave }]);
  } catch (e) {
    waveNotices.set(id, vscode.l10n.t('Could not reopen the task — {0}.', (e && e.message) || vscode.l10n.t('unknown error')));
    pushPanelState();
    return;
  }

  // Étage 1 : le registre a rendu l'identité tout de suite. Sinon (repli
  // presse-papier, fichier de session en retard) le membre reste « en attente »
  // et l'étage 2 le rattrapera au premier Entrée — le cas normal, pas un échec.
  const r = result.launched && result.launched[0];
  if (r && r.sessionId) {
    intentStore.record(r.sessionId, { model: m.model, effort: m.effort });
    groupStore.attach(id, key, r.sessionId);
  }
  pushPanelState();
}

async function addToGroup(id) {
  if (!(groupStore && groupStore.get(id))) return;
  const sessionId = await pickConversation(vscode.l10n.t('Add a conversation to this group'));
  if (!sessionId) return;
  const conv = stateEngine.getSnapshot().conversations.find((c) => c.sessionId === sessionId);
  if (groupStore.addExisting(id, sessionId, (conv && conv.title) || '')) pushPanelState();
}

// ── Conversation maîtresse — ⌂-focus (plan repli-auto étape 9) ─────────────
// Remplace l'ancien QuickPick set/change/unlink (lot 11) : le bouton ⌂ n'est
// visible côté webview que quand le groupe N'A PAS de master (garde répétée
// ici, défensive — un double message ou un double clic ne doit pas écraser un
// lien déjà posé). Un clic lie DIRECTEMENT l'onglet VS Code actif de CETTE
// fenêtre : aucune saisie, aucun choix dans une liste — la seule décision
// possible est l'échec propre. Trois garde-fous, dans l'ordre du plan :
//   1. onglet non-Claude (ou aucun onglet actif) → no-op + message ;
//   2. résolution ambiguë (0 ou ≥2 conversations correspondent au libellé de
//      l'onglet actif) → no-op + message, jamais un lien deviné ;
//   3. refus du store (déjà membre de CE groupe) → relayé, pas avalé en
//      silence.
// `localActiveLabel()` (tabs.js), pas `tabTracker.getTabs().activeLabel` : ce
// dernier RESTE sur le dernier onglet Claude vu tant qu'on n'en revisite pas
// un autre (c'est voulu pour le surlignage) — le ⌂-focus a besoin de la
// vérité instantanée, sinon un onglet fichier actif lierait la conv d'avant.
async function setGroupMaster(id) {
  const g = groupStore && groupStore.get(id);
  if (!g || g.masterSessionId || !stateEngine) return;
  const activeLabel = localActiveLabel();
  if (!activeLabel) {
    vscode.window.showInformationMessage(vscode.l10n.t('Claude Convs: the active tab is not a Claude conversation.'));
    return;
  }
  const matches = stateEngine.getSnapshot().conversations.filter((c) => convMatchesLabel(activeLabel, c));
  if (matches.length !== 1) {
    vscode.window.showInformationMessage(matches.length > 1
      ? vscode.l10n.t('Claude Convs: the active tab matches more than one conversation — cannot link automatically.')
      : vscode.l10n.t('Claude Convs: could not identify the conversation in the active tab.'));
    return;
  }
  const conv = matches[0];
  if (!groupStore.setMaster(id, conv.sessionId, conv.title || '')) {
    vscode.window.showInformationMessage(vscode.l10n.t('Claude Convs: this conversation is already a member of this group.'));
    return;
  }
  pushPanelState();
}

// Rattachement d'une conversation déjà lancée (lot B, plan « master conv
// isolée » 2026-08-09) — bouton overlay hover-only d'une ligne PLATE
// (panel.js createRow). Symétrique de `setGroupMaster` : là-bas l'onglet actif
// devient la maîtresse d'UN GROUPE DÉJÀ LÀ ; ici, `id` désigne la conversation
// CIBLE (celle sous le survol), et l'onglet actif désigne la maîtresse d'un
// groupe qui N'EXISTE PAS ENCORE — il naît ici, avec la cible comme seul et
// unique membre. Même doctrine partout : aucune saisie, aucune liste,
// l'onglet actif tranche, tout le reste est un no-op + message.
async function linkConvToActiveMaster(id) {
  if (!groupStore || !stateEngine || !id) return;
  const activeLabel = localActiveLabel();
  if (!activeLabel) {
    vscode.window.showInformationMessage(vscode.l10n.t('Claude Convs: the active tab is not a Claude conversation.'));
    return;
  }
  const matches = stateEngine.getSnapshot().conversations.filter((c) => convMatchesLabel(activeLabel, c));
  if (matches.length !== 1) {
    vscode.window.showInformationMessage(matches.length > 1
      ? vscode.l10n.t('Claude Convs: the active tab matches more than one conversation — cannot link automatically.')
      : vscode.l10n.t('Claude Convs: could not identify the conversation in the active tab.'));
    return;
  }
  const master = matches[0];
  if (master.sessionId === id) {
    vscode.window.showInformationMessage(vscode.l10n.t('Claude Convs: a conversation cannot be its own master.'));
    return;
  }
  // Un seul refus, et il ne porte QUE sur la cible (plan « la maîtresse
  // n'engage que son dernier lot », 2026-08-15) : le groupe naît ci-dessous
  // avec elle pour unique membre, or `create()` pose le sessionId directement,
  // sans passer par la garde d'unicité d'`attach()` — une conv membre de deux
  // groupes, ce sont deux lignes pour une seule conversation.
  //
  // Ce qui ne se refuse PLUS : que l'une des deux soit déjà MAÎTRESSE ailleurs
  // (c'était `claimedIds`, qui mélangeait les deux revendications). Une conv de
  // cadrage revendiquée par plusieurs lots est le cas nominal — elle enchaîne
  // les batchs — et la règle donne la tête au lien le plus récent, donc à
  // celui-ci : le lot précédent cède au RENDU, il n'est pas délié. Refuser ici
  // privait le geste de son usage même (re-pointer une maîtresse) et laissait
  // le store dire une chose que le panneau ne savait plus montrer. Que la
  // maîtresse soit MEMBRE d'un autre lot est, de même, la filiation nominale.
  const attached = groupStore.attachedIds();
  if (attached.has(id)) {
    vscode.window.showInformationMessage(vscode.l10n.t('Claude Convs: one of these conversations is already part of a group.'));
    return;
  }
  const g = groupStore.create(master.title || '', [{ prompt: '', sessionId: id, wave: 1 }]);
  groupStore.setMaster(g.id, master.sessionId, master.title || '');
  pushPanelState();
}

// Porte de sortie d'un ⌂ posé par erreur (survol de la ligne master, hover-only
// — plan repli-auto étape 9) : dissocie sans confirmation, geste réversible
// (relier ne coûte qu'un clic sur l'onglet voulu). Mêmes métadonnées seules
// que `dissolveGroup` : rien n'est fermé, rien n'est interrompu.
function unlinkGroupMaster(id) {
  if (!groupStore) return;
  if (groupStore.unsetMaster(id)) pushPanelState();
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

// Résolution SEULE (lot A du plan « master conv isolée » 2026-08-09) — aucun
// effet de bord sur groupStore, donc utilisable AVANT qu'un groupe existe :
// c'est elle qui décide, pour un batch d'une seule tâche, si un groupe naît.
// L'ancien `resolveMasterForGroup` faisait les deux (résolution + setMaster)
// et exigeait donc un groupe préexistant — createBatch() applique maintenant
// le setMaster séparément, une fois le groupe (éventuellement) créé.
function resolveMasterCandidate(paste, token) {
  if (!stateEngine || !paste) return null;
  let res;
  try { res = resolveMaster({ pasted: paste, token, candidates: masterCandidates() }); }
  catch { return null; }
  if (!res.sessionId) {
    console.log('[QuotaBar] no master conversation candidate (%s, %d match(es))', res.reason, res.matches);
    return null;
  }
  const conv = stateEngine.getSnapshot().conversations.find((c) => c.sessionId === res.sessionId);
  console.log('[QuotaBar] master conversation candidate = %s (via %s)', res.sessionId, res.via);
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

// Même doctrine que hooksAppearInstalled() ci-dessus, pour le second fichier
// que installClaudeHooks() déploie — indépendant du premier (cf. commentaire
// HANDOFFS_COMMAND_PATH en tête de fichier). fs.existsSync qui échoue (droits,
// chemin exotique) retombe sur `false` : le pire que ça produit est un bouton
// « Install hooks » proposé à tort, jamais un panneau qui ment en disant tout
// va bien.
function handoffsAppearInstalled() {
  try { return fs.existsSync(HANDOFFS_COMMAND_PATH); } catch { return false; }
}

// Même doctrine, pour le fichier de philosophie de lot déposé par
// applyBatchPhilosophy() — un simple signal d'existence, jamais un parse de
// CLAUDE.md à chaque appel : suffisant pour éviter de RE-proposer (cf.
// maybeOfferBatchPhilosophy) sans lire le fichier personnel de l'utilisateur
// en continu.
function batchPhilosophyAppearInstalled() {
  try { return fs.existsSync(BATCH_PHILOSOPHY_MARKER_PATH); } catch { return false; }
}

// Aperçu montré dans la modale de consentement — lu depuis le fichier SOURCE
// à chaque appel, jamais dupliqué en dur ici : ce que l'utilisateur voit
// avant d'accepter est TOUJOURS exactement ce qui sera déposé dans
// ~/.claude/, aucun risque de divergence entre un texte figé dans ce fichier
// et le contenu réellement écrit.
function readBatchPhilosophyPreview(context) {
  try {
    return fs.readFileSync(path.join(context.extensionPath, 'philosophy', BATCH_PHILOSOPHY_FILE), 'utf8').trim();
  } catch { return ''; }
}

// Proposition de la « philosophie de lot » (lot onboarding 4, 2026-08-19) —
// JAMAIS fondue dans la modale des hooks (cf. commentaire de
// BATCH_PHILOSOPHY_MARKER_PATH en tête de fichier : statut différent,
// consentement différent). Le texte qui sera importé dans CHAQUE conversation
// future est montré EN CLAIR avant tout accord (`detail`, le contenu réel du
// fichier), pas seulement la ligne technique qui l'importe — on ne fait pas
// signer à l'aveugle une modification du fichier personnel de l'utilisateur.
// Appelée par la commande Palette, par le lien du walkthrough, et par le
// chaînage optionnel de installHooks() (maybeOfferBatchPhilosophy ci-dessous)
// : toujours le même consentement, jamais un raccourci silencieux.
async function promptBatchPhilosophy(context) {
  const preview = readBatchPhilosophyPreview(context);
  const addIt = vscode.l10n.t('Add it');
  let choice;
  try {
    choice = await vscode.window.showWarningMessage(
      vscode.l10n.t('Claude Convs can add a short "working in batches" note to your personal CLAUDE.md.\n\n') +
      vscode.l10n.t('This is optional — the extension works fully without it — and strongly recommended: it teaches Claude to offer splitting work into several conversations, each with the model and effort that part deserves, instead of doing everything in one costly conversation.\n\n') +
      vscode.l10n.t('It adds one line to ~/.claude/CLAUDE.md: {0}\n\n', BATCH_PHILOSOPHY_IMPORT_LINE) +
      vscode.l10n.t('Add it?'),
      { modal: true, detail: preview },
      addIt
    );
  } catch { choice = undefined; }

  // Refusable SANS CONSÉQUENCE : mémorisé pour ne plus RE-proposer
  // automatiquement après un futur installHooks() (cf.
  // maybeOfferBatchPhilosophy), mais jamais pour retirer la commande de la
  // Palette — un refus ici n'éteint rien d'autre.
  try { context.globalState.update(BATCH_PHILOSOPHY_PROMPT_DISMISSED_KEY, true); } catch {}
  if (choice !== addIt) return;

  try {
    applyBatchPhilosophy({ extensionRoot: context.extensionPath });
    vscode.window.showInformationMessage(vscode.l10n.t('Claude Convs: batching philosophy added to your CLAUDE.md.'));
  } catch (err) {
    vscode.window.showErrorMessage(vscode.l10n.t('Claude Convs: could not add the batching philosophy — {0}', ((err && err.message) || String(err)).trim().slice(0, 500)));
  }
}

// Chaînage optionnel après un install de hooks réussi (installHooks()) —
// jamais un second appel silencieux : batchPhilosophyAppearInstalled() saute
// l'offre si déjà déposé, et le refus mémorisé (BATCH_PHILOSOPHY_PROMPT_
// DISMISSED_KEY) saute toute proposition AUTOMATIQUE ultérieure — la Palette
// et le walkthrough restent le chemin pour qui change d'avis plus tard.
async function maybeOfferBatchPhilosophy(context) {
  if (batchPhilosophyAppearInstalled()) return;
  if (context.globalState.get(BATCH_PHILOSOPHY_PROMPT_DISMISSED_KEY)) return;
  await promptBatchPhilosophy(context);
}

// Pousse les deux signaux d'onboarding vers les clés `setContext` (CTX_HOOKS_
// INSTALLED / CTX_HANDOFFS_INSTALLED, cf. leur commentaire) et retourne les
// mêmes booléens pour buildPanelState() — une seule paire d'appels
// fs.existsSync par push, jamais une pour le contexte et une autre pour le
// webview. `executeCommand('setContext', …)` n'est appelé que sur un
// changement réel (lastHooksCtx/lastHandoffsCtx) : recalculer est gratuit
// (un stat), mais réémettre le même setContext à chaque tick/poll ne le
// serait pas forcément côté hôte VS Code.
function updateSetupContext() {
  const hooksInstalled = hooksAppearInstalled();
  const handoffsInstalled = handoffsAppearInstalled();
  if (hooksInstalled !== lastHooksCtx) {
    lastHooksCtx = hooksInstalled;
    try { vscode.commands.executeCommand('setContext', CTX_HOOKS_INSTALLED, hooksInstalled); } catch {}
  }
  if (handoffsInstalled !== lastHandoffsCtx) {
    lastHandoffsCtx = handoffsInstalled;
    try { vscode.commands.executeCommand('setContext', CTX_HANDOFFS_INSTALLED, handoffsInstalled); } catch {}
  }
  return { hooksInstalled, handoffsInstalled };
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

module.exports = {
  activate, deactivate, computeBatchNoticeFromLaunch, computeLastChoiceFromTasks,
  buildBatchStaticSuffix, shouldPurgeBatchLaunch, shouldCreateGroup,
  mergeLaunchedWaveMembers, findChainTarget,
};
