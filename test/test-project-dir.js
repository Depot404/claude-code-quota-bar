#!/usr/bin/env node
// Tests de projectDirFor() — dérivation « chemin du workspace » → nom du dossier
// ~/.claude/projects/<dir> où le CLI range les transcripts.
//
// POURQUOI CE BANC EXISTE (2026-08-19) : c'est le point d'entrée de TOUTE la
// liste de conversations. Une dérivation fausse fait lire un dossier qui
// n'existe pas — panneau vide en permanence, sans message ni erreur, avec des
// onglets Claude grands ouverts à l'écran. Le bug a vécu longtemps sans être vu
// parce qu'il ne se déclenche que sur certains chemins : la machine de
// développement travaille sous un chemin qui ne contient que des espaces et des
// séparateurs, seul cas où l'ancienne dérivation (séparateurs + espaces
// seulement) et la vraie (TOUT non-alphanumérique) tombent d'accord.
//
// Aucune attente ci-dessous n'est calculée par la fonction testée : les valeurs
// sont écrites en toutes lettres, relevées en faisant fabriquer à un vrai CLI
// (2.1.235) le dossier d'un chemin témoin. Le reste des bancs fabrique ses
// dossiers AVEC projectDirFor, donc reste vrai quoi qu'elle réponde — c'est
// exactement pourquoi ils n'ont jamais rien vu.
// Lancement : node test/test-project-dir.js

const path = require('path');
const { projectDirFor } = require('../state');

let fails = 0;
function check(label, ok, got) {
  if (ok) { console.log(`  ok  ${label}`); }
  else { fails++; console.error(`FAIL  ${label} (obtenu: ${got})`); }
}

// Seul le dernier segment nous intéresse : le préfixe ~/.claude/projects dépend
// du HOME de la machine qui lance le banc.
function slug(p) {
  const dir = projectDirFor(p);
  return dir === null ? null : path.basename(dir);
}

function eq(label, input, expected) {
  const got = slug(input);
  check(label, got === expected, got);
}

console.log('\n1. Le témoin empirique — un caractère spécial = un tiret, jamais deux regroupés');
// Relevé sur un vrai CLI : ce chemin exact a produit ce dossier exact (seul le
// nom d'utilisateur est remplacé ici). `_` `.` ` ` `(` `)` `é` `+` valent chacun
// un tiret, et l'accent en vaut UN, pas deux.
eq('chemin témoin complet',
  'C:\\Users\\dev\\AppData\\Local\\Temp\\slug_test.v1 (a)_é+b',
  'C--Users-dev-AppData-Local-Temp-slug-test-v1--a----b');

console.log('\n2. Les caractères qui vidaient le panneau, un par un');
eq('underscore (dossier daté « 2026-05_Client »)',
  'C:\\Users\\dev\\Docs\\2026-05_Client', 'C--Users-dev-Docs-2026-05-Client');
eq('point dans le nom d\'utilisateur — cassait TOUS les workspaces de la machine',
  'C:\\Users\\jean.dupont\\Projet', 'C--Users-jean-dupont-Projet');
eq('accent', 'C:\\Users\\dev\\Café', 'C--Users-dev-Caf-');
eq('apostrophe', 'C:\\Users\\dev\\l\'atelier', 'C--Users-dev-l-atelier');
eq('parenthèses et signes', 'C:\\dev\\app (v2)+', 'C--dev-app--v2--');

console.log('\n3. Non-régression : ce qui marchait déjà doit continuer');
// Le cas « espaces et séparateurs seulement » — celui qui masquait le bug.
eq('espaces seuls', 'C:\\Users\\dev\\Documents\\My Projects\\App',
  'C--Users-dev-Documents-My-Projects-App');
eq('racine de lecteur', 'D:\\', 'D--');

console.log('\n4. Casse préservée — le CLI ne normalise pas la lettre de lecteur');
// L'ancienne version forçait la minuscule. Inoffensif sur Windows (système de
// fichiers insensible à la casse) mais c'était une divergence gratuite de plus.
eq('majuscule conservée', 'C:\\Dev\\App', 'C--Dev-App');
eq('minuscule conservée', 'c:\\Dev\\App', 'c--Dev-App');

console.log('\n5. Autres formes de chemin (l\'extension est publiée, pas seulement Windows)');
eq('POSIX', '/home/dev/mon projet', '-home-dev-mon-projet');
eq('UNC', '\\\\serveur\\partage\\proj', '--serveur-partage-proj');
eq('slashs avant', 'C:/Users/dev/App', 'C--Users-dev-App');

console.log('\n6. Propriété générale : la sortie ne contient QUE [A-Za-z0-9-]');
// Le garde-fou qui ferme la classe entière, plutôt que d'énumérer les
// caractères un à un : n'importe quel caractère inattendu (emoji, cyrillique,
// espace insécable, tabulation) doit devenir un tiret, pas survivre.
const exotique = 'C:\\Users\\dev\\Ω 项目\u00a0\t«test»\\#1&2';
const got = slug(exotique);
check('aucun caractère hors classe ne survit', /^[A-Za-z0-9-]+$/.test(got), got);
check('longueur préservée (un pour un, jamais de regroupement)',
  got.length === exotique.length, `${got.length} vs ${exotique.length}`);

console.log('\n7. Dégradation : pas de workspace → pas de dossier, jamais d\'exception');
check('null → null', projectDirFor(null) === null, projectDirFor(null));
check('undefined → null', projectDirFor(undefined) === null, projectDirFor(undefined));
check('chaîne vide → null', projectDirFor('') === null, projectDirFor(''));

if (fails) { console.error(`\n${fails} échec(s)`); process.exit(1); }
console.log('\nTous les tests project-dir passent.');
