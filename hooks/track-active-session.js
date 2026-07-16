#!/usr/bin/env node
// UserPromptSubmit hook. Deux effets :
//  1) ~/.claude/sessions-state.json : la session passe à `busy` (le panneau
//     sidebar l'affiche en train de travailler, via fs.watch → instantané).
//  2) ~/.claude/active-session.json : modèle de la session active (legacy,
//     consommé par l'affichage du modèle).
//
// Source canonique : ce fichier est versionné dans le repo Octopus
// (Tools/ClaudeCodeQuotaBar/hooks/). Déployé vers ~/.claude/scripts/ par
// install.ps1. Ne pas éditer directement la copie de ~/.claude/scripts/ —
// éditer ici puis relancer install.ps1.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { updateSession, readHookInput } = require('./sessions-state.js');
const { modelIdToDisplay } = require('./model-id.js');
const { extractLastAssistant } = require('./transcript.js');

const ACTIVE_SESSION_PATH = path.join(os.homedir(), '.claude', 'active-session.json');

readHookInput((data) => {
  const sessionId = data.session_id;
  if (!sessionId) return;

  // `busy` d'abord, et INCONDITIONNELLEMENT : l'état de la conv ne dépend pas
  // de notre capacité à résoudre le modèle. (Piège : la résolution échoue au
  // 1er prompt d'une session fraîche — transcript encore sans réponse assistant.)
  //
  // `busy_since` (lot 10) : horodatage du DÉMARRAGE de ce run, distinct de
  // `since` (qui, lui, est réécrit à `done`/`waiting` par hook-session-state.js
  // et ne survit donc pas jusqu'au Stop). C'est ce point de repère que l'ack
  // strict compare au séjour sur l'onglet — « venir regarder pendant que ça
  // travaille » ne compte que si l'arrivée est postérieure à CE timestamp.
  // Réécrit à chaque prompt : le run en cours est toujours le plus récent.
  updateSession(sessionId, {
    state: 'busy',
    cwd: data.cwd || null,
    transcript: data.transcript_path || null,
    message: null,
    busy_since: Date.now(),
  });

  // Modèle : lu depuis le transcript (réponse précédente). SEULE source fiable,
  // c'est le model_id réellement servi à CETTE session.
  //
  // Pas de fallback sur current-model.json : ce fichier est GLOBAL et peut être
  // écrasé par une autre session (RC sur un binaire Claude Code plus ancien qui
  // résout l'alias `opus` vers une version différente). S'y rabattre au 1er prompt
  // d'une session fraîche injectait une mauvaise version dans active-session.json
  // → quota-bar affichait Opus 4.7 au lieu de 4.8 après un reload. On préfère ne
  // rien écrire : l'extension scanne alors le transcript du workspace (toujours
  // correct) et corrige dès la 1re réponse.
  if (!data.transcript_path) return;
  let model = null;
  try {
    const last = extractLastAssistant(data.transcript_path);
    model = last ? modelIdToDisplay(last.modelId) : null;
  } catch {}
  if (!model) return;

  try {
    fs.writeFileSync(ACTIVE_SESSION_PATH, JSON.stringify({
      session_id: sessionId,
      model,
      timestamp: Date.now(),
    }));
  } catch {}
  // Pas d'output : hook silencieux
});
