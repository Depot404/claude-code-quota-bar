#!/usr/bin/env node
// Hook multi-événements : Stop / Notification / PermissionRequest /
// PermissionDenied / Elicitation / ElicitationResult / SessionEnd /
// PreCompact / PostCompact → sessions-state.json. Un seul script pour tous :
// il route sur `hook_event_name` du payload. L'état `busy` est posé par
// track-active-session.js (UserPromptSubmit).
//
// Source canonique : Tools/ClaudeCodeQuotaBar/hooks/. Déployé vers
// ~/.claude/scripts/ par install.ps1 — ne pas éditer la copie déployée.
//
// RÈGLE DU LOT « toute attente = ? » : dès que Claude rend la main à
// l'utilisateur, quelle qu'en soit la forme, la conv passe `waiting` (le
// panneau affiche « ? » et joue le son). Aucune forme d'attente ne doit
// dépendre du seul événement `Notification` — cf. ci-dessous.
//
// ── PreCompact/PostCompact (constat user 2026-08-25, « aucun symbole pendant
// une compaction ») ──────────────────────────────────────────────────────
// La compaction AUTOMATIQUE (matcher `auto`, précompute en tâche de fond
// entre deux tours — cf. `precomputeCompactionEnabled` du CLI) ne passe PAR
// AUCUN prompt utilisateur : UserPromptSubmit ne la voit jamais. PreCompact
// pose donc ici un marqueur DÉDIÉ (`compacting`/`compact_since`), lu par
// `effectiveState` (state.js) pour forcer l'affichage `busy` — le spinner
// EXISTANT, sans toucher au rendu (panel.js) ni à `state`/`since` de
// l'entrée (l'accusé de lecture `ack_ts` reste donc exact si la conv était
// déjà `done` et lue avant la compaction).
//
// PIÈGE (même classe que le spinner éternel n°2, 2026-08-18, cf.
// hooks/transcript.js:434-509) : la doc officielle ne garantit PAS que
// PostCompact tire après chaque PreCompact (compaction bloquée par un AUTRE
// hook, CLI tué en plein milieu…) — un marqueur jamais levé gèlerait le
// spinner pour toujours. Trois filets, aucun ne suffit seul :
//  1. `compact_since` est daté ; state.js ignore le marqueur au-delà d'un
//     plafond (COMPACTING_CAP_MS) et retombe sur l'état réel de l'entrée ;
//  2. state.js ne l'honore que si le process CLI est VIVANT (isLive) — un
//     process mort ne postera jamais son PostCompact ;
//  3. le prochain UserPromptSubmit (track-active-session.js) ET le prochain
//     Stop (ci-dessous) lèvent le marqueur explicitement, bien avant le
//     plafond — la levée « naturelle » n'attend donc quasiment jamais le cas 1.
//
// PreCompact peut BLOQUER la compaction (exit 2 = deny) : ce hook reste donc
// strictement silencieux et sort toujours en 0, comme PermissionRequest.
//
// PAYLOAD RÉEL, mesuré le 2026-08-25 sur un `/compact` (hooks instrumentés,
// journal ~/.claude/compact-debug.log) — la doc ne le détaille pas :
//   PreCompact  { session_id, transcript_path, cwd, prompt_id,
//                 hook_event_name, trigger: 'manual'|'auto',
//                 custom_instructions }
//   PostCompact { …idem, trigger, compact_summary }
// Séquence observée : PreCompact (T) → PostCompact (T+2 min 34) → prompt
// suivant. AUCUN UserPromptSubmit pour la commande `/compact` elle-même, et
// AUCUN Stop après la compaction. C'est ce qui valide le choix de ne pas
// toucher à `state` : le marqueur seul allume le spinner, et sa levée rend
// l'entrée à l'état d'AVANT (`done` en manuel ; `busy` en automatique,
// puisqu'on est alors au milieu d'un tour). Aucun matcher n'est déclaré à
// l'installation (hooks-install.js) : les deux `trigger` sont donc couverts,
// l'automatique compris.

const { updateSession, removeSession, readHookInput, readState } = require('./sessions-state.js');

// « Terminée et jamais relue » est un FAIT DURABLE, pas un état de process
// (2026-08-06, 8e signalement du ✓ vif qui n'apparaît jamais).
//
// CE QUI SE PASSAIT : SessionEnd effaçait l'entrée ENTIÈRE — donc `state: done`
// ET `ack_ts`, seule trace de « tu n'es jamais revenu voir le résultat ». Or ce
// hook tire précisément quand le CLI meurt, ce qui arrive en masse au
// RECHARGEMENT d'une fenêtre VS Code : tous les CLI sont tués, toutes les
// entrées purgées, et le panneau — qui retombe alors sur `idle`, c'est-à-dire
// « les hooks ne savent rien » — repeint en ✓ ATTÉNUÉ des conversations
// terminées que personne n'a lues. Le fait survivait à l'écran (la conv est
// toujours là, son transcript aussi) mais sa vérité, elle, était détruite.
//
// Même classe d'erreur que celle documentée en tête de member-truth.js : un
// fait durable déduit d'une source volatile. La correction est symétrique de
// celle-là — on ne détruit plus la trace tant qu'elle a quelque chose à dire.
// Le fichier reste borné : `prune` (24 h sans activité) et la fermeture de
// l'onglet (extension.js closeConversations → removeSession) continuent de
// nettoyer, eux, sur des faits qui, eux, terminent vraiment la conversation.
//
// `reason: 'clear'` fait exception : /clear efface la conversation elle-même,
// il n'y a plus rien à revenir lire.
function isUnreadDone(sessionId) {
  try {
    const e = (readState().sessions || {})[sessionId];
    if (!e || e.state !== 'done') return false;
    return (e.ack_ts || 0) < (e.since || e.updated_at || 0);
  } catch { return false; }
}

// ── Notification : liste NOIRE, pas liste blanche ───────────────────────────
// Ces types ne rendent PAS la main :
//  - idle_prompt        : « aucune saisie depuis 60 s » — la conv est déjà done/idle
//  - auth_success, elicitation_complete/response, agent_completed,
//    computer_use_enter/exit, push_notification : information, pas attente.
// Tout le reste (permission_prompt, elicitation_dialog, elicitation_url_dialog,
// worker_permission_prompt, agent_needs_input, et tout type ajouté demain) est
// une attente. L'allowlist d'origine laissait passer en silence chaque type
// nouveau ou renommé — le panneau montrait alors le spinner pendant que le
// dialogue attendait une réponse.
const NOT_WAITING_TYPES = new Set([
  'idle_prompt',
  'auth_success',
  'elicitation_complete',
  'elicitation_response',
  'agent_completed',
  'computer_use_enter',
  'computer_use_exit',
  'push_notification',
]);

// Repli quand `notification_type` est absent du payload : le champ manque pour
// de bon sur certaines versions (anthropics/claude-code#11964, fermé « not
// planned » → le workaround officiel EST la lecture du message). Sans ce repli,
// une notification sans type ne posait rien du tout.
const IDLE_MESSAGE_RE = /is waiting for your input/i;
const WAITING_MESSAGE_RE = /needs? (your )?(permission|input|approval)|permission (for|to use)|waiting for (your )?(approval|permission)/i;

function isWaitingNotification(data) {
  const type = data.notification_type;
  if (typeof type === 'string' && type) return !NOT_WAITING_TYPES.has(type);
  const msg = typeof data.message === 'string' ? data.message : '';
  // Seul cas où le texte doit primer : le message d'idle_prompt (« Claude is
  // waiting for your input ») matcherait sinon la règle d'attente ci-dessous.
  if (IDLE_MESSAGE_RE.test(msg)) return false;
  return WAITING_MESSAGE_RE.test(msg);
}

function toolLabel(data) {
  return typeof data.tool_name === 'string' && data.tool_name ? data.tool_name : null;
}

// `since` porté par le patch, et non laissé à updateSession.
//
// updateSession ne réarme `since` que si l'état CHANGE — or ces événements se
// répètent à l'identique, et chaque répétition est un fait neuf :
//  - Stop → Stop : un Stop hook à feedback (exit 2) relance Claude, puis le vrai
//    Stop arrive. Sans réarmement, `since` reste celui du PREMIER Stop, et tout
//    ce qui s'y compare devient faux — la fin de tour est lue comme une reprise
//    (conv « au travail » pour toujours), et le ✓ ne redevient jamais vif alors
//    qu'il y a du neuf à lire.
//  - attente → attente : une 2e permission après une 1re accordée. Sans
//    réarmement, l'écriture qui a suivi la 1re fait passer la 2e attente pour
//    une reprise → la conv « travaille » alors qu'elle attend l'user.
// Vu en exécutant les vrais hooks (test/test-ack.js § 6), pas en relisant le code.
const stamp = () => ({ since: Date.now() });

function handle(data) {
  const sessionId = data && data.session_id;
  if (!sessionId) return;

  const base = { cwd: data.cwd || null, transcript: data.transcript_path || null };
  const waiting = (message) => updateSession(sessionId, { ...base, ...stamp(), state: 'waiting', message: message || null });
  // L'attente vient d'être levée (refus, réponse d'élicitation) : le tour
  // reprend tout de suite. On ne laisse pas le « ? » s'éteindre uniquement
  // grâce à la correction transcript de state.js — elle exige une écriture
  // postérieure de 2 s, et une conv qui ne réécrit rien resterait « ? ».
  const resumed = () => updateSession(sessionId, { ...base, ...stamp(), state: 'busy', message: null });

  switch (data.hook_event_name) {
    case 'Stop':
      // message: null → le patch efface le texte de la Notification précédente
      // compacting/compact_since: null → filet 3 (cf. en-tête) : un Stop est
      // TOUJOURS la fin d'un marqueur de compaction encore posé, qu'un
      // PostCompact ait tiré entre-temps ou non.
      updateSession(sessionId, { ...base, ...stamp(), state: 'done', message: null, compacting: null, compact_since: null });
      break;

    case 'Notification':
      if (isWaitingNotification(data)) waiting(data.message);
      break;

    // Le VRAI signal d'un dialogue de permission, et le seul immédiat.
    // `Notification:permission_prompt` n'est émis qu'après 6 s d'INACTIVITÉ de
    // l'utilisateur (garde vérifiée dans le binaire 2.1.217 : timer de 6 000 ms
    // + test « dernière interaction ≥ 6 s » ; cf. anthropics/claude-code#58909) :
    // quand l'user est devant son clavier — précisément quand il regarde le
    // panneau — il ne tire jamais, et la conv restait sur le spinner pendant que
    // le dialogue attendait. PermissionRequest, lui, tire dans le flux de
    // permission lui-même, avant l'affichage du dialogue, sans condition.
    //
    // C'est un hook DÉCISIONNEL (il peut renvoyer allow/deny) : ne jamais rien
    // écrire sur stdout ni sortir en code ≠ 0 — le silence laisse la décision à
    // l'utilisateur, qui est tout ce qu'on veut ici.
    case 'PermissionRequest': {
      const tool = toolLabel(data);
      waiting(tool ? `Claude needs your permission to use ${tool}` : 'Claude needs your permission');
      break;
    }

    // Élicitation MCP : un serveur demande une saisie, dialogue bloquant.
    case 'Elicitation': {
      const server = typeof data.mcp_server_name === 'string' && data.mcp_server_name ? data.mcp_server_name : 'An MCP server';
      waiting(`${server} needs your input`);
      break;
    }

    case 'PermissionDenied':
    case 'ElicitationResult':
      resumed();
      break;

    // Pose le marqueur — jamais `state`/`since` (cf. en-tête) : `entry.state`
    // reste la vérité de la SESSION (busy/waiting/done), le marqueur ne fait
    // que forcer l'AFFICHAGE busy par-dessus, le temps de la compaction.
    case 'PreCompact':
      updateSession(sessionId, { ...base, compacting: true, compact_since: Date.now() });
      break;

    // Ne peut PAS bloquer (exit 2 ignoré côté CLI) : lève le marqueur, sans
    // toucher à `state` — l'entrée retrouve d'elle-même son état réel
    // (busy/waiting/done) au prochain snapshot.
    case 'PostCompact':
      updateSession(sessionId, { compacting: null, compact_since: null });
      break;

    case 'SessionEnd':
      // Signal OPPORTUNISTE depuis le lot 5, plus le chemin principal : ce hook
      // ne tire ni sur /exit ni sur /clear (anthropics/claude-code#17885, #6428)
      // et reste erratique à la fermeture d'onglet (#14760, #45424). Une conv ne
      // disparaît donc plus grâce à lui mais parce que son onglet n'existe plus
      // (tabs.js + filtre de présence de state.js). On le garde : quand il tire,
      // il nettoie l'entrée gratuitement — mais rien ne doit plus en dépendre.
      //
      // SAUF si l'entrée porte encore un fait que rien d'autre ne détient :
      // terminée, jamais relue (cf. isUnreadDone ci-dessus). Nettoyer « gratuit »
      // ne l'est plus quand ça efface la seule preuve qu'il reste quelque chose
      // à lire — le ✓ vif redeviendrait pâle à chaque rechargement de fenêtre.
      if (data.reason !== 'clear' && isUnreadDone(sessionId)) break;
      removeSession(sessionId);
      break;
  }
}

// Exécuté comme hook (`node hook-session-state.js`) : payload sur stdin.
// Require() depuis un banc : rien ne se déclenche, seules les fonctions sont
// exposées — sans cette garde, un `require` resterait suspendu sur stdin.
if (require.main === module) readHookInput(handle);

module.exports = { handle, isWaitingNotification, NOT_WAITING_TYPES };
