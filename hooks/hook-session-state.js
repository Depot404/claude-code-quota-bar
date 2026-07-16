#!/usr/bin/env node
// Hook multi-événements : Stop / Notification / SessionEnd → sessions-state.json.
// Un seul script pour les trois : il route sur `hook_event_name` du payload.
// L'état `busy` est posé par track-active-session.js (UserPromptSubmit).
//
// Source canonique : Tools/ClaudeCodeQuotaBar/hooks/. Déployé vers
// ~/.claude/scripts/ par install.ps1 — ne pas éditer la copie déployée.

const { updateSession, removeSession, readHookInput } = require('./sessions-state.js');

// Notifications qui rendent VRAIMENT la main à l'user (le panneau doit crier).
// Volontairement absents :
//  - idle_prompt        : « aucune saisie depuis 60 s » — la conv est déjà done/idle
//  - auth_success, elicitation_complete/response, agent_completed : pas une attente
const WAITING_TYPES = new Set(['permission_prompt', 'elicitation_dialog', 'agent_needs_input']);

// `since` porté par le patch, et non laissé à updateSession.
//
// updateSession ne réarme `since` que si l'état CHANGE — or ces deux événements
// se répètent à l'identique, et chaque répétition est un fait neuf :
//  - Stop → Stop : un Stop hook à feedback (exit 2) relance Claude, puis le vrai
//    Stop arrive. Sans réarmement, `since` reste celui du PREMIER Stop, et tout
//    ce qui s'y compare devient faux — la fin de tour est lue comme une reprise
//    (conv « au travail » pour toujours), et le ✓ ne redevient jamais vif alors
//    qu'il y a du neuf à lire.
//  - Notification → Notification : une 2e permission après une 1re accordée.
//    Sans réarmement, l'écriture qui a suivi la 1re fait passer la 2e attente
//    pour une reprise → la conv « travaille » alors qu'elle attend l'user.
// Vu en exécutant les vrais hooks (test/test-ack.js § 6), pas en relisant le code.
const stamp = () => ({ since: Date.now() });

readHookInput((data) => {
  const sessionId = data.session_id;
  if (!sessionId) return;

  const base = { cwd: data.cwd || null, transcript: data.transcript_path || null };

  switch (data.hook_event_name) {
    case 'Stop':
      // message: null → le patch efface le texte de la Notification précédente
      updateSession(sessionId, { ...base, ...stamp(), state: 'done', message: null });
      break;

    case 'Notification':
      if (WAITING_TYPES.has(data.notification_type)) {
        updateSession(sessionId, { ...base, ...stamp(), state: 'waiting', message: data.message || null });
      }
      break;

    case 'SessionEnd':
      // Signal OPPORTUNISTE depuis le lot 5, plus le chemin principal : ce hook
      // ne tire ni sur /exit ni sur /clear (anthropics/claude-code#17885, #6428)
      // et reste erratique à la fermeture d'onglet (#14760, #45424). Une conv ne
      // disparaît donc plus grâce à lui mais parce que son onglet n'existe plus
      // (tabs.js + filtre de présence de state.js). On le garde : quand il tire,
      // il nettoie l'entrée gratuitement — mais rien ne doit plus en dépendre.
      removeSession(sessionId);
      break;
  }
});
