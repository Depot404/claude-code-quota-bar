// Banc de la FILIATION DES LOTS (plan PLAN_arbre_filiation_2026-08-15.md, lot 1)
// — quel groupe se rend imbriqué sous la ligne d'un membre d'un autre.
//
// nesting.js consomme la forme DÉJÀ ENVOYÉE AU WEBVIEW (celle que groupsState
// construit) : ce banc la reproduit littéralement, champ par champ, plutôt
// qu'une forme « équivalente » — un banc qui invente sa propre forme ne prouve
// rien du câblage réel. Le bout-en-bout sur le vrai groupsState, lui, est dans
// test-nesting-e2e.js.
const path = require('path');
const { computeNesting } = require(path.join(__dirname, '..', 'nesting.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}
const j = (v) => JSON.stringify(v);

// Fabriques minimales, aux NOMS DE CHAMPS du contrat (panel.js en-tête).
const member = (key, convId, status) => ({ key, convId: convId || null, status: status || 'done' });
const group = (id, members, master) => ({
  id,
  master: master
    ? { convId: master.convId, listed: master.listed !== false, linkedAt: master.linkedAt }
    : null,
  members: members || [],
});
// Rôle de la maîtresse (plan « la maîtresse n'engage que son dernier lot »).
const role = (r, id) => (r.masterRole[id] || {}).role;
const blocks = (r, id) => !!(r.masterRole[id] || {}).latest;
const under = (n, groupId, memberKey) => !!n && n.groupId === groupId && n.memberKey === memberKey;

console.log('1. Cas nominal — la maîtresse du lot B EST un membre du lot A');
{
  // Le chantier en lots : la conv du lot 1 (« c1 ») est membre du batch A, et
  // c'est d'elle qu'a été collé le bloc qui a créé le batch B.
  const A = group('gA', [member('m1', 'c1'), member('m2', 'c2')]);
  const B = group('gB', [member('n1', 'd1')], { convId: 'c1' });
  const { nestedUnder, childrenOf } = computeNesting([A, B]);
  check('B est imbriqué sous le membre m1 de A', under(nestedUnder.gB, 'gA', 'm1'), j(nestedUnder));
  check('A, lui, n\'est imbriqué nulle part', !nestedUnder.gA, j(nestedUnder));
  check('A est l\'hôte déclaré de B (relation inverse)', j(childrenOf.gA) === j(['gB']), j(childrenOf));
  check('B n\'accueille personne', !childrenOf.gB, j(childrenOf));
}

console.log('\n2. Maîtresse hors de la fenêtre du panneau (listed: false) → rendu classique');
{
  const A = group('gA', [member('m1', 'c1')]);
  const B = group('gB', [member('n1', 'd1')], { convId: 'c1', listed: false });
  const { nestedUnder } = computeNesting([A, B]);
  check('aucune filiation : il n\'y a pas de ligne de A à habiter', !nestedUnder.gB, j(nestedUnder));
}

console.log('\n3. Maîtresse listée mais membre d\'AUCUN groupe (conversation plate)');
{
  const A = group('gA', [member('m1', 'c1')]);
  const B = group('gB', [member('n1', 'd1')], { convId: 'zzz' });
  const { nestedUnder } = computeNesting([A, B]);
  check('aucune filiation : B garde sa propre ligne maîtresse', !nestedUnder.gB, j(nestedUnder));
}

console.log('\n4. Maîtresse membre du MÊME groupe (cycle à 1, fabricable par redirection)');
{
  const B = group('gB', [member('n1', 'c1')], { convId: 'c1' });
  const { nestedUnder } = computeNesting([B]);
  check('un lot ne s\'imbrique jamais sous lui-même', !nestedUnder.gB, j(nestedUnder));
}

console.log('\n5. Cycle à 2 — A maîtresse de B et B maîtresse de A');
{
  // `setMaster` ne refuse que la maîtresse membre du MÊME groupe : ceci est
  // parfaitement constructible à la main.
  const A = group('gA', [member('m1', 'c1')], { convId: 'd1' });
  const B = group('gB', [member('n1', 'd1')], { convId: 'c1' });
  const { nestedUnder, childrenOf } = computeNesting([A, B]);
  check('A n\'est pas imbriqué', !nestedUnder.gA, j(nestedUnder));
  check('B non plus — les deux redeviennent des blocs frères', !nestedUnder.gB, j(nestedUnder));
  check('personne n\'accueille personne', j(childrenOf) === '{}', j(childrenOf));
}

console.log('\n6. Chaîne à 3 niveaux — A ← B ← C');
{
  const A = group('gA', [member('m1', 'c1')]);
  const B = group('gB', [member('n1', 'd1')], { convId: 'c1' });
  const C = group('gC', [member('p1', 'e1')], { convId: 'd1' });
  const { nestedUnder, childrenOf } = computeNesting([A, B, C]);
  check('B sous le membre m1 de A', under(nestedUnder.gB, 'gA', 'm1'), j(nestedUnder));
  check('C sous le membre n1 de B', under(nestedUnder.gC, 'gB', 'n1'), j(nestedUnder));
  check('A reste la racine', !nestedUnder.gA, j(nestedUnder));
  check('inverse cohérent sur les deux niveaux',
    j(childrenOf.gA) === j(['gB']) && j(childrenOf.gB) === j(['gC']), j(childrenOf));
}

console.log('\n7. Un lot qui POINTE vers un cycle sans en faire partie garde sa filiation');
{
  const B = group('gB', [member('n1', 'd1')], { convId: 'e1' });   // ↖ cycle avec C
  const C = group('gC', [member('p1', 'e1')], { convId: 'd1' });   // ↙
  const D = group('gD', [member('q1', 'f1')], { convId: 'e1' });   // vers C, hors cycle
  const { nestedUnder } = computeNesting([B, C, D]);
  check('le cycle B↔C est cassé des deux côtés', !nestedUnder.gB && !nestedUnder.gC, j(nestedUnder));
  check('D, lui, reste imbriqué sous C (sa chaîne est finie)', under(nestedUnder.gD, 'gC', 'p1'), j(nestedUnder));
}

console.log('\n8. Supplantation (husk→successeur) — les identifiants arrivent DÉJÀ résolus');
{
  // Le store dit encore « husk » des deux côtés ; extension.js redirige au
  // rendu (supersede.js). Ce module ne voit que le résultat.
  const A = group('gA', [member('m1', 'succ')]);
  const B = group('gB', [member('n1', 'd1')], { convId: 'succ' });
  const { nestedUnder } = computeNesting([A, B]);
  check('les deux côtés redirigés → la filiation tient', under(nestedUnder.gB, 'gA', 'm1'), j(nestedUnder));

  // Un seul côté redirigé (l'autre resté sur le husk) : les identifiants ne
  // s'égalent plus. On ne devine RIEN — rendu classique, comportement d'avant.
  const A2 = group('gA', [member('m1', 'succ')]);
  const B2 = group('gB', [member('n1', 'd1')], { convId: 'husk' });
  check('un seul côté redirigé → aucune filiation devinée',
    !computeNesting([A2, B2]).nestedUnder.gB, j(computeNesting([A2, B2]).nestedUnder));
}

console.log('\n9. La ligne d\'accueil doit EXISTER — un membre terminé-fermé ne l\'est plus');
{
  // panel.js ne rend plus les membres `done-closed` (« ce qui reste à faire »,
  // plan repli-auto étape 11) : s'imbriquer sous une ligne absente ferait
  // disparaître le sous-lot AVEC elle.
  const A = group('gA', [member('m1', 'c1', 'done-closed')]);
  const B = group('gB', [member('n1', 'd1')], { convId: 'c1' });
  const { nestedUnder } = computeNesting([A, B]);
  check('hôte done-closed → B redevient un bloc autonome (et reste visible)',
    !nestedUnder.gB, j(nestedUnder));
  // Corollaire, et c'est ce qui rend inutile toute « suspension du repli
  // auto » : un groupe qui accueille un enfant a forcément un membre NON
  // done-closed, donc groupDone() est faux, donc il ne peut pas être masqué.
  const A2 = group('gA', [member('m1', 'c1', 'busy'), member('m2', 'c2', 'done-closed')]);
  const B2 = group('gB', [member('n1', 'd1')], { convId: 'c1' });
  check('… tandis qu\'un hôte encore actif accueille normalement',
    under(computeNesting([A2, B2]).nestedUnder.gB, 'gA', 'm1'));
}

console.log('\n10. Ambiguïté — deux membres résolus sur la MÊME conversation');
{
  // Impossible depuis le store (garde d'unicité de `attach`), fabricable par
  // une redirection qui fait converger deux membres sur un même successeur.
  // Ambiguïté = aucun hôte, jamais un choix au hasard (même principe que
  // matchPending, attach.js).
  const A = group('gA', [member('m1', 'c1')]);
  const A2 = group('gA2', [member('x1', 'c1')]);
  const B = group('gB', [member('n1', 'd1')], { convId: 'c1' });
  const { nestedUnder } = computeNesting([A, A2, B]);
  check('deux hôtes possibles → aucune filiation', !nestedUnder.gB, j(nestedUnder));
}

console.log('\n11. Deux sous-lots sous la MÊME ligne — ordre du store, jamais inventé');
{
  const A = group('gA', [member('m1', 'c1')]);
  const B = group('gB', [member('n1', 'd1')], { convId: 'c1' });
  const C = group('gC', [member('p1', 'e1')], { convId: 'c1' });
  const { nestedUnder, childrenOf } = computeNesting([A, B, C]);
  check('les deux s\'accrochent au même membre',
    under(nestedUnder.gB, 'gA', 'm1') && under(nestedUnder.gC, 'gA', 'm1'), j(nestedUnder));
  check('… dans l\'ordre où le store les rend', j(childrenOf.gA) === j(['gB', 'gC']), j(childrenOf));
}

console.log('\n12. Dégradation silencieuse — entrées absentes ou incomplètes');
{
  check('aucun groupe', j(computeNesting([]).nestedUnder) === '{}');
  check('entrée non tableau', j(computeNesting(null).nestedUnder) === '{}');
  check('groupe sans id ignoré', j(computeNesting([{ members: [] }]).nestedUnder) === '{}');
  const A = group('gA', [member('m1', 'c1')]);
  check('groupe sans members ni master', j(computeNesting([A, { id: 'gB' }]).nestedUnder) === '{}');
  const B = group('gB', [member('n1', null)], { convId: 'c1' });
  check('membre non lié (convId null) : jamais un hôte, jamais une erreur',
    under(computeNesting([A, B]).nestedUnder.gB, 'gA', 'm1'), j(computeNesting([A, B]).nestedUnder));
  const C = { id: 'gC', master: { convId: 'c1', listed: true } };  // members absent
  check('master sans tableau de membres', under(computeNesting([A, C]).nestedUnder.gC, 'gA', 'm1'));
}

// ══════════════════════════════════════════════════════════════════════════
// RÔLE DE LA MAÎTRESSE — plan PLAN_maitresse_dernier_lot_2026-08-15.md.
// « Une conversation maîtresse n'engage que le DERNIER lot qui l'a revendiquée. »
// ══════════════════════════════════════════════════════════════════════════

console.log('\n13. Claimant UNIQUE — strictement le comportement d\'avant');
{
  const A = group('gA', [member('m1', 'c1')], { convId: 'zzz', linkedAt: 100 });
  const r = computeNesting([A]);
  check('la maîtresse est rendue par son groupe (host)', role(r, 'gA') === 'host', j(r.masterRole));
  check('… et elle bloque toujours le « lot terminé »', blocks(r, 'gA'), j(r.masterRole));
  const B = group('gB', [member('n1', 'd1')]);       // aucune maîtresse désignée
  check('un lot sans maîtresse n\'a aucun rôle à porter',
    !computeNesting([B]).masterRole.gB, j(computeNesting([B]).masterRole));
}

console.log('\n14. DEUX claimants, maîtresse membre d\'aucun lot (le cas témoin réel)');
{
  // Une même conv de cadrage a lancé deux lots à des heures différentes : elle
  // est la maîtresse déclarée des deux. Sans arbitrage, le dernier RENDU prend
  // le nœud de conversation et l'autre garde une capsule vide.
  const vieux = group('g0301', [member('m1', 'a1')], { convId: 'cadrage', linkedAt: 300 });
  const recent = group('g1434', [member('n1', 'b1')], { convId: 'cadrage', linkedAt: 1434 });
  const r = computeNesting([vieux, recent]);
  check('le lien le plus RÉCENT garde la tête', role(r, 'g1434') === 'host', j(r.masterRole));
  check('le plus ancien la CÈDE', role(r, 'g0301') === 'ceded', j(r.masterRole));
  check('seul le récent bloque le « lot terminé »',
    blocks(r, 'g1434') && !blocks(r, 'g0301'), j(r.masterRole));
  check('aucune filiation là-dedans (la maîtresse n\'est membre de rien)',
    j(r.nestedUnder) === '{}', j(r.nestedUnder));

  // L'ordre du store ne doit RIEN changer : c'est la date qui tranche, pas la
  // position — c'est tout l'écart avec le « dernier rendu gagne » d'avant.
  const inverse = computeNesting([recent, vieux]);
  check('… et l\'ordre dans lequel le store les rend n\'y change rien',
    role(inverse, 'g1434') === 'host' && role(inverse, 'g0301') === 'ceded', j(inverse.masterRole));
}

console.log('\n15. Égalité de dates → l\'ordre du store tranche, le DERNIER gagne');
{
  const A = group('gA', [member('m1', 'a1')], { convId: 'cadrage', linkedAt: 500 });
  const B = group('gB', [member('n1', 'b1')], { convId: 'cadrage', linkedAt: 500 });
  const r = computeNesting([A, B]);
  check('déterministe : le dernier du store garde la tête',
    role(r, 'gB') === 'host' && role(r, 'gA') === 'ceded', j(r.masterRole));
}

console.log('\n16. Legacy — aucun `linkedAt` (stockage écrit avant ce plan)');
{
  // sanitize pose déjà le createdAt du groupe pour défaut ; ce module doit
  // rester lisible même si la valeur n'arrive pas du tout (0 des deux côtés).
  const A = group('gA', [member('m1', 'a1')], { convId: 'cadrage' });
  const B = group('gB', [member('n1', 'b1')], { convId: 'cadrage' });
  const r = computeNesting([A, B]);
  check('aucune date des deux côtés → résolution déterministe, jamais une erreur',
    role(r, 'gB') === 'host' && role(r, 'gA') === 'ceded', j(r.masterRole));
  const C = group('gC', [member('p1', 'c1')], { convId: 'cadrage', linkedAt: 42 });
  const r2 = computeNesting([C, A]);            // C daté, A sans date (donc 0)
  check('un claimant daté passe devant un claimant sans date',
    role(r2, 'gC') === 'host' && role(r2, 'gA') === 'ceded', j(r2.masterRole));
}

console.log('\n17. Deux claimants ET maîtresse membre d\'un 3e lot → les DEUX nestent');
{
  // Exception filiation : la conv est déjà rendue comme membre de A, donc
  // AUCUN claimant ne rend de tête propre — ils pendent tous les deux sous
  // cette ligne (childrenOf est un tableau, le plan filiation le prévoit).
  const A = group('gA', [member('m1', 'cadrage')]);
  const vieux = group('gV', [member('v1', 'a1')], { convId: 'cadrage', linkedAt: 300 });
  const recent = group('gR', [member('r1', 'b1')], { convId: 'cadrage', linkedAt: 1434 });
  const r = computeNesting([A, vieux, recent]);
  check('les deux sous-lots s\'accrochent à la même ligne d\'accueil',
    under(r.nestedUnder.gV, 'gA', 'm1') && under(r.nestedUnder.gR, 'gA', 'm1'), j(r.nestedUnder));
  check('… dans l\'ordre du store', j(r.childrenOf.gA) === j(['gV', 'gR']), j(r.childrenOf));
  check('rôle « nested » des deux côtés : personne ne rend de tête propre',
    role(r, 'gV') === 'nested' && role(r, 'gR') === 'nested', j(r.masterRole));
  check('mais le blocage du « terminé » reste au plus récent',
    blocks(r, 'gR') && !blocks(r, 'gV'), j(r.masterRole));
}

console.log('\n18. Supplantation — deux revendications qui convergent sur le même successeur');
{
  // Le store dit encore « husk » d'un côté ; extension.js redirige AVANT
  // d'appeler ce module. Deux claims sur le même successeur = la même conv,
  // sans une ligne de code de plus ici.
  const A = group('gA', [member('m1', 'a1')], { convId: 'succ', linkedAt: 100 });
  const B = group('gB', [member('n1', 'b1')], { convId: 'succ', linkedAt: 200 });
  const r = computeNesting([A, B]);
  check('la redirection étant déjà faite, les deux se disputent bien la même conv',
    role(r, 'gB') === 'host' && role(r, 'gA') === 'ceded', j(r.masterRole));

  // Non redirigés (deux identifiants distincts) : deux conversations, deux
  // maîtresses — chacun garde tout, comme avant.
  const C = group('gC', [member('p1', 'c1')], { convId: 'husk', linkedAt: 100 });
  const r2 = computeNesting([C, B]);
  check('deux identifiants distincts → deux têtes légitimes',
    role(r2, 'gC') === 'host' && role(r2, 'gB') === 'host', j(r2.masterRole));
}

console.log('\n19. Maîtresse sans convId — rien à départager, comportement d\'avant');
{
  const A = { id: 'gA', master: { convId: null, listed: true, linkedAt: 10 }, members: [] };
  const B = { id: 'gB', master: { convId: null, listed: true, linkedAt: 20 }, members: [] };
  const r = computeNesting([A, B]);
  check('aucun des deux ne cède quoi que ce soit',
    role(r, 'gA') === 'host' && role(r, 'gB') === 'host', j(r.masterRole));
  check('… et tous deux bloquent leur « terminé »', blocks(r, 'gA') && blocks(r, 'gB'), j(r.masterRole));
}

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
