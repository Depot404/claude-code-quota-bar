// Banc : résolution du bouton « inherit » (lot 12 du plan
// PLAN_creation_groupes_2026-07-22.md, §3 — décision user 2026-07-23,
// « inherit est opaque, je ne sais jamais sur quel modèle est le sélecteur »).
//
// `readInheritSettings()` (batch.js) lit ~/.claude/settings.json (`model`,
// `effortLevel`) SANS jamais fabriquer de valeur : fichier illisible/absent,
// JSON invalide, ou champ manquant ⇒ `null` pour CE champ précisément — c'est
// ça qui laisse le formulaire retomber sur un bouton « inherit » nu plutôt
// que d'inventer un modèle. Prend un chemin explicite (`settingsPath`) pour
// rester testable sans mocker `os.homedir()`.
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readInheritSettings } = require(path.join(__dirname, '..', 'batch.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-inherit-'));
function settingsFile(name) { return path.join(SANDBOX, name); }
function write(name, content) { fs.writeFileSync(settingsFile(name), content); return settingsFile(name); }

console.log('\n1. Settings présents, model + effortLevel renseignés');
const full = write('full.json', JSON.stringify({ model: 'opus[1m]', effortLevel: 'high' }));
check('model relu tel quel (alias [1m] compris — la simplification est côté affichage, pas ici)',
  readInheritSettings(full).model === 'opus[1m]', JSON.stringify(readInheritSettings(full)));
check('effort relu tel quel', readInheritSettings(full).effort === 'high');

console.log('\n2. Settings absents (fichier inexistant)');
const missing = settingsFile('does-not-exist.json');
check('model → null, jamais une valeur inventée', readInheritSettings(missing).model === null);
check('effort → null', readInheritSettings(missing).effort === null);

console.log('\n3. Settings illisibles (JSON invalide)');
const broken = write('broken.json', '{ not json at all');
check('model → null (pas d\'exception, pas de valeur devinée)', readInheritSettings(broken).model === null);
check('effort → null', readInheritSettings(broken).effort === null);

console.log('\n4. Settings valides mais SANS les champs concernés (autres réglages seulement)');
const partial = write('partial.json', JSON.stringify({ statusLine: { type: 'command' } }));
check('model absent du fichier → null', readInheritSettings(partial).model === null);
check('effort absent du fichier → null', readInheritSettings(partial).effort === null);

console.log('\n5. Un seul des deux champs présent');
const modelOnly = write('model-only.json', JSON.stringify({ model: 'sonnet' }));
check('model présent → relu', readInheritSettings(modelOnly).model === 'sonnet');
check('effort absent → null (pas emprunté à l\'autre champ)', readInheritSettings(modelOnly).effort === null);

console.log('\n6. Modèle "exotique" (alias inconnu du sélecteur, ex. un futur modèle)');
const exotic = write('exotic.json', JSON.stringify({ model: 'fable-6-preview[1m]', effortLevel: 'xhigh' }));
check('rendu tel quel, aucune validation contre MODELS ici (c\'est panel.js qui n\'affiche que sur le bouton inherit, jamais une comparaison de liste)',
  readInheritSettings(exotic).model === 'fable-6-preview[1m]');
check('effort exotique aussi rendu tel quel', readInheritSettings(exotic).effort === 'xhigh');

console.log('\n7. Champs non-string (JSON valide mais type inattendu) → null, jamais une coercion');
const wrongType = write('wrong-type.json', JSON.stringify({ model: 42, effortLevel: null }));
check('model non-string → null', readInheritSettings(wrongType).model === null);
check('effort non-string → null', readInheritSettings(wrongType).effort === null);

console.log('\n8. Champ vide/blanc → null (pas une chaîne vide affichée dans un bouton)');
const blank = write('blank.json', JSON.stringify({ model: '   ', effortLevel: '' }));
check('model tout-espaces → null', readInheritSettings(blank).model === null);
check('effort chaîne vide → null', readInheritSettings(blank).effort === null);

console.log('\n9. Racine JSON qui n\'est pas un objet (ex. un tableau ou une valeur scalaire)');
const notObject = write('not-object.json', JSON.stringify(['oops']));
check('tableau en racine → { model: null, effort: null }, pas d\'exception',
  readInheritSettings(notObject).model === null && readInheritSettings(notObject).effort === null);

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
