// Banc : moteur de vagues (lot 4 du plan PLAN_creation_groupes_2026-07-22.md).
//
// Node PUR (waves.js) : pas de vscode, pas de sessionId — juste des membres
// `{ wave, status }` où `status` est déjà résolu par l'appelant. Ce qui peut
// silencieusement mal tourner, et que ce banc verrouille :
//   1. le déverrouillage n'est jamais partiel — une vague à moitié `done` ne
//      compte pas comme terminée ;
//   2. `stale`/disparu bloque l'AUTO sans jamais bloquer le FORCE (▶ manuel) ;
//   3. jamais plus d'une vague d'avance, y compris quand plusieurs vagues
//      suivantes sont déjà entièrement `done` (ne devrait pas arriver en
//      usage réel — les vagues futures sont `queued` — mais un bug amont ne
//      doit pas se traduire par un saut de plusieurs vagues) ;
//   4. les deux cas dégénérés du plan : une vague unique (parallèle pur) et
//      n vagues d'une tâche (séquentiel pur).
const path = require('path');

const EXT = path.join(__dirname, '..');
const {
  waveNumbers, tasksInWave, waveStatus, launchedWave, nextWave,
  waveToAutoLaunch, canForceLaunch,
} = require(path.join(EXT, 'waves.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

function m(wave, status) { return { wave, status }; }

function run() {
  console.log('\n1. waveNumbers / tasksInWave');
  const members = [m(1, 'done'), m(1, 'done'), m(2, 'launched'), m(3, 'queued')];
  check('numéros de vague, triés, sans doublon', waveNumbers(members).join() === '1,2,3');
  check('tasksInWave isole la bonne vague', tasksInWave(members, 2).length === 1);
  check('vague absente → tableau vide', tasksInWave(members, 9).length === 0);

  console.log('\n2. waveStatus : done / blocked / pending / empty');
  check('toutes done → done', waveStatus(members, 1) === 'done');
  check('un seul launched, pas done → pending', waveStatus(members, 2) === 'pending');
  check('vague sans tâche → empty', waveStatus(members, 9) === 'empty');
  const withStale = [m(1, 'done'), m(1, 'stale')];
  check('une tâche stale → blocked (même si l\'autre est done)', waveStatus(withStale, 1) === 'blocked');
  check('stale prime sur pending', waveStatus([m(1, 'launched'), m(1, 'stale')], 1) === 'blocked');

  console.log('\n3. launchedWave : la plus avancée déjà ouverte');
  check('aucun membre lancé → 0', launchedWave([m(1, 'queued'), m(2, 'queued')]) === 0);
  check('max des vagues non-queued', launchedWave(members) === 2, String(launchedWave(members)));
  check('done compte comme lancée', launchedWave([m(1, 'done')]) === 1);
  check('stale compte comme lancée (elle a bien été ouverte)', launchedWave([m(1, 'stale')]) === 1);

  console.log('\n4. nextWave : contiguë, ou null en bout de file');
  check('vague suivante existante', nextWave(members, 1) === 2);
  check('saute une vague vide s\'il le faut (défensif)', nextWave([m(1, 'done'), m(3, 'queued')], 1) === 3);
  check('rien après la dernière → null', nextWave(members, 3) === null);

  console.log('\n5. waveToAutoLaunch : la règle qui protège l\'auto (toujours actif, pas de toggle)');
  const readyWave1 = [m(1, 'done'), m(1, 'done'), m(2, 'queued')];
  check('vague courante done → ouvre la suivante', waveToAutoLaunch(readyWave1) === 2);
  const notReady = [m(1, 'done'), m(1, 'launched'), m(2, 'queued')];
  check('vague courante PAS entièrement done → rien (pas de partiel)', waveToAutoLaunch(notReady) === null);
  const blockedWave = [m(1, 'done'), m(1, 'stale'), m(2, 'queued')];
  check('vague courante bloquée (stale) → suspendu, jamais d\'ouverture', waveToAutoLaunch(blockedWave) === null);
  const noMore = [m(1, 'done'), m(1, 'done')];
  check('plus aucune vague suivante → null (pas juste "rien à faire")', waveToAutoLaunch(noMore) === null);
  // launchedWave est calculé À PARTIR des statuts (waves.js launchedWave) :
  // une tâche `done` compte forcément comme déjà lancée, donc il n'existe
  // aucune combinaison de statuts qui représenterait « la vague 3 est prête
  // alors que la 2 ne l'est pas encore » — la garde structurelle est que
  // nextWave() ne rend JAMAIS que le plus petit numéro strictement après
  // launchedWave (vérifié section 4 : « saute une vague vide »).
  const twoDone = [m(1, 'done'), m(2, 'done'), m(3, 'queued')];
  check('vagues 1 et 2 déjà lancées+done → auto avance à la 3, une seule à la fois',
    waveToAutoLaunch(twoDone) === 3, String(waveToAutoLaunch(twoDone)));

  console.log('\n6. canForceLaunch : le bouton ▶, toujours actionnable s\'il reste une vague');
  check('vague courante pending → ▶ reste possible (forcer un partiel)', canForceLaunch(notReady) === 2);
  check('vague courante bloquée (stale) → ▶ reste la seule porte de sortie', canForceLaunch(blockedWave) === 2);
  check('vague courante done → ▶ propose aussi la suivante (forcer avant l\'auto)', canForceLaunch(readyWave1) === 2);
  check('plus aucune vague → ▶ n\'a rien à proposer', canForceLaunch(noMore) === null);

  console.log('\n7. Cas dégénérés (décision 5 du plan)');
  const pureParallel = [m(1, 'done'), m(1, 'done'), m(1, 'launched')];
  check('1 vague = parallèle pur : jamais de vague suivante', canForceLaunch(pureParallel) === null);
  check('… et l\'auto n\'a jamais rien à ouvrir non plus', waveToAutoLaunch(pureParallel) === null);
  const pureSequential = [m(1, 'done'), m(2, 'queued'), m(3, 'queued'), m(4, 'queued')];
  check('n vagues de 1 = séquentiel pur : avance d\'exactement une vague',
    waveToAutoLaunch(pureSequential) === 2);
  const afterStep2 = [m(1, 'done'), m(2, 'done'), m(3, 'queued'), m(4, 'queued')];
  check('… puis d\'une seule autre à l\'étape suivante, jamais deux d\'un coup',
    waveToAutoLaunch(afterStep2) === 3);

  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

run();
