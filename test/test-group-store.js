// Banc : groupes de conversations — persistance et cycle de vie (lot 2 du plan
// PLAN_creation_groupes_2026-07-22.md).
//
// Ce qui peut silencieusement mal tourner, et que ce banc verrouille :
//   1. la persistance (workspaceState) — ce qui est relu doit être ce qui a été
//      écrit, y compris après une écriture par une VERSION ANTÉRIEURE de
//      l'extension (JSON hétéroclite, champs manquants) ;
//   2. la dissolution ne doit RIEN emporter d'autre que les métadonnées — c'est
//      la promesse du plan, et le seul moyen de la tester ici est de vérifier
//      que le store ne touche jamais à autre chose que sa propre liste ;
//   3. l'unicité du sessionId : deux membres pour une même conversation, c'est
//      une ligne fantôme dans le panneau ;
//   4. la purge, qui ne doit jamais emporter un groupe encore représenté à
//      l'écran.
const path = require('path');

const EXT = path.join(__dirname, '..');
const { createGroupStore, hueOf, sanitizeGroup } = require(path.join(EXT, 'groups.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

// Faux workspaceState : un objet JSON qui survit d'un store à l'autre, comme
// le vrai survit à un reload de fenêtre.
function fakeStorage(initial = []) {
  let data = JSON.parse(JSON.stringify(initial));
  return {
    load: () => JSON.parse(JSON.stringify(data)),
    save: (g) => { data = JSON.parse(JSON.stringify(g)); },
    raw: () => data,
  };
}

const TASKS = [
  { prompt: 'Implement the token refresh flow', model: 'opus', effort: 'high', wave: 1 },
  { prompt: 'Write the integration tests', model: 'sonnet', effort: 'medium', wave: 1 },
  { prompt: 'Update the docs once both have landed', model: null, effort: null, wave: 2 },
];

function run() {
  console.log('\n1. Création et persistance');
  const st = fakeStorage();
  let store = createGroupStore({ load: st.load, save: st.save, now: () => 1000, newId: () => 'g1' });
  const g = store.create('Payment refactor', TASKS);
  check('groupe créé avec un membre par tâche', g.members.length === 3, JSON.stringify(g.members.length));
  check('membres non liés à la création (le sessionId vient après)',
    g.members.every((m) => m.sessionId === null));
  check('modèle/effort/vague conservés', g.members[0].model === 'opus' && g.members[2].wave === 2);
  check('écrit dans le stockage', st.raw().length === 1 && st.raw()[0].id === 'g1', JSON.stringify(st.raw()));

  // Reload de fenêtre : nouveau store, même stockage.
  store = createGroupStore({ load: st.load, save: st.save, now: () => 2000 });
  check('relu à l\'identique après « reload »', store.all().length === 1 && store.all()[0].members.length === 3);

  console.log('\n2. Nom par défaut et teinte');
  const st2 = fakeStorage();
  const anon = createGroupStore({ load: st2.load, save: st2.save, now: () => Date.UTC(2026, 6, 22, 20, 41), newId: () => 'gx' })
    .create('', [{ prompt: 'x' }]);
  check('nom vide → repli horodaté', /^Batch \d\d:\d\d$/.test(anon.name), anon.name);
  check('teinte stable et bornée', hueOf('Payment refactor') === hueOf('Payment refactor') && hueOf('Payment refactor') < 360);
  check('deux noms différents → deux teintes (en général)', hueOf('a') !== hueOf('b'));

  console.log('\n3. Rattachement : un sessionId n\'appartient qu\'à un membre');
  check('attachByIndex suit l\'ordre des tâches', store.attachByIndex('g1', 0, 's-A') && store.get('g1').members[0].sessionId === 's-A');
  check('même sessionId sur un 2e membre : REFUSÉ', store.attachByIndex('g1', 1, 's-A') === false);
  check('… et le 2e membre reste non lié', store.get('g1').members[1].sessionId === null);
  check('sessionId différent : accepté', store.attach('g1', 'm2', 's-B') && store.get('g1').members[1].sessionId === 's-B');
  check('groupIdOf retrouve le groupe d\'une conv', store.groupIdOf('s-B') === 'g1');
  check('groupIdOf d\'une conv hors groupe → null', store.groupIdOf('s-inconnu') === null);
  check('attachedIds liste les deux', [...store.attachedIds()].sort().join() === 's-A,s-B');
  // m3 est en vague 2 : depuis le lot 4, il naît `queued` (launchedAt null) —
  // pending() (étage 2 du rattachement) ne doit JAMAIS lui chercher une
  // conversation tant que sa vague n'est pas ouverte (aucun onglet n'existe).
  check('vague 2 pas encore lancée → absente de pending()', store.pending().length === 0, JSON.stringify(store.pending()));
  check('markLaunched fait entrer m3 dans pending()',
    store.markLaunched('g1', 'm3', 3000) && store.pending().map((p) => p.key).join() === 'm3');
  check('markLaunched une 2e fois sur le même membre : refusé (déjà lancé)', store.markLaunched('g1', 'm3', 4000) === false);
  check('detach délie sans rien supprimer', store.detach('g1', 'm2') && store.get('g1').members.length === 3 && store.get('g1').members[1].sessionId === null);
  store.attach('g1', 'm2', 's-B');

  console.log('\n4. Intentions réamorcées après reload (badge d\'écart)');
  const intents = store.intents();
  check('une intention par membre lié qui a DEMANDÉ quelque chose', intents.length === 2, JSON.stringify(intents));
  check('membre sans rien demandé (model/effort null, lot 14) : aucune intention (rien à comparer)',
    !intents.some((i) => i.sessionId === 's-C'));
  check('modèle et effort transportés', intents[0].model === 'opus' && intents[0].effort === 'high');

  console.log('\n5. Renommer, replier');
  check('renommage', store.rename('g1', '  Refonte paiements  ') && store.get('g1').name === 'Refonte paiements');
  check('nom vide refusé', store.rename('g1', '   ') === false && store.get('g1').name === 'Refonte paiements');
  check('repli persisté', store.setCollapsed('g1', true) && st.raw()[0].collapsed === true);

  console.log('\n6. Retrait de membre et dissolution');
  const st3 = fakeStorage();
  const s3 = createGroupStore({ load: st3.load, save: st3.save, now: () => 1000, newId: () => 'gg' });
  s3.create('Deux', [{ prompt: 'a' }, { prompt: 'b' }]);
  s3.attach('gg', 'm1', 'x1');
  check('retrait d\'un membre', s3.removeMember('gg', 'm1') && s3.get('gg').members.length === 1);
  check('la conv retirée n\'est plus rattachée à rien', s3.groupIdOf('x1') === null);
  check('retrait du DERNIER membre → le groupe disparaît', s3.removeMember('gg', 'm2') && s3.all().length === 0);
  check('stockage vidé aussi', st3.raw().length === 0);

  const st4 = fakeStorage();
  const s4 = createGroupStore({ load: st4.load, save: st4.save, now: () => 1000, newId: () => 'gd' });
  s4.create('À dissoudre', [{ prompt: 'a' }, { prompt: 'b' }]);
  s4.attach('gd', 'm1', 'keep-me');
  check('dissolution', s4.dissolve('gd') === true && s4.all().length === 0);
  check('dissoudre deux fois n\'invente rien', s4.dissolve('gd') === false);

  console.log('\n7. Ajout manuel d\'une conversation existante');
  const st5 = fakeStorage();
  const s5 = createGroupStore({ load: st5.load, save: st5.save, now: () => 1000, newId: () => 'ga' });
  s5.create('Groupe', [{ prompt: 'a' }]);
  s5.attach('ga', 'm1', 'sess-1');
  check('ajout accepté', s5.addExisting('ga', 'sess-2', 'Titre de la conv') && s5.get('ga').members.length === 2);
  check('rien n\'a été DEMANDÉ pour elle → model/effort null (lot 14), aucun écart possible',
    s5.get('ga').members[1].model === null && s5.get('ga').members[1].effort === null);
  check('une conv déjà membre n\'est pas ajoutée deux fois', s5.addExisting('ga', 'sess-1', 'x') === false);
  check('membre ajouté à la main : jamais dans pending() (pas de prompt à matcher)',
    s5.pending().length === 0, JSON.stringify(s5.pending()));

  console.log('\n8. Purge de stockage (jamais un groupe encore à l\'écran)');
  const DAY = 24 * 60 * 60 * 1000;
  const st6 = fakeStorage([
    { id: 'old-orphan', name: 'Vieux sans conv', createdAt: 0, members: [{ key: 'm1', sessionId: 'gone' }] },
    { id: 'old-visible', name: 'Vieux mais visible', createdAt: 0, members: [{ key: 'm1', sessionId: 'still-here' }] },
    { id: 'recent', name: 'Récent', createdAt: 9 * DAY, members: [{ key: 'm1', sessionId: null }] },
  ]);
  const s6 = createGroupStore({ load: st6.load, save: st6.save, now: () => 10 * DAY });
  const dropped = s6.prune(7 * DAY, new Set(['still-here']));
  check('groupe vieux ET sans conv connue : purgé', dropped === 1 && !s6.get('old-orphan'));
  check('groupe vieux mais dont une conv est encore là : GARDÉ', !!s6.get('old-visible'));
  check('groupe récent : gardé même sans conv rattachée', !!s6.get('recent'));

  console.log('\n9. Stockage écrit par une version antérieure (tolérance)');
  check('entrée sans id → jetée', sanitizeGroup({ name: 'x' }) === null);
  check('entrée non-objet → jetée', sanitizeGroup('nope') === null && sanitizeGroup(null) === null);
  const clean = sanitizeGroup({ id: 'g', members: [{ key: 'm1' }, { nokey: 1 }, null], extra: 'ignoré' });
  check('membres illisibles jetés, les autres complétés (model/effort null, lot 14)',
    clean.members.length === 1 && clean.members[0].model === null && clean.members[0].sessionId === null,
    JSON.stringify(clean));
  const legacyInherit = sanitizeGroup({ id: 'g2', members: [{ key: 'm1', model: 'inherit', effort: 'inherit' }] });
  check('ancienne valeur littérale "inherit" (stockage pré-lot-14) : traverse telle quelle, jamais interprétée comme une intention',
    legacyInherit.members[0].model === 'inherit' && legacyInherit.members[0].effort === 'inherit', JSON.stringify(legacyInherit));
  check('nom absent → repli, jamais undefined', clean.name === 'Batch');
  // Trou de numérotation venu d'un stockage antérieur (déplacement « +1 sur le
  // numéro » d'avant le 2026-08-22, ou dernier membre d'une vague retiré) : le
  // panneau afficherait « vague 1 » puis « vague 3 », et la flèche ◂ serait
  // morte faute de vague 2 où revenir. L'invariant tient à la LECTURE.
  const holed = sanitizeGroup({ id: 'gh', members: [
    { key: 'm1', wave: 1, launchedAt: 5 }, { key: 'm2', wave: 3 }, { key: 'm3', wave: 3 }, { key: 'm4', wave: 7 },
  ] });
  check('vagues trouées à la lecture → renumérotées 1,2,3 sans rien réordonner',
    holed.members.map((m) => m.key + '=' + m.wave).join(' ') === 'm1=1 m2=2 m3=2 m4=3',
    holed.members.map((m) => m.key + '=' + m.wave).join(' '));
  check('… la vague déjà lancée reste devant, et lancée',
    holed.members[0].wave === 1 && holed.members[0].launchedAt === 5);
  const st7 = fakeStorage([{ id: 'g', name: 'ok', members: [] }, 'garbage', 42]);
  const s7 = createGroupStore({ load: st7.load, save: st7.save });
  check('un stockage à moitié pourri ne fait pas planter le store', s7.all().length === 1);
  const s8 = createGroupStore({ load: () => { throw new Error('storage down'); }, save: () => {} });
  check('lecture qui jette → store vide, jamais d\'exception', s8.all().length === 0);

  console.log('\n10. Vagues (lot 4) : membersOfWave, déplacement');
  const st9 = fakeStorage();
  let s9Seq = 0;
  const s9 = createGroupStore({ load: st9.load, save: st9.save, now: () => 1000, newId: () => 'gw' + (s9Seq++) });
  // Une vague est une POSITION, jamais un numéro figé (décision 2026-08-22) :
  // la numérotation reste contiguë, et `delta` vaut UN CRAN. Un membre seul
  // dans sa vague FUSIONNE avec la voisine (sa vague disparaît) ; un membre
  // accompagné SE DÉTACHE dans une vague neuve — c'est le seul chemin qui
  // fabrique une vague, et c'est lui qui rend le geste réversible.
  const WAVE_TASKS = [
    { prompt: 'a', wave: 1 }, { prompt: 'b', wave: 1 },
    { prompt: 'c', wave: 2 }, { prompt: 'e', wave: 2 },
    { prompt: 'd', wave: 3 },
  ];
  s9.create('W', WAVE_TASKS);
  check('seule la vague 1 a un launchedAt à la création',
    s9.get('gw0').members.filter((m) => m.launchedAt != null).map((m) => m.key).join() === 'm1,m2');
  check('membersOfWave(2) rend le bon sous-ensemble', s9.membersOfWave('gw0', 2).map((m) => m.key).join() === 'm3,m4');

  // Vue lisible de la répartition : « 1:m1,m2 | 2:m3,m4 | 3:m5 ». C'est la
  // SEULE chose que ces tests regardent — un numéro de vague isolé ne dit rien
  // tant qu'on ne voit pas ce qu'il y a autour.
  const shape = (st, id) => {
    const ms = st.get(id).members;
    const waves = [...new Set(ms.map((m) => m.wave))].sort((a, b) => a - b);
    return waves.map((w) => w + ':' + ms.filter((m) => m.wave === w).map((m) => m.key).join(',')).join(' | ');
  };

  check('départ : deux vagues en file derrière la vague 1 lancée',
    shape(s9, 'gw0') === '1:m1,m2 | 2:m3,m4 | 3:m5', shape(s9, 'gw0'));

  // m3 est ACCOMPAGNÉ (m4 partage sa vague) : il se détache dans une vague
  // neuve juste après, et tout ce qui suivait se décale.
  check('▸ sur un membre accompagné : il se détache dans une vague neuve',
    s9.moveQueuedMember('gw0', 'm3', 1) && shape(s9, 'gw0') === '1:m1,m2 | 2:m4 | 3:m3 | 4:m5', shape(s9, 'gw0'));
  // ... et la flèche inverse annule EXACTEMENT le clic précédent : m3 est
  // maintenant seul, il refusionne avec la vague d'avant, qui se renumérote.
  check('◂ derrière : le clic précédent est annulé au numéro près',
    s9.moveQueuedMember('gw0', 'm3', -1) && shape(s9, 'gw0') === '1:m1,m2 | 2:m3,m4 | 3:m5', shape(s9, 'gw0'));

  // Le bug du 2026-08-22 : la seule ligne d'une vague part rejoindre la
  // suivante, sa vague se vide — et il fallait pouvoir revenir. Avant, la
  // vague 2 n'existait plus et le retour était refusé en silence.
  check('m5 (seul en vague 3) rejoint la vague 2 : sa vague disparaît, pas de trou',
    s9.moveQueuedMember('gw0', 'm5', -1) && shape(s9, 'gw0') === '1:m1,m2 | 2:m3,m4,m5', shape(s9, 'gw0'));
  check('retour : m5 se détache à nouveau dans sa propre vague',
    s9.moveQueuedMember('gw0', 'm5', 1) && shape(s9, 'gw0') === '1:m1,m2 | 2:m3,m4 | 3:m5', shape(s9, 'gw0'));

  // Deuxième moitié du bug : créer une vague APRÈS la dernière. Seul un membre
  // accompagné peut le faire — m5 est seul en dernière vague, le pousser plus
  // loin ne ferait que renuméroter sa propre vague.
  check('▸ sur le seul membre de la dernière vague : REFUSÉ (rien ne changerait)',
    s9.moveQueuedMember('gw0', 'm5', 1) === false);
  check('▸ sur un membre accompagné de la dernière vague : une vague neuve naît au bout',
    s9.moveQueuedMember('gw0', 'm5', -1) && s9.moveQueuedMember('gw0', 'm5', 1) &&
    shape(s9, 'gw0') === '1:m1,m2 | 2:m3,m4 | 3:m5', shape(s9, 'gw0'));

  // Le seuil des vagues lancées tient toujours : un membre SEUL dans la
  // première vague en file n'a nulle part où reculer.
  check('◂ sur le seul membre de la première vague en file : REFUSÉ (la vague 1 est partie)',
    s9.moveQueuedMember('gw0', 'm5', -1) && s9.moveQueuedMember('gw0', 'm3', -1) &&
    s9.moveQueuedMember('gw0', 'm3', -1) === false, shape(s9, 'gw0'));
  check('… et il est bien seul en vague 2, la vague 1 lancée intacte',
    shape(s9, 'gw0') === '1:m1,m2 | 2:m3 | 3:m4,m5', shape(s9, 'gw0'));
  check('un membre accompagné, LUI, peut se détacher devant ses voisines',
    s9.moveQueuedMember('gw0', 'm5', -1) && shape(s9, 'gw0') === '1:m1,m2 | 2:m3 | 3:m5 | 4:m4', shape(s9, 'gw0'));

  s9.markLaunched('gw0', 'm3', 2000);
  check('un membre déjà lancé ne bouge plus', s9.moveQueuedMember('gw0', 'm3', 1) === false);
  check("une vague déjà ouverte n'accueille plus personne",
    s9.moveQueuedMember('gw0', 'm5', -1) === false, shape(s9, 'gw0'));

  const st10 = fakeStorage();
  const s10 = createGroupStore({ load: st10.load, save: st10.save, now: () => 1000, newId: () => 'ge' });
  s10.create('Existante', [{ prompt: 'a' }]);
  s10.addExisting('ge', 'sess-x', 'Titre');
  check('addExisting compte comme lancée (pas queued) — moteur de vagues cohérent',
    s10.get('ge').members[1].launchedAt != null);

  console.log('\n11. Conversation maîtresse (lot 11) — un POINTEUR, pas un membre');
  const st11 = fakeStorage();
  let s11 = createGroupStore({ load: st11.load, save: st11.save, now: () => 1000, newId: () => 'gm' });
  s11.create('Chantier', [{ prompt: 'a' }, { prompt: 'b' }]);
  check('un groupe naît sans maîtresse', s11.get('gm').masterSessionId === null);
  check('setMaster enregistre l\'identifiant ET le titre du moment',
    s11.setMaster('gm', 'sess-master', 'Cadrage du chantier')
    && s11.get('gm').masterSessionId === 'sess-master'
    && s11.get('gm').masterTitle === 'Cadrage du chantier');
  check('… et persiste', st11.raw()[0].masterSessionId === 'sess-master' && st11.raw()[0].masterTitle === 'Cadrage du chantier');
  s11 = createGroupStore({ load: st11.load, save: st11.save, now: () => 1000 });
  check('… et survit au reload', s11.get('gm').masterSessionId === 'sess-master' && s11.get('gm').masterTitle === 'Cadrage du chantier');
  check('masterGroupIdOf retrouve le groupe', s11.masterGroupIdOf('sess-master') === 'gm' && s11.masterGroupIdOf('sess-autre') === null);
  check('la maîtresse ne compte PAS dans les membres', s11.get('gm').members.length === 2);
  check('claimedIds inclut la maîtresse, attachedIds non',
    s11.claimedIds().has('sess-master') && !s11.attachedIds().has('sess-master'));
  check('un membre ne peut pas être rattaché à la maîtresse de son propre groupe',
    s11.attach('gm', 'm1', 'sess-master') === false);
  check('… ni y être ajouté comme conversation existante', s11.addExisting('gm', 'sess-master', 'x') === false);
  check('un autre sessionId se rattache normalement', s11.attach('gm', 'm1', 'sess-1') === true);
  check('setMaster REFUSE une conversation déjà membre de ce groupe (elle serait à deux places)',
    s11.setMaster('gm', 'sess-1', 'Membre') === false && s11.get('gm').masterSessionId === 'sess-master');

  // Cas nominal d'un chantier en lots : la conv du lot N est membre d'un groupe
  // antérieur ET la maîtresse du groupe du lot N+1. Rien ne l'interdit.
  const gNext = s11.create('Lot suivant', [{ prompt: 'c' }, { prompt: 'd' }]);
  check('une conversation membre d\'un AUTRE groupe peut être maîtresse ici',
    s11.setMaster(gNext.id, 'sess-1', 'Lot N') === true);

  check('unsetMaster efface identifiant et titre',
    s11.unsetMaster('gm') && s11.get('gm').masterSessionId === null && s11.get('gm').masterTitle === '');
  check('unsetMaster sur un groupe sans maîtresse : sans effet', s11.unsetMaster('gm') === false);
  check('setMaster sur un groupe inconnu : sans effet', s11.setMaster('nope', 'x', 'y') === false);

  // ── Instant du lien (plan « la maîtresse n'engage que son dernier lot ») ──
  // C'est LUI qui départage deux groupes revendiquant la même conversation :
  // sans lui, le rendu tranchait par l'ordre du store, et re-lier une vieille
  // maîtresse à la main restait sans effet visible.
  const stLink = fakeStorage();
  let clockLink = 5000;
  let sLink = createGroupStore({ load: stLink.load, save: stLink.save, now: () => clockLink, newId: () => 'gLink' });
  sLink.create('Chantier', [{ prompt: 'a' }]);
  check('un groupe naît sans lien de maîtresse daté', sLink.get('gLink').masterLinkedAt === 0);
  sLink.setMaster('gLink', 'sess-m', 'Cadrage');
  check('setMaster stampe l\'instant du lien', sLink.get('gLink').masterLinkedAt === 5000);
  clockLink = 9000;
  sLink.setMaster('gLink', 'sess-autre', 'Autre cadrage');
  check('… et le re-stampe à chaque lien accepté (le geste doit avoir un effet)',
    sLink.get('gLink').masterLinkedAt === 9000);
  check('… et il persiste', stLink.raw()[0].masterLinkedAt === 9000);
  sLink = createGroupStore({ load: stLink.load, save: stLink.save, now: () => clockLink });
  check('… et survit au reload', sLink.get('gLink').masterLinkedAt === 9000);

  // Stockage écrit AVANT ce lot : aucun champ master, aucune migration.
  const legacy = sanitizeGroup({ id: 'old', name: 'Ancien', members: [{ key: 'm1' }] });
  check('stockage antérieur au lot 11 : masterSessionId null, masterTitle vide',
    legacy.masterSessionId === null && legacy.masterTitle === '');
  check('stockage antérieur au plan « dernier lot » : masterLinkedAt = createdAt du groupe',
    sanitizeGroup({ id: 'old', name: 'Ancien', createdAt: 777, members: [] }).masterLinkedAt === 777);
  check('… et 0 quand même le createdAt manque (jamais NaN, jamais undefined)',
    legacy.masterLinkedAt === 0);
  check('masterLinkedAt illisible dans le stockage : repli createdAt, jamais interprété',
    sanitizeGroup({ id: 'x', name: 'X', createdAt: 555, masterLinkedAt: 'hier', members: [] }).masterLinkedAt === 555);
  check('masterSessionId non-string dans le stockage : jeté, jamais interprété',
    sanitizeGroup({ id: 'x', name: 'X', masterSessionId: 42, masterTitle: {}, members: [] }).masterSessionId === null);

  // Purge : un groupe vieux dont il ne reste QUE la maîtresse à l'écran est
  // encore représenté — il ne doit pas disparaître du stockage.
  const st12 = fakeStorage();
  let clock12 = 1000;
  const s12 = createGroupStore({ load: st12.load, save: st12.save, now: () => clock12, newId: () => 'gold' });
  s12.create('Vieux', [{ prompt: 'a' }]);
  s12.setMaster('gold', 'sess-master', 'Cadrage');
  clock12 = 10_000_000;   // le groupe est maintenant bien plus vieux que maxAgeMs
  check('purge : un groupe ancien dont la maîtresse est encore connue est conservé',
    s12.prune(1000, new Set(['sess-master'])) === 0 && s12.all().length === 1);
  check('purge : plus rien de connu → il part', s12.prune(1000, new Set()) === 1 && s12.all().length === 0);

  console.log('\n12. Ajout en file à un groupe existant (plan ajout-tache 2026-07-24)');
  const st13 = fakeStorage();
  let s13Seq = 0;
  const s13 = createGroupStore({ load: st13.load, save: st13.save, now: () => 5000, newId: () => 'ga' + (s13Seq++) });
  s13.create('Chantier', [{ prompt: 'a', wave: 1 }, { prompt: 'b', wave: 2 }]);
  check('vague explicite en file : acceptée', s13.addTask('ga0', { prompt: 'c', model: 'opus', effort: 'high' }, 2));
  const withC = s13.get('ga0');
  check('nouveau membre = m3, clé jamais réutilisée', withC.members.length === 3 && withC.members[2].key === 'm3', JSON.stringify(withC.members));
  check('champs conservés (fabrique memberOfTask)',
    withC.members[2].prompt === 'c' && withC.members[2].model === 'opus' && withC.members[2].effort === 'high' && withC.members[2].wave === 2);
  check('AUCUN lancement : queued sans sessionId', withC.members[2].launchedAt === null && withC.members[2].sessionId === null);
  check('wave: null → nouvelle vague (max+1)', s13.addTask('ga0', { prompt: 'd' }, null) && s13.get('ga0').members.find((m) => m.key === 'm4').wave === 3);
  check('prompt vide : refusé', s13.addTask('ga0', { prompt: '   ' }, 3) === false);
  check('vague ≤ 0 ou non entière : refusée', s13.addTask('ga0', { prompt: 'x' }, 0) === false && s13.addTask('ga0', { prompt: 'x' }, 1.5) === false);
  check('groupe inconnu : sans effet', s13.addTask('nope', { prompt: 'x' }, 1) === false);
  check('persisté', st13.raw()[0].members.length === 4);

  // Vague EN COURS : ACCEPTÉE depuis 2026-08-28 (demande user — glisser un lot
  // dans la vague qui tourne). m1 (vague 1) est lancé DÈS la création (comme le
  // Create), lw vaut donc déjà 1 sans rien de plus à faire. Le membre naît
  // quand même `queued` ici : c'est extension.js qui l'ouvre juste après.
  check('vague EN COURS (1) : acceptée', s13.addTask('ga0', { prompt: 'y' }, 1) === true);
  const withY = s13.get('ga0');
  check('… déposée dans la vague 1, et queued dans le store',
    withY.members.length === 5 && withY.members[4].wave === 1 && withY.members[4].launchedAt === null,
    JSON.stringify(withY.members.map((m) => m.key + ':' + m.wave)));

  // Vague PASSÉE : refusée. Elle est terminée, y poser une tâche ne veut rien
  // dire — et rien ne viendrait jamais l'ouvrir.
  const st13b = fakeStorage();
  let s13bSeq = 0;
  const s13b = createGroupStore({ load: st13b.load, save: st13b.save, now: () => 5000, newId: () => 'gb' + (s13bSeq++) });
  s13b.create('Passe', [{ prompt: 'a', wave: 1 }, { prompt: 'b', wave: 2 }]);
  s13b.markLaunched('gb0', 'm2', 6000);   // la vague 2 est partie : lw = 2
  check('vague PASSÉE (1, alors que la 2 est lancée) : refusée', s13b.addTask('gb0', { prompt: 'z' }, 1) === false);
  check('le nombre de membres n\'a pas bougé', s13b.get('gb0').members.length === 2);

  // addTasks : N prompts d'un coup, et DEUX gestes nommés depuis le
  // 2026-08-29 — 'into' (rejoindre la vague visée) et 'before' (s'insérer
  // devant elle). Avant, un geste unique fondait la première vague du bloc
  // dans la vague visée et intercalait les suivantes : sur un bloc à 4 vagues,
  // l'user obtenait une vague existante mélangée à une nouvelle et le reste du
  // lot repoussé (« un gros bazar », capture du 2026-08-29).
  const st13c = fakeStorage();
  let s13cSeq = 0;
  const s13c = createGroupStore({ load: st13c.load, save: st13c.save, now: () => 5000, newId: () => 'gc' + (s13cSeq++) });
  s13c.create('Bloc', [{ prompt: 'a', wave: 1 }, { prompt: 'b', wave: 2 }, { prompt: 'c', wave: 3 }]);
  check('into, bloc mono-vague : les 2 tâches atterrissent DANS la vague visée, rien d\'autre ne bouge',
    s13c.addTasks('gc0', [{ prompt: 'x', wave: 1 }, { prompt: 'y', wave: 1 }], 2, 'into').length === 2
    && shape(s13c, 'gc0') === '1:m1 | 2:m2,m4,m5 | 3:m3', shape(s13c, 'gc0'));
  check('into, bloc à 2 vagues : REFUSÉ — une vague ne peut pas tenir une topologie',
    s13c.addTasks('gc0', [{ prompt: 'p', wave: 1 }, { prompt: 'q', wave: 2 }], 3, 'into').length === 0
    && shape(s13c, 'gc0') === '1:m1 | 2:m2,m4,m5 | 3:m3', shape(s13c, 'gc0'));
  // 'before' : le bloc arrive INTACT devant la vague visée, qui est repoussée
  // avec ses suivantes. C'est le cas qui produisait le mélange.
  check('before : les 2 vagues du bloc s\'insèrent en 3 et 4, l\'ancienne vague 3 devient 5',
    s13c.addTasks('gc0', [{ prompt: 'p', wave: 1 }, { prompt: 'q', wave: 2 }], 3, 'before').length === 2
    && shape(s13c, 'gc0') === '1:m1 | 2:m2,m4,m5 | 3:m6 | 4:m7 | 5:m3', shape(s13c, 'gc0'));
  // Se glisser DEVANT la vague en cours ouvrirait d'un coup tout ce qu'on
  // insère (extension.js openMembersInLaunchedWaves) : c'est justement
  // l'ordonnancement que le bloc demandait d'éviter.
  const st13d = fakeStorage();
  let s13dSeq = 0;
  const s13d = createGroupStore({ load: st13d.load, save: st13d.save, now: () => 5000, newId: () => 'gd' + (s13dSeq++) });
  s13d.create('Devant', [{ prompt: 'a', wave: 1 }, { prompt: 'b', wave: 2 }]);
  check('before sur la vague EN COURS : refusé', s13d.addTasks('gd0', [{ prompt: 'z', wave: 1 }], 1, 'before').length === 0
    && shape(s13d, 'gd0') === '1:m1 | 2:m2', shape(s13d, 'gd0'));
  check('into sur la vague EN COURS : toujours accepté (elle est ouverte, le membre part aussitôt)',
    s13d.addTasks('gd0', [{ prompt: 'z', wave: 1 }], 1, 'into').length === 1
    && shape(s13d, 'gd0') === '1:m1,m3 | 2:m2', shape(s13d, 'gd0'));
  check('before sur une vague EN FILE : accepté', s13d.addTasks('gd0', [{ prompt: 'w', wave: 1 }], 2, 'before').length === 1
    && shape(s13d, 'gd0') === '1:m1,m3 | 2:m4 | 3:m2', shape(s13d, 'gd0'));
  check('liste vide ou prompts blancs : rien, et aucune clé rendue',
    s13c.addTasks('gc0', [], 1).length === 0 && s13c.addTasks('gc0', [{ prompt: '  ' }], 2).length === 0);
  check('groupe inconnu : sans effet', s13c.addTasks('nope', [{ prompt: 'x' }], 1).length === 0);

  console.log('\n13. rearm : réarmer un lien MORT-NÉ (plan lien-mort-né 2026-08-04)');
  const st14 = fakeStorage();
  let nowAt = 5000;
  const s14 = createGroupStore({ load: st14.load, save: st14.save, now: () => nowAt, newId: () => 'gr' });
  s14.create('Relance', [{ prompt: 'a', wave: 1 }, { prompt: 'b', wave: 2 }]);
  s14.attach('gr', 'm1', 'mort-ne');
  check('réarmement accepté sur un membre lancé', s14.rearm('gr', 'm1', 9000) === true);
  const m1 = s14.get('gr').members[0];
  check('… le sessionId mort est effacé', m1.sessionId === null, JSON.stringify(m1));
  check('… launchedAt repoussé (repère temporel neuf pour l\'étage 2)', m1.launchedAt === 9000, String(m1.launchedAt));
  check('… le ticket redevient « en attente » pour l\'étage 2',
    s14.pending().map((p) => p.key).join() === 'm1', JSON.stringify(s14.pending()));
  check('… persisté', st14.raw()[0].members[0].sessionId === null && st14.raw()[0].members[0].launchedAt === 9000);
  check('… le sessionId mort est libéré (plus revendiqué par personne)', s14.groupIdOf('mort-ne') === null);
  check('membre JAMAIS lancé (queued) : rien à réarmer', s14.rearm('gr', 'm2', 9000) === false);
  check('… et il n\'est pas devenu lancé pour autant', s14.get('gr').members[1].launchedAt === null);
  check('membre inconnu / groupe inconnu : sans effet',
    s14.rearm('gr', 'nope', 9000) === false && s14.rearm('nope', 'm1', 9000) === false);
  nowAt = 12345;
  check('`at` absent → horloge du store', s14.rearm('gr', 'm1') === true && s14.get('gr').members[0].launchedAt === 12345);

  console.log('\n14. waveMode : l\'interrupteur manuel/auto vit PAR LOT (2026-08-26)');
  const st15 = fakeStorage();
  const s15 = createGroupStore({ load: st15.load, save: st15.save, now: () => 1000, newId: () => 'gm' });
  const gm = s15.create('Modes', [{ prompt: 'a', wave: 1 }, { prompt: 'b', wave: 2 }]);
  check('lot neuf → AUTO (décision user : le comportement historique reste le défaut)',
    gm.waveMode === 'auto', String(gm.waveMode));
  check('bascule en manuel acceptée', s15.setWaveMode('gm', 'manual') === true);
  check('… lue sur le groupe', s15.get('gm').waveMode === 'manual');
  check('… PERSISTÉE avec le groupe (elle doit survivre au reload)',
    st15.raw()[0].waveMode === 'manual', JSON.stringify(st15.raw()[0].waveMode));
  check('re-poser le même mode ne change rien (pas de push d\'etat pour rien)',
    s15.setWaveMode('gm', 'manual') === false);
  check('retour en auto', s15.setWaveMode('gm', 'auto') === true && s15.get('gm').waveMode === 'auto');
  check('groupe inconnu : sans effet', s15.setWaveMode('nope', 'manual') === false);
  // Un mode illisible ne doit JAMAIS figer un lot en attente d'un clic : tout
  // ce qui n'est pas exactement 'manual' retombe sur 'auto'.
  check('valeur inconnue → auto', s15.setWaveMode('gm', 'sometimes') === false && s15.get('gm').waveMode === 'auto');
  const s15b = createGroupStore({ load: () => [{ id: 'old', name: 'Legacy', members: [{ key: 'm1', prompt: 'x' }] }], save: () => {} });
  check('stockage écrit AVANT ce lot (aucun waveMode) → auto, zéro migration',
    s15b.get('old').waveMode === 'auto', String(s15b.get('old').waveMode));
  check('sanitizeGroup : waveMode illisible → auto',
    sanitizeGroup({ id: 'z', waveMode: 42, members: [] }).waveMode === 'auto');
  check('sanitizeGroup : « manual » traverse tel quel',
    sanitizeGroup({ id: 'z', waveMode: 'manual', members: [] }).waveMode === 'manual');

  console.log('\n15. setMemberWave : une DESTINATION, pas un cran (menu « vague n ▾ », 2026-08-26)');
  // §10 couvre les CRANS (◂/▸) : un membre seul fusionne, un membre accompagné
  // se détache. Cette sémantique-là ne sait pas exprimer « va en vague 4 » — le
  // même clic ne fait pas la même chose selon qui partage la vague de départ.
  // C'est une opération DIFFÉRENTE, donc une porte différente, et ce qu'elle
  // doit garantir est ce que le menu promet à l'œil : la tâche se retrouve avec
  // les membres de la vague DÉSIGNÉE, et la numérotation reste contiguë.
  const st16 = fakeStorage();
  let s16Seq = 0;
  const s16 = createGroupStore({ load: st16.load, save: st16.save, now: () => 1000, newId: () => 'gd' + (s16Seq++) });
  s16.create('D', [
    { prompt: 'a', wave: 1 }, { prompt: 'b', wave: 1 },
    { prompt: 'c', wave: 2 }, { prompt: 'd', wave: 3 }, { prompt: 'e', wave: 4 },
  ]);
  check('départ : vague 1 lancée, trois vagues en file d\'un membre chacune',
    shape(s16, 'gd0') === '1:m1,m2 | 2:m3 | 3:m4 | 4:m5', shape(s16, 'gd0'));

  // Le geste que les flèches ne savent pas faire : deux vagues franchies d'un
  // coup. Au passage la vague de départ se vide, disparaît, et tout se
  // resserre — le numéro demandé (4) désigne le GROUPE DE MEMBRES, pas le
  // libellé qu'il portera après compactage (3).
  check('destination absolue : m3 saute en vague 4, sa vague vidée disparaît sans trou',
    s16.setMemberWave('gd0', 'm3', 4) && shape(s16, 'gd0') === '1:m1,m2 | 2:m4 | 3:m3,m5', shape(s16, 'gd0'));
  check('… et m3 est bien avec m5, la tâche qui occupait la vague visée',
    s16.get('gd0').members.find((m) => m.key === 'm3').wave === s16.get('gd0').members.find((m) => m.key === 'm5').wave);

  // « Nouvelle vague à la fin » : m4 est seul en vague 2, mais ce n'est pas la
  // dernière — il part au bout, comme le ferait « + nouvelle » du formulaire.
  check('wave null : nouvelle vague à la fin',
    s16.setMemberWave('gd0', 'm4', null) && shape(s16, 'gd0') === '1:m1,m2 | 2:m3,m5 | 3:m4', shape(s16, 'gd0'));
  // … et là, il est seul en dernière position : le refaire ne déplacerait
  // rien, seulement renuméroter. Même refus que le ▸ de moveQueuedMember.
  check('wave null sur un membre déjà seul en dernière vague : REFUSÉ (rien ne changerait)',
    s16.setMemberWave('gd0', 'm4', null) === false);
  check('la vague COURANTE d\'un membre : REFUSÉE (le menu la marque « ici », non cliquable)',
    s16.setMemberWave('gd0', 'm4', 3) === false);

  // Les seuils, les mêmes qu'addTasks et moveQueuedMember — le menu ne doit
  // jamais offrir une porte que le store refuserait en silence, ni en refuser
  // une que le store accepterait.
  //
  // La vague EN COURS est une DESTINATION depuis 2026-08-28 (demande user :
  // « lot 11, j'aimerais pouvoir le mettre en vague 2 qui vient de commencer,
  // ce n'est pas proposé »). Le store la prend ; c'est extension.js
  // (openMembersInLaunchedWaves) qui ouvre le membre juste après, une vague
  // déjà partie n'ayant personne d'autre pour venir le chercher.
  check('vague EN COURS : ACCEPTÉE (le membre part aussitôt, côté extension)',
    s16.setMemberWave('gd0', 'm4', 1) === true && shape(s16, 'gd0') === '1:m1,m2,m4 | 2:m3,m5', shape(s16, 'gd0'));
  check('… et il reste queued DANS le store (aucun lancement ici)',
    s16.get('gd0').members.find((m) => m.key === 'm4').launchedAt === null);
  // Remis en file pour la suite des refus (et pour retrouver trois vagues).
  check('retour en nouvelle vague à la fin', s16.setMemberWave('gd0', 'm4', null) === true);
  check('vague inexistante (> max) : REFUSÉE (jamais de trou depuis un état périmé)',
    s16.setMemberWave('gd0', 'm4', 9) === false);
  check('numéro non entier ou négatif : REFUSÉ',
    s16.setMemberWave('gd0', 'm4', 2.5) === false && s16.setMemberWave('gd0', 'm4', -1) === false);
  check('membre déjà lancé : REFUSÉ (m1 est parti avec la vague 1)',
    s16.setMemberWave('gd0', 'm1', 2) === false);
  check('groupe ou clé inconnus : sans effet',
    s16.setMemberWave('nope', 'm4', 2) === false && s16.setMemberWave('gd0', 'zz', 2) === false);
  check('aucun refus n\'a bougé la répartition',
    shape(s16, 'gd0') === '1:m1,m2 | 2:m3,m5 | 3:m4', shape(s16, 'gd0'));
  check('un déplacement accepté est PERSISTÉ (il doit survivre au reload)',
    st16.raw()[0].members.find((m) => m.key === 'm4').wave === 3,
    JSON.stringify(st16.raw()[0].members.map((m) => m.key + ':' + m.wave)));

  // L'invariant que tout le reste du panneau lit : jamais de trou, jamais un
  // libellé « ▶ vague 4 » sur une file qui n'en compte que trois.
  const nums16 = [...new Set(s16.get('gd0').members.map((m) => m.wave))].sort((a, b) => a - b);
  check('numérotation contiguë depuis 1 après tous ces déplacements',
    nums16.join() === '1,2,3', nums16.join());

  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

run();
