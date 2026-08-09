// Banc de « ce qui reste à faire » — condition de disparition d'un groupe
// entièrement terminé (plan repli-auto, PLAN_repli_auto_groupe_done_2026-08-04.md,
// étape 11 : remplace le repli auto de l'étape 2 par un masquage au rendu).
//
// group-done.js ne fait que plier des `status` déjà tranchés par
// member-truth.js — ce banc reproduit la table du plan (§Tests) ligne à
// ligne, comme test-member-truth.js le fait pour sa propre table.
const path = require('path');
const { groupDone } = require(path.join(__dirname, '..', 'group-done.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

console.log('1. groupDone — condition de repli');

check('aucun membre → false', groupDone([], null) === false);
check('tous done-closed, pas de maîtresse → true', groupDone(['done-closed', 'done-closed'], null) === true);
check('un membre stale parmi des done-closed → false', groupDone(['done-closed', 'stale'], null) === false);
check('un membre unsent-lost parmi des done-closed → false', groupDone(['done-closed', 'unsent-lost'], null) === false);
check('un membre done (onglet ouvert) parmi des done-closed → false', groupDone(['done-closed', 'done'], null) === false);
check('maîtresse done-closed → true', groupDone(['done-closed'], 'done-closed') === true);
check('maîtresse busy → false', groupDone(['done-closed'], 'busy') === false);
check('maîtresse idle → false', groupDone(['done-closed'], 'idle') === false);
check('maîtresse hors table connue (statut inattendu) → false', groupDone(['done-closed'], 'weird') === false);
check('pas de maîtresse (null) → true si membres ok', groupDone(['done-closed'], null) === true);

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
