// Banc : parseur strict du bloc ```claude-convs``` (lot 3 du plan
// PLAN_creation_groupes_2026-07-22.md ; séparateur `[---]` du plan
// PLAN_zone_unique_separateur_2026-07-23.md).
//
// Le point d'entrée reste le collage dans le champ prompt (batch.js/panel.js,
// zone unique depuis le 2026-07-23) — ce parseur ne lit jamais un transcript,
// il reconnaît juste un format dans du texte collé. Couvre : nominal (group +
// sections + model/effort/stage), malformé → repli + raison (section sans
// prompt, valeur inconnue, vagues non contiguës, champ dupliqué), plusieurs
// blocs → le dernier gagne, texte sans bloc → reste un prompt simple (plus de
// dumbSplit), séparateur `[---]` vs legacy `---`.
const path = require('path');
const EXT = path.join(__dirname, '..');
const { parseClaudeConvsBlock } = require(path.join(EXT, 'batch.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

function fence(body) {
  return '```claude-convs\n' + body + '\n```';
}

console.log('\n1. Texte sans bloc → non trouvé, reste un prompt simple (plus de découpage)');
const noBlock = parseClaudeConvsBlock('juste du texte\n\ncollé normalement');
check('found: false', noBlock.found === false, JSON.stringify(noBlock));
check('tasks null', noBlock.tasks === null);
// Décision 3 du plan zone unique : un texte à lignes vides sans format reconnu
// reste UN SEUL prompt — ici, ce n'est même plus ce parseur qui en décide
// (il ne fait que dire found: false), c'est panel.js qui laisse le texte tel
// quel dans le champ. On vérifie juste qu'aucune tentative de découpage ne
// se cache plus derrière un `found: false`.
check('un texte à lignes vides multiples reste lui aussi non reconnu (found: false)',
  parseClaudeConvsBlock('Lot 1\n\nLot 2\n\nLot 3').found === false);

console.log('\n2. Nominal : group + 2 sections, model/effort/stage');
const nominal = parseClaudeConvsBlock(fence(
  'group: Refonte paiement\n' +
  'model: sonnet\n' +
  'effort: medium\n' +
  'Lot 1 : schéma refunds.\n' +
  '---\n' +
  'model: opus\n' +
  'effort: high\n' +
  'stage: 2\n' +
  'Revue de sécurité du lot 1.'
));
check('found', nominal.found === true, JSON.stringify(nominal));
check('pas d\'erreur', nominal.error === null, nominal.error);
check('group extrait', nominal.group === 'Refonte paiement', nominal.group);
check('2 tâches', nominal.tasks && nominal.tasks.length === 2, JSON.stringify(nominal.tasks));
check('tâche 1 : model/effort/wave par défaut wave=1', nominal.tasks[0].model === 'sonnet' && nominal.tasks[0].effort === 'medium' && nominal.tasks[0].wave === 1, JSON.stringify(nominal.tasks[0]));
check('tâche 2 : stage → wave', nominal.tasks[1].model === 'opus' && nominal.tasks[1].wave === 2, JSON.stringify(nominal.tasks[1]));
check('prompt tel quel (pas de champ résiduel)', nominal.tasks[0].prompt === 'Lot 1 : schéma refunds.', JSON.stringify(nominal.tasks[0].prompt));

console.log('\n3. Sans group, sans champs (tout par défaut)');
const bare = parseClaudeConvsBlock(fence('Une seule tâche, aucun champ.'));
check('found + pas d\'erreur', bare.found && bare.error === null, JSON.stringify(bare));
check('group absent', bare.group === null);
check('model/effort au défaut résolu (null sans résolution injectée, lot 14), wave 1',
  bare.tasks[0].model === null && bare.tasks[0].effort === null && bare.tasks[0].wave === 1, JSON.stringify(bare.tasks[0]));

console.log('\n4. Prompt multi-lignes préservé');
const multi = parseClaudeConvsBlock(fence('model: haiku\nligne 1\nligne 2\nligne 3'));
check('prompt sur 3 lignes', multi.tasks[0].prompt === 'ligne 1\nligne 2\nligne 3', JSON.stringify(multi.tasks[0].prompt));

console.log('\n4bis. Défaut résolu injecté (lot 14) — model:/effort: restent optionnels DANS LE BLOC');
const resolved = { model: 'opus', effort: 'high' };
const bareResolved = parseClaudeConvsBlock(fence('Aucun champ, tout doit venir du défaut résolu.'), resolved);
check('section sans champ ⇒ pré-remplie par le défaut résolu, jamais "inherit"',
  bareResolved.tasks[0].model === 'opus' && bareResolved.tasks[0].effort === 'high', JSON.stringify(bareResolved.tasks[0]));
const partial = parseClaudeConvsBlock(fence('model: sonnet\nEffort non donné, doit prendre le défaut résolu.'), resolved);
check('model: explicite, effort: absent ⇒ effort résolu par le défaut (pas celui du modèle du bloc précédent)',
  partial.tasks[0].model === 'sonnet' && partial.tasks[0].effort === 'high', JSON.stringify(partial.tasks[0]));
const haikuNoEffortField = parseClaudeConvsBlock(fence('model: haiku\nHaiku explicite, aucun effort donné.'), resolved);
check('model: haiku explicite ⇒ jamais d\'effort résolu, même avec un défaut résolu par ailleurs',
  haikuNoEffortField.tasks[0].effort === null, JSON.stringify(haikuNoEffortField.tasks[0]));
const haikuWithEffortField = parseClaudeConvsBlock(fence('model: haiku\neffort: high\nHaiku + effort explicite quand même.'), resolved);
check('model: haiku + effort: explicite ⇒ ignoré (mis à null), envForTask ne le poserait de toute façon jamais',
  haikuWithEffortField.tasks[0].effort === null, JSON.stringify(haikuWithEffortField.tasks[0]));

console.log('\n5. Malformé : section sans prompt (que des champs)');
const noPrompt = parseClaudeConvsBlock(fence('model: sonnet\neffort: high'));
check('found mais erreur', noPrompt.found === true && !!noPrompt.error, JSON.stringify(noPrompt));
check('tasks null (pas de résultat partiel)', noPrompt.tasks === null);
check('raison mentionne la section', /section 1/.test(noPrompt.error), noPrompt.error);

console.log('\n6. Malformé : valeur modèle inconnue');
const badModel = parseClaudeConvsBlock(fence('model: gpt-4\nun prompt'));
check('erreur modèle', /unknown model/.test(badModel.error || ''), JSON.stringify(badModel));
check('tasks null', badModel.tasks === null);

console.log('\n7. Malformé : valeur effort inconnue');
const badEffort = parseClaudeConvsBlock(fence('effort: insane\nun prompt'));
check('erreur effort', /unknown effort/.test(badEffort.error || ''), JSON.stringify(badEffort));

console.log('\n8. Malformé : vagues non contiguës (stage 1 puis 3)');
const gapWaves = parseClaudeConvsBlock(fence(
  'stage: 1\npremière\n---\nstage: 3\ntroisième'
));
check('erreur de contiguïté', /not contiguous/.test(gapWaves.error || ''), JSON.stringify(gapWaves));
check('tasks null', gapWaves.tasks === null);

console.log('\n9. Malformé : stage invalide (non entier / < 1)');
check('stage non numérique', /invalid stage/.test((parseClaudeConvsBlock(fence('stage: abc\np')).error || '')));
check('stage à zéro', /invalid stage/.test((parseClaudeConvsBlock(fence('stage: 0\np')).error || '')));

console.log('\n10. Malformé : champ dupliqué dans une section');
const dup = parseClaudeConvsBlock(fence('model: sonnet\nmodel: opus\nun prompt'));
check('erreur duplication', /given more than once/.test(dup.error || ''), JSON.stringify(dup));

console.log('\n11. Malformé : group hors de la première section ou donné deux fois');
const groupElsewhere = parseClaudeConvsBlock(fence('un prompt\n---\ngroup: trop tard\nautre prompt'));
check('group refusé hors 1re section', /group:/.test(groupElsewhere.error || ''), JSON.stringify(groupElsewhere));
const groupTwice = parseClaudeConvsBlock(fence('group: a\ngroup: b\nun prompt'));
check('group refusé en double', /given more than once/.test(groupTwice.error || ''), JSON.stringify(groupTwice));

console.log('\n12. Plusieurs blocs dans le texte collé → le DERNIER gagne');
const text = 'prose avant\n\n' + fence('premier bloc, ignoré') + '\n\nprose au milieu\n\n' + fence('second bloc, celui qui compte');
const multiBlock = parseClaudeConvsBlock(text);
check('dernier bloc retenu', multiBlock.tasks && multiBlock.tasks[0].prompt === 'second bloc, celui qui compte', JSON.stringify(multiBlock));

console.log('\n13. Bloc vide → rejeté (section unique sans prompt)');
const empty = parseClaudeConvsBlock(fence(''));
check('rejeté avec une raison, tasks null', empty.found === true && empty.tasks === null && !!empty.error, JSON.stringify(empty));

console.log('\n14. Fence optionnelle (lot 6 §1) — même contenu SANS les ```, copié depuis le rendu du chat');
const bareBody =
  'group: Refonte paiement\n' +
  'model: sonnet\n' +
  'effort: medium\n' +
  'Lot 1 : schéma refunds.\n' +
  '---\n' +
  'model: opus\n' +
  'effort: high\n' +
  'stage: 2\n' +
  'Revue de sécurité du lot 1.';
const bareNominal = parseClaudeConvsBlock(bareBody);
check('found sans fence', bareNominal.found === true, JSON.stringify(bareNominal));
check('pas d\'erreur', bareNominal.error === null, bareNominal.error);
check('group extrait', bareNominal.group === 'Refonte paiement', bareNominal.group);
check('2 tâches', bareNominal.tasks && bareNominal.tasks.length === 2, JSON.stringify(bareNominal.tasks));
check('tâche 2 : stage → wave', bareNominal.tasks[1].model === 'opus' && bareNominal.tasks[1].wave === 2, JSON.stringify(bareNominal.tasks[1]));

console.log('\n15. Fence optionnelle : bloc nu malformé → repli avec raison, comme avec fence');
const bareBad = parseClaudeConvsBlock('model: gpt-4\nun prompt\n---\nmodel: sonnet\nun autre');
check('found', bareBad.found === true, JSON.stringify(bareBad));
check('erreur modèle', /unknown model/.test(bareBad.error || ''), JSON.stringify(bareBad));
check('tasks null (pas de résultat partiel)', bareBad.tasks === null);

console.log('\n16. Fence optionnelle : détection par la première ligne (un seul champ, un seul prompt, aucun séparateur)');
const bareSingleField = parseClaudeConvsBlock('model: haiku\nUne seule tâche, un seul champ, pas de ---.');
check('found via 1re ligne = champ reconnu', bareSingleField.found === true, JSON.stringify(bareSingleField));
check('model appliqué', bareSingleField.tasks && bareSingleField.tasks[0].model === 'haiku', JSON.stringify(bareSingleField));

console.log('\n17. Fence optionnelle : garde-fou — texte sans séparateur NI champ en tête → jamais tenté comme bloc nu');
const noSignal = parseClaudeConvsBlock('Juste un paragraphe normal collé dans le formulaire, sans rapport avec le format.');
check('found: false (reste un prompt simple)', noSignal.found === false, JSON.stringify(noSignal));

console.log('\n18. Cas mixte : fence présente au milieu d\'un texte qui contient aussi un `---` isolé avant elle → la fence gagne (dernier bloc)');
const mixed = 'note perso\n---\nencore une note\n\n' + fence('model: opus\nseule tâche du bloc fencé');
const mixedResult = parseClaudeConvsBlock(mixed);
check('la fence a priorité (found + tâche du bloc fencé)', mixedResult.found === true && mixedResult.tasks && mixedResult.tasks[0].prompt === 'seule tâche du bloc fencé', JSON.stringify(mixedResult));

console.log('\n19. Jeton de session (lot 11) : transporté tel quel, jamais validé ici');
const SESS = '11111111-2222-4333-8444-555555555555';
const withSession = parseClaudeConvsBlock(fence(
  'session: ' + SESS + '\n' +
  'group: Refonte\n' +
  'model: sonnet\n' +
  'Lot 1.\n' +
  '---\n' +
  'stage: 2\n' +
  'Lot 2.'
));
check('session extrait', withSession.session === SESS, JSON.stringify(withSession.session));
check('group toujours extrait à côté', withSession.group === 'Refonte', withSession.group);
check('la ligne session: ne pollue PAS le prompt de la 1re section',
  withSession.tasks && withSession.tasks[0].prompt === 'Lot 1.', JSON.stringify(withSession.tasks && withSession.tasks[0]));
check('2 tâches, vagues intactes',
  withSession.tasks.length === 2 && withSession.tasks[1].wave === 2, JSON.stringify(withSession.tasks));

const noSession = parseClaudeConvsBlock(fence('model: opus\nUne tâche sans jeton.'));
check('bloc sans session: → session null (poste sans nos hooks)', noSession.session === null, JSON.stringify(noSession));

// Un jeton faux ne doit JAMAIS faire rejeter un bloc par ailleurs correct :
// c'est master.js qui le revalide contre les transcripts, et le jette sans bruit.
const junkSession = parseClaudeConvsBlock(fence('session: pas-un-uuid\nUne tâche.'));
check('jeton qui n\'est pas un uuid : accepté ici, le bloc reste valide',
  junkSession.error === null && junkSession.session === 'pas-un-uuid', JSON.stringify(junkSession));

const sessionTwice = parseClaudeConvsBlock(fence('session: a\nsession: b\nUne tâche.'));
check('session: en double → bloc rejeté', /session: given more than once/.test(sessionTwice.error || ''), sessionTwice.error);

const sessionLate = parseClaudeConvsBlock(fence('Une tâche.\n---\nsession: ' + SESS + '\nUne autre.'));
check('session: dans une section ultérieure → bloc rejeté',
  /session: only allowed at the top/.test(sessionLate.error || ''), sessionLate.error);
check('… sans résultat partiel', sessionLate.tasks === null && sessionLate.session === null);

const bareSession = parseClaudeConvsBlock('session: ' + SESS + '\nmodel: opus\nUne tâche collée sans fence.');
check('bloc NU détecté par une 1re ligne session: (chemin nominal du bouton Copy)',
  bareSession.found === true && bareSession.session === SESS && bareSession.tasks[0].model === 'opus',
  JSON.stringify(bareSession));

console.log('\n20. Séparateur [---] (plan zone unique 2026-07-23) : nouveau signal, tolérance 3+ tirets');
const bracketSep = parseClaudeConvsBlock(fence('model: sonnet\npremière\n[---]\nmodel: opus\nseconde'));
check('[---] coupe, même sans champ imposé juste après (contrairement au legacy ---)',
  bracketSep.found === true && bracketSep.error === null && bracketSep.tasks.length === 2, JSON.stringify(bracketSep));
const bracketSepNoField = parseClaudeConvsBlock(fence('model: sonnet\npremière\n[---]\ndeuxième section, aucun champ dessus'));
check('[---] coupe même quand la section suivante ne commence PAS par un champ',
  bracketSepNoField.found === true && bracketSepNoField.tasks.length === 2
  && bracketSepNoField.tasks[1].prompt === 'deuxième section, aucun champ dessus', JSON.stringify(bracketSepNoField));
const longerBracketSep = parseClaudeConvsBlock(fence('model: sonnet\npremière\n[-----]\nmodel: opus\nseconde'));
check('[-----] (5 tirets) coupe aussi — tolérance "3 tirets ou plus"',
  longerBracketSep.found === true && longerBracketSep.tasks.length === 2, JSON.stringify(longerBracketSep));

console.log('\n21. Legacy --- nu : ne coupe QUE si la ligne suivante est un champ reconnu');
const legacyWithField = parseClaudeConvsBlock(fence('model: sonnet\npremière\n---\nmodel: opus\nseconde'));
check('--- suivi de model: → coupé (legacy toujours accepté)',
  legacyWithField.found === true && legacyWithField.error === null && legacyWithField.tasks.length === 2, JSON.stringify(legacyWithField));
const isolatedDash = parseClaudeConvsBlock(fence('model: sonnet\nun prompt avec un\n---\nsépar isolé dedans, sans champ derrière'));
check('--- isolé (rien de reconnu derrière) → PAS coupé, redevient du texte dans le même prompt',
  isolatedDash.found === true && isolatedDash.error === null && isolatedDash.tasks.length === 1
  && /---/.test(isolatedDash.tasks[0].prompt), JSON.stringify(isolatedDash));

console.log('\n22. Bloc fencé ET bloc nu, tous deux avec le nouveau séparateur [---]');
const fencedBracket = parseClaudeConvsBlock(fence('model: sonnet\nfencé 1\n[---]\nmodel: opus\nfencé 2'));
check('bloc fencé avec [---] : 2 tâches', fencedBracket.found && fencedBracket.tasks.length === 2, JSON.stringify(fencedBracket));
const bareBracket = parseClaudeConvsBlock('group: G\nmodel: sonnet\nnu 1\n[---]\nmodel: opus\nnu 2');
check('bloc nu (sans fence) avec [---] : 2 tâches, group extrait',
  bareBracket.found && bareBracket.tasks.length === 2 && bareBracket.group === 'G', JSON.stringify(bareBracket));

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
