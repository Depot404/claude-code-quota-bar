// Banc du lot 3 « relais quand le prochain tour coûte cher » : la lib
// hooks/turn-cost.js, puis le hook UserPromptSubmit qui la porte, exécuté POUR
// DE VRAI (process node, payload sur stdin, HOME bac à sable).
//
// Ce qu'il verrouille, et qui ne se voit nulle part ailleurs :
//   1. le hook reste STRICTEMENT SILENCIEUX tant que le dernier tour est sous
//      le seuil — un output part dans le contexte de CHAQUE tour de CHAQUE
//      conversation, c'est la régression la plus chère de ce lot ;
//   2. la notice n'est émise QU'UNE FOIS par conversation, marqueur persistant
//      à l'appui (une consigne répétée gaspillerait le contexte qu'elle
//      prétend économiser) ;
//   3. le coût rendu est celui du DERNIER TOUR, dans les DEUX ordres
//      d'écriture possibles (entrée du prompt courant déjà écrite ou non) ;
//   4. lecture incrémentale : offset persisté, aucun double comptage, et un
//      gros transcript repris n'est jamais relu en entier ;
//   5. un transcript absent, illisible ou tronqué ne fait JAMAIS échouer le
//      prompt.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tc = require('../hooks/turn-cost.js');
const { costOfUsage } = require('../cost.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}
function near(a, b) { return Math.abs(a - b) < 1e-9; }

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-turn-'));
function sandbox(name) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}
function env(dir, extra) {
  return Object.assign({ USERPROFILE: dir, HOME: dir, APPDATA: path.join(dir, 'AppData') }, extra || {});
}

// ── Fixtures de transcript ──────────────────────────────────────────────────
// Lignes écrites À LA MAIN : la détection de borne travaille sur des
// SOUS-CHAÎNES (`"type":"user"`, `"toolUseResult"`, `"isMeta":true`) avant tout
// JSON.parse — un JSON.stringify pourrait réordonner les clés et faire passer
// le banc à côté de ce qu'il teste.
const MODEL = 'claude-opus-4-8';
function usage(out) { return { input_tokens: 1000, output_tokens: out }; }
function dollars(out) { return costOfUsage(usage(out), MODEL).total; }

function assistantLine(id, out) {
  return '{"type":"assistant","timestamp":"2026-08-18T10:00:00.000Z","message":' +
    JSON.stringify({ id, model: MODEL, usage: usage(out) }) + '}';
}
const PROMPT = '{"type":"user","timestamp":"2026-08-18T10:00:00.000Z","message":{"role":"user","content":"go"}}';
const TOOL_RESULT = '{"type":"user","toolUseResult":{"stdout":"ok"},"message":{"role":"user","content":[{"type":"tool_result"}]}}';
const META = '{"type":"user","isMeta":true,"message":{"role":"user","content":"[Image #1]"}}';

function writeLines(file, lines) { fs.writeFileSync(file, lines.join('\n') + '\n'); }
function appendLines(file, lines) { fs.appendFileSync(file, lines.join('\n') + '\n'); }

const SESSION = '11111111-2222-4333-8444-555555555555';

console.log('\n1. Découpage en tours : bornes vraies, fausses bornes, dernier tour');
{
  const dir = sandbox('turns');
  const tr = path.join(dir, 'a.jsonl');
  // tour 1 : deux messages assistant séparés par un résultat d'outil et une
  // entrée isMeta — ni l'un ni l'autre ne clôt un tour.
  writeLines(tr, [
    PROMPT,
    assistantLine('m1', 10000),
    TOOL_RESULT,
    assistantLine('m2', 20000),
    META,
    assistantLine('m3', 30000),
    PROMPT,                       // borne : clôt le tour 1
    assistantLine('m4', 40000),   // tour 2, encore ouvert
  ]);
  const st = tc.updateFromTranscript(SESSION, tr, env(dir));
  const turn1 = dollars(10000) + dollars(20000) + dollars(30000);
  check('tour 1 clos au bon montant', near(st.last, turn1), `${st.last} vs ${turn1}`);
  check('un seul tour complet compté', st.turns === 1, String(st.turns));
  check('tour en cours accumulé à part', near(st.open, dollars(40000)), String(st.open));
  check('cumul = tous les messages', near(st.total, turn1 + dollars(40000)), String(st.total));
  check('dernier tour = le tour ouvert (prompt courant pas encore écrit)',
    near(tc.lastTurnDollars(st), dollars(40000)), String(tc.lastTurnDollars(st)));
}

console.log('\n2. Autre ordre d\'écriture : l\'entrée du prompt courant est déjà là');
{
  const dir = sandbox('order');
  const tr = path.join(dir, 'a.jsonl');
  writeLines(tr, [PROMPT, assistantLine('m1', 50000), PROMPT]);
  const st = tc.updateFromTranscript(SESSION, tr, env(dir));
  check('tour ouvert vide', near(st.open, 0), String(st.open));
  check('dernier tour = le tour clos', near(tc.lastTurnDollars(st), dollars(50000)),
    String(tc.lastTurnDollars(st)));
}

console.log('\n3. Aucune borne vue → aucun tour, jamais un chiffre partiel');
{
  const dir = sandbox('noboundary');
  const tr = path.join(dir, 'a.jsonl');
  writeLines(tr, [assistantLine('m1', 90000)]);
  const st = tc.updateFromTranscript(SESSION, tr, env(dir));
  check('rien à annoncer', tc.lastTurnDollars(st) === 0, String(tc.lastTurnDollars(st)));
}

console.log('\n4. Lecture incrémentale : même résultat qu\'une lecture d\'un bloc');
{
  const dirA = sandbox('incr-a');
  const trA = path.join(dirA, 'a.jsonl');
  writeLines(trA, [PROMPT, assistantLine('m1', 10000)]);
  const first = tc.updateFromTranscript(SESSION, trA, env(dirA));
  const offset1 = first.offset;
  appendLines(trA, [assistantLine('m2', 20000), PROMPT, assistantLine('m3', 30000)]);
  const incr = tc.updateFromTranscript(SESSION, trA, env(dirA));

  const dirB = sandbox('incr-b');
  const trB = path.join(dirB, 'a.jsonl');
  writeLines(trB, [PROMPT, assistantLine('m1', 10000), assistantLine('m2', 20000), PROMPT, assistantLine('m3', 30000)]);
  const whole = tc.updateFromTranscript(SESSION, trB, env(dirB));

  check('offset avancé, pas repris de zéro', incr.offset > offset1 && offset1 > 0, `${offset1} → ${incr.offset}`);
  check('cumul identique', near(incr.total, whole.total), `${incr.total} vs ${whole.total}`);
  check('dernier tour identique', near(incr.last, whole.last), `${incr.last} vs ${whole.last}`);
  check('aucun double comptage', near(incr.total, dollars(10000) + dollars(20000) + dollars(30000)), String(incr.total));
  check('état persisté sur disque', fs.existsSync(tc.stateFileFor(SESSION, env(dirA))));
}

console.log('\n5. Un message assistant sur plusieurs lignes n\'est compté qu\'une fois');
{
  const dir = sandbox('dedup');
  const tr = path.join(dir, 'a.jsonl');
  writeLines(tr, [PROMPT, assistantLine('m1', 10000), assistantLine('m1', 10000), assistantLine('m1', 10000), PROMPT]);
  const st = tc.updateFromTranscript(SESSION, tr, env(dir));
  check('trois lignes, un seul montant', near(st.last, dollars(10000)), String(st.last));
}

console.log('\n6. Gros transcript repris : seule la queue est lue, le tour tronqué est écarté');
{
  const dir = sandbox('cold');
  const tr = path.join(dir, 'a.jsonl');
  const pad = '{"type":"progress","pad":"' + 'x'.repeat(4000) + '"}';
  const padding = [];
  for (let i = 0; i < 700; i++) padding.push(pad);   // ~2,8 Mo, > COLD_TAIL
  writeLines(tr, padding.concat([
    assistantLine('old', 900000),   // tour tronqué : ne doit JAMAIS être annoncé
    PROMPT,
    assistantLine('m1', 40000),
    PROMPT,
  ]));
  const size = fs.statSync(tr).size;
  check('fixture bien au-dessus du seuil de queue', size > tc.COLD_TAIL, String(size));
  const st = tc.updateFromTranscript(SESSION, tr, env(dir));
  check('départ à froid : le début du fichier n\'est pas lu', st.offset > tc.COLD_TAIL / 2, String(st.offset));
  check('le tour tronqué n\'est pas annoncé', near(tc.lastTurnDollars(st), dollars(40000)),
    String(tc.lastTurnDollars(st)));
}

console.log('\n6bis. Queue sans aucune borne : silence, jamais un tour partiel');
{
  const dir = sandbox('cold-partial');
  const tr = path.join(dir, 'a.jsonl');
  const pad = '{"type":"progress","pad":"' + 'x'.repeat(4000) + '"}';
  const padding = [];
  for (let i = 0; i < 700; i++) padding.push(pad);
  writeLines(tr, padding.concat([assistantLine('m1', 900000)]));
  const st = tc.updateFromTranscript(SESSION, tr, env(dir));
  check('rien à annoncer', tc.lastTurnDollars(st) === 0, String(tc.lastTurnDollars(st)));
}

console.log('\n7. Fichier rétréci : recompté de zéro, marqueur de notice préservé');
{
  const dir = sandbox('shrink');
  const tr = path.join(dir, 'a.jsonl');
  writeLines(tr, [PROMPT, assistantLine('m1', 10000), assistantLine('m2', 20000), PROMPT]);
  tc.updateFromTranscript(SESSION, tr, env(dir));
  const file = tc.stateFileFor(SESSION, env(dir));
  const st0 = JSON.parse(fs.readFileSync(file, 'utf8'));
  st0.notified = true;
  fs.writeFileSync(file, JSON.stringify(st0));
  writeLines(tr, [PROMPT, assistantLine('m9', 30000), PROMPT]);
  const st = tc.updateFromTranscript(SESSION, tr, env(dir));
  check('recompté sur le nouveau contenu', near(st.total, dollars(30000)), String(st.total));
  check('marqueur de notice conservé', st.notified === true);
}

console.log('\n8. Transcript absent ou illisible : aucun jet, aucune notice');
{
  const dir = sandbox('missing');
  let threw = false;
  let st;
  try { st = tc.updateFromTranscript(SESSION, path.join(dir, 'nope.jsonl'), env(dir)); } catch { threw = true; }
  check('pas d\'exception', !threw);
  check('rien à annoncer', st && tc.lastTurnDollars(st) === 0);
  check('relayNotice → null', tc.relayNotice({ session_id: SESSION, transcript_path: path.join(dir, 'nope.jsonl') }, env(dir)) === null);
  check('relayNotice sans transcript_path → null', tc.relayNotice({ session_id: SESSION }, env(dir)) === null);
}

console.log('\n9. Seuil : réglage du panneau relu dans settings.json, défaut sinon');
{
  const dir = sandbox('threshold');
  const userDir = path.join(dir, 'AppData', 'Code', 'User');
  fs.mkdirSync(userDir, { recursive: true });
  check('défaut quand rien n\'est réglé', tc.readThreshold(env(dir)) === tc.DEFAULT_RELAY_DOLLARS,
    String(tc.readThreshold(env(dir))));
  // settings.json de VS Code : commentaires, virgule traînante, et une URL
  // contenant `//` DANS une chaîne — le piège classique du dé-commentaire naïf.
  fs.writeFileSync(path.join(userDir, 'settings.json'), [
    '{',
    '  // seuil de rythme',
    '  "claudeCodeQuotaBar.relayNoticeDollars": 7.5,',
    '  "some.url": "https://example.com/x", /* bloc */',
    '}',
  ].join('\n'));
  check('seuil lu depuis settings.json', tc.readThreshold(env(dir)) === 7.5, String(tc.readThreshold(env(dir))));
  check('surcharge par variable d\'environnement',
    tc.readThreshold(env(dir, { QUOTABAR_RELAY_DOLLARS: '0.25' })) === 0.25);
  const stripped = tc.stripJsonc('{"a":"http://x//y", // c\n "b":1,}');
  let parsed = null;
  try { parsed = JSON.parse(stripped); } catch {}
  check('`//` dans une chaîne survit au dé-commentaire', parsed && parsed.a === 'http://x//y', stripped);
  check('virgule traînante retirée', parsed && parsed.b === 1, stripped);
  // settings.json cassé : on ne casse rien, on retombe sur le défaut.
  fs.writeFileSync(path.join(userDir, 'settings.json'), '{ ceci n\'est pas du JSON');
  check('settings.json illisible → défaut', tc.readThreshold(env(dir)) === tc.DEFAULT_RELAY_DOLLARS);
}

console.log('\n10. Notice : au seuil, une seule fois par conversation');
{
  const dir = sandbox('notice');
  const tr = path.join(dir, 'a.jsonl');
  const e = env(dir, { QUOTABAR_RELAY_DOLLARS: '1' });
  // Tour bon marché : silence.
  writeLines(tr, [PROMPT, assistantLine('m1', 1000), PROMPT]);
  check('sous le seuil → pas de notice', tc.relayNotice({ session_id: SESSION, transcript_path: tr }, e) === null);
  // Tour cher mais conversation encore JEUNE : silence. Un tour cher sur une
  // conv d'un seul tour ne prouve aucun rythme — c'est le cas que la garde de
  // maturité écarte, et le plus fréquent au premier prompt après un déploiement.
  const young = sandbox('young');
  const trYoung = path.join(young, 'a.jsonl');
  writeLines(trYoung, [PROMPT, assistantLine('m1', 200000), PROMPT]);
  const stYoung = tc.updateFromTranscript(SESSION, trYoung, env(young));
  check('un seul tour vu', stYoung.turns < tc.MIN_TURNS, String(stYoung.turns));
  check('tour cher mais conv jeune → silence',
    tc.relayNotice({ session_id: SESSION, transcript_path: trYoung }, env(young, { QUOTABAR_RELAY_DOLLARS: '1' })) === null);

  // Tour cher, conversation mûre : notice, avec le montant réel.
  appendLines(tr, [assistantLine('m2', 200000), PROMPT]);
  const notice = tc.relayNotice({ session_id: SESSION, transcript_path: tr }, e);
  check('au-dessus du seuil → notice', typeof notice === 'string' && notice.length > 0);
  check('montant réel cité', notice && notice.indexOf(tc.formatDollars(dollars(200000))) !== -1, String(notice));
  check('trois lignes, pas plus', notice && notice.split('\n').length === 3, String(notice && notice.split('\n').length));
  check('elle PROPOSE, elle n\'agit pas', notice && /never act on it unasked/.test(notice));
  // Deuxième tour cher : plus rien, le marqueur a tenu.
  appendLines(tr, [assistantLine('m3', 300000), PROMPT]);
  check('une seule fois par conversation',
    tc.relayNotice({ session_id: SESSION, transcript_path: tr }, e) === null);
  const st = JSON.parse(fs.readFileSync(tc.stateFileFor(SESSION, e), 'utf8'));
  check('marqueur persisté', st.notified === true);

  // Seuil à 0 : la notice est DÉSACTIVÉE, pas « toujours déclenchée ».
  const off = sandbox('off');
  const trOff = path.join(off, 'a.jsonl');
  writeLines(trOff, [PROMPT, assistantLine('m1', 200000), PROMPT, assistantLine('m2', 200000), PROMPT]);
  check('seuil 0 → notice désactivée',
    tc.relayNotice({ session_id: SESSION, transcript_path: trOff }, env(off, { QUOTABAR_RELAY_DOLLARS: '0' })) === null);
}

console.log('\n11. Le hook, POUR DE VRAI (process node, stdin, HOME bac à sable)');

const HOOK = path.join(__dirname, '..', 'hooks', 'track-active-session.js');

function runHook(payload, dir, extra) {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [HOOK], {
      env: Object.assign({}, process.env, env(dir, extra)),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('error', rej);
    p.on('close', (code) => res({ code, out, err }));
    p.stdin.write(JSON.stringify(payload));
    p.stdin.end();
  });
}

async function run() {
  const dir = sandbox('hook');
  const tr = path.join(dir, 'a.jsonl');
  const base = {
    session_id: SESSION,
    hook_event_name: 'UserPromptSubmit',
    cwd: 'C:\\Users\\Test\\Projets VSCODE\\Octopus',
    transcript_path: tr,
  };
  const cheap = { QUOTABAR_RELAY_DOLLARS: '1' };

  // Tour bon marché : le hook doit rester MUET.
  writeLines(tr, [PROMPT, assistantLine('m1', 1000), PROMPT]);
  const quiet = await runHook({ ...base, prompt: 'continue' }, dir, cheap);
  check('exit 0', quiet.code === 0, `code=${quiet.code} err=${quiet.err}`);
  check('stdout VIDE sous le seuil', quiet.out === '', JSON.stringify(quiet.out));
  check('effet historique intact : session busy',
    JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'sessions-state.json'), 'utf8')).sessions[SESSION].state === 'busy');

  // Tour cher : un unique objet JSON, conforme au contrat des hooks.
  appendLines(tr, [assistantLine('m2', 200000), PROMPT]);
  const loud = await runHook({ ...base, prompt: 'continue' }, dir, cheap);
  check('exit 0', loud.code === 0, `code=${loud.code} err=${loud.err}`);
  let payload = null;
  try { payload = JSON.parse(loud.out); } catch {}
  check('un unique objet JSON sur stdout', payload !== null, JSON.stringify(loud.out).slice(0, 200));
  check('contrat hookSpecificOutput respecté',
    payload && payload.hookSpecificOutput && payload.hookSpecificOutput.hookEventName === 'UserPromptSubmit');
  check('la notice est dans additionalContext',
    payload && /Claude Convs: the last turn/.test(payload.hookSpecificOutput.additionalContext));

  // Deuxième tour cher, même conversation : silence retrouvé.
  appendLines(tr, [assistantLine('m3', 300000), PROMPT]);
  const again = await runHook({ ...base, prompt: 'continue' }, dir, cheap);
  check('plus jamais dans cette conversation', again.out === '', JSON.stringify(again.out).slice(0, 200));

  // `/handoffs` + tour cher, dans une AUTRE conversation : les deux messages
  // partent ensemble, dans UN SEUL objet JSON (le contrat n'en admet pas deux).
  const dir2 = sandbox('hook-both');
  const tr2 = path.join(dir2, 'a.jsonl');
  writeLines(tr2, [PROMPT, assistantLine('m1', 200000), PROMPT, assistantLine('m2', 200000), PROMPT]);
  const both = await runHook({ ...base, transcript_path: tr2, prompt: '/handoffs' }, dir2, cheap);
  let p2 = null;
  try { p2 = JSON.parse(both.out); } catch {}
  check('un seul objet JSON malgré deux messages', p2 !== null, JSON.stringify(both.out).slice(0, 200));
  const ctx = p2 ? p2.hookSpecificOutput.additionalContext : '';
  check('jeton de session présent', ctx.indexOf('claude-convs-session: ' + SESSION) !== -1);
  check('notice présente', /Claude Convs: the last turn/.test(ctx));

  // Transcript absent : le prompt ne doit JAMAIS échouer.
  const dir3 = sandbox('hook-missing');
  const gone = await runHook({ ...base, transcript_path: path.join(dir3, 'nope.jsonl'), prompt: 'salut' }, dir3, cheap);
  check('exit 0 sans transcript', gone.code === 0, `code=${gone.code} err=${gone.err}`);
  check('stdout vide sans transcript', gone.out === '', JSON.stringify(gone.out));

  console.log(`\n${pass} ok / ${fail} fail`);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
