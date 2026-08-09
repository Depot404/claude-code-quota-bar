// Banc : recalcul du message de « Create » (lot 6, correctif §3 —
// « N/N conversation(s) opened — press Enter in each tab » restait affiché
// même une fois les onglets envoyés, fermés ou rouverts, constaté au premier
// essai terrain). `computeBatchNoticeFromLaunch` (extension.js) est une
// fonction PURE : `launch`/`convs`/`aliveIds` injectés, aucun mock VS Code
// nécessaire — seul `require('vscode')` en tête d'extension.js doit être
// bouché pour pouvoir charger le module.
const Module = require('module');
const path = require('path');

const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'vscode') {
    return {
      window: {}, commands: {}, workspace: {}, env: {}, Uri: {},
      l10n: { t: (message, ...args) => (args.length ? message.replace(/\{(\d+)\}/g, (_, i) => (args[i] !== undefined ? args[i] : '')) : message) },
    };
  }
  return origLoad.call(this, req, ...rest);
};
let computeBatchNoticeFromLaunch, buildBatchStaticSuffix, shouldPurgeBatchLaunch, shouldCreateGroup;
try {
  ({ computeBatchNoticeFromLaunch, buildBatchStaticSuffix, shouldPurgeBatchLaunch, shouldCreateGroup } = require(path.join(__dirname, '..', 'extension.js')));
} finally {
  Module._load = origLoad;
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

// `groupId: 'g1'` par défaut : un lot de 3 tâches vient forcément d'un Create
// à plusieurs tâches, donc d'un groupe (launchBatch, extension.js — un groupe
// ne naît QUE si tasks.length > 1). Les tests du lot ungrouped (étape 14,
// §15/16) le mettent explicitement à `null`.
function launch(overrides) {
  return { total: 3, trackedSessionIds: ['a', 'b', 'c'], staticSuffix: '', groupId: 'g1', ...overrides };
}

console.log('\n1. Pas de lot lancé → le texte de repli est rendu tel quel');
check('fallback', computeBatchNoticeFromLaunch(null, [], new Set(), 'texte de repli') === 'texte de repli');

console.log('\n2. Aucun membre rattaché (100% en repli presse-papier) → repli, rien à recalculer');
check('fallback', computeBatchNoticeFromLaunch(launch({ trackedSessionIds: [] }), [], new Set(), 'repli initial') === 'repli initial');

console.log('\n3. Juste après le lancement : rien envoyé, les 3 process sont vivants → message initial inchangé');
const n3 = computeBatchNoticeFromLaunch(launch(), [], new Set(['a', 'b', 'c']), null);
check('0/3 pour l’instant', n3 === '0/3 conversation(s) opened — press Enter in each tab.', n3);

console.log('\n4. Un membre a été envoyé (entrée dans le snapshot), les deux autres encore ouverts → recompte');
const n4 = computeBatchNoticeFromLaunch(launch(), [{ sessionId: 'a' }], new Set(['b', 'c']), null);
check('1/3, toujours en attente pour les 2 autres', n4 === '1/3 conversation(s) opened — press Enter in each tab.', n4);

console.log('\n5. Les 3 ont été envoyés (les 3 apparaissent dans le snapshot) → le bandeau DISPARAÎT (rend null)');
const n5 = computeBatchNoticeFromLaunch(launch(), [{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }], new Set(), 'jamais affiché');
check('null = plus rien à signaler', n5 === null, n5);

console.log('\n6. Un lien MORT-NÉ (process disparu du registre, jamais apparu dans le snapshot)');
const n6 = computeBatchNoticeFromLaunch(launch(), [{ sessionId: 'a' }], new Set(['b']), null);
// a: envoyé (dans convs) — b: toujours ouvert (vivant, pas envoyé) — c: fermé sans envoi (ni convs ni vivant)
// Plan lien-mort-né 2026-08-04 : le texte ne dit plus « onglet fermé » — un fait
// sur l'ONGLET qu'on ne peut pas connaître ; seul le LIEN est prouvé perdu.
check('message mentionne le lien perdu, PAS "lost" sur un envoyé', /1 task lost its link before sending/.test(n6), n6);
check('reste "opened" tant qu’il reste un membre inserted (b)', /1\/3 conversation\(s\) opened/.test(n6), n6);

console.log('\n7. Plus aucun membre inserted : le reste (2) a perdu son lien → message dédié, avec le remède du groupe');
const n7 = computeBatchNoticeFromLaunch(launch(), [{ sessionId: 'a' }], new Set(), null);
// Étape 14 : plus de "press Enter in their tabs (if still open)" — pending
// === 0, donc plus aucun onglet PROUVÉ ouvert, on ne prescrit plus dessus.
check('texte "lost their link" au pluriel, remède "Relancer" (groupe) SEULEMENT',
  n7 === '2 tasks lost their link before sending — use “Relaunch”.', n7);
check('plus de prescription "press Enter" sur un onglet dont on ne sait rien', !/press Enter/.test(n7), n7);

console.log('\n8. Un seul lien mort-né, singulier correct');
const n8 = computeBatchNoticeFromLaunch(launch({ trackedSessionIds: ['a'] }), [], new Set(), null);
check('texte au singulier', n8 === '1 task lost its link before sending — use “Relaunch”.', n8);

console.log('\n8bis. Étape 14 — lot SANS groupe (tâche unique) : ni bouton ni ré-appariement pour un lien mort-né → rien à prescrire');
const n8bis = computeBatchNoticeFromLaunch(launch({ trackedSessionIds: ['a'], total: 1, groupId: null }), [], new Set(), 'jamais affiché');
check('aucune action réelle (pas de relaunchChip/linkChip hors groupe) → notice EFFACÉ, pas de promesse dans le vide',
  n8bis === null, n8bis);

console.log('\n8ter. Étape 14 — lot SANS groupe, mixte : un membre encore inserted (onglet prouvé ouvert) + un lien mort-né');
const n8ter = computeBatchNoticeFromLaunch(launch({ trackedSessionIds: ['a', 'b'], total: 2, groupId: null }), [], new Set(['a']), null);
// a : vivant, rien envoyé → inserted (pending) — b : mort, rien envoyé → unsent-lost (lost), mais SANS groupe.
check('le segment "press Enter" reste (a est PROUVÉ inserted)', /0\/2 conversation\(s\) opened/.test(n8ter), n8ter);
check('le lien perdu de b n\'est PAS mentionné (aucun remède hors groupe)', !/lost their link|lost its link/.test(n8ter), n8ter);

console.log('\n9. Suffixe statique (groupe, vagues, non-identifiés) conservé tant que le bandeau "opened" est affiché');
const n9 = computeBatchNoticeFromLaunch(
  launch({ staticSuffix: ' Grouped as “Demo”.' }),
  [],
  new Set(['a', 'b', 'c']),
  null
);
check('suffixe accroché', n9 === '0/3 conversation(s) opened — press Enter in each tab. Grouped as “Demo”.', n9);

console.log('\n10. Lot 9 — done + onglet fermé, mais transcript existant (fait durable) → aucun bandeau');
const n10 = computeBatchNoticeFromLaunch(launch(), [], new Set(), null, () => true);
check('null = plus rien à signaler, jamais "lost its link"', n10 === null, n10);

console.log('\n11. Lot 9 — jamais envoyée (pas de transcript) + process mort → bandeau conservé');
const n11 = computeBatchNoticeFromLaunch(launch(), [], new Set(), null, () => false);
check('texte "lost their link" conservé, remède "Relancer" (groupe) seulement — étape 14',
  n11 === '3 tasks lost their link before sending — use “Relaunch”.', n11);

console.log('\n12. Lot 9 — cas mixte : a a un transcript (vue périmée), b sans transcript ni process (lien mort-né), c vivant');
const n12 = computeBatchNoticeFromLaunch(launch(), [], new Set(['c']), null, (id) => id === 'a');
check('a compté "sent" via transcript, pas "lost"', /1 task lost its link before sending/.test(n12), n12);
check('reste "opened" tant que c (vivant, pas envoyé) est en attente', /1\/3 conversation\(s\) opened/.test(n12), n12);

console.log('\n13. Plan repli-auto étape 6 — buildBatchStaticSuffix() : réduit à l’ACTIONNABLE');
check('rien de tracké, pas de groupe → suffixe vide',
  buildBatchStaticSuffix({ unlinked: 0, grouped: false, fallbackAt: null }) === '', buildBatchStaticSuffix({ unlinked: 0, grouped: false, fallbackAt: null }));
const s1 = buildBatchStaticSuffix({ unlinked: 2, grouped: true, fallbackAt: null });
check('groupé, non identifiées → remède "Link…" dans le groupe',
  s1 === ' 2 not identified yet — they will link themselves once started, or use “Link…” in the group.', s1);
const s2 = buildBatchStaticSuffix({ unlinked: 1, grouped: false, fallbackAt: null });
check('sans groupe, non identifiée → message sans "Link…" (rien où cliquer)',
  s2 === ' 1 could not be identified (no session file) — model/effort mismatch badge unavailable for those.', s2);
const s3 = buildBatchStaticSuffix({ unlinked: 0, grouped: true, fallbackAt: 2 });
check('arrêt en cours de lot → "Stopped at task 3"',
  s3 === ' Stopped at task 3 — see the message above.', s3);
for (const grouped of [true, false]) {
  const s = buildBatchStaticSuffix({ unlinked: 1, grouped, fallbackAt: 0 });
  check(`jamais de doublon d’affichage (grouped=${grouped}) : ni nom de groupe, ni maîtresse, ni progression de vagues`,
    !/Grouped as|Master conversation|Wave 1 of/.test(s), s);
  check(`jamais le disclaimer menu officiel dans le texte courant (grouped=${grouped}) — c’est un tooltip désormais`,
    !/official menu/.test(s), s);
}

console.log('\n14. Plan repli-auto étape 6 — shouldPurgeBatchLaunch() : cycle de vie du bandeau');
check('pas de lancement en cours → jamais de purge',
  shouldPurgeBatchLaunch(null, () => false) === false);
check('lancement sans groupe (tâche unique) → jamais de purge, rien à surveiller',
  shouldPurgeBatchLaunch({ groupId: null }, () => false) === false);
check('groupe encore présent dans le store → pas de purge',
  shouldPurgeBatchLaunch({ groupId: 'g1' }, (id) => id === 'g1') === false);
check('groupe dissous/purgé du store → purge',
  shouldPurgeBatchLaunch({ groupId: 'g1' }, () => false) === true);
// Étape 14 : « membre retiré via ✕ jusqu'au dernier » emprunte le MÊME
// chemin — groups.js removeMember dissout lui-même le groupe vidé
// (test-group-store.js « retrait du DERNIER membre → le groupe disparaît »),
// donc `groupExists(groupId)` répond déjà `false` ici, sans code neuf.
check('groupe vidé par retraits successifs (dernier membre parti) = même verdict qu\'un ⨯ explicite',
  shouldPurgeBatchLaunch({ groupId: 'g1' }, (id) => false) === true);

console.log('\n15. Étape 14 — invariant bout en bout : segments indépendants, jamais une chaîne de cas figée');
check('pending>0 seul → un seul segment "opened", pas de mention de lien perdu',
  computeBatchNoticeFromLaunch(launch(), [], new Set(['a', 'b', 'c']), null) === '0/3 conversation(s) opened — press Enter in each tab.');
check('lost>0 seul (groupé) → un seul segment "Relancer", pas de "press Enter"',
  computeBatchNoticeFromLaunch(launch(), [], new Set(), null) === '3 tasks lost their link before sending — use “Relaunch”.');
check('pending>0 ET lost>0 (groupé) → les deux segments, dans l\'ordre, un seul espace',
  computeBatchNoticeFromLaunch(launch(), [], new Set(['a']), null)
    === '0/3 conversation(s) opened — press Enter in each tab. 2 tasks lost their link before sending — use “Relaunch”.',
  computeBatchNoticeFromLaunch(launch(), [], new Set(['a']), null));
check('ni pending ni lost actionnable (ungrouped, tout mort-né) → null, jamais de phrase creuse',
  computeBatchNoticeFromLaunch(launch({ groupId: null }), [], new Set(), null) === null);

console.log('\n16. Lot A (plan master-conv-isolée 2026-08-09) — shouldCreateGroup() : groupe à une seule tâche');
check('plusieurs tâches → groupe, toujours (inchangé)',
  shouldCreateGroup(2, '', false) === true);
check('1 tâche, sans nom de groupe ni maîtresse résolue → pas de groupe',
  shouldCreateGroup(1, '', false) === false);
check('1 tâche + `group:` (nom non vide) → groupe',
  shouldCreateGroup(1, 'Refonte paiement', false) === true);
check('1 tâche + maîtresse résolue (candidat non nul) → groupe',
  shouldCreateGroup(1, '', true) === true);
check('1 tâche, collage non résolu (candidat null/falsy) et sans nom → pas de groupe',
  shouldCreateGroup(1, undefined, null) === false);
check('0 tâche (garde défensive, ne devrait pas arriver après normalizeTasks) → pas de groupe',
  shouldCreateGroup(0, 'Nom', true) === false);

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
