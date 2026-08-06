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
// Node PUR — aucun `require('vscode')`, aucun accès disque : testable cas par
// cas (test/test-group-done.js), comme member-truth.js et waves.js.
// ============================================================================

// groupDone(memberStatuses, masterStatus) → bool
//   memberStatuses : array des `status` memberTruth() des membres du groupe
//                    (déjà redirigés husk→successeur par supersede.js).
//   masterStatus   : `status` memberTruth() de la conv maîtresse, ou null si
//                    le groupe n'a pas de maîtresse désignée.
//   → true ssi le groupe a au moins un membre, TOUS sont 'done-closed', et la
//     maîtresse (si désignée) l'est aussi. Une maîtresse encore ouverte ou
//     vivante bloque ce statut — elle reste la porte d'entrée du groupe.
//
// Étape 11 : ce booléen sert désormais à decider si le groupe ENTIER se rend
// (`panel.js` — `done` vrai ⇒ groupe absent du DOM, le store le garde,
// `prune()` le nettoiera). Un groupe SANS maîtresse dont tous les membres
// sont `done-closed` disparaît donc lui aussi (rien d'autre à montrer). Le
// cas « membres tous finis, maîtresse encore ouverte » (capsule seule + chip
// « ✓ done ») n'a PAS besoin de ce module : c'est une agrégation directe des
// `status` des membres déjà transmis (même principe que `doneCount`, calculé
// côté webview sans passer par une fonction partagée — rien de nouveau à
// déduire, juste compter ce qui est déjà tranché).
function groupDone(memberStatuses, masterStatus) {
  const list = Array.isArray(memberStatuses) ? memberStatuses : [];
  if (list.length === 0) return false;
  if (!list.every((s) => s === 'done-closed')) return false;
  if (masterStatus != null && masterStatus !== 'done-closed') return false;
  return true;
}

module.exports = { groupDone };
