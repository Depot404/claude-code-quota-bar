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

check('aucun membre → false', groupDone([]) === false);
check('tous done-closed → true', groupDone(['done-closed', 'done-closed']) === true);
check('un membre stale parmi des done-closed → false', groupDone(['done-closed', 'stale']) === false);
check('un membre unsent-lost parmi des done-closed → false', groupDone(['done-closed', 'unsent-lost']) === false);
check('un membre done (onglet ouvert) parmi des done-closed → false', groupDone(['done-closed', 'done']) === false);
check('argument absent/non-tableau → false', groupDone() === false && groupDone(null) === false);

// 2026-08-18 — la maîtresse ne retient plus rien : quel que soit son état, seuls
// les membres décident. Les anciens appels à deux arguments continuent de
// compiler (le second est simplement ignoré) : ces cas VÉRIFIENT ce fait, ils
// ne documentent plus une signature.
console.log('2. la maîtresse ne bloque plus le retrait du lot');
check('maîtresse busy → true', groupDone(['done-closed'], 'busy') === true);
check('maîtresse idle → true', groupDone(['done-closed'], 'idle') === true);
check('maîtresse done-closed → true', groupDone(['done-closed'], 'done-closed') === true);
check('maîtresse encore ouverte MAIS un membre stale → false', groupDone(['stale'], 'idle') === false);

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
