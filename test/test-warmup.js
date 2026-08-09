// Banc de la fenêtre de stabilisation du premier rendu (warmup.js) — pur, sans
// vscode ; horloge et scheduler injectés pour rester déterministe et instantané.
const { createBootSettler } = require('../warmup.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

// Scheduler synchrone : setTimeout(fn, ms) empile fn, on la déclenche en avançant
// l'horloge fictive nous-même — aucun vrai délai, le banc tourne en < 1 ms.
function fakeClock() {
  let t = 0;
  const queue = [];
  return {
    now: () => t,
    setTimeout: (fn, ms) => { queue.push({ at: t + ms, fn }); },
    advance(ms) {
      t += ms;
      // Traiter dans l'ordre, y compris les fn qui en replanifient d'autres.
      while (queue.length && queue[0].at <= t) {
        const job = queue.shift();
        job.fn();
      }
    },
  };
}

console.log('1. Signature stable dès le premier tick → settle après un seul pas');
{
  const clock = fakeClock();
  const settler = createBootSettler({ stepMs: 200, maxMs: 1200, now: clock.now, setTimeout: clock.setTimeout });
  let settledCount = 0;
  settler.run(() => 'a,b,c', null, () => { settledCount++; });
  check('pas encore settled avant le premier tick', !settler.isSettled());
  clock.advance(200);
  check('settled après un pas (signature inchangée)', settler.isSettled() && settledCount === 1);
}

console.log('\n2. Signature qui bouge puis se stabilise → settle une fois stable, pas avant');
{
  const clock = fakeClock();
  const sigs = ['a', 'a,b', 'a,b,c', 'a,b,c', 'a,b,c'];
  let i = 0;
  const signature = () => sigs[Math.min(i, sigs.length - 1)];
  const onTick = () => { i++; };
  let settledCount = 0;
  const settler = createBootSettler({ stepMs: 200, maxMs: 2000, now: clock.now, setTimeout: clock.setTimeout });
  settler.run(signature, onTick, () => { settledCount++; });
  clock.advance(200); // i=1 'a,b' vs prev 'a' → change
  check('toujours pas settled tant que ça bouge (tick 1)', !settler.isSettled());
  clock.advance(200); // i=2 'a,b,c' vs prev 'a,b' → change
  check('toujours pas settled (tick 2)', !settler.isSettled());
  clock.advance(200); // i=3 'a,b,c' vs prev 'a,b,c' → stable
  check('settled dès que deux ticks consécutifs concordent', settler.isSettled() && settledCount === 1);
}

console.log('\n3. Signature qui ne se stabilise jamais → settle au plafond (dégradation silencieuse)');
{
  const clock = fakeClock();
  let n = 0;
  const signature = () => 'v' + (n++); // change à CHAQUE lecture
  let settledCount = 0;
  const settler = createBootSettler({ stepMs: 100, maxMs: 350, now: clock.now, setTimeout: clock.setTimeout });
  settler.run(signature, null, () => { settledCount++; });
  clock.advance(100);
  check('pas settled avant le plafond', !settler.isSettled());
  clock.advance(100);
  check('toujours pas settled', !settler.isSettled());
  clock.advance(200); // dépasse maxMs=350
  check('settled au plafond même si la signature bouge encore', settler.isSettled() && settledCount === 1);
}

console.log('\n4. Une fois settled, run() ré-appelé déclenche onSettled immédiatement (aucun report)');
{
  const clock = fakeClock();
  const settler = createBootSettler({ stepMs: 200, maxMs: 1200, now: clock.now, setTimeout: clock.setTimeout });
  settler.run(() => 'x', null, () => {});
  clock.advance(200);
  check('settled après le premier run', settler.isSettled());
  let calledSync = false;
  settler.run(() => 'y', null, () => { calledSync = true; });
  check('deuxième run() honoré tout de suite, sans nouveau délai', calledSync);
}

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
