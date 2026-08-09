// Banc du lot 11, étage 0 : le jeton de session injecté par le hook
// UserPromptSubmit (track-active-session.js).
//
// Ce qu'il verrouille, et qui ne se voit nulle part ailleurs :
//   1. le hook reste STRICTEMENT SILENCIEUX pour tout prompt ordinaire — un
//      output sur stdout est injecté dans le contexte de CHAQUE tour de CHAQUE
//      conversation (cf. sessions-state.js) ; c'est la régression la plus chère
//      que ce lot pouvait introduire ;
//   2. sur `/handoffs`, il émet un unique objet JSON conforme au contrat
//      documenté (hookSpecificOutput.additionalContext), avec le session_id
//      REÇU du CLI — jamais une valeur fabriquée ;
//   3. son effet historique (passage à `busy` dans sessions-state.json) n'a pas
//      bougé.
//
// Le hook tourne POUR DE VRAI (process node, payload sur stdin), dans un HOME
// bac à sable — comme Claude Code le lance.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-token-'));
fs.mkdirSync(path.join(SANDBOX, '.claude'), { recursive: true });

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

const HOOK = path.join(__dirname, '..', 'hooks', 'track-active-session.js');
const SESSION = '11111111-2222-4333-8444-555555555555';

function runHook(payload) {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [HOOK], {
      env: { ...process.env, USERPROFILE: SANDBOX, HOME: SANDBOX },
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

const base = {
  session_id: SESSION,
  hook_event_name: 'UserPromptSubmit',
  cwd: 'C:\\Users\\Test\\Projets VSCODE\\Octopus',
};

async function run() {
  console.log('\n1. Prompt ordinaire : silence absolu sur stdout');
  const plain = await runHook({ ...base, prompt: 'Corrige le bug de la barre de quota' });
  check('exit 0', plain.code === 0, `code=${plain.code} err=${plain.err}`);
  check('stdout VIDE (rien n\'est injecté dans le contexte)', plain.out === '', JSON.stringify(plain.out));

  console.log('\n2. Prompt /handoffs : le jeton est émis');
  const ho = await runHook({ ...base, prompt: '/handoffs' });
  check('exit 0', ho.code === 0, `code=${ho.code} err=${ho.err}`);
  let parsed = null;
  try { parsed = JSON.parse(ho.out); } catch {}
  check('stdout = un unique objet JSON', !!parsed, JSON.stringify(ho.out));
  check('hookEventName conforme au contrat',
    parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.hookEventName === 'UserPromptSubmit',
    JSON.stringify(parsed));
  const ctx = (parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext) || '';
  check('additionalContext porte la ligne claude-convs-session avec le session_id REÇU',
    ctx.indexOf('claude-convs-session: ' + SESSION) !== -1, ctx);
  check('… et dit explicitement de ne pas l\'inventer', /[Nn]ever invent/.test(ctx), ctx);

  console.log('\n3. Variantes de frappe');
  const withArgs = await runHook({ ...base, prompt: '/handoffs pour le chantier en cours' });
  check('/handoffs suivi d\'arguments : jeton émis', withArgs.out.indexOf(SESSION) !== -1, withArgs.out);
  const spaced = await runHook({ ...base, prompt: '  /handoffs\n' });
  check('espaces en tête : jeton émis', spaced.out.indexOf(SESSION) !== -1, spaced.out);
  const lookalike = await runHook({ ...base, prompt: '/handoffsomething' });
  check('commande qui COMMENCE pareil mais n\'est pas /handoffs : silence',
    lookalike.out === '', lookalike.out);
  const mentioned = await runHook({ ...base, prompt: 'explique-moi ce que fait /handoffs' });
  check('/handoffs cité au milieu d\'une phrase : silence', mentioned.out === '', mentioned.out);

  console.log('\n4. L\'effet historique du hook n\'a pas bougé');
  const statePath = path.join(SANDBOX, '.claude', 'sessions-state.json');
  let st = null;
  try { st = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
  check('sessions-state.json écrit', !!(st && st.sessions), JSON.stringify(st));
  check('la session est passée à busy', st && st.sessions[SESSION] && st.sessions[SESSION].state === 'busy',
    JSON.stringify(st && st.sessions));
  check('busy_since posé', st && st.sessions[SESSION] && Number.isFinite(st.sessions[SESSION].busy_since));

  const noId = await runHook({ hook_event_name: 'UserPromptSubmit', prompt: '/handoffs' });
  check('payload sans session_id : rien émis, aucune exception', noId.out === '' && noId.code === 0,
    `code=${noId.code} out=${noId.out} err=${noId.err}`);

  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error('banc en erreur :', e && e.message); process.exit(1); });
