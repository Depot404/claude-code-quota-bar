// Moteur d'état des conversations (lot 2).
//
// Agrège, pour le workspace courant :
//   - ~/.claude/sessions-state.json  → état posé par les hooks (busy/waiting/done)
//   - ~/.claude/projects/<ws>/*.jsonl → modèle réel, ctx%, titre, activité (mtime)
//   - ~/.claude/active-session.json  → quelle conv a reçu le dernier prompt
//     (repli du surlignage seulement — le surlignage suit l'onglet sélectionné)
//
// Réactif : fs.watch sur les deux dossiers → push instantané, AUCUN poll 5 min
// pour l'état (le poll réseau ne subsiste que pour le quota, dans extension.js).
//
// Aucune dépendance à `vscode` : le workspace est injecté → module testable en
// Node pur (node -e "require('./state.js')...").
//
// Une conv sans onglet ouvert nulle part est masquée (lot 5, cf. isGone) : la
// présence d'onglet est injectée via `tabs`, jamais lue ici — c'est ce qui garde
// le module hors de `vscode`.
//
// API :
//   const { createStateEngine } = require('./state.js');
//   const engine = createStateEngine({ workspacePath, tabs, onChange: (snap) => {} });
//   engine.getSnapshot();        // { conversations: [...], activeSessionId, generatedAt }
//   engine.markClosed([ids]);    // onglets fermés → retrait immédiat
//   engine.dispose();
//   tabs: () => ({ known: boolean, labels: string[], activeLabel: string|null,
//                   activeIndex: number|null, labelChangedAt: number })
//         — union de toutes les fenêtres ; activeLabel = onglet Claude
//           sélectionné dans CETTE fenêtre (surlignage par fenêtre) ;
//           activeIndex = sa POSITION dans `labels` (lot 2 du plan
//           d'appariement, 2026-08-21) — départage deux onglets au libellé
//           identique, ce que le libellé seul ne peut plus faire ;
//           labelChangedAt = dernier changement de valeur d'activeLabel
//           (référence temporelle du juge renderer, 2026-08-27)
//   rendererActive: () => ({ sessionId, claude, flushedAt })
//         — l'éditeur ACTIF au sens du memento du renderer (session-titles.js
//           createRendererActive) : il COMBLE un surlignage vide, cf. le juge
//           dans buildSnapshot (2.106.0). Absent (bancs, base illisible) ⇒
//           juge inactif, verdict par libellés inchangé.
//   liveSessions: () => Set<sessionId>   — sessions CLI vivantes
//         (live-sessions.js ; défaut = le vrai registre ~/.claude/sessions)
//
// Une conversation du snapshot :
//   { sessionId, title, titleSource, state, acked, since, busySince,
//     model, modelId, effort, ctx: {tokens, denom, pct}, message, isActive,
//     tabOpen, tabAmbiguous, transcript, mtime }
//   tabAmbiguous : cette conv appartient à un groupe où l'appariement onglet
//               ↔ conv est arbitraire (mêmes titres tronqués, cf. pairTabs
//               dans labels.js) — signal pour le rendu (lot 3), n'affecte
//               rien ici
//   effort    : effort RÉEL du dernier tour lu dans le transcript (`high`,
//               `medium`…), null quand la conv n'en porte pas
//   title     : ce que l'utilisateur doit lire — le titre du transcript
//               (`ai-title`, sinon un repli : 1er message, dernier prompt)
//   state ∈ busy | waiting | done | stale | idle
//   acked : le ✓ a-t-il été lu (onglet consulté après la fin du tour) — lot 6

const fs = require('fs');
const os = require('os');
const path = require('path');
const { modelIdToDisplay, detectContextWindow } = require('./hooks/model-id.js');
const { usageTokens, extractLastAssistant, extractTitleInfo, scanAiTitleIncremental, pendingInteractiveAt, interruptedAt, lastActivityTs, firstUserText, pendingResumeSignals } = require('./hooks/transcript.js');
const { convMatchesLabel, pairTabs, isPlaceholderTabLabel, labelNamesAnother } = require('./labels.js');
const { removeSession } = require('./hooks/sessions-state.js');
const { liveSessionIds, foreignSessionIds, liveSessionEntries, SESSIONS_DIR } = require('./live-sessions.js');
// Validation EN BLOC de la photo des positions d'onglets (2026-08-29) : même
// juge pour le clic (focus.js) et pour le surlignage — une photo périmée
// acceptée d'un côté et refusée de l'autre remettrait les deux en désaccord.
const { validatePositions } = require('./tab-positions.js');
const { computeSupersededBy } = require('./supersede.js');
const { createCostReader } = require('./cost.js');
const { logEvent, createVerdictFilter } = require('./ack-journal.js');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SESSIONS_STATE_PATH = path.join(CLAUDE_DIR, 'sessions-state.json');
const ACTIVE_SESSION_PATH = path.join(CLAUDE_DIR, 'active-session.json');

// ── Le juge renderer COMBLE un surlignage vide (2.106.0) ────────────────────
// Marge du juge : la vérité renderer (memento du state.vscdb, cf.
// session-titles.js createRendererActive) ne désigne une ligne que si son flush
// est postérieur d'au moins cette marge au dernier changement adopté par le
// tracker d'onglets. Elle couvre l'asynchronisme flush/horloge : un état capturé
// à T peut être écrit à T+ε — sans marge, un geste tombé dans cet ε serait
// « jugé » par un memento qui ne l'a pas vu.
// Marge COURTE parce qu'il n'y a jamais rien à rétrograder : le juge n'entre en
// scène que si le verdict par libellés est MUET (onglet renommé avec le prompt
// de sa tâche, « Claude Code » sans titre — mesuré le 2026-09-02), et combler un
// vide n'écrase aucun choix. C'est la garde `judgeAllowed` de buildSnapshot.
// ⚠️ Ce que l'ancienne marge longue (45 s, 2026-08-27 → 2.110.0) protégeait
// n'existe plus : elle bornait le juge quand il pouvait ÉCRASER un choix
// existant pour corriger un mensonge de la copie miroir — mensonge supprimé en
// amont par VS Code 1.135 (microsoft/vscode#331914). Historique et mesures
// (`flushedAt` est le mtime du FICHIER et ne date pas la clé lue ; jusqu'à 27 s
// de retard) : NOTES_architecture.md.
const RENDERER_TRUTH_FILL_MARGIN_MS = Number(process.env.QUOTABAR_TRUTH_FILL_MARGIN_MS) || 3000;

// Une conv `busy` dont le transcript n'a rien écrit depuis 5 min ET dont le
// process CLI est MORT est un zombie (process tué, crash, VS Code fermé sans
// SessionEnd) → affichée `stale`. Un process encore VIVANT, lui, travaille même
// en silence (longue réflexion, outil long) — cf. busyOrStale.
// Affichage seulement : on ne tue rien (garde-fou du plan).
const STALE_MS = 5 * 60 * 1000;
// Marqueur `compacting` posé par PreCompact (hooks/hook-session-state.js) :
// aucune garantie doc que PostCompact tire (compaction bloquée par un autre
// hook, CLI tué en plein milieu) — au-delà de ce plafond sans levée, on cesse
// de le croire et on retombe sur l'état réel de l'entrée (busy/waiting/done),
// jamais un spinner éternel. Généreux à dessein : une compaction sur un très
// gros historique peut prendre plusieurs minutes ; le vrai filet anti-gel est
// de toute façon la levée au premier UserPromptSubmit/Stop (posée côté hook),
// ce plafond ne couvre que le cas où AUCUN des deux ne survient jamais.
const COMPACTING_CAP_MS = 10 * 60 * 1000;

// Même filet, pour l'autre moitié appariée du spinner : une tâche de fond
// LANCÉE dont la notification de fin n'arrive jamais (agent tué, notification
// passée par un canal non relevé, CLI qui ne réécrit plus ce transcript).
// `pendingResumeSignals` ne peut alors plus jamais se dénouer, et la
// conversation tourne pour l'éternité — mesuré le 2026-08-28 sur la session
// 935cae15 : tâche lancée à 02:07, entrée hooks à `done` depuis 10:30, spinner
// encore en rotation à 10:49 (signalé par l'user, « la conversation est arrêtée
// mais le loading continue de tourner »). Au-delà de ce plafond, le signal
// cesse de tenir l'affichage et l'on retombe sur l'état ÉCRIT par les hooks —
// jamais l'inverse : une tâche vraiment en vol se voit dans le quart d'heure.
// Généreux (les sous-agents les plus longs se comptent en minutes) ; borne
// sautée si le signal n'est pas datable (`0`), comme partout ailleurs ici.
const PENDING_TASK_CAP_MS = 60 * 60 * 1000;

// …et surtout : une tâche de fond ne tient le spinner que tant que la
// conversation DONNE ENCORE SIGNE DE VIE. Mesuré le 2026-08-28, deuxième
// signalement du même symptôme : commande de fond lancée à 11:45, tour terminé
// (hook Stop, `done` ÉCRIT) à 11:53, plus une ligne écrite ensuite — et à 12:01
// la conversation tournait toujours à l'écran alors qu'elle attendait une
// réponse de l'utilisateur. Le plafond d'une heure ne pouvait rien y faire.
// Le raisonnement : quand une tâche de fond se termine VRAIMENT, elle écrit —
// sa notification arrive dans le transcript. Un transcript figé depuis
// plusieurs minutes, avec un `done` posé par le CLI lui-même, ne décrit donc
// pas une conversation au travail. Et si la notification finit par arriver, le
// fichier bouge et la conversation repasse busy d'elle-même : le pire cas de
// cette borne est un ✓ affiché quelques minutes trop tôt, jamais un spinner
// qui ne s'éteint plus.
const PENDING_IDLE_MS = Number(process.env.CLAUDE_QUOTA_PENDING_IDLE_MS) > 0
  ? Number(process.env.CLAUDE_QUOTA_PENDING_IDLE_MS)
  : 5 * 60 * 1000;

// Temps laissé aux CLI respawnés par un rechargement de fenêtre pour republier
// leurs libellés d'onglets avant qu'une ABSENCE de libellé puisse valoir preuve
// de fermeture (cf. `settling` dans buildSnapshot). Même cause et même ordre de
// grandeur que WAVE_ACTIVATION_GRACE_MS (extension.js), qui protège déjà les
// lancements de vagues de cette même tempête ; un cran au-dessus parce que le
// symptôme observé durait « environ une minute ». L'env var ne sert qu'aux
// bancs — attendre 90 s par test serait absurde.
// ⚠️ 2026-09-02 : cette horloge ne couvre plus que le tout début du remontage,
// l'instant où même la liste d'onglets n'est pas encore complète. Le vrai
// remontage, lui, ne se mesure PAS en secondes (cf. `settling`) : un onglet
// restauré attend d'être VISITÉ pour publier son libellé — mesuré à +195 s,
// +237 s, +567 s et +627 s sur quatre rechargements du même jour.
const ACTIVATION_GRACE_MS = Number(process.env.CLAUDE_QUOTA_PRESENCE_GRACE_MS) > 0
  ? Number(process.env.CLAUDE_QUOTA_PRESENCE_GRACE_MS)
  : 90 * 1000;
// Filtre anti-bavardage du journal de surlignage (lot 0) : une extension héberge
// une seule fenêtre, donc un seul verdict à la fois — une clé fixe suffit,
// partagée par tous les appels de buildSnapshot de ce process.
const highlightVerdictFilter = createVerdictFilter();
// Même filtre, même raison, pour la composition de la LISTE (cf. `dropped`
// dans buildSnapshot) : un recompute par écriture de transcript, donc des
// dizaines par minute, et une seule ligne quand la composition change.
const presenceJournalFilter = createVerdictFilter();
// Marge avant de lire une écriture transcript comme une REPRISE du travail
// (après une permission accordée, ou après un Stop qui n'a pas fini le tour).
// Elle absorbe le voisinage immédiat du hook : le dernier message assistant du
// tour s'écrit à quelques centaines de ms du Stop.
const RESUME_GRACE_MS = 2000;
// Entrée d'état sans transcript actif depuis ce délai → on ne l'affiche plus.
const STATE_ENTRY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Onglet fermé (lot 5) : une écriture transcript dans les secondes qui suivent
// est un reliquat de la session qu'on vient de tuer, pas une reprise. Au-delà,
// c'est que la conv est repartie (resume) → elle a le droit de réapparaître.
const CLOSE_GRACE_MS = 10 * 1000;
// Entrée hooks avec un `transcript` renseigné mais dont le FICHIER n'existe pas
// encore (lot 12) : une conv toute neuve peut légitimement précéder de quelques
// secondes la première écriture de son transcript — pas un débris. Au-delà de ce
// délai sans que le fichier apparaisse (session avortée : incident du 2026-07-16,
// entrée jamais suivie d'un transcript), c'est un reliquat → purgé.
const TRANSCRIPT_MISSING_PURGE_MS = 5 * 60 * 1000;

const DEFAULTS = { recentMs: 4 * 60 * 60 * 1000, maxItems: 12, debounceMs: 250, tickMs: 30000 };

// ~/.claude/projects/<dir> : VS Code workspace → nom de dossier projet.
// C:\Users\X\Mes Projets → C--Users-X-Mes-Projets.
//
// Le CLI remplace CHAQUE caractère non alphanumérique par un tiret, un pour un :
// il n'en regroupe jamais deux et ne touche pas à la casse. Vérifié en lui
// faisant fabriquer le dossier d'un chemin témoin (CLI 2.1.235, 2026-08-19) :
//   ...\slug_test.v1 (a)_é+b  →  C--Users-...-slug-test-v1--a----b
// Toute autre classe de caractères fait chercher un dossier qui n'existe PAS,
// donc une liste vide pour toujours, sans le moindre message. La version
// d'avant ne convertissait que les séparateurs et les espaces : un seul `_`,
// point ou accent dans le chemin suffisait à vider le panneau — et s'il était
// dans le nom d'utilisateur Windows (`C:\Users\jean.dupont`), sur TOUS les
// workspaces de la machine à la fois. Invisible ici parce que ce poste travaille
// sous un chemin qui ne contient que des espaces, seul cas où les deux
// dérivations tombent d'accord (signalé 2026-08-19 : panneau vide chez un tiers).
function projectDirFor(workspacePath) {
  if (!workspacePath) return null;
  return path.join(CLAUDE_DIR, 'projects', String(workspacePath).replace(/[^a-zA-Z0-9]/g, '-'));
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function readSessionsState() {
  const s = readJson(SESSIONS_STATE_PATH);
  return s && s.sessions ? s.sessions : {};
}

function readActiveSessionId() {
  const a = readJson(ACTIVE_SESSION_PATH);
  return a && a.session_id ? a.session_id : null;
}

function statMtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

// busy vs zombie : le transcript muet depuis STALE_MS ne suffit PAS à conclure
// au zombie. Un process CLI VIVANT qui n'écrit rien travaille quand même — une
// longue réflexion (extended thinking), ou un outil long (build, WebSearch,
// sous-agent) dont le tool_result n'est pas encore écrit, laisse le mtime figé
// plusieurs minutes. Seul un process MORT fait d'un `busy` muet un `stale`.
// C'est la même exigence que member-truth.js (stale ⇒ session morte) : les deux
// tables de vérité du projet s'accordent enfin sur la définition de `stale`.
// (Incident : conv en pleine réflexion affichée « en sommeil » au bout de 5 min.)
function busyOrStale(mtime, now, isLive) {
  if (isLive) return 'busy';
  return now - mtime > STALE_MS ? 'stale' : 'busy';
}

// Le transcript écrit ENCORE, et il écrit APRÈS le hook : le travail a repris.
// La condition de fraîcheur n'est pas cosmétique — sans elle, une entrée d'état
// ancienne dont la dernière écriture est postérieure de 3 s au hook serait lue
// comme « en train de travailler » pour l'éternité.
// `activity` = timestamp du dernier MESSAGE conversationnel (lastActivityTs),
// jamais le mtime brut quand il est disponible : au reload de la fenêtre, le
// CLI respawné par l'extension officielle appende des lignes de comptabilité
// (`last-prompt`…) qui bougent le mtime sans aucun travail — chaque conv `done`
// non lue affichait alors un spinner pendant STALE_MS (incident 2026-08-07,
// prouvé sur transcript-témoin : dernier assistant à 03:23:07 = le Stop,
// mtime à 03:24:33 = la naissance du CLI respawné).
function isResuming(since, activity, now) {
  return activity > since + RESUME_GRACE_MS && now - activity <= STALE_MS;
}

// État affiché = état posé par les hooks, corrigé par l'activité réelle du
// transcript. Trois corrections indispensables, toutes fondées sur le même
// constat : les hooks disent ce qui s'est passé, le transcript dit ce qui se
// passe.
//  - `waiting` : quand l'user accorde une permission, Claude reprend le travail
//    mais AUCUN hook ne le signale (pas d'événement « permission accordée »).
//    Une écriture transcript postérieure au passage en waiting = reprise.
//  - `done` : le hook Stop tire AUSSI quand le tour continue — Stop hook à
//    feedback (un exit 2 qui relance Claude avec une consigne), message
//    envoyé en cours de tour. La conv affichait alors ✓ en pleine bosse. Même
//    remède : l'écriture postérieure fait foi. Mais le repli est `done`, JAMAIS
//    `stale` : quand les écritures cessent, le tour est bel et bien terminé —
//    prétendre le contraire serait remplacer un faux ✓ par un faux zombie.
//  - `busy` : vieillissement vers `stale` — mais SEULEMENT quand le process CLI
//    est mort (`isLive` faux). Un process vivant qui se tait travaille encore ;
//    cf. busyOrStale. `isLive` est injecté par buildSnapshot depuis le registre
//    des sessions vivantes (live-sessions.js) ; absent (appel unitaire) = faux,
//    donc le comportement d'avant.
// `activityTs` (optionnel) : timestamp du dernier message conversationnel du
// transcript (tail-reader → lastActivityTs), qui remplace le mtime dans les
// détections de REPRISE (waiting/done) — un write de comptabilité du CLI
// respawné ne relance plus un spinner (cf. isResuming). Absent (appel unitaire,
// transcript illisible, message non daté) → repli mtime = comportement d'avant.
// busy→stale reste sur le mtime : là, N'IMPORTE QUELLE écriture est un signe de
// vie, et le doute doit profiter à `busy`.
// `resumeSignals` (optionnel, incident vagues 2026-08-17) : THUNK vers
// pendingResumeSignals du transcript — « la conv va-t-elle reprendre TOUTE
// SEULE ? » (tâche de fond sans notification, réveil ScheduleWakeup à venir).
// Un `done` dans cette situation est un mensonge du point de vue de la TÂCHE :
// le tour est fini, pas le travail — le lot 1 du batch SNCF a rendu la main à
// 13:37:50 en attendant son agent de fond, le moteur de vagues a lu « done »
// et a ouvert la vague 2 sur un lot inachevé. On corrige donc en `busy`, ce
// qui est vrai au sens utile (« elle avance seule, pas la peine d'y aller »),
// et TOUT s'aligne d'un coup : ligne, compteur du chip, moteur de vagues, son
// de fin (différé jusqu'à la VRAIE fin). SEULEMENT si la session est VIVANTE :
// un CLI mort ne recevra jamais sa notification — la conclure « en cours »
// gèlerait la vague pour l'éternité, exactement le travers que member-truth.js
// interdit. Thunk et pas valeur : le scan (4 Mo) ne doit tourner que si on en
// arrive là — jamais pendant qu'une conv écrit (elle est `busy` bien avant).
//
// `startedAt` (optionnel, incident spinner éternel 2026-08-18) : instant (ms
// epoch) de naissance du process CLI VIVANT qui porte cette entrée
// (liveSessionEntries, live-sessions.js). Un lancement de fond ou un réveil
// programmé signalé par le transcript n'est une preuve de reprise QUE pour le
// process qui pourra recevoir sa notification — celui qui l'a posé, ou un
// futur respawn. Un process VIVANT mais NÉ APRÈS ce lancement (reload de
// fenêtre, resume) ne recevra jamais cette notification-là : le lancement est
// un débris de la session précédente, pas une promesse de reprise. Prouvé
// sur transcript réel (347e407a, 2026-08-18) : deux `run_in_background`
// et un sous-agent lancés à 19h45/20h14 la veille, jamais notifiés — le
// process qui lit ce transcript est né à 00:43:37, largement après ; sans
// cette date, `done` restait `busy` pour l'éternité, aucune écriture ne
// pouvant plus jamais réparer un transcript qui n'avance plus. `startedAt`
// absent (session hors registre, appel unitaire) OU signal non daté (`0`) →
// comparaison sautée, comportement d'AVANT cette date — jamais pire.
function effectiveState(entry, mtime, now, isLive, activityTs, resumeSignals, startedAt) {
  // Compaction en cours (cf. COMPACTING_CAP_MS) : force `busy` PAR-DESSUS
  // l'état réel de l'entrée, quel qu'il soit (`done` compris — précompute en
  // tâche de fond entre deux tours, cf. hook-session-state.js). Jamais sans
  // process vivant : un CLI mort ne postera jamais son PostCompact, le
  // croire ferait un spinner éternel sur une conv qui n'ira nulle part.
  if (entry && entry.compacting && isLive && entry.compact_since
    && now - entry.compact_since <= COMPACTING_CAP_MS) return 'busy';
  if (!entry || !entry.state) return 'idle';
  const since = entry.since || entry.updated_at || 0;
  const activity = activityTs || mtime;
  switch (entry.state) {
    case 'waiting':
      return activity > since + RESUME_GRACE_MS ? busyOrStale(mtime, now, isLive) : 'waiting';
    case 'busy':
      return busyOrStale(mtime, now, isLive);
    case 'done': {
      if (isResuming(since, activity, now)) return 'busy';
      if (isLive && typeof resumeSignals === 'function') {
        const rs = resumeSignals();
        if (rs) {
          // ts == null (rien à comparer) ou ts === 0 (présent, non datable) →
          // le doute profite à l'affichage précédent, jamais un blocage neuf.
          const startedAfter = (ts) => startedAt == null || !ts || ts >= startedAt;
          // Plafond de fraîcheur (cf. PENDING_TASK_CAP_MS) : un lancement dont
          // la notification n'est jamais venue ne tient pas le spinner
          // indéfiniment. `wakeupAt` a déjà le sien (une date d'échéance).
          const fresh = (ts) => !ts || now - ts <= PENDING_TASK_CAP_MS;
          // Signe de vie : le transcript a-t-il bougé récemment ? (cf.
          // PENDING_IDLE_MS.) Une conversation figée depuis plusieurs minutes
          // n'est pas au travail, quoi qu'en dise un lancement sans réponse.
          const stirring = now - activity <= PENDING_IDLE_MS;
          const pending = !!rs.pendingTask && startedAfter(rs.pendingTaskAt)
            && fresh(rs.pendingTaskAt) && stirring;
          const sleeping = !!rs.wakeupAt && rs.wakeupAt > now && startedAfter(rs.wakeupSetAt);
          if (pending || sleeping) return 'busy';
        }
      }
      return 'done';
    }
    default:
      return 'idle';
  }
}

// Instant où les hooks ont posé l'état de cette entrée. `since` (réarmé aux
// SEULS changements d'état, cf. sessions-state.js) et jamais `updated_at`, qui
// avance aussi sur une écriture sans rapport — un accusé de lecture, par
// exemple — et rendrait les hooks artificiellement « plus frais » que le
// transcript.
function hookStamp(entry) {
  if (!entry || !entry.state) return 0;
  return entry.since || entry.updated_at || 0;
}

// ── Le transcript corrige l'état AFFICHÉ, jamais l'état brut de l'entrée ──────
//
// Deux faits n'émettent AUCUN hook et ne se lisent que dans le transcript :
// l'interruption manuelle (anthropics/claude-code#45289) et la question
// interactive en attente (AskUserQuestion/ExitPlanMode). Jusqu'au 2026-08-08,
// on ne les appliquait que si l'entrée hooks disait littéralement `busy` — un
// test sur la SOURCE, alors que ce qu'on corrige est le RÉSULTAT.
//
// CE QUI SE PASSAIT (prouvé sur un transcript réel, 2026-08-08) : un hook Stop
// à FEEDBACK (exit 2 — un hook qui rend la main avec une consigne au lieu de
// laisser le tour finir ; sur un poste qui en a un, c'est à presque CHAQUE fin
// de tour) pose `done` et RELANCE Claude. Le tour continue, et c'est `isResuming` — donc
// une DÉDUCTION de state.js, pas les hooks — qui réaffiche `busy`. L'entrée,
// elle, dit toujours `done`. Interrompre pendant cette reprise ne déclenchait
// donc plus rien : le spinner tournait, puis, 5 min plus tard, la conv basculait
// en `done` — faux ✓ vif « va voir » ET son de fin de tour, sur un travail que
// l'utilisateur venait de couper lui-même. Même trou pour une question posée
// après un Stop à feedback : aucun « ? », spinner puis faux ✓.
//
// La règle est donc : ces preuves s'appliquent quel que soit l'état affiché,
// et c'est leur DATE qui arbitre. Une preuve du transcript postérieure au
// dernier événement hooks est la plus fraîche des deux et gagne ; un événement
// hooks postérieur (l'utilisateur a relancé, UserPromptSubmit a reposé `busy`
// avant même que le CLI n'écrive le nouveau prompt) gagne à son tour — ce qui
// supprime au passage le clignotement d'un carré « interrompu » d'une fraction
// de seconde au redémarrage. Preuve non datable (`0`, message sans timestamp) :
// appliquée sans comparaison, c'est-à-dire le comportement d'avant la datation.
function applyTranscriptTruth(state, entry, t) {
  if (!t) return state;
  const hook = hookStamp(entry);
  const fresher = (ts) => ts != null && (ts === 0 || ts >= hook);
  // L'interruption prime sur tout le reste, y compris sur le vieillissement
  // busy→stale et sur une attente en cours : le dernier mot du transcript est
  // « l'utilisateur a coupé », il n'y a plus ni travail ni question en vol.
  if (fresher(t.interruptedAt)) return 'interrupted';
  if (state !== 'waiting' && fresher(t.pendingInteractiveAt)) return 'waiting';
  return state;
}

// « Lu » : l'onglet a été consulté après la fin du tour (ack_ts posé par ack.js,
// via l'extension). Le ✓ vif ne s'éteint donc plus par un timer arbitraire — le
// lot 2 le passait en gris au bout de 30 min, que l'user l'ait vu ou non.
// Un nouveau Stop réarme le vif tout seul : `since` repasse devant `ack_ts`.
// Pas d'entrée `done` connue (conv d'avant les hooks, ou simple idle) → rien à
// relire → « lu ».
function isAcked(entry) {
  if (!entry || entry.state !== 'done') return true;
  const since = entry.since || entry.updated_at || 0;
  return (entry.ack_ts || 0) >= since;
}

// ── Présence d'onglet (lot 5) ──────────────────────────────────────────────
// La disparition d'une conv ne repose PLUS sur le hook SessionEnd, qui ne tire
// ni sur /exit ni sur /clear (anthropics/claude-code#17885, #6428) et reste
// erratique à la fermeture d'onglet (#14760, #45424) : sans lui, la conv
// traînait jusqu'à recentMs (4 h) ou au fade `done` (30 min) — la latence
// signalée par l'user. La vérité, c'est l'onglet.
//
// Ce filtre s'applique à CHAQUE snapshot, pas au seul démarrage : il couvre donc
// par construction tout l'historique — convs fermées extension éteinte, convs
// antérieures au lot 5, convs antérieures à l'installation des hooks (jamais
// entrées dans sessions-state.json, vues via leur transcript seul, donc `idle`,
// donc filtrées comme les autres).
//
// `tabs.known` à false = on ne sait rien des onglets (option absente, tracker
// mort) → on ne masque RIEN : le doute profite à l'affichage.
const NO_TABS = { known: false, labels: [] };
const NO_LIVE = new Set();

// Un onglet peut porter le titre du transcript OU le dernier prompt de la
// conversation : les deux comptent — voir convMatchesLabel.
function hasOpenTab(c, tabs) {
  return tabs.labels.some((l) => convMatchesLabel(l, c));
}

// COMBIEN d'onglets ouverts portent cette conversation — pas « y en a-t-il un »
// (hasOpenTab suffit à l'affichage), mais combien. Seule supersede.js en a
// besoin, et pour une raison précise : deux conversations HOMONYMES matchent le
// même onglet aussi bien que le leur, si bien qu'un `tabOpen` vrai des deux
// côtés ne dit pas s'il y a UN onglet repris (le vrai husk) ou DEUX onglets
// bien réels (deux conversations distinctes). Le compte, lui, le dit.
function countOpenTabs(c, tabs) {
  return tabs.labels.reduce((n, l) => (convMatchesLabel(l, c) ? n + 1 : n), 0);
}

// Tolérance au bruit d'UN SEUL recompute (lot 2, bascule au focus, 2026-07-24).
// Symptôme : plusieurs conversations d'un même groupe partagent le préfixe
// « Implement part N… » ; une fois tronqués par VS Code à la largeur (pas à un
// nombre de caractères, cf. labels.js), leurs libellés d'onglet peuvent devenir
// ambigus le temps d'un recompute déclenché par un simple changement de focus
// (aucun onglet fermé) — le matching titre↔onglet d'une conv rate alors CE SEUL
// passage sans que son onglet ait bougé, et le chip vert « fermer & retirer »
// disparaît pour de bon (rien ne le réarme). On ne fait confiance à une absence
// qu'après plusieurs recomputes CONSÉCUTIFS sans match — un manque isolé est
// ignoré. Le doute profite à l'affichage : un chip vert en trop est bénin, une
// fermeture réelle est de toute façon détectée ailleurs (`closedAt`/isGone, qui
// retire la conversation ENTIÈREMENT et n'a pas besoin de ce compteur).
const TAB_OPEN_MISS_TOLERANCE = 2; // 1 manque toléré, 2 consécutifs = perdu

// misses : Map<sessionId, count> tenue par l'appelant (créée fraîche à chaque
// buildSnapshot() isolé — les bancs restent déterministes — ou tenue par
// l'engine à travers ses recomputes, seul cas où la tolérance s'exerce vraiment).
// isLive (lot gel-tabs 2026-08-17, invariant « vivante ⇒ ouverte ») : une
// session NÉE D'UNE FENÊTRE VS CODE (liveSessionIds, jamais foreignSessionIds —
// cf. isGone) dont le process CLI tourne ENCORE ne peut PAS avoir son onglet
// fermé : fermer l'onglet tue le CLI (même constat que isGone). La tolérance
// ci-dessus ne protège que d'un bruit de matching PASSAGER ; elle s'épuise si le
// titre du transcript (ai-title) ne matche durablement aucun libellé — cas réel
// d'une conv de cadrage tout juste devenue maîtresse d'un groupe, dont
// session-titles.js (state.vscdb, écrit par le renderer AVEC latence) n'a pas
// encore la paire sessionId→titre-onglet réel. `tabOpen` retombait alors à
// `false` ~30 s, et panel.js (rendu STANDARD, même fabrique pour un membre plat
// et pour la ligne maîtresse) barrait le titre comme « terminée · onglet fermé »
// sur une conversation dont l'onglet était grand ouvert à l'écran. Une session
// vivante ne descend donc plus JAMAIS à false, quel que soit le nombre de
// ratés — le doute n'a plus lieu d'être, la preuve de vivacité est plus forte
// que n'importe quel manque de libellé.
function resolveTabOpen(sessionId, rawOpen, misses, isLive) {
  if (rawOpen) { misses.delete(sessionId); return true; }
  if (isLive) return true;
  const n = (misses.get(sessionId) || 0) + 1;
  misses.set(sessionId, n);
  return n < TAB_OPEN_MISS_TOLERANCE;
}

// Tolérance à une perte AMBIGUË de l'appariement (lot « présence par
// identifiant », 2026-08-26) — la garde qui rend la règle de dégradation
// non négociable : une ligne déjà affichée ne doit JAMAIS disparaître du seul
// fait que l'identité (openIds, cf. pairTabs) est absente ou en retard.
//
// POURQUOI CE N'EST PAS resolveTabOpen — celui-ci lisse le CHIP d'affichage
// (barré ou non) d'une conv qu'isGone a DÉJÀ décidé de garder ; il n'a jamais
// eu à protéger la PRÉSENCE elle-même. Or le clignotement signalé par l'user
// (« se barre puis se debarre ») se joue une étape plus tôt : `pairing.index`
// (labels.js) peut perdre un sessionId d'un recompute à l'autre — non pas
// parce que son onglet a fermé, mais parce que l'ordre des candidats ou des
// libellés a changé au sein d'un groupe AMBIGU (deux sœurs au même titre
// tronqué, cf. PLAN_appariement_onglets_2026-08-15.md), et pairTabs retombe
// alors sur son ordre de départage. Avec l'identité disponible (openIds côté
// pairTabs), ce cas ne se présente presque plus JAMAIS — mais « presque »
// n'est pas une garantie : base verrouillée, memento flushé en retard,
// ancienne version de VS Code sans le memento. Cette tolérance couvre
// exactement ce résidu.
//
// Distinction avec une perte NON ambiguë (aucun libellé ne matche du tout,
// `pairing.ambiguous` ne contient pas ce sessionId) : celle-là reste un fait
// FIABLE, immédiat, sans tolérance — c'est elle qui fait toujours disparaître
// une conversation réellement fermée dès le premier recompute qui le constate
// (exigence « < 1 s » du lot 5, cf. isGone). Seule la perte NÉE d'une
// ambiguïté de libellé mérite le doute.
const PRESENCE_MISS_TOLERANCE = 3; // 2 pertes ambiguës consécutives tolérées, 3 = perdu

function resolveHasTabForPresence(sessionId, hasTab, isAmbiguous, misses) {
  if (hasTab) { misses.delete(sessionId); return true; }
  if (!isAmbiguous) { misses.delete(sessionId); return false; }
  const n = (misses.get(sessionId) || 0) + 1;
  misses.set(sessionId, n);
  return n < PRESENCE_MISS_TOLERANCE;
}

// Sources de titre qui PEUVENT matcher un libellé d'onglet, donc dont l'absence
// de correspondance est une information (elle prouve qu'aucun onglet ne porte
// cette conv). Les titres de repli (1er message, dernier prompt) n'en sont pas :
// l'extension officielle ne les met pas sur ses onglets.
// `tab-store` en faisait partie jusqu'en 2.114.0 — plus aucune conversation ne
// peut porter cette source depuis le retrait du store d'onglets (mesuré mort).
const MATCHABLE_TITLE_SOURCES = new Set(['ai-title']);

// c : { sessionId, title, titleSource, state, mtime }
// live    : Set des sessionId dont le process CLI tourne DANS UNE FENÊTRE VS CODE
// foreign : Set des sessionId vivants dont l'origine prouve le contraire
//           (Remote Control/mobile, terminal, agent SDK…) — cf. live-sessions.js
// `hasTab` (lot 2 du plan d'appariement, 2026-08-21) : booléen PRÉCALCULÉ par
// l'appelant à partir de l'appariement bijectif (pairTabs), à préférer à
// `hasOpenTab(c, tabs)` — qui ne répond que « un libellé matche », vrai pour
// DEUX sœurs homonymes même quand une seule a réellement son onglet. Absent
// (bancs qui appellent isGone() directement, une conv à la fois) → repli sur
// hasOpenTab, identique à un appariement sur cette conv seule (aucune
// ambiguïté possible sans une autre conv pour la disputer) : comportement
// inchangé pour tous les appels existants.
// ⚠️ LES TROIS ÉCHAPPATOIRES CI-DESSOUS SONT DE NOUVEAU INCONDITIONNELLES
// (2.114.0). Du 2026-08-24 au 2026-09-05, un quatrième argument `identityKnown`
// les levait quand le store d'onglets VS Code (`agentSessions.model.cache`)
// publiait la paire sessionId→titre de cette session : « identité publiée +
// aucun onglet à son nom ⇒ fermée ». Ce store est MORT — 2 entrées pour 7
// onglets ouverts, mesuré le 2026-09-05 — donc cette preuve ne se levait plus
// jamais pour les conversations vivantes, et pouvait en revanche conclure à
// tort sur les deux qu'il connaît encore. Personne ne la remplace : une
// conversation dont le titre ne matche aucun libellé et dont le process tourne
// reste affichée, comme avant le 2026-08-24 — c'est le doute qui profite à
// l'affichage, et il est réparé par l'ÉVÉNEMENT de fermeture (`closedAt`),
// seul à disparaître en moins d'une seconde.
function isGone(c, tabs, closedAt, live = NO_LIVE, foreign = NO_LIVE, hasTab) {
  if (!tabs.known) return false;
  const open = typeof hasTab === 'boolean' ? hasTab : hasOpenTab(c, tabs);
  // Ouverte ici ou dans une autre fenêtre (union publiée par tabs.js), ET
  // c'est bien CETTE conv que l'appariement lui a assigné.
  if (open) return false;

  // Onglet fermé sous nos yeux : règle user explicite, ça prime sur l'état —
  // une conv fermée en plein travail disparaît quand même. Prime AUSSI sur la
  // vivacité du process ci-dessous : entre la fermeture de l'onglet et la mort
  // du CLI il s'écoule un instant, pendant lequel la conv doit déjà avoir
  // disparu de l'écran (exigence « < 1 s » du lot 5).
  const closed = closedAt.get(c.sessionId);
  if (closed != null) {
    if ((c.mtime || 0) <= closed + CLOSE_GRACE_MS) return true;
    // Écriture postérieure à la grâce : la session est repartie ailleurs.
    closedAt.delete(c.sessionId);
  }


  // Process CLI vivant : identité STABLE, indépendante de tout libellé. C'est
  // la parade au bug d'origine (2026-07-22) — onglet renommé par l'extension
  // officielle, plus aucun titre ne matche, conv ouverte et au travail masquée.
  // …mais SEULEMENT tant que le store n'a pas publié l'identité d'onglet de
  // cette session. « Le CLI tourne, donc son onglet est ouvert » est FAUX, et
  // c'est mesuré (2026-08-24) : un CLI relevé vivant 16 h après l'ouverture,
  // dans une fenêtre née la même minute et JAMAIS rechargée, qui ne déclarait
  // plus un seul onglet Claude — fermer l'onglet ne tue pas toujours le
  // process. Ce que ce constat autorisait — trancher dès que le store publiait
  // l'identité — est parti avec le store (cf. l'en-tête) : la vivacité
  // redevient le dernier mot, faute d'une preuve disponible.
  if (live.has(c.sessionId)) return false;

  // …mais vivante AILLEURS n'est pas vivante ICI (2026-08-17). Une session du
  // serveur Remote Control (ouverte depuis le mobile, exécutée sur ce PC dans
  // le même dossier de travail, donc le même dossier de transcripts), un
  // terminal, un agent SDK : aucun onglet ne les portera jamais. Sans ce test
  // elles restaient affichées en permanence — le process vit tant que le serveur
  // RC tient la session — sur une ligne où cliquer ne mène nulle part, et en
  // consommant une des `maxItems` places d'une vraie conversation.
  // Placé APRÈS hasOpenTab et après `live` : les deux preuves d'un onglet d'ici
  // l'emportent, notamment quand une conv mobile est REPRISE dans VS Code (même
  // sessionId, deux process au registre).
  // C'est une preuve POSITIVE, pas un défaut de correspondance : entrypoint
  // absent ou inconnu ⇒ l'ensemble ne la contient pas ⇒ rien ne change.
  if (foreign.has(c.sessionId)) return true;

  // Sans onglet mais au travail : on garde, faute de savoir. Ce filet ne couvre
  // plus que les sessions ABSENTES du registre (process mort alors que les hooks
  // disent encore busy) — celles dont on connaît l'origine ont déjà tranché
  // ci-dessus. `stale` n'en est pas : c'est « plus rien d'écrit depuis 5 min »,
  // donc on ne peut pas la dire vivante — et c'est justement l'état où atterrit
  // une conv fermée pendant que VS Code était éteint (SessionEnd n'ayant pas tiré).
  if (c.state === 'busy' || c.state === 'waiting') return false;

  // Titre de repli : il ne peut PAS matcher un libellé d'onglet de façon fiable,
  // donc son absence de correspondance ne prouve rien. Cette exemption était
  // levée quand le store d'onglets publiait, lui, un titre matchable — elle
  // redevient inconditionnelle avec son retrait (cf. l'en-tête).
  if (!MATCHABLE_TITLE_SOURCES.has(c.titleSource)) return false;

  return true;
}

// Lecture d'un transcript avec cache : pendant qu'une conv travaille, fs.watch
// tire un recompute à chaque écriture. Sans ce cache on relirait 64 Ko × N convs
// plusieurs fois par seconde. Clé d'invalidation : (mtime, size).
//
// `titleScans` (lot 8) est un cache SÉPARÉ, à part : contrairement au cache
// value ci-dessus (jetable, une entrée par (mtime,size)), le scan d'ai-title
// doit survivre à travers les recomputes pour rester incrémental — sinon
// chaque écriture relirait le fichier depuis l'octet 0. Coût : O(delta) par
// écriture au lieu de O(fichier) ; premier passage = scan complet, une fois.
function createTranscriptReader() {
  const cache = new Map();
  const titleScans = new Map();
  // Dernier état assistant connu par fichier (modèle + ctx), CONSERVÉ à travers
  // les recomputes — comme titleScans, contrairement au cache (mtime,size)
  // jetable ci-dessus. extractLastAssistant ne lit que TAIL_BYTES (64 Ko) : un
  // seul tool_result géant en queue (screenshot base64, gros fichier lu, longue
  // sortie de commande) tient sur une ligne > 64 Ko et pousse le dernier message
  // assistant hors de la fenêtre → extractLastAssistant rend null, et le modèle
  // ET le ctx% disparaissaient du panneau (« — » intermittent, signalé
  // 2026-07-22 : « finit par s'afficher au bout d'un moment », c.-à-d. quand un
  // assistant repasse dans la fenêtre). On réaffiche alors le dernier connu :
  // jamais faux (le modèle d'une session ne change pas), ctx% éventuellement un
  // peu ancien — préférable à un blanc clignotant. La toute première ouverture
  // (aucun assistant encore écrit) reste « — » quelques secondes : rien à
  // mémoriser tant que le premier tour n'a pas produit de réponse.
  const lastAssistant = new Map();
  function read(filePath) {
    let stat;
    try { stat = fs.statSync(filePath); } catch { return null; }
    const key = `${stat.mtimeMs}:${stat.size}`;
    const hit = cache.get(filePath);
    if (hit && hit.key === key) return hit.value;

    let value = { title: null, titleSource: null, modelId: null, model: null, effort: null, ctx: null, mtime: stat.mtimeMs, activityTs: stat.mtimeMs, pendingInteractive: false, interrupted: false, pendingInteractiveAt: null, interruptedAt: null };
    try {
      // Les deux faits sont DATÉS (ms epoch, `0` = présent mais non datable,
      // `null` = absent) : applyTranscriptTruth compare cette date à celle du
      // dernier événement hooks. Les booléens restent publiés pour les
      // consommateurs qui ne demandent qu'une présence.
      value.pendingInteractiveAt = pendingInteractiveAt(filePath);
      value.interruptedAt = interruptedAt(filePath);
      value.pendingInteractive = value.pendingInteractiveAt !== null;
      value.interrupted = value.interruptedAt !== null;
      // Reprise ≠ comptabilité (2026-08-07) : cf. effectiveState/isResuming.
      value.activityTs = lastActivityTs(filePath) || stat.mtimeMs;
      const last = extractLastAssistant(filePath);
      if (last) {
        value.modelId = last.modelId;
        value.model = modelIdToDisplay(last.modelId);
        // Effort RÉEL du dernier tour (lot 1 création groupée) : même source et
        // même cache que le modèle — c'est ce que le panneau affiche, et la
        // seule chose à laquelle une intention de lancement se compare.
        value.effort = last.effort || null;
        const tokens = usageTokens(last.usage);
        if (tokens > 0) {
          const denom = detectContextWindow(last.modelId, tokens);
          value.ctx = { tokens, denom, pct: Math.min(100, (tokens / denom) * 100) };
        }
        lastAssistant.set(filePath, { modelId: value.modelId, model: value.model, effort: value.effort, ctx: value.ctx });
      } else {
        // Dernier assistant hors des 64 Ko (gros tool_result en queue) : garder
        // l'affichage précédent plutôt que l'effacer.
        const prev = lastAssistant.get(filePath);
        if (prev) { value.modelId = prev.modelId; value.model = prev.model; value.effort = prev.effort; value.ctx = prev.ctx; }
      }
      let titleState = titleScans.get(filePath);
      if (!titleState) {
        titleState = { scannedBytes: 0, aiTitle: null };
        titleScans.set(filePath, titleState);
      }
      scanAiTitleIncremental(filePath, titleState);
      const t = extractTitleInfo(filePath, titleState.aiTitle);
      value.title = t.title;
      value.titleSource = t.source;
      // Troisième libellé d'onglet possible (labels.js convMatchesLabel).
      value.lastPrompt = t.lastPrompt || null;
    } catch {}

    cache.set(filePath, { key, value });
    return value;
  }
  // Scan des signaux de reprise autonome (incident vagues 2026-08-17) : cache
  // SÉPARÉ, même clé (mtime, size), mais calculé À LA DEMANDE — effectiveState
  // ne le tire que sur une entrée `done` non-resuming, donc une fois par fin
  // de tour (le fichier ne bouge plus → une seule lecture de 4 Mo, cachée).
  // L'accrocher au lecteur (plutôt qu'un paramètre de plus à buildSnapshot)
  // préserve la signature publique — les bancs qui injectent leur reader
  // continuent de passer, et un reader nu (sans la propriété) dégrade en
  // silence, règle du projet.
  const resumeCache = new Map();
  read.resumeSignals = function (filePath) {
    if (!filePath) return null;
    let stat;
    try { stat = fs.statSync(filePath); } catch { return null; }
    const key = `${stat.mtimeMs}:${stat.size}`;
    const hit = resumeCache.get(filePath);
    if (hit && hit.key === key) return hit.value;
    let value = null;
    try { value = pendingResumeSignals(filePath); } catch { value = null; }
    resumeCache.set(filePath, { key, value });
    return value;
  };
  return read;
}

// Une session appartient au workspace si son transcript vit dans le dossier
// projet du workspace. Repli sur cwd quand le hook n'a pas transmis de
// transcript_path (payload partiel).
function belongsToWorkspace(entry, projectDir, workspacePath) {
  if (entry.transcript) {
    try {
      return path.resolve(path.dirname(entry.transcript)).toLowerCase()
           === path.resolve(projectDir).toLowerCase();
    } catch { return false; }
  }
  if (entry.cwd && workspacePath) {
    return path.resolve(entry.cwd).toLowerCase() === path.resolve(workspacePath).toLowerCase();
  }
  return false;
}

function listTranscripts(projectDir) {
  try {
    return fs.readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ sessionId: f.slice(0, -6), file: path.join(projectDir, f) }));
  } catch { return []; }
}

// Lecture (avec cache) du premier message user d'un transcript — second signal
// d'identité de computeSupersededBy (supersede.js, durci 2026-08-05) : un
// resume REJOUE ce message à l'identique même quand l'ai-title, lui, a dérivé
// d'un mot d'une session à l'autre. Clé de cache = le CHEMIN seul, jamais
// (mtime,size) comme createTranscriptReader ci-dessus : le premier message
// d'un transcript n'écrit plus une fois posé (fichier append-only), une entrée
// reste donc vraie pour toute la durée de vie du process.
function createFirstUserReader() {
  const cache = new Map();
  return function readFirstUser(filePath) {
    if (!filePath) return null;
    if (cache.has(filePath)) return cache.get(filePath);
    let text = null;
    try { text = firstUserText(filePath); } catch { text = null; }
    cache.set(filePath, text);
    if (cache.size > 500) cache.clear();
    return text;
  };
}

// Construit le snapshot : union des sessions connues des hooks et des
// transcripts récents du workspace (une conv ouverte avant l'installation des
// hooks n'a pas d'entrée d'état — elle doit quand même apparaître, en idle).
// `readFirstUser` est OPTIONNEL (rétro-compatible avec les bancs qui appellent
// buildSnapshot à deux arguments) : absent → `firstUser` reste null pour
// toutes les convs, computeSupersededBy retombe sur le groupement par titre
// seul, comportement d'avant.
function buildSnapshot(opts, readTranscript, readFirstUser) {
  const { workspacePath, recentMs, maxItems } = opts;
  const now = Date.now();
  const projectDir = projectDirFor(workspacePath);
  const activeSessionId = readActiveSessionId();
  const entries = readSessionsState();
  const byId = new Map();
  // Sessions dont le TRANSCRIPT a été jugé trop vieux ci-dessous : mémorisées
  // pour que la boucle des fiches hooks ne les réadmette pas (cf. son commentaire).
  const aged = new Set();

  // Identités STABLES, indépendantes des libellés (lot 2026-07-22).
  const live = (typeof opts.liveSessions === 'function' && opts.liveSessions()) || NO_LIVE;
  // Sessions vivantes qui n'appartiennent PAS à une fenêtre VS Code (cf. isGone).
  // Absente des opts (bancs d'avant ce lot) ⇒ ensemble vide ⇒ comportement d'avant.
  const foreign = (typeof opts.foreignSessions === 'function' && opts.foreignSessions()) || NO_LIVE;
  // Sessions dont un onglet Claude est confirmé ouvert DANS CETTE FENÊTRE, par
  // IDENTITÉ exacte (session-titles.js `createOpenSessionIds`, memento
  // `workbench.parts.editor` du state.vscdb) — source de vérité de la présence
  // pour pairTabs ci-dessous (labels.js), le libellé d'onglet ne redevenant que
  // le repli explicite. Absente des opts (bancs d'avant ce lot, base illisible,
  // ancienne version de VS Code sans le memento) ⇒ Set vide ⇒ pairTabs retombe
  // intégralement sur l'appariement par libellé, comportement d'avant à l'octet
  // près.
  const rawOpenIds = (typeof opts.openSessionIds === 'function' && opts.openSessionIds()) || NO_LIVE;
  // ── LE MEMENTO EST UN SOUVENIR, LA FERMETURE EST UN TÉMOIGNAGE (2026-09-02) ─
  // Une session dont l'onglet s'est fermé SOUS NOS YEUX quitte le memento ici,
  // à la source, avant tout usage. Sans ça, la ligne survivait ~30 s à sa
  // fermeture (mesuré par l'user, journal `presence-drop` : drop à 21:21:22
  // avec `closed:true` déjà posé, aucun changement de composition dans les 35 s
  // précédentes) — le retrait ne se faisait plus sur l'événement mais au tick
  // suivant, dont la période est justement de 30 s.
  //
  // POURQUOI ÇA N'ARRIVAIT PAS AVANT 2.103.0 : `openIds` n'entrait alors dans le
  // jugement de présence que pendant la grâce d'activation. Depuis, `settling`
  // est le régime NORMAL (il suffit d'UN onglet restauré non visité, cf. plus
  // bas) et la présence se lit sur `openIds || libellé`. Or les deux preuves
  // n'ont pas la même fraîcheur : le libellé tombe dans les 150 ms (tabs.js
  // republie sur l'événement), le memento retarde jusqu'à ~27 s (mesure de
  // 2.84.0) et GÈLE tant que la fenêtre n'a pas le focus. L'union restait donc
  // vraie et `isGone` sortait sur son premier test — `if (open) return false`,
  // AVANT de consulter `closedAt`. Cet ordre était sans conséquence tant que
  // `open` ne venait que du libellé ; ajouter une source qui retarde a rendu
  // périmable une preuve traitée comme fraîche.
  //
  // C'est la doctrine du 2026-08-29, appliquée dans l'autre sens : l'ÉVÉNEMENT
  // de fermeture et le VERDICT de présence ne sont pas la même preuve. On savait
  // qu'un verdict ne doit jamais déclencher d'irréversible ; la réciproque
  // manquait — un souvenir ne doit jamais contredire un événement observé.
  //
  // NEUTRALISÉ À LA SOURCE, et non au point de lecture : le même memento sert
  // la présence, `tabOpen`, l'appariement de pairTabs ET le filtre d'ancienneté
  // (`tabProvenOpen` ci-dessous) — ce dernier retenait une vieille conversation
  // fermée exactement le même temps, à la porte d'AVANT. Les corriger séparément
  // ne se verrait pas (« un fait d'affichage doit avoir UNE source »).
  //
  // Ce qui n'est PAS neutralisé : le LIBELLÉ. Un onglet qui porte encore ce nom
  // reste une preuve fraîche d'ouverture — réouverture, sœur homonyme —, et
  // `isGone` garde sa propre sortie de secours (écriture postérieure à la
  // fermeture ⇒ `closedAt.delete`). Neutraliser les deux fabriquerait le faux
  // négatif symétrique, la leçon de 2.86.1.
  const closedIds = opts.closedAt instanceof Map ? opts.closedAt : null;
  const openIds = closedIds && closedIds.size && rawOpenIds.size
    ? new Set([...rawOpenIds].filter((id) => !closedIds.has(id)))
    : rawOpenIds;
  // Naissance (ms epoch) de chaque process VIVANT du registre — incident
  // spinner éternel 2026-08-18, cf. le commentaire de `effectiveState` sur
  // `startedAt`. Absente des opts (bancs d'avant ce lot) ⇒ Map vide ⇒ la
  // comparaison de date est sautée partout, comportement d'avant à l'octet près.
  const liveStarts = (typeof opts.liveSessionStarts === 'function' && opts.liveSessionStarts()) || new Map();
  // Lu ICI, et non plus bas dans la fonction : le filtre d'ancienneté juste en
  // dessous en a besoin (cf. tabProvenOpen).
  const tabs = (typeof opts.tabs === 'function' && opts.tabs()) || NO_TABS;
  // Marques « à relire » (lot 3 du plan marque-a-relire) : les sessionId que
  // l'utilisateur a marqués À LA MAIN. Ce n'est pas un état du moteur, c'est
  // une INTENTION déclarée — « je dois y revenir » —, et c'est ce qui lui donne
  // le droit de tenir une ligne dans la liste quand les deux preuves d'usage
  // (process vivant, onglet ouvert) ont disparu : sans ça la marque raterait
  // très exactement le geste qui la motive, fermer l'onglet en croyant le
  // travail fini. Thunk absent (bancs d'avant ce lot, usage isolé) ⇒ ensemble
  // vide ⇒ comportement d'avant à l'octet près, comme toutes les sources
  // optionnelles de ce module. Tableau toléré autant qu'un Set : l'appelant
  // sérialise un store, pas une structure interne de state.js.
  const rawPinned = typeof opts.pinnedSessions === 'function' ? opts.pinnedSessions() : null;
  const pinnedIds = rawPinned instanceof Set
    ? rawPinned
    : new Set(Array.isArray(rawPinned) ? rawPinned : []);

  // « Un onglet OUVERT porte-t-il encore cette conversation ? » — par IDENTITÉ,
  // et par elle seule : le memento du renderer NOMME la session de chaque onglet
  // Claude de cette fenêtre, y compris un onglet restauré jamais visité (dont le
  // libellé n'est que « Claude Code »). C'est la porte qui tient l'invariant
  // « onglet ouvert ⇒ listée » AVANT toute lecture de transcript — filtre
  // d'ancienneté et priorité dans les `maxItems` places : sans elle, une
  // conversation de plus de 4 h dont l'onglet est grand ouvert redevient
  // invisible, `aged` la retirant en amont.
  // Un second croisement existait ici (`tabStillOpenFor` : store des titres ×
  // libellés d'onglets) — parti en 2.114.0 avec le store, mesuré mort. Ce qu'il
  // couvrait en propre : un onglet ouvert dans une AUTRE fenêtre (le memento est
  // par fenêtre). Perte assumée et nommée, pas remplacée : ces conversations
  // restent candidates par leur libellé tant qu'elles sont récentes.
  // openIds vide (base illisible) ⇒ personne n'est prouvé ouvert ⇒ filtre
  // d'ancienneté seul, comportement de repli habituel.
  const tabProvenOpen = (sessionId) => openIds.has(sessionId);

  if (projectDir) {
    for (const { sessionId, file } of listTranscripts(projectDir)) {
      const mtime = statMtime(file);
      const entry = entries[sessionId];
      const fresh = entry && now - (entry.updated_at || 0) < STATE_ENTRY_MAX_AGE_MS;
      // Session vivante : candidate même si son transcript n'a rien écrit
      // depuis recentMs (4 h) — une conv ouverte et laissée en plan la journée
      // reste ouverte, et son onglet aussi.
      // …et session MORTE dont l'ONGLET est resté ouvert : même conclusion
      // (2026-08-18). Le panneau doit tenir l'invariant « onglet ouvert ⇒
      // listée », parce que tout le reste en dépend : member-truth.js conclut
      // `done-closed` — titre BARRÉ sur une ligne maîtresse, ligne RETIRÉE pour
      // un membre de vague — du seul fait qu'une conversation n'est pas dans la
      // liste. Sans cette exemption ce raisonnement devient faux au bout de 4 h,
      // et une conversation de cadrage terminée la nuit, CLI éteint mais onglet
      // grand ouvert à l'écran, se retrouve barrée « terminée · onglet fermé »
      // (signalé par l'user le 2026-08-18). La preuve ne coûte aucune lecture :
      // libellé d'onglet du store croisé avec les onglets ouverts. Store muet ou
      // tracker d'onglets absent → false → comportement d'avant, jamais un
      // masquage de plus.
      // `fresh` (fiche hooks de moins de 24 h) N'EXEMPTE PLUS de ce filtre
      // (2026-08-20). Il l'a fait longtemps sans dommage visible — les deux
      // durees se recouvrent dans le cas nominal — mais sur une conversation
      // SANS ai-title il rendait la ligne IMMORTELLE, et c'est le seul chemin
      // par lequel elle pouvait l'etre. Enchainement constate sur donnees
      // reelles (deux convs du 2026-08-19, signalees par l'user) : plus aucun
      // onglet ne les portait, mais leur titre etant un repli (1er prompt),
      // isGone refuse par construction de conclure quoi que ce soit d'une
      // absence de correspondance ; la seule echeance qui restait etait l'age
      // du transcript, annulee par une fiche hooks retamponnee a 15:35 alors
      // que la conversation n'avait plus rien ecrit depuis 23:45 la veille.
      // `updated_at` date la FICHE, pas la conversation : c'est un fait sur un
      // fichier annexe, jamais une preuve que la conv est encore la. Les deux
      // exemptions qui restent en sont, elles, de vraies preuves : process CLI
      // vivant, ou onglet prouve ouvert. `fresh` garde son seul usage
      // legitime, juste en dessous : decider si l'entree hooks est encore
      // exploitable pour l'ETAT de la conversation.
      // …et session MARQUÉE « à relire » (lot 3, 2026-08-22) : troisième
      // exemption, de nature différente des deux autres — ce n'est pas une
      // preuve d'usage observée, c'est un ORDRE de l'utilisateur, posé et levé
      // à la main (décision 7 du plan : jamais d'extinction automatique). Elle
      // doit être appliquée ICI, dans le filtre lui-même, et surtout PAS en
      // réadmettant plus bas ce que ce filtre a écarté : `aged` existe
      // précisément pour que la boucle des fiches hooks ne repêche pas une
      // conv refusée en connaissance de cause (incident 2026-08-20, deux convs
      // immortelles) — une conv marquée ne doit donc jamais y entrer, sinon la
      // marque se retrouverait à contourner un filtre par une porte de service
      // au lieu d'être une exemption assumée. Coût dit à l'user : une conv
      // marquée reprend une place de `maxItems`, comme une conv à onglet
      // ouvert (cf. le tri des candidats plus bas).
      if (now - mtime > recentMs && !live.has(sessionId)
        && !tabProvenOpen(sessionId)
        && !pinnedIds.has(sessionId)) { aged.add(sessionId); continue; }
      byId.set(sessionId, { sessionId, transcript: file, mtime, entry: fresh ? entry : null });
    }
  }

  // Sessions connues des hooks dont le transcript n'a pas été listé (fichier
  // pas encore créé au tout 1er prompt) : on les garde, sans données transcript
  // — SAUF si l'entrée pointe vers un fichier transcript qui n'existe pas :
  // sans fichier, pas de titre, pas de modèle, pas de matching d'onglet possible
  // ni de retrait fiable par le filtre de présence (lot 5) → une ligne fantôme
  // « Conversation » irrécupérable (incident 2026-07-16). Ces entrées ne sont
  // jamais rendues ; celles qui dépassent le délai de grâce sont purgées du
  // fichier d'état (débris — SessionEnd n'est pas fiable, cf. lot 5).
  const debrisIds = [];
  for (const [sessionId, entry] of Object.entries(entries)) {
    if (byId.has(sessionId) || !entry) continue;
    // « Pas vue » et « ÉCARTÉE » ne sont pas la même chose (2026-08-20). Cette
    // boucle est là pour ce que la précédente n'a PAS PU voir — la conv dont le
    // transcript n'existe pas encore, au tout premier prompt. Sans ce test elle
    // réadmet aussi ce que la précédente vient d'écarter en connaissance de
    // cause : le filtre d'ancienneté travaille sur le transcript, cette boucle
    // ne regarde que la fiche hooks, et la fiche gagnait toujours. C'est par ce
    // chemin-là que les deux convs du 2026-08-19 revenaient à chaque snapshot,
    // le fix de la boucle du dessus restant sans aucun effet visible.
    if (aged.has(sessionId)) continue;
    if (now - (entry.updated_at || 0) > STATE_ENTRY_MAX_AGE_MS) continue;
    if (!belongsToWorkspace(entry, projectDir, workspacePath)) continue;
    if (entry.transcript && !fs.existsSync(entry.transcript)) {
      const bornAt = entry.updated_at || entry.since || now;
      if (now - bornAt > TRANSCRIPT_MISSING_PURGE_MS) debrisIds.push(sessionId);
      continue;
    }
    byId.set(sessionId, {
      sessionId,
      transcript: entry.transcript || null,
      mtime: entry.transcript ? statMtime(entry.transcript) : (entry.updated_at || 0),
      entry,
    });
  }
  for (const id of debrisIds) removeSession(id);

  // Trier sur mtime (connu par statSync, aucune lecture) puis lire les
  // transcripts UN PAR UN jusqu'à tenir maxItems convs VISIBLES — et pas lire
  // les maxItems premiers en bloc. La lecture (64 Ko/fichier) est de loin
  // l'étape chère : mesuré sur un dossier projet à 374 transcripts, 209 ms si on
  // lit tout contre 15 ms pour 12. Le cas nominal (rien de masqué) en lit donc
  // toujours exactement maxItems.
  //
  // Pourquoi pas simplement filtrer après troncature : le filtre de présence
  // masque désormais l'essentiel de l'historique, et les convs masquées
  // consommeraient les 12 places. Vérifié — 12 convs fermées plus récentes
  // qu'une conv OUVERTE donnaient un panneau VIDE, la seule conv ouverte étant
  // 13e au tri. SCAN_LIMIT borne le coût du cas dégradé (tout est masqué) au
  // lieu de relire les 374.
  // Priorité aux conversations dont un ONGLET est ouvert (2026-08-18) — même
  // invariant que l'exemption d'ancienneté plus haut, mais l'autre moitié :
  // entrer dans les candidats ne suffit pas, encore faut-il entrer dans les
  // `maxItems` places, et la troncature se fait dans l'ordre de ce tableau.
  // Une conv à onglet ouvert mais ancienne se faisait couper par 12
  // conversations plus fraîches, l'invariant « onglet ouvert ⇒ listée »
  // retombait, et avec lui TOUT ce que la hiérarchie en déduit : ligne
  // maîtresse barrée (member-truth), membre retiré de sa vague (panel.js),
  // filiation défaite (nesting.js exige `master.listed`), groupe replié
  // (group-done.js). Le poste de l'auteur tient 11 onglets Claude pour 12
  // places : la marge n'est pas théorique. À onglet égal, le mtime tranche
  // comme avant — et sans store d'onglets, tout le monde est à égalité, donc
  // l'ordre est celui d'avant à l'octet près.
  // Les conversations MARQUÉES passent juste derrière (lot 3) : entrer dans les
  // candidats ne suffit pas, il faut aussi entrer dans les `maxItems` places,
  // sinon une conv marquée ancienne se ferait couper par 12 conversations plus
  // fraîches et la marque ne survivrait à rien. Derrière, jamais devant :
  // l'invariant « onglet ouvert ⇒ listée » fonde member-truth.js (« pas dans la
  // liste ⇒ terminée · fermée »), une marque ne doit pas pouvoir le reprendre.
  // Effet de bord utile : une marquée étant en tête des candidats, elle est
  // toujours dans les SCAN_LIMIT transcripts réellement lus, si vieille soit-elle.
  const hasTab = new Map();
  for (const c of byId.values()) hasTab.set(c.sessionId, tabProvenOpen(c.sessionId) ? 1 : 0);
  const pinRank = (id) => (pinnedIds.has(id) ? 1 : 0);
  const candidates = [...byId.values()].sort((a, b) => {
    const d = hasTab.get(b.sessionId) - hasTab.get(a.sessionId);
    if (d !== 0) return d;
    const p = pinRank(b.sessionId) - pinRank(a.sessionId);
    if (p !== 0) return p;
    return (b.mtime || 0) - (a.mtime || 0);
  });
  const SCAN_LIMIT = maxItems * 4;

  // Coût estimé ($) consommé depuis le début de chaque conversation (cost.js).
  // Injecté par l'engine, qui garde l'accumulateur incrémental à travers ses
  // recomputes ; absent (bancs, usage isolé) → `cost` reste null partout et le
  // panneau n'affiche rien, comportement d'avant à l'octet près.
  const readCost = typeof opts.readCost === 'function' ? opts.readCost : null;
  const closedAt = opts.closedAt instanceof Map ? opts.closedAt : new Map();
  // Cf. resolveTabOpen : Map fraîche par défaut (bancs déterministes), tenue
  // par l'engine à travers ses recomputes dans le cas réel.
  const tabOpenMisses = opts.tabOpenMisses instanceof Map ? opts.tabOpenMisses : new Map();
  // Cf. resolveHasTabForPresence : Map fraîche par défaut (bancs déterministes),
  // tenue par l'engine à travers ses recomputes dans le cas réel — SÉPARÉE de
  // tabOpenMisses ci-dessus, qui protège un champ d'affichage déjà décidé
  // présent, pas la présence elle-même.
  const presenceMisses = opts.presenceMisses instanceof Map ? opts.presenceMisses : new Map();

  const conversations = [];
  // Convs dont l'identité (titre, et plus bas premier message) peut nourrir
  // computeSupersededBy — VISIBLES (mêmes objets que `conversations`) ET
  // MASQUÉES par isGone (durci 2026-08-05) : un husk dont le titre a dérivé ne
  // matche plus aucun onglet — isGone le juge donc `gone` sur ce seul critère,
  // AVANT même que la supplantation ait pu jouer — et sortirait de tout calcul
  // si on ne gardait pas trace de son identité ici. `computeSupersededBy` a
  // besoin de le VOIR pour le comparer au successeur ; il n'a pas besoin d'être
  // RENDU (`conversations`) pour ça, seulement présent dans ce tableau.
  const supersedeCandidates = [];

  // PASSE 1 — lire chaque candidat (état, titre affiché) SANS encore décider
  // qui est visible. L'appariement bijectif ci-dessous (lot 2 du plan
  // d'appariement, 2026-08-21) a besoin de voir TOUS les titres à la fois
  // pour départager deux sœurs homonymes — décider `gone` conv par conv,
  // comme avant, referait exactement l'erreur d'origine (chacune cherche son
  // onglet toute seule). Les transcripts sont de toute façon lus jusqu'à
  // SCAN_LIMIT : cette passe ne coûte rien de plus, elle ne fait que reporter
  // la décision de visibilité après le calcul de l'appariement.
  const prepared = [];
  for (const c of candidates.slice(0, SCAN_LIMIT)) {
    const t = c.transcript ? readTranscript(c.transcript) : null;
    // `live.has` : process CLI vivant ⇒ un `busy` muet reste `busy` (travail en
    // cours), jamais `stale` par simple vieillissement du mtime.
    let convState = effectiveState(c.entry, c.mtime, now, live.has(c.sessionId), t && t.activityTs,
      // Reprise autonome (tâche de fond, réveil programmé) : thunk — le scan ne
      // tourne que si effectiveState en a besoin (entrée `done` d'une session
      // vivante), et le lecteur le cache par (mtime, size). Reader de banc sans
      // la propriété → undefined → dégradation silencieuse, comportement d'avant.
      typeof readTranscript.resumeSignals === 'function'
        ? () => readTranscript.resumeSignals(c.transcript)
        : undefined,
      liveStarts.get(c.sessionId) ?? null);
    // Interruption manuelle (bouton Stop / Échap) et question interactive en
    // attente : deux faits qu'AUCUN hook ne signale, donc que seul le transcript
    // connaît — cf. applyTranscriptTruth, qui arbitre par la DATE des preuves.
    //
    // ÉTAT PROPRE `interrupted` (2026-07-22) — c'était `idle` jusque-là, donc
    // rendu par le même ✓ vert pâle que « rien en cours ». Or les deux disent
    // l'inverse l'un de l'autre : le ✓ pâle veut dire « rien à faire ici », une
    // interruption veut dire « travail inachevé, tu voulais y revenir » — c'est
    // justement la conv qu'on cherche dans la liste 20 min plus tard. Aucun
    // consommateur de `state` ne teste `idle` (sons, ack, canari, isGone ne
    // regardent que busy/waiting/done), donc un état à part se comporte
    // exactement comme `idle` partout ailleurs et ne change QUE le rendu.
    // Surtout pas `done` : l'user vient de couper lui-même, il regarde déjà la
    // conv — aucun ✓ vif « va voir » à armer, et aucun son (onTransition
    // n'émet que sur done/waiting). Il s'efface tout seul à la reprise :
    // le marqueur cesse d'être le dernier mot dès qu'un vrai prompt ou une
    // réponse assistant le suit.
    convState = applyTranscriptTruth(convState, c.entry, t);
    prepared.push({
      c, t, state: convState, lastPrompt: (t && t.lastPrompt) || null,
      title: (t && t.title) || 'Conversation', titleSource: (t && t.titleSource) || null,
    });
  }

  // Appariement bijectif (lot 2 du plan d'appariement, 2026-08-21) : chaque
  // onglet n'est consommé qu'UNE fois. `prepared` est déjà dans l'ordre de
  // `candidates` (onglet connu d'abord, puis mtime décroissant) — c'est cet
  // ordre qui départage les groupes ambigus dans pairTabs (labels.js).
  const pairing = pairTabs(
    prepared.map((p) => ({ sessionId: p.c.sessionId, title: p.title, lastPrompt: p.lastPrompt })),
    (tabs && tabs.labels) || [],
    openIds,
  );

  // ── L'IDENTITÉ ÉCRASE L'APPARIEMENT (2026-08-29) ──────────────────────────
  // `pairTabs` reste un appariement par ORDRE, y compris dans sa pré-passe par
  // identité : celle-ci réserve un libellé à une session confirmée ouverte, mais
  // ne choisit pas LEQUEL — avec deux libellés strictement égaux, elle prend le
  // premier libre, dans l'ordre d'AFFICHAGE des conversations (mtime), qui n'a
  // aucune raison d'être l'ordre des ONGLETS. Mesuré au banc d'intégration
  // (test-click-highlight-loop.js) : sur deux sœurs homonymes, le surlignage
  // désignait SYSTÉMATIQUEMENT l'autre — clic exact, ligne fausse, c'est-à-dire
  // le symptôme signalé par l'utilisateur.
  // Le memento du renderer, lui, dit la position VRAIE de chaque session
  // (session-titles.js `locations`, `flatIndex` = rang parmi les onglets Claude,
  // le même index que publie tabs.js). Quand il parle, il tranche ; sinon
  // l'appariement par libellé garde la main, à l'octet près.
  //
  // ⚠️ LE MEMENTO S'ACCEPTE EN BLOC OU PAS DU TOUT. Il retarde ; une photo
  // périmée mélangée aux libellés frais du tracker fabrique des positions qui
  // n'ont jamais existé — pire que l'appariement qu'elle remplace (mesuré :
  // après une fermeture non encore flushée, le surlignage désignait une
  // troisième conversation, ni celle affichée ni celle cliquée). On le valide
  // donc ENTIÈREMENT contre l'état frais avant d'en retenir la moindre ligne :
  //   - autant d'onglets Claude connus du tracker que de positions publiées ;
  //   - à chaque position, un libellé COMPATIBLE avec la conversation visée.
  // Un seul désaccord ⇒ photo périmée ⇒ on garde l'appariement par libellé,
  // à l'octet près. C'est le même principe que les trois contrôles de focus.js,
  // appliqué ici à la table entière plutôt qu'à une ligne.
  const tabLocations = (typeof opts.sessionTabLocations === 'function' && opts.sessionTabLocations()) || null;
  const labels = (tabs && tabs.labels) || [];
  const positionOf = validatePositions(tabLocations, {
    claudeCount: labels.length,
    activeFlatIndex: (tabs && typeof tabs.activeIndex === 'number') ? tabs.activeIndex : null,
  });
  // Sessions dont l'onglet est NOMMÉ par le memento validé, par opposition à
  // celles que pairTabs a simplement appariées dans l'ordre. La distinction est
  // décisive plus bas : seul un index d'identité autorise à surligner sans autre
  // preuve quand plusieurs conversations partagent le libellé actif.
  const indexFromMemento = new Set();
  if (positionOf) {
    // Ce que le libellé trouvé à la position peut contredire (2026-09-03) : pas
    // « ne correspond pas à cette conversation » — c'est le cas de tout onglet
    // que l'extension officielle a renommé avec le dernier prompt (« ok go »,
    // journal 01:00:00 `matches:0 via:none` sur une position JUSTE), et le
    // prendre pour un veto laissait la ligne éteinte jusqu'au prochain flush du
    // juge (~5 s, puis rechute à chaque changement d'onglet). Seul un libellé
    // qui NOMME une autre conversation listée prouve une photo périmée pour
    // cette ligne (onglets réordonnés depuis le flush). Cf. labels.js
    // `labelNamesAnother` — la même règle que focus.js, au même instant.
    const listed = prepared.map((q) => ({ sessionId: q.c.sessionId, title: q.title, lastPrompt: q.lastPrompt }));
    for (const p of prepared) {
      const loc = positionOf.get(p.c.sessionId);
      if (!loc) continue;
      const label = labels[loc.flatIndex];
      if (label == null) continue;
      if (labelNamesAnother(label, { sessionId: p.c.sessionId, title: p.title, lastPrompt: p.lastPrompt }, listed)) continue;
      pairing.index.set(p.c.sessionId, loc.flatIndex);
      pairing.ambiguous.delete(p.c.sessionId);
      indexFromMemento.add(p.c.sessionId);
    }
  }

  // ── Fenêtre en cours de REMONTAGE (2026-08-28) ────────────────────────────
  // Les libellés d'onglets (~/.claude/panel-tabs/<pid>.json) sont republiés par
  // des CLI que VS Code vient tout juste de respawner, avec des dizaines de
  // secondes de retard. Pendant ce creux, une conversation dont l'onglet est
  // grand ouvert ne matche aucun libellé : une ligne se barre, une autre
  // disparaît, puis tout revient seul (constat user au reload de la 2.86.0).
  //
  // La parade n'est PAS de suspendre le jugement — essayé en 2.86.1, et c'est
  // pire : plus rien ne disparaissant, tout l'historique récent remonte en
  // fantômes (mesuré chez l'user : 10 lignes pour 4 onglets). C'est de juger
  // sur une source qui, elle, a survécu au reload : le memento
  // `workbench.parts.editor` du RENDERER, qui porte l'IDENTITÉ des éditeurs
  // restaurés. Relevé au même instant sur la fenêtre en cause : 4 sessions
  // déclarées ouvertes, exactement les 4 onglets réels.
  //
  // openIds vide (base illisible, verrouillée, ancienne version de VS Code)
  // ⇒ personne ne peut trancher ⇒ AUCUNE grâce, comportement d'avant à l'octet
  // près : mieux vaut une disparition d'une minute qu'un panneau de fantômes.
  // `activatedAt` absent des opts (tous les bancs d'avant ce lot) : idem.
  //
  // ── LE REMONTAGE NE SE MESURE PAS EN SECONDES (2026-09-02) ────────────────
  // L'horloge de 90 s supposait que les libellés reviennent SEULS. Ils ne
  // reviennent pas : VS Code ne désérialise un webview restauré qu'à sa
  // première VISITE, et jusque-là son onglet porte le titre générique
  // « Claude Code » (cf. labels.js `isPlaceholderTabLabel`). Mesuré au journal
  // sur quatre rechargements du 2026-09-02 : premiers vrais libellés à +195 s,
  // +237 s, +567 s, +627 s — chaque fois à l'instant d'une visite. Cinq minutes
  // après un reload, la grâce était donc écoulée depuis longtemps et trois
  // onglets grands ouverts passaient pour « prouvés fermés » : 2 lignes pour
  // 5 onglets (capture user, §9(d) des notes d'audit).
  // Le témoin juste est donc le FAIT, pas le délai : reste-t-il un onglet
  // Claude dont le libellé n'est pas encore résolu ? L'horloge est conservée
  // pour ce qu'elle seule couvre — les toutes premières secondes, où la liste
  // d'onglets elle-même peut être incomplète, donc sans aucun blanc à voir.
  const settling = openIds.size > 0
    && ((typeof opts.activatedAt === 'number' && now - opts.activatedAt < ACTIVATION_GRACE_MS)
      || labels.some(isPlaceholderTabLabel));

  // ── JOURNAL DE PRÉSENCE (2026-09-02) ──────────────────────────────────────
  // « Le JOURNAL tranche, jamais un mécanisme inféré » (CLAUDE.md) ne valait
  // que pour le SURLIGNAGE : le 2026-09-02, aucune ligne du journal ne pouvait
  // dire par quelle règle une conversation avait quitté le panneau, et le
  // diagnostic a dû se reconstituer par les `matches:0` des verdicts de
  // surlignage — un signal qui ne parle QUE de l'onglet actif, donc muet sur
  // les quatre autres lignes manquantes. Une ligne par CHANGEMENT de
  // composition ferme l'angle mort ; le filtre anti-bavardage la garde lisible.
  // Aucun verdict n'en dépend (cf. ack-journal.js : ce module n'influence rien).
  const dropped = [];

  // PASSE 2 — décide qui est visible, dans le même ordre, avec l'appariement
  // déjà connu.
  for (const p of prepared) {
    const { c, t, state, lastPrompt, title, titleSource } = p;
    const hasTab = pairing.index.has(c.sessionId);
    // Tolérance à une perte AMBIGUË (cf. resolveHasTabForPresence) : une ligne
    // déjà affichée ne part JAMAIS sur le seul fait qu'un groupe de sœurs
    // homonymes a retrouvé son ordre de départage cette fois-ci. Une perte
    // NON ambiguë (pairing.ambiguous ne contient pas ce sessionId) reste,
    // elle, immédiate — c'est un fait fiable, pas un tirage au sort.
    // Pendant le remontage (cf. `settling`), la preuve d'onglet vient du
    // RENDERER et de lui seul : les libellés ne sont pas tous revenus, et la
    // tolérance aux pertes ambiguës ne sait rien d'une source absente. Le
    // reste du temps, rien ne change.
    // UNION des deux preuves, jamais le memento seul (2026-09-02) : un onglet
    // NEUF — celui qu'une vague vient d'ouvrir — porte lui aussi le libellé
    // générique, donc `settling` est vrai en plein régime normal, et le memento
    // du renderer ne connaît pas encore cette session (il retarde jusqu'à ~27 s,
    // et il gèle tant que la fenêtre n'a pas le focus). Le juger sur le seul
    // memento masquerait la conversation qu'on vient d'ouvrir. Un libellé qui
    // matche reste ce qu'il a toujours été : une preuve d'onglet ouvert.
    // Une fermeture OBSERVÉE rend la perte non ambiguë, donc immédiate (frère du
    // correctif ci-dessus, même passe) : la tolérance existe pour le seul cas
    // « le départage des sœurs homonymes a désigné l'autre cette fois-ci », un
    // tirage au sort dont on se méfie — pas pour un onglet qu'on a VU se fermer.
    // Sans ça, `open` restait vrai le temps des tolérances et masquait `closedAt`
    // à `isGone` par le même chemin exactement, sur l'autre branche. La preuve
    // fraîche garde toujours le dernier mot : `hasTab` sort `true` avant même
    // d'arriver ici (cf. resolveHasTabForPresence).
    const presenceHasTab = settling
      ? (openIds.has(c.sessionId) || hasTab)
      : resolveHasTabForPresence(
        c.sessionId, hasTab,
        pairing.ambiguous.has(c.sessionId) && !closedAt.has(c.sessionId),
        presenceMisses
      );
    const gone = isGone(
      { sessionId: c.sessionId, title, titleSource, state, mtime: c.mtime },
      tabs, closedAt, live, foreign, presenceHasTab
    );
    // Onglet prouvé fermé ⇒ ligne retirée, SANS exception (décision user
    // 2026-08-26, qui révoque la rétention du lot 3). La marque « à relire »
    // garde ses deux autres effets — exemption du filtre d'ancienneté, priorité
    // dans les candidats — mais elle ne survit plus à la fermeture de l'onglet.
    // C'est ce `if` qui rend la réouverture IMPOSSIBLE par construction : plus
    // aucune ligne ne peut être rendue sans onglet derrière, donc plus aucun
    // clic ne peut demander d'en ouvrir un.
    if (gone) {
      // Jamais rendue — mais son identité reste candidate à la supplantation
      // (cf. commentaire au-dessus de `supersedeCandidates`). `gone` implique
      // déjà `!hasTab` (isGone retourne plus tôt sinon) : tabOpen est donc
      // toujours faux ici, pas besoin de resolveTabOpen.
      supersedeCandidates.push({
        sessionId: c.sessionId, title, titleSource,
        mtime: c.mtime, live: live.has(c.sessionId), tabOpen: false, transcript: c.transcript,
      });
      dropped.push({
        id: c.sessionId, rule: 'gone', state, labelMatch: hasTab, memento: openIds.has(c.sessionId),
        live: live.has(c.sessionId),
        foreign: foreign.has(c.sessionId), closed: closedAt.has(c.sessionId), src: titleSource,
      });
      continue;
    }
    // Le rendu reste borné à maxItems (comme avant), mais le scan, lui,
    // continue jusqu'à SCAN_LIMIT — sans ça, un husk plus ancien que les
    // maxItems convs visibles ne serait jamais lu, donc jamais candidat.
    if (conversations.length >= maxItems) { dropped.push({ id: c.sessionId, rule: 'maxItems' }); continue; }
    const row = {
      sessionId: c.sessionId,
      title,
      // Un onglet porte-t-il encore cette conv (union de toutes les fenêtres) ?
      // Sert au badge « terminé, l'onglet peut être fermé » des membres de
      // groupe (lot 2). `tabs.known` faux = on ne sait rien des onglets → false,
      // et le badge ne s'affiche pas : ne rien proposer vaut mieux que proposer
      // de fermer un onglet dont on ignore l'existence. Sinon, l'appariement
      // bijectif (`hasTab`, plus haut) passe par resolveTabOpen (lot « bascule
      // au focus ») pour absorber un manque isolé plutôt que de le croire
      // tout de suite.
      // Pendant le remontage (`settling`), MÊME JUGE que la présence : le
      // memento du renderer. La présence avait été corrigée ainsi en 2.86.2,
      // mais tabOpen restait jugé sur l'appariement de libellés — or les CLI
      // respawnent et les libellés ne sont pas tous revenus : une conv done
      // (CLI pas encore vivant, isLive muet) épuisait ses 2 tolérances en un
      // burst de recomputes et PANEL.JS BARRAIT son titre ~30 s, onglet grand
      // ouvert à l'écran (constat user au reload de la 2.96.0, 2026-08-31).
      // « Un fait d'affichage doit avoir UNE source » : la ligne et son barré
      // se jugent ensemble ou pas du tout. Banc : test-presence.js §14.
      tabOpen: tabs.known
        ? (settling
          ? presenceHasTab
          : resolveTabOpen(c.sessionId, hasTab, tabOpenMisses, live.has(c.sessionId)))
        : false,
      // Cette conv appartient-elle à un groupe où l'appariement est arbitraire
      // (mêmes titres tronqués) ? Lot 3 du plan d'appariement : consommé par
      // le surlignage plus bas (se taire plutôt que deviner) et par le webview
      // (signe discret + infobulle sur la ligne).
      tabAmbiguous: pairing.ambiguous.has(c.sessionId),
      // Le consommateur (focus.js, extension.js) rematche des libellés
      // d'onglets contre ces titres — DEUX depuis 2.114.0 : `title` et ce
      // dernier prompt (jamais rendu) — cf. convMatchesLabel.
      lastPrompt,
      titleSource,
      state,
      acked: isAcked(c.entry),
      since: (c.entry && (c.entry.since || c.entry.updated_at)) || c.mtime || null,
      // Démarrage du run en cours (lot 10, posé par le hook UserPromptSubmit) —
      // distinct de `since` ci-dessus, qui est réécrit à chaque `done`/`waiting`.
      // Sert uniquement à l'ack strict côté extension.js ; absent (conv
      // d'avant ce lot) → l'appelant ne doit RIEN en déduire, pas un skip.
      busySince: (c.entry && c.entry.busy_since) || null,
      model: (t && t.model) || null,
      modelId: (t && t.modelId) || null,
      // Effort réel du dernier tour, tel qu'écrit dans le transcript — absent
      // sur les conversations qui n'en portent pas (cf. extractLastAssistant).
      effort: (t && t.effort) || null,
      ctx: (t && t.ctx) || null,
      // Intégrale de consommation, là où `ctx` n'est qu'une photo. Calculé
      // seulement pour les convs RENDUES (on est déjà passé sous maxItems) :
      // le périmètre est la VUE, comme le veut le plan — une conv masquée ne
      // coûte pas une lecture d'append.
      cost: readCost && c.transcript ? readCost(c.transcript) : null,
      message: state === 'waiting' && c.entry ? (c.entry.message || null) : null,
      isActive: false,
      transcript: c.transcript,
      mtime: c.mtime,
    };
    conversations.push(row);
    supersedeCandidates.push(row);
  }

  // Une ligne quand la composition de la liste change — jamais à chaque
  // recompute (cf. presenceJournalFilter). Enveloppée comme tout le reste du
  // journal : elle ne décide rien et ne doit jamais casser un snapshot.
  try {
    const sig = JSON.stringify([
      conversations.length, settling,
      dropped.map((d) => `${d.id}:${d.rule}:${d.labelMatch ? 'L' : '-'}${d.memento ? 'M' : '-'}`),
      [...aged],
    ]);
    const take = presenceJournalFilter.take('presence', sig);
    if (take) {
      logEvent('presence-drop', {
        shown: conversations.length,
        settling,
        openIds: openIds.size,
        labels: labels.length,
        placeholders: labels.filter(isPlaceholderTabLabel).length,
        tabsKnown: !!tabs.known,
        aged: [...aged],
        dropped,
        repeatsSkipped: take.repeatsSkipped,
      });
    }
  } catch {}

  // Supplantation de session, à travers un reload OU un respawn spontané
  // (supersede.js) : quand l'extension officielle relance une conversation
  // sous un NOUVEAU sessionId, l'ancien transcript subsiste en HUSK mort. Deux
  // lignes pour une seule conversation (bug 3, 2026-07-24) : on sort le husk de
  // la VUE et on PUBLIE la redirection husk→successeur, pour que les membres de
  // groupe rattachés à l'ancien id suivent le successeur vivant (bugs 1 & 2,
  // résolus côté extension.js — la vue ne réécrit rien de durable). Calculé sur
  // `supersedeCandidates` (visibles + masquées, cf. plus haut), PAS sur la
  // seule `conversations` : depuis le durcissement 2026-08-05, un husk dont le
  // titre a dérivé ne matche plus aucun onglet — isGone le masque avant même
  // que ce calcul tourne — mais son premier message, lui, reste comparable.
  const supersededBy = computeSupersededBy(supersedeCandidates.map((c) => ({
    sessionId: c.sessionId,
    title: c.title,
    titleSource: c.titleSource,
    mtime: c.mtime,
    live: live.has(c.sessionId),
    tabOpen: c.tabOpen,
    // Nombre d'onglets qui portent cette conv (cf. countOpenTabs) : ce qui
    // permet à supersede.js de distinguer un onglet REPRIS d'un onglet de plus.
    tabMatches: countOpenTabs(c, tabs),
    // Second signal (durci 2026-08-05) : premier message user, pour folder un
    // respawn même quand l'ai-title a dérivé d'un mot — cf. createFirstUserReader.
    firstUser: typeof readFirstUser === 'function' ? readFirstUser(c.transcript) : null,
  })));
  if (Object.keys(supersededBy).length) {
    for (let i = conversations.length - 1; i >= 0; i--) {
      if (supersededBy[conversations[i].sessionId]) conversations.splice(i, 1);
    }
  }

  // Tri d'AFFICHAGE (indépendant du tri mtime ci-dessus, qui ne sert qu'à
  // borner la lecture des transcripts — cf. SCAN_LIMIT). 3 modes exposés au
  // panneau (claudeCodeQuotaBar.conversationSortOrder) :
  //  - lastActivity : ordre déjà obtenu par le tri des candidats, rien à faire.
  //  - tabOrder : ordre des onglets VS Code (position dans l'appariement
  //    bijectif `pairing`, lot 2 du plan d'appariement — plus le premier match
  //    par libellé d'avant ce lot, qui donnait le MÊME rang à deux sœurs
  //    homonymes). Une conv sans onglet assigné (CLI, ou tabs.known false)
  //    part en Infinity : Array.prototype.sort étant stable (garanti ES2019+),
  //    ces convs gardent entre elles leur ordre mtime d'origine au lieu d'être
  //    mélangées.
  //  - statusFirst : busy/waiting en tête, peu importe l'ancienneté ; le reste
  //    garde l'ordre mtime (même stabilité de tri).
  const sortOrder = typeof opts.sortOrder === 'function' ? opts.sortOrder() : opts.sortOrder;
  if (sortOrder === 'tabOrder') {
    const posOf = new Map();
    for (const c of conversations) {
      const idx = pairing.index.get(c.sessionId);
      posOf.set(c.sessionId, typeof idx === 'number' ? idx : Infinity);
    }
    conversations.sort((a, b) => posOf.get(a.sessionId) - posOf.get(b.sessionId));
  } else if (sortOrder === 'statusFirst') {
    const rank = (c) => (c.state === 'busy' || c.state === 'waiting') ? 0 : 1;
    conversations.sort((a, b) => rank(a) - rank(b));
  }

  // Surlignage « conversation courante » = la conv dont l'ONGLET est sélectionné
  // dans cette fenêtre (tabs.activeLabel, mémorisé par tabs.js). Avant le
  // 2026-07-19 il suivait active-session.json — la conv du DERNIER PROMPT
  // SOUMIS — et ne bougeait donc jamais au clic sur un onglet. Ce fichier ne
  // sert plus que de repli quand la fenêtre n'a encore jamais eu d'onglet Claude
  // sélectionné (fenêtre fraîche, panneau seul). Un activeLabel qui ne matche
  // AUCUNE conv listée (titre renommé onglet inactif, conv hors maxItems) ne se
  // rabat PAS sur le repli : aucun surlignage vaut mieux qu'un surlignage faux.
  //
  // « la conversation appariée à CET INDEX » (lot 2 du plan d'appariement,
  // 2026-08-21) — plus « le premier libellé qui matche », qui désignait
  // n'importe laquelle de deux sœurs homonymes selon l'ordre d'affichage du
  // moment (le bug d'origine : le surlignage suivait l'activité, pas
  // l'onglet réellement sélectionné). `tabs.activeIndex` n'est valable dans
  // l'union `tabs.labels` que si les libellés locaux en restent le PRÉFIXE
  // (cf. tabs.js `allLabels()`) — vérifié ici plutôt que supposé, en
  // comparant le libellé à cet index à `activeLabel`.
  const activeLabel = (tabs && tabs.activeLabel) || null;
  const rawActiveIndex = tabs && typeof tabs.activeIndex === 'number' ? tabs.activeIndex : null;
  const activeIndex = (rawActiveIndex != null && tabs.labels && tabs.labels[rawActiveIndex] === activeLabel)
    ? rawActiveIndex : null;
  let highlightVia = 'none';
  let highlightSessionId = null;
  let highlightMatches = 0;
  if (activeLabel) {
    highlightMatches = conversations.reduce((n, c) => n + (convMatchesLabel(activeLabel, c) ? 1 : 0), 0);
    // Repli sur l'ancien matching par libellé (premier match dans l'ordre
    // d'affichage) quand l'index n'est pas disponible — acte mémorisé,
    // souvenir de repli, ou index qui ne désigne aucune conv visible.
    let target = activeIndex != null
      ? conversations.find((c) => pairing.index.get(c.sessionId) === activeIndex)
      : null;
    const byIndex = !!target;
    if (!target) target = conversations.find((c) => convMatchesLabel(activeLabel, c));
    // ── PLUSIEURS CONVERSATIONS PORTENT CE LIBELLÉ ⇒ SEULE L'IDENTITÉ TRANCHE
    // (2026-08-29, onzième reprise du symptôme). La garde d'origine (lot 3 du
    // plan d'appariement) testait `pairing.ambiguous` — le verdict de pairTabs,
    // pas le fait observable. Relevé au journal ce jour sur deux sœurs
    // homonymes RÉELLES : `matches:2` et pourtant `via:"label"`, donc un target
    // désigné par « le premier qui matche » — c'est-à-dire au hasard, et le
    // surlignage sautait d'une sœur à l'autre d'un recompute au suivant.
    //
    // Le critère est désormais le fait lui-même : dès que `highlightMatches > 1`,
    // aucun raisonnement TEXTUEL ne peut désigner la bonne — ni le repli par
    // libellé, ni un appariement que pairTabs a lui-même marqué arbitraire.
    // Le critère n'est PAS « pairTabs a-t-il su apparier » — il croit toujours
    // savoir, y compris quand il vient de tirer au sort entre deux libellés
    // égaux (c'est le bug d'origine). C'est « d'où vient cet index » : du
    // memento validé, qui NOMME l'onglet de cette session, ou d'un appariement
    // par ordre, qui ne fait que la placer. Dans le second cas, avec plusieurs
    // conversations au même libellé, seule une identité vraie peut désigner.
    const arbitrary = highlightMatches > 1
      && !(target && indexFromMemento.has(target.sessionId));
    if (target && arbitrary) {
      // La SEULE identité admise ici : `tabs.actSessionId`, le sessionId que le
      // CLIC du panneau vient d'activer par la voie identité (focus.js) — un
      // geste humain visant CETTE conversation-là.
      // `active-session.json` (la conv du DERNIER PROMPT soumis) a été retiré de
      // ce départage en 2.110.0 : il ne mesure pas la bonne grandeur. Écrire
      // dans une conversation ne dit pas quel onglet est AFFICHÉ — on peut
      // soumettre dans l'une des deux sœurs puis aller lire l'autre depuis la
      // barre d'onglets, et le surlignage restait alors faux SANS RECOURS (un
      // `highlightSessionId` posé interdit au juge renderer de combler).
      // Se taire est le repli honnête, et il est ACTIF : sans identité, la ligne
      // reste éteinte, donc le juge renderer comble par identité exacte au flush
      // suivant (~5 s mesurées) — une meilleure preuve, pas une preuve en moins.
      const clicked = tabs && tabs.actSessionId;
      const sister = (clicked
        && conversations.find((c) => c.sessionId === clicked && convMatchesLabel(activeLabel, c)))
        || null;
      target = sister || null;
      if (sister) highlightVia = 'panel-click';
    }
    if (target) {
      target.isActive = true;
      // `label` ne s'écrit que si aucune IDENTITÉ n'a désigné la cible :
      // écraser 'panel-click'/'active-session' ferait passer une preuve exacte
      // pour une correspondance de texte au journal — et c'est ce journal qui
      // sert à diagnostiquer ce chemin (règle du dossier, 2026-08-26).
      // `identity` (2026-09-03) : aucun libellé ne matche, c'est la POSITION du
      // memento validé qui a désigné la ligne — le journal doit le dire tel
      // quel, pas « label » (une correspondance de texte qui n'a pas eu lieu).
      if (highlightVia === 'none') highlightVia = (byIndex && highlightMatches === 0) ? 'identity' : 'label';
      highlightSessionId = target.sessionId;
    }
  }
  // PAS de branche « aucun onglet Claude sélectionné » (retirée en 2.110.0).
  // Elle surlignait alors `active-session.json`, la conv du dernier prompt
  // soumis — sur une fenêtre qui n'a AUCUN onglet Claude à l'écran, c'est
  // désigner une conversation qu'on ne regarde pas. Le sens honnête est : rien.
  // Le juge renderer ci-dessous reste, lui, libre d'allumer la ligne de
  // l'éditeur réellement affiché, par identité.

  // ── LE JUGE RENDERER COMBLE UN SURLIGNAGE VIDE (2.106.0) ──────────────────
  // Tout le verdict ci-dessus descend d'UNE source : la copie miroir tabGroups
  // de l'hôte d'extension (via tabs.js). Elle donne le bon LIBELLÉ — jamais une
  // IDENTITÉ. Quand ce libellé ne correspond à aucune conversation listée
  // (l'onglet a été renommé avec le début du prompt de sa tâche, mesuré le
  // 2026-09-02 et signalé par l'user), il ne reste RIEN et le panneau n'allume
  // plus la ligne de l'onglet qu'on regarde.
  //
  // Le juge est une source ÉTRANGÈRE au miroir : le memento
  // `workbench.parts.editor` du state.vscdb, écrit par le RENDERER — le
  // processus qui peint l'écran — et qui porte l'IDENTITÉ exacte (sessionID) de
  // l'éditeur actif, pas un libellé tronqué à apparier (cf. session-titles.js
  // createRendererActive).
  //
  // Il ne COMBLE, il n'ÉCRASE jamais (`judgeAllowed`) : dès qu'une preuve a déjà
  // désigné une ligne — identité, position du memento, libellé, clic — c'est
  // elle qui tient, et le memento (qui retarde jusqu'à 27 s, mesuré) n'a rien à
  // redire. La branche « écraser pour corriger un mensonge du miroir » est
  // partie en 2.110.0 avec le mensonge lui-même (VS Code ≥ 1.135), et avec elle
  // sa marge longue, son bandeau et ses épisodes.
  //
  // Ses trois refus, inchangés :
  //  - memento plus vieux que le dernier avis du tracker (flushedAt - marge >
  //    labelChangedAt) : il n'apprend rien, on se tait ;
  //  - actif non-Claude (claude:false, l'utilisateur est sur un fichier) : le
  //    repli-souvenir garde la main — basculer sur un fichier n'éteint pas le
  //    surlignage ;
  //  - session hors liste : se taire vaut mieux qu'un surlignage sur de
  //    l'invisible.
  const rendererTruth = (typeof opts.rendererActive === 'function' && opts.rendererActive()) || null;
  const judgeAllowed = !highlightSessionId;
  const truthUsable = judgeAllowed && !!(rendererTruth && rendererTruth.claude && rendererTruth.sessionId
      && typeof rendererTruth.flushedAt === 'number'
      && tabs && typeof tabs.labelChangedAt === 'number' && tabs.labelChangedAt > 0);
  const truthFresh = truthUsable
    && rendererTruth.flushedAt - RENDERER_TRUTH_FILL_MARGIN_MS > tabs.labelChangedAt;
  if (truthFresh) {
    const target = conversations.find((c) => c.sessionId === rendererTruth.sessionId);
    if (target) {
      for (const c of conversations) c.isActive = false;
      target.isActive = true;
      highlightSessionId = rendererTruth.sessionId;
      highlightVia = 'renderer-truth';
    }
  }
  // Journal du lot 0 (préalable au fix d'appariement) — un OBSERVATEUR : aucune
  // décision ci-dessus n'en dépend, l'absence de journal ne change rien au
  // rendu. Ne trace qu'un CHANGEMENT de verdict (verdictFilter), sinon le
  // panneau produirait des dizaines de lignes par minute. Cf. lot 0 du
  // PLAN_appariement_onglets_2026-08-15.md pour le détail des champs.
  {
    const sig = JSON.stringify([activeLabel, highlightSessionId, highlightVia, highlightMatches,
      tabs && tabs.source]);
    const taken = highlightVerdictFilter.take('highlight', sig);
    if (taken) {
      logEvent('highlight-verdict', {
        activeLabel, sessionId: highlightSessionId, matches: highlightMatches,
        activeSessionId, via: highlightVia,
        source: (tabs && tabs.source) || null,
        windowFocused: tabs ? tabs.windowFocused : null,
        sinceFocusMs: tabs ? tabs.sinceFocusMs : null,
        repeatsSkipped: taken.repeatsSkipped,
      });
    }
  }

  // Purge des compteurs de sessions qui ne sont même plus candidates (fermées
  // depuis longtemps, hors recentMs) : resolveTabOpen ne doit pas accumuler
  // pour l'éternité une conv qui ne repassera plus jamais par buildSnapshot.
  for (const id of [...tabOpenMisses.keys()]) {
    if (!byId.has(id)) tabOpenMisses.delete(id);
  }
  // Même raison, même risque de fuite : presenceMisses (resolveHasTabForPresence).
  for (const id of [...presenceMisses.keys()]) {
    if (!byId.has(id)) presenceMisses.delete(id);
  }
  // Même raison pour l'accumulateur de coût : ses totaux par fichier n'ont plus
  // de consommateur dès qu'une conversation quitte l'ensemble des candidates.
  if (readCost && typeof readCost.forget === 'function') {
    const keep = new Set();
    for (const c of byId.values()) if (c.transcript) keep.add(c.transcript);
    readCost.forget(keep);
  }

  // Déjà trié (lastActivity/tabOrder/statusFirst ci-dessus) et borné à maxItems.
  // `supersededBy` (husk→successeur) : la redirection d'identité que les
  // consommateurs de sessionId (membres de groupe, master, moteur de vagues)
  // appliquent au rendu — cf. supersede.js. Vide dans le cas nominal.
  return { conversations, activeSessionId, generatedAt: now, supersededBy };
}

// Ce que le webview AFFICHE, et rien d'autre. Le snapshot porte aussi des champs
// qui bougent sans rien changer à l'écran — au premier chef `mtime`, réécrit à
// chaque ligne du transcript pendant qu'une conv travaille. Les inclure ici
// revenait à notifier le panneau en boucle pendant un run, donc à re-rendre ses
// nœuds, donc à remettre l'animation du spinner à zéro (lot 6c) : le rendu
// incrémental de panel.js encaisse déjà ce cas, autant ne pas produire le bruit.
function renderKey(convs) {
  return JSON.stringify(convs.map((c) => [
    c.sessionId, c.title, c.state, c.acked, c.model, c.effort,
    c.ctx ? Math.round(c.ctx.pct) : null, c.isActive, c.message,
    // Coût AU CENTIME — la précision affichée, pas la précision calculée : le
    // panneau montre deux décimales, une variation plus fine ne change rien à
    // l'écran et ne mérite pas un push. Même esprit que le ctx% arrondi.
    c.cost ? Math.round(c.cost.total * 100) : null,
    // Coût du dernier tour, même précision : sans lui, la couleur de rythme
    // (B3) ne se rafraîchirait pas tant que le CUMUL n'a pas assez bougé pour
    // changer son propre centime arrondi.
    c.cost ? Math.round(c.cost.lastTurn * 100) : null,
    // `tabOpen` (lot « bascule au focus ») : sans lui, un recompute qui corrige
    // tout seul une valeur fausse (cf. resolveTabOpen) ne repousse rien au
    // panneau tant qu'aucun AUTRE champ n'a changé — le chip resterait faux
    // jusqu'à un événement sans rapport.
    c.tabOpen,
  ]));
}

function createStateEngine(options = {}) {
  // Onglets fermés observés par tabs.js : sessionId → instant de fermeture.
  // Le moteur en est propriétaire ; isGone() y purge les sessions reparties.
  const closedAt = new Map();
  // Compteur de manques consécutifs pour resolveTabOpen (lot « bascule au
  // focus ») : DOIT survivre d'un recompute à l'autre pour que la tolérance
  // serve à quelque chose — une Map fraîche à chaque appel annulerait le lot.
  const tabOpenMisses = new Map();
  // Même besoin de survie d'un recompute à l'autre, pour resolveHasTabForPresence
  // (lot « présence par identifiant ») — Map SÉPARÉE de tabOpenMisses ci-dessus :
  // les deux comptent des manques sur des questions différentes (le chip
  // d'affichage vs la présence même de la ligne) et ne doivent pas se remettre
  // à zéro l'une l'autre.
  const presenceMisses = new Map();
  // `liveSessions` a un défaut RÉEL : le registre est du Node pur, lisible d'ici
  // (contrairement au state.vscdb, dont seul l'hôte d'extension connaît le
  // chemin — d'où `openSessionIds` sans défaut, injecté par extension.js).
  // Accumulateur de coût, propriété du moteur : il DOIT survivre d'un recompute
  // à l'autre — c'est lui qui porte l'octet où la lecture s'était arrêtée. Une
  // instance neuve à chaque tick relirait des dizaines de Mo toutes les 30 s.
  // `options.readCost` a la priorité pour que les bancs injectent le leur.
  const readCost = typeof options.readCost === 'function' ? options.readCost : createCostReader();
  const opts = {
    liveSessions: liveSessionIds, foreignSessions: foreignSessionIds,
    // Défaut RÉEL, même registre que liveSessions ci-dessus (live-sessions.js) :
    // cf. `startedAt` sur effectiveState.
    liveSessionStarts: () => new Map(liveSessionEntries().map((e) => [e.sessionId, e.startedAt || null])),
    ...DEFAULTS, ...options, closedAt, tabOpenMisses, presenceMisses, readCost,
  };
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
  // Part de la clé de rendu qui N'EST PAS dans les conversations (2026-08-06).
  //
  // POURQUOI — `renderKey` ne décrit que la LISTE. Or le panneau affiche aussi
  // les groupes, dont le statut (member-truth.js) se déduit de sources que la
  // liste ne porte pas : registre des sessions vivantes, état des hooks, onglet
  // prouvé fermé. Ces sources bougent SANS que la liste change — typiquement
  // juste après la fermeture du dernier onglet d'un groupe : la conversation a
  // déjà quitté la vue (un push a eu lieu), puis, quelques centaines de ms plus
  // tard, la purge de sessions-state.json / la disparition du fichier de session
  // fait basculer la maîtresse en « terminée ». Le recompute correspondant
  // tirait bien (les watchers sont là), mais sa clé — conversations seules —
  // était IDENTIQUE : aucun onChange, donc aucun push, donc le groupe et sa
  // ligne maîtresse restaient à l'écran jusqu'au prochain événement sans
  // rapport (ouverture d'une conversation, rafraîchissement du quota).
  //
  // L'appelant injecte donc une signature de CE QU'IL RENDRA en plus de la
  // liste. Absente (bancs, usage isolé) → comportement d'avant, à l'octet près.
  const extraKey = typeof opts.extraKey === 'function' ? opts.extraKey : null;
  let extraKeyErrors = 0;
  const readTranscript = createTranscriptReader();
  const readFirstUser = createFirstUserReader();
  const watchers = [];
  let snapshot = buildSnapshot(opts, readTranscript, readFirstUser);
  // Pas d'extraKey ici : l'appelant construit son moteur AVANT d'avoir de quoi
  // répondre (extension.js n'a pas encore sa référence `stateEngine`). Le
  // premier recompute verra donc une clé différente et poussera une fois — un
  // push de plus au démarrage, jamais un push de moins.
  let lastKey = renderKey(snapshot.conversations);
  let debounce = null;
  let disposed = false;

  function recompute() {
    if (disposed) return;
    const next = buildSnapshot(opts, readTranscript, readFirstUser);
    // AVANT de composer la clé : extraKey() interroge l'appelant, qui relit ce
    // moteur (getSnapshot) pour résoudre ses groupes — il doit y trouver le
    // snapshot du tour courant, pas celui du précédent.
    snapshot = next;
    let key = renderKey(next.conversations);
    if (extraKey) {
      // Une signature qui jette ne doit jamais empêcher la notification : le
      // doute profite à l'affichage, comme partout ailleurs dans ce module.
      let extra;
      // Un compteur, pas une horloge : deux recomputes peuvent tomber dans la
      // même milliseconde, et la clé serait alors identique — le panneau
      // resterait muet précisément quand on ne sait plus rien.
      try { extra = String(extraKey()); } catch { extra = 'err:' + (++extraKeyErrors); }
      key += '|' + extra;
    }
    // generatedAt et mtime bougent en permanence : ne notifier que si le RENDU
    // change vraiment (cf. renderKey).
    if (key === lastKey) return;
    lastKey = key;
    try { onChange(snapshot); } catch {}
  }

  function schedule() {
    if (disposed) return;
    clearTimeout(debounce);
    debounce = setTimeout(recompute, opts.debounceMs);
  }

  function watch(dir, filter) {
    try {
      const w = fs.watch(dir, (_evt, filename) => {
        if (!filename || filter(filename)) schedule();
      });
      watchers.push(w);
    } catch {}
  }

  watch(CLAUDE_DIR, (f) => f === 'sessions-state.json' || f === 'active-session.json');
  const projectDir = projectDirFor(opts.workspacePath);
  if (projectDir && fs.existsSync(projectDir)) watch(projectDir, (f) => f.endsWith('.jsonl'));
  // Registre des sessions vivantes : un fichier apparaît/disparaît à chaque
  // ouverture/fermeture de conversation. Sans ce watcher, la reprise
  // d'affichage d'une conv relancée (ou son retrait à la mort du CLI)
  // attendrait le tick 30 s. Dossier absent (CLI plus ancien) → pas de
  // watcher, pas d'erreur : `watch` avale déjà l'échec.
  watch(SESSIONS_DIR, (f) => f.endsWith('.json'));

  // Tick d'horloge — PAS un poll de données : busy→stale et done→idle sont des
  // transitions PUREMENT temporelles, qui ne produisent aucun événement fichier
  // (un process mort n'écrit plus, justement). Sans ce tick, un zombie resterait
  // « au travail » à l'écran indéfiniment. Coût : quelques statSync/30 s, et
  // onChange n'est appelé que si le rendu change réellement.
  const ticker = setInterval(recompute, opts.tickMs);

  return {
    getSnapshot: () => snapshot,
    refresh: recompute,
    // Onglet PROUVÉ fermé (étape 17, member-truth.js bug n°6) : `closedAt` est
    // posé ICI, au moment même de l'événement d'onglet — avant que le registre
    // des sessions ou les hooks aient eu le temps de purger leur propre trace.
    // C'est le fait le plus À JOUR que le module détienne sur cet onglet ;
    // l'exposer permet à member-truth de ne plus jamais présumer un onglet
    // ouvert (`idle`/`inserted`) pendant la course asynchrone qui suit.
    // `isTabGone` l'a complété du 2026-08-24 au 2026-09-05 : « identité publiée
    // par le store d'onglets + aucun onglet apparié ⇒ fermée », le seul verdict
    // qui couvrait une fermeture faite fenêtre éteinte ou un process orphelin.
    // Retiré en 2.114.0 avec le store, mesuré mort (2 entrées pour 7 onglets) —
    // il ne concluait donc plus rien, sinon à tort. Personne ne le remplace :
    // ces deux cas ne sont plus couverts, et une parade « memento validé sans
    // la session ⇒ fermée » est explicitement EXCLUE (le memento est par
    // fenêtre, les libellés sont l'union des fenêtres : faux positif
    // inter-fenêtres garanti).
    isTabClosed: (sessionId) => closedAt.has(sessionId),
    // Onglet(s) fermé(s) : on retire tout de suite, SANS attendre la purge de
    // sessions-state.json que fait l'appelant derrière — celle-ci prend un lock
    // inter-process et peut traîner ; l'affichage, lui, doit tomber sous la
    // seconde (exigence du lot).
    markClosed(sessionIds) {
      const now = Date.now();
      let touched = false;
      for (const id of sessionIds || []) {
        if (!id) continue;
        closedAt.set(id, now);
        tabOpenMisses.delete(id);
        touched = true;
      }
      if (!touched) return;
      for (const [id, ts] of closedAt) {
        if (now - ts > STATE_ENTRY_MAX_AGE_MS) closedAt.delete(id);
      }
      recompute();
    },
    dispose() {
      disposed = true;
      clearTimeout(debounce);
      clearInterval(ticker);
      for (const w of watchers) { try { w.close(); } catch {} }
      watchers.length = 0;
    },
  };
}

module.exports = {
  createStateEngine,
  buildSnapshot,
  projectDirFor,
  effectiveState,
  applyTranscriptTruth,
  isAcked,
  isGone,
  resolveTabOpen,
  resolveHasTabForPresence,
  PRESENCE_MISS_TOLERANCE,
  renderKey,
  readSessionsState,
  readActiveSessionId,
  createTranscriptReader,
  createFirstUserReader,
  SESSIONS_STATE_PATH,
  STALE_MS,
  RESUME_GRACE_MS,
  CLOSE_GRACE_MS,
  TRANSCRIPT_MISSING_PURGE_MS,
  DEFAULTS,
};
