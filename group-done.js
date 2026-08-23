// ============================================================================
// « Ce qui reste à faire » : condition de disparition d'un groupe terminé
// (plan repli-auto, 2026-08-04 — étape 11 remplace le repli auto de l'étape 2
// par un MASQUAGE au rendu, cf. panel.js).
//
// POURQUOI un module à part, aussi court soit-il : `member-truth.js` est LA
// table de vérité du statut d'un membre — ce module ne la ré-interroge pas ni
// ne la re-déduit, il se contente de PLIER le résultat déjà tranché
// (`memberTruth(...).status`) en une seule question binaire. Consommer la
// table, ne jamais recalculer un fait qu'elle a déjà établi ailleurs (c'est
// exactement la classe d'erreur que member-truth.js documente en tête).
//
// 2026-08-18 — LA MAÎTRESSE NE RETIENT PLUS LE LOT. Jusqu'ici, une maîtresse
// encore ouverte bloquait ce statut (« elle reste la porte d'entrée du
// groupe ») : le lot restait donc affiché, réduit à sa capsule et à un chip
// « ✓ done », et la conversation de cadrage gardait sa ligne de tête — son
// « tag » — indéfiniment. Or c'est le cas NOMINAL : la conv de cadrage reste
// ouverte, c'est celle depuis laquelle on travaille, et `prune()` (groups.js)
// ne purge jamais un groupe dont la maîtresse est encore listée. Le lot ne
// s'effaçait donc, en pratique, que le jour où l'on fermait aussi la conv de
// cadrage. Décision : le lot n'existe QUE pour ses membres — quand ils sont
// tous finis et fermés, il n'a plus rien à montrer et se retire ; la maîtresse
// redevient une conversation ordinaire de la liste plate (panel.js la sort de
// `masterIds` sur ce même `done`), sans que rien ne soit écrit dans le store,
// ni fermé, ni interrompu.
//
// CE QUE ÇA NE CHANGE PAS, et qui est la raison de ne regarder QUE
// `done-closed` : un membre INTERROMPU (`stale`) ou dont le prompt n'est jamais
// parti (`unsent-lost` — le cas du reload de la fenêtre VS Code, qui efface le
// prompt inséré sans l'envoyer) retient toujours le lot. Sa ligne reste, donc
// son ▶ « Relaunch » aussi. On ne cache jamais du travail qui n'a pas eu lieu.
//
// Node PUR — aucun `require('vscode')`, aucun accès disque : testable cas par
// cas (test/test-group-done.js), comme member-truth.js et waves.js.
// ============================================================================

// groupDone(memberStatuses) → bool
//   memberStatuses : array des `status` memberTruth() des membres du groupe
//                    (déjà redirigés husk→successeur par supersede.js).
//   → true ssi le groupe a au moins un membre et que TOUS sont 'done-closed'.
//
// Étape 11 : ce booléen décide si le groupe ENTIER se rend (`panel.js` —
// `done` vrai ⇒ groupe absent du DOM, le store le garde, `prune()` le
// nettoiera).
function groupDone(memberStatuses) {
  const list = Array.isArray(memberStatuses) ? memberStatuses : [];
  if (list.length === 0) return false;
  return list.every((s) => s === 'done-closed');
}

module.exports = { groupDone };
