// Banc de hooks/cost-history.js — historisation journalière persistante des
// coûts, base pour une future analyse d'optimisation (aucune vue, décision
// explicite du chantier).
//
// Ce qu'il verrouille, et qui ne se voit nulle part ailleurs :
//   1. le rebalayage complet est un BACKFILL : tout l'historique déjà présent
//      sur disque (plusieurs jours, plusieurs conversations) est reconstruit
//      dès le premier passage, pas seulement « à partir de maintenant » ;
//   2. le dédoublonnage par id de message consécutif tient, comme dans
//      cost.js/turn-cost.js ;
//   3. le fichier n'est réécrit qu'UNE FOIS par jour civil (`updateDailyHistory`
//      ne rescanne pas à chaque appel) ;
//   4. un jour qui change de date (mock d'horloge) redéclenche bien le scan ;
//   5. les totaux hebdo/mensuel sont de purs recalculs à la lecture, jamais
//      stockés, et somment correctement plusieurs jours ;
//   6. rien ne lève jamais, même dossier de transcripts absent.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ch = require('../hooks/cost-history.js');
const { costOfUsage } = require('../cost.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}
function near(a, b) { return Math.abs(a - b) < 1e-9; }

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-costhist-'));
function sandbox(name) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(path.join(dir, '.claude', 'projects'), { recursive: true });
  return dir;
}
function env(dir) {
  return { USERPROFILE: dir, HOME: dir };
}

const MODEL_SONNET = 'claude-sonnet-5';
const MODEL_OPUS = 'claude-opus-5';
function usage(out) { return { input_tokens: 1000, output_tokens: out }; }
function dollars(out, model) { return costOfUsage(usage(out), model || MODEL_SONNET).total; }

function assistantLine(id, out, ts, model) {
  return '{"type":"assistant","timestamp":"' + ts + '","message":' +
    JSON.stringify({ id, model: model || MODEL_SONNET, usage: usage(out) }) + '}';
}

function writeTranscript(dir, wsName, sessionName, lines) {
  const wsDir = path.join(dir, '.claude', 'projects', wsName);
  fs.mkdirSync(wsDir, { recursive: true });
  const file = path.join(wsDir, sessionName + '.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

console.log('\n1. Backfill au premier passage : plusieurs jours, plusieurs conversations');
{
  const dir = sandbox('backfill');
  writeTranscript(dir, 'ws-a', 's1', [
    assistantLine('m1', 10000, '2026-08-18T09:00:00.000Z'),
    assistantLine('m2', 20000, '2026-08-19T09:00:00.000Z'),
  ]);
  writeTranscript(dir, 'ws-b', 's2', [
    assistantLine('m3', 5000, '2026-08-18T15:00:00.000Z', MODEL_OPUS),
  ]);
  const ok = ch.updateDailyHistory(env(dir), Date.parse('2026-08-19T20:00:00.000Z'));
  check('écriture déclenchée au premier passage', ok === true);
  const hist = ch.readHistory(env(dir));
  check('fichier persisté et lisible', hist !== null);
  const d18 = hist.days['2026-08-18'];
  const d19 = hist.days['2026-08-19'];
  check('jour 18 = deux conversations sommées',
    d18 && near(d18.total, dollars(10000) + dollars(5000, MODEL_OPUS)), JSON.stringify(d18));
  check('jour 18 : 2 messages', d18 && d18.messages === 2, String(d18 && d18.messages));
  check('jour 19 = un message', d19 && near(d19.total, dollars(20000)) && d19.messages === 1);
  check('ventilation par modèle correcte',
    d18 && near(d18.byModel['claude-opus-5'], dollars(5000, MODEL_OPUS)), JSON.stringify(d18 && d18.byModel));
  check('updatedAt = jour de l\'appel', hist.updatedAt === '2026-08-19', hist.updatedAt);
}

console.log('\n2. Dédoublonnage : un message sur plusieurs lignes JSONL consécutives');
{
  const dir = sandbox('dedup');
  writeTranscript(dir, 'ws', 's1', [
    assistantLine('m1', 10000, '2026-08-18T09:00:00.000Z'),
    assistantLine('m1', 10000, '2026-08-18T09:00:00.000Z'),
    assistantLine('m1', 10000, '2026-08-18T09:00:00.000Z'),
  ]);
  ch.updateDailyHistory(env(dir), Date.parse('2026-08-18T20:00:00.000Z'));
  const hist = ch.readHistory(env(dir));
  const d = hist.days['2026-08-18'];
  check('trois lignes, un seul montant compté', d && near(d.total, dollars(10000)) && d.messages === 1,
    JSON.stringify(d));
}

console.log('\n3. Gardé : pas de rescan une deuxième fois le même jour');
{
  const dir = sandbox('gate-same-day');
  writeTranscript(dir, 'ws', 's1', [assistantLine('m1', 10000, '2026-08-18T09:00:00.000Z')]);
  const first = ch.updateDailyHistory(env(dir), Date.parse('2026-08-18T10:00:00.000Z'));
  check('premier appel : écrit', first === true);
  // Un message de plus arrive dans le transcript, mais on est TOUJOURS le
  // même jour civil : la fonction ne doit pas le voir avant demain.
  fs.appendFileSync(
    path.join(dir, '.claude', 'projects', 'ws', 's1.jsonl'),
    assistantLine('m2', 20000, '2026-08-18T18:00:00.000Z') + '\n'
  );
  const second = ch.updateDailyHistory(env(dir), Date.parse('2026-08-18T19:00:00.000Z'));
  check('même jour civil : rescan sauté', second === false);
  const hist = ch.readHistory(env(dir));
  check('le message ajouté après coup n\'est pas encore compté',
    near(hist.days['2026-08-18'].total, dollars(10000)), JSON.stringify(hist.days['2026-08-18']));
}

console.log('\n4. Le lendemain : le rescan reprend, et voit tout (backfill inclus)');
{
  const dir = sandbox('gate-next-day');
  writeTranscript(dir, 'ws', 's1', [assistantLine('m1', 10000, '2026-08-18T09:00:00.000Z')]);
  ch.updateDailyHistory(env(dir), Date.parse('2026-08-18T10:00:00.000Z'));
  fs.appendFileSync(
    path.join(dir, '.claude', 'projects', 'ws', 's1.jsonl'),
    assistantLine('m2', 20000, '2026-08-19T09:00:00.000Z') + '\n'
  );
  const next = ch.updateDailyHistory(env(dir), Date.parse('2026-08-19T09:30:00.000Z'));
  check('jour civil différent : rescan redéclenché', next === true);
  const hist = ch.readHistory(env(dir));
  check('nouveau jour présent', hist.days['2026-08-19'] && near(hist.days['2026-08-19'].total, dollars(20000)));
  check('ancien jour toujours là (backfill préservé)',
    hist.days['2026-08-18'] && near(hist.days['2026-08-18'].total, dollars(10000)));
}

console.log('\n5. Totaux hebdo/mensuel : recalculés à la lecture, jamais stockés');
{
  const dir = sandbox('rollups');
  // Semaine ISO du 17 au 23 août 2026 (lundi->dimanche) ; 24 août = semaine suivante.
  writeTranscript(dir, 'ws', 's1', [
    assistantLine('m1', 10000, '2026-08-17T09:00:00.000Z'), // lundi
    assistantLine('m2', 20000, '2026-08-19T09:00:00.000Z'), // mercredi, même semaine
    assistantLine('m3', 30000, '2026-08-24T09:00:00.000Z'), // lundi suivant, même mois
    assistantLine('m4', 40000, '2026-09-02T09:00:00.000Z'), // mois suivant
  ]);
  ch.updateDailyHistory(env(dir), Date.parse('2026-09-02T20:00:00.000Z'));
  const hist = ch.readHistory(env(dir));
  check('champ `days` ne contient aucun total agrégé', !('weekly' in hist) && !('monthly' in hist));

  const weekly = ch.weeklyTotals(hist);
  const w1 = ch.isoWeekKey('2026-08-17');
  const w2 = ch.isoWeekKey('2026-08-24');
  check('deux jours de la même semeine ISO sommés',
    near(weekly[w1].total, dollars(10000) + dollars(20000)), JSON.stringify(weekly));
  check('semaine suivante distincte', near(weekly[w2].total, dollars(30000)));

  const monthly = ch.monthlyTotals(hist);
  check('août = 3 messages sommés (17, 19, 24)',
    near(monthly['2026-08'].total, dollars(10000) + dollars(20000) + dollars(30000)) &&
    monthly['2026-08'].messages === 3, JSON.stringify(monthly));
  check('septembre distinct', near(monthly['2026-09'].total, dollars(40000)));
}

console.log('\n6. Dégradation propre : aucun dossier de transcripts, jamais d\'exception');
{
  const dir = sandbox('empty');
  fs.rmSync(path.join(dir, '.claude', 'projects'), { recursive: true, force: true });
  let threw = false;
  let ok;
  try { ok = ch.updateDailyHistory(env(dir), Date.parse('2026-08-18T10:00:00.000Z')); } catch { threw = true; }
  check('pas d\'exception', !threw);
  check('écriture quand même (fichier vide, days={})', ok === true);
  const hist = ch.readHistory(env(dir));
  check('days = objet vide', hist && hist.days && Object.keys(hist.days).length === 0, JSON.stringify(hist));
}

console.log('\n7. Le hook UserPromptSubmit déclenche bien la mise à jour, en silence');
{
  const { spawn } = require('child_process');
  const dir = sandbox('hook');
  const wsDir = path.join(dir, '.claude', 'projects', 'ws');
  fs.mkdirSync(wsDir, { recursive: true });
  const tr = path.join(wsDir, 'a.jsonl');
  const PROMPT = '{"type":"user","timestamp":"2026-08-18T09:00:00.000Z","message":{"role":"user","content":"go"}}';
  fs.writeFileSync(tr, [PROMPT, assistantLine('m1', 1000, '2026-08-18T09:00:01.000Z'), PROMPT].join('\n') + '\n');

  const HOOK = path.join(__dirname, '..', 'hooks', 'track-active-session.js');
  const p = spawn(process.execPath, [HOOK], {
    env: Object.assign({}, process.env, env(dir), { QUOTABAR_RELAY_DOLLARS: '1' }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  p.stdout.on('data', (c) => { out += c; });
  p.stderr.on('data', (c) => { err += c; });
  p.on('close', (code) => {
    check('exit 0', code === 0, `code=${code} err=${err}`);
    check('stdout inchangé (silencieux, sous le seuil)', out === '', JSON.stringify(out));
    const histFile = path.join(dir, '.claude', ch.HISTORY_FILE);
    check('quotabar-cost-daily.json écrit par le hook', fs.existsSync(histFile));

    console.log(`\n${pass} ok / ${fail} fail`);
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
    process.exit(fail === 0 ? 0 : 1);
  });
  p.stdin.write(JSON.stringify({
    session_id: '11111111-2222-4333-8444-555555555555',
    hook_event_name: 'UserPromptSubmit',
    cwd: 'C:\\Users\\Test\\Projets VSCODE\\Octopus',
    transcript_path: tr,
    prompt: 'continue',
  }));
  p.stdin.end();
}
