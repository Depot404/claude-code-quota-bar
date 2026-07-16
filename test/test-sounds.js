// Banc du lot 1 (sons de notification) : débounce anti-rebond `done`, silence
// `busy`, un seul son pour une répétition du même état, et dédoublonnage
// multi-fenêtres via un vrai claim de fichier (2 process, comme
// test/test-relay.js). PowerShell n'est jamais réellement lancé — `play` est
// injecté et enregistre juste ses appels.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-sounds-'));
os.homedir = () => SANDBOX;                       // AVANT le require de sounds.js
fs.mkdirSync(path.join(SANDBOX, '.claude'), { recursive: true });

const { createSoundPlayer, claimSound, CLAIMS_PATH } = require(path.join(__dirname, '..', 'sounds.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. Silence quand désactivé ────────────────────────────────────────────
console.log('\n1. Toggle off → aucun son, même sur une vraie transition');
{
  const played = [];
  const player = createSoundPlayer({ isEnabled: () => false, play: (k) => played.push(k), doneDebounceMs: 10 });
  player.onTransition('s1', 'waiting', 1000);
  player.onTransition('s2', 'done', 1000);
  check('waiting non joué', played.length === 0, JSON.stringify(played));
  player.dispose();
}

// ── 2. `waiting` sonne immédiatement, sans débounce ──────────────────────
console.log('\n2. waiting → son immédiat, une seule fois par transition');
{
  const played = [];
  const player = createSoundPlayer({ isEnabled: () => true, play: (k) => played.push(k), doneDebounceMs: 10 });
  player.onTransition('s1', 'waiting', 2000);
  check('waiting joué tout de suite', played.length === 1 && played[0] === 'waiting', JSON.stringify(played));
  // Re-notification du MÊME état (même `since`) : pas un nouveau son.
  player.onTransition('s1', 'waiting', 2000);
  check('répétition du même état (même since) → pas de 2e son', played.length === 1, JSON.stringify(played));
  player.dispose();
}

// ── 3. `done` débounce, joue après le délai ──────────────────────────────
console.log('\n3. done → armé, joué après le débounce si rien ne l\'annule');
async function doneDelayedTest() {
  const played = [];
  const player = createSoundPlayer({ isEnabled: () => true, play: (k) => played.push(k), doneDebounceMs: 60 });
  player.onTransition('s1', 'done', 3000);
  check('pas encore joué juste après la transition (débounce en cours)', played.length === 0, JSON.stringify(played));
  await sleep(120);
  check('joué une fois le débounce écoulé', played.length === 1 && played[0] === 'done', JSON.stringify(played));
  player.dispose();
}

// ── 4. Anti-faux-`done` : rebond Stop→busy annule le son armé ────────────
console.log('\n4. Rebond Stop→busy (correction transcript-après-Stop) → le son armé est annulé');
async function doneCancelledTest() {
  const played = [];
  const player = createSoundPlayer({ isEnabled: () => true, play: (k) => played.push(k), doneDebounceMs: 60 });
  player.onTransition('s1', 'done', 4000);
  await sleep(20);
  player.onTransition('s1', 'busy', 4050);   // la conv travaille encore : le state engine l'a corrigé
  await sleep(120);
  check('le son "done" armé n\'a JAMAIS joué', played.length === 0, JSON.stringify(played));
  player.dispose();
}

// ── 5. Une conv indépendante n'est pas affectée par l'annulation d'une autre
console.log('\n5. Le débounce est par conversation (sessionId), pas global');
async function perSessionTest() {
  const played = [];
  const player = createSoundPlayer({ isEnabled: () => true, play: (k) => played.push(k), doneDebounceMs: 60 });
  player.onTransition('a', 'done', 5000);
  player.onTransition('b', 'done', 5000);
  player.onTransition('a', 'busy', 5010);   // annule SEULEMENT « a »
  await sleep(120);
  check('« a » annulée, « b » a bien sonné', played.length === 1 && played[0] === 'done', JSON.stringify(played));
  player.dispose();
}

// ── 6. Dispose annule tout timer en attente ───────────────────────────────
console.log('\n6. dispose() coupe les timers armés (pas de son après la destruction du player)');
async function disposeTest() {
  const played = [];
  const player = createSoundPlayer({ isEnabled: () => true, play: (k) => played.push(k), doneDebounceMs: 40 });
  player.onTransition('s1', 'done', 6000);
  player.dispose();
  await sleep(100);
  check('rien joué après dispose', played.length === 0, JSON.stringify(played));
}

// ── 7. Claim de fichier : purge des entrées > 24 h ────────────────────────
console.log('\n7. Un claim vieux de plus de 24 h est purgé (même règle que sessions-state.json)');
{
  const key = 'stale:done:1';
  const claims = { [key]: Date.now() - (25 * 60 * 60 * 1000) };
  fs.writeFileSync(CLAIMS_PATH, JSON.stringify(claims));
  check('claim expiré → reposable (purge avant lecture)', claimSound(key) === true);
}

// ── 8. Dédoublonnage multi-fenêtres : 2 vrais process, 1 seul joue ────────
console.log('\n8. Deux process (deux "fenêtres") posent le MÊME claim → un seul gagne');
function runInstance(key) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'sounds-claim-instance.js'), key], {
      env: { ...process.env, USERPROFILE: SANDBOX, HOME: SANDBOX },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.on('error', reject);
    p.on('close', () => {
      try { resolve(JSON.parse(out.trim())); } catch (e) { reject(e); }
    });
  });
}
async function multiInstanceTest() {
  const key = 'shared-session:done:9999';
  const [r1, r2] = await Promise.all([runInstance(key), runInstance(key)]);
  const claimedCount = [r1, r2].filter((r) => r.claimed).length;
  check('exactement une des deux instances a posé le claim', claimedCount === 1,
    JSON.stringify({ r1, r2 }));
}

(async () => {
  await doneDelayedTest();
  await doneCancelledTest();
  await perSessionTest();
  await disposeTest();
  await multiInstanceTest();
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
