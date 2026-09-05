// Banc : `shouldCreateGroup` (extension.js) — quand un « Create » fonde un lot.
//
// Ce fichier remplace test-batch-notice.js, supprimé le 2026-09-04 avec le
// bandeau qu'il testait : le panneau ne DÉCRIT plus un lot déjà lancé (chaque
// phrase répétait ce que la ligne du membre porte déjà, cf. extension.js
// `batchStatus`). Ce qui restait de vivant dans ce banc, c'est cette seule
// fonction — pure, injectée, testable sans mock VS Code au-delà du bouchon
// `require('vscode')` en tête d'extension.js.
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
let shouldCreateGroup;
try {
  ({ shouldCreateGroup } = require(path.join(__dirname, '..', 'extension.js')));
} finally {
  Module._load = origLoad;
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

console.log('\n1. Lot A (plan master-conv-isolée 2026-08-09) — groupe à une seule tâche');
check('plusieurs tâches → groupe, toujours (inchangé)',
  shouldCreateGroup(2, '', false) === true);
check('1 tâche, sans nom de groupe ni maîtresse résolue → pas de groupe',
  shouldCreateGroup(1, '', false) === false);
// RÉTABLI le 2026-09-02 (régression de la même journée, cf. extension.js) :
// refuser le groupe sur un simple `group:` laissait la tâche SANS AUCUNE
// surface à l'écran — avant le premier Entrée le transcript n'existe pas
// encore, le lot était son seul porteur d'état. Le vrai grief (le nom n'est
// affiché nulle part) se règle par la CHROME de la grip (panel.js), pas en
// empêchant le lot de naître.
check('1 tâche + `group:` (nom non vide) → groupe',
  shouldCreateGroup(1, 'Refonte paiement', false) === true);
check('1 tâche + `group:` ET maîtresse → groupe (les deux raisons cumulées)',
  shouldCreateGroup(1, 'Refonte paiement', true) === true);
check('1 tâche + maîtresse résolue (candidat non nul) → groupe',
  shouldCreateGroup(1, '', true) === true);
check('1 tâche, collage non résolu (candidat null/falsy) et sans nom → pas de groupe',
  shouldCreateGroup(1, undefined, null) === false);
check('0 tâche (garde défensive, ne devrait pas arriver après normalizeTasks) → pas de groupe',
  shouldCreateGroup(0, 'Nom', true) === false);

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
