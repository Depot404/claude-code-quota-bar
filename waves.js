// ============================================================================
// Moteur de vagues (lot 4 du plan PLAN_creation_groupes_2026-07-22.md).
//
// Node PUR : ne connaît ni sessionId, ni transcript, ni vscode — juste une
// liste de « membres » `{ wave, status }` où `status` a déjà été résolu par
// l'appelant (extension.js, à partir de l'état RÉEL de la conversation) :
//   'queued'   — pas encore lancé (wave à venir) ;
//   'launched' — onglet ouvert, pas encore `done` (busy/waiting/idle/interrupted
//                comptent pareil ici : ça n'empêche pas la vague de progresser,
//                ça l'empêche juste d'être COMPLÈTE) ;
//   'done'     — terminé ;
//   'stale'    — interrompu/disparu SANS avoir tourné son hook Stop (le cas visé
//                par la décision 5 du plan : ça suspend l'auto, jamais le manuel).
//
// Une seule décision par fonction, et rien de caché :
//   - waveStatus     : l'état d'UNE vague (done / blocked / pending) ;
//   - launchedWave   : la vague la plus avancée déjà ouverte (0 = aucune) ;
//   - nextWave       : la vague suivante à ouvrir, ou null s'il n'y en a plus ;
//   - waveToAutoLaunch : la vague à ouvrir AUTOMATIQUEMENT maintenant, ou null.
//     Ne rend jamais plus que `launchedWave + 1` : les vagues sont contiguës
//     (batch.js normalizeTasks le garantit), donc « jamais plus d'une vague
//     d'avance » est un invariant STRUCTUREL, pas une règle vérifiée ici.
//   - canForceLaunch : le bouton ▶ manuel reste TOUJOURS possible dès qu'il
//     reste une vague en file — y compris quand la vague courante est bloquée
//     ou seulement partiellement terminée (décision 5 : « forcer = ▶ manuel »).
// ============================================================================

function waveNumbers(members) {
  const list = Array.isArray(members) ? members : [];
  return [...new Set(list.map((m) => m.wave))].sort((a, b) => a - b);
}

function tasksInWave(members, w) {
  const list = Array.isArray(members) ? members : [];
  return list.filter((m) => m.wave === w);
}

// 'done'    : toutes les tâches de la vague sont `done` ;
// 'blocked' : au moins une tâche `stale` (interrompue sans Stop, ou disparue) —
//             l'auto se suspend, le manuel reste l'unique porte de sortie ;
// 'pending' : ni l'un ni l'autre (encore `queued`/`launched` en cours) ;
// 'empty'   : vague inexistante (défensif — ne devrait pas arriver, les vagues
//             sorties de batch.js sont contiguës et non vides).
function waveStatus(members, w) {
  const tasks = tasksInWave(members, w);
  if (!tasks.length) return 'empty';
  if (tasks.some((t) => t.status === 'stale')) return 'blocked';
  if (tasks.every((t) => t.status === 'done')) return 'done';
  return 'pending';
}

// Vague la plus avancée déjà ouverte : le max des `wave` dont au moins une
// tâche n'est plus `queued`. 0 si rien n'a jamais été lancé (ne devrait pas
// arriver en usage réel — la vague 1 est ouverte dès la création — mais reste
// un point de départ cohérent pour les bancs).
function launchedWave(members) {
  const list = Array.isArray(members) ? members : [];
  let max = 0;
  for (const m of list) {
    if (m.status !== 'queued' && m.wave > max) max = m.wave;
  }
  return max;
}

// Première vague strictement après `after` qui existe encore parmi les
// membres. `null` = plus rien en file (la dernière vague est déjà ouverte).
function nextWave(members, after) {
  const ws = waveNumbers(members);
  for (const w of ws) if (w > after) return w;
  return null;
}

// Vague à ouvrir AUTOMATIQUEMENT maintenant, ou `null` si rien à faire :
//   - toggle sur 'manual' → jamais d'ouverture automatique, quoi qu'il arrive ;
//   - vague courante pas `done` (encore en cours, ou `blocked`) → on attend ;
//   - plus de vague suivante → rien à ouvrir (dernière vague déjà lancée).
function waveToAutoLaunch(members, autoAdvance) {
  if (!autoAdvance) return null;
  const lw = launchedWave(members);
  if (waveStatus(members, lw) !== 'done') return null;
  return nextWave(members, lw);
}

// Le bouton ▶ : toujours actionnable dès qu'il reste une vague en file,
// indépendamment de l'état de la vague courante (décision 5 — « le bouton ▶
// manuel reste TOUJOURS visible »). Rend le numéro de vague à forcer, ou null.
function canForceLaunch(members) {
  return nextWave(members, launchedWave(members));
}

module.exports = {
  waveNumbers, tasksInWave, waveStatus, launchedWave, nextWave,
  waveToAutoLaunch, canForceLaunch,
};
