// Banc « toute attente affiche ? » : le panneau doit passer `waiting` dès que
// Claude rend la main, quelle que soit la forme de la demande.
//
// Tout tourne dans un HOME bac à sable ; les hooks sont exécutés POUR DE VRAI
// (process node séparé, payload sur stdin), comme Claude Code les lance —
// c'est la seule façon de prouver aussi qu'ils ne polluent jamais stdout, ce
// qui, sur un hook DÉCISIONNEL comme PermissionRequest, accorderait ou
// refuserait une permission à la place de l'utilisateur.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-perm-'));
os.homedir = () => SANDBOX;                       // AVANT les require
fs.mkdirSync(path.join(SANDBOX, '.claude'), { recursive: true });

const state = require(path.join(__dirname, '..', 'state.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOOK = path.join(__dirname, '..', 'hooks', 'hook-session-state.js');
const WS = 'C:\\Users\\Test\\Projets VSCODE\\Perm';
const dir = state.projectDirFor(WS);
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'live.jsonl');
const line = (o) => JSON.stringify(o) + '\n';

fs.writeFileSync(file,
  line({ type: 'user', message: { content: 'go' } })
  + line({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000 } } })
  + line({ type: 'ai-title', aiTitle: 'Demande de permission' }));

// Le hook tourne dans SON process : USERPROFILE lui donne son HOME.
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
    p.stdin.end(JSON.stringify(payload));
  });
}

const base = { session_id: 'live', cwd: WS, transcript_path: file };

(async () => {
  const engine = state.createStateEngine({
    workspacePath: WS,
    tabs: () => ({ known: true, labels: ['Demande de permission'] }),
    tickMs: 3600000, debounceMs: 10,
  });
  const conv = () => engine.getSnapshot().conversations.find((c) => c.sessionId === 'live');
  const refresh = () => engine.refresh();

  // Reprise du travail : une écriture transcript postérieure de > 2 s à
  // l'attente (RESUME_GRACE_MS) — c'est ce que fait Claude quand la permission
  // est accordée.
  async function transcriptResumes(tokens) {
    await sleep(2100);
    fs.appendFileSync(file, line({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: tokens } } }));
    refresh();
  }

  // ── 1. PermissionRequest : le signal immédiat ────────────────────────────
  console.log('\n1. PermissionRequest → « ? » tout de suite (le cas Artifact)');
  {
    const r = await runHook({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Artifact', tool_input: { file_path: 'x.html' } });
    refresh();
    check('exit 0', r.code === 0, `code ${r.code} err=${r.err}`);
    // Non négociable : le moindre octet sur stdout serait interprété comme une
    // décision de permission (allow/deny) par Claude Code.
    check('stdout VIDE (le hook ne décide jamais à la place de l\'user)', r.out === '', JSON.stringify(r.out));
    check('état = waiting', conv() && conv().state === 'waiting', JSON.stringify(conv()));
    check('… et le panneau nomme l\'outil', conv().message === 'Claude needs your permission to use Artifact', JSON.stringify(conv().message));
  }

  console.log('\n2. Permission accordée → le travail reprend');
  {
    await transcriptResumes(1100);
    check('écriture transcript postérieure → busy', conv().state === 'busy', JSON.stringify(conv()));
  }

  // ── 3. Refus / réponse d'élicitation : l'attente se referme ──────────────
  console.log('\n3. PermissionDenied et Elicitation/ElicitationResult');
  {
    await runHook({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} });
    refresh();
    check('2e permission d\'affilée → waiting (since réarmé)', conv().state === 'waiting', JSON.stringify(conv()));

    const r = await runHook({ ...base, hook_event_name: 'PermissionDenied', tool_name: 'Bash', tool_input: {}, tool_use_id: 't1', reason: 'user_refused' });
    refresh();
    check('PermissionDenied → busy sans attendre une écriture transcript', conv().state === 'busy', JSON.stringify(conv()));
    check('… stdout vide là aussi', r.out === '', JSON.stringify(r.out));

    await runHook({ ...base, hook_event_name: 'Elicitation', mcp_server_name: 'gmail', params: {} });
    refresh();
    check('Elicitation MCP → waiting', conv().state === 'waiting', JSON.stringify(conv()));
    check('… message nommant le serveur', conv().message === 'gmail needs your input', JSON.stringify(conv().message));

    await runHook({ ...base, hook_event_name: 'ElicitationResult', mcp_server_name: 'gmail', action: 'accept' });
    refresh();
    check('ElicitationResult → busy', conv().state === 'busy', JSON.stringify(conv()));
  }

  // ── 4. Notification : liste NOIRE + repli sur le message ─────────────────
  console.log('\n4. Notification : tout type inconnu est une attente, sauf les informatifs');
  {
    // Type jamais listé côté extension (elicitation_url_dialog est apparu après
    // l'allowlist d'origine) : doit quand même crier.
    await runHook({ ...base, hook_event_name: 'Notification', notification_type: 'elicitation_url_dialog', message: 'Claude Code needs your input' });
    refresh();
    check('type inconnu (elicitation_url_dialog) → waiting', conv().state === 'waiting', JSON.stringify(conv()));

    await transcriptResumes(1200);
    await runHook({ ...base, hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
    refresh();
    check('idle_prompt → PAS waiting (la conv est déjà rendue)', conv().state === 'busy', JSON.stringify(conv()));

    await runHook({ ...base, hook_event_name: 'Notification', notification_type: 'agent_completed', message: 'Agent finished' });
    refresh();
    check('agent_completed → PAS waiting', conv().state === 'busy', JSON.stringify(conv()));

    // notification_type absent du payload (claude-code#11964) : le message fait foi.
    await runHook({ ...base, hook_event_name: 'Notification', message: 'Claude needs your permission to use Write' });
    refresh();
    check('type ABSENT + message de permission → waiting', conv().state === 'waiting', JSON.stringify(conv()));

    await transcriptResumes(1300);
    await runHook({ ...base, hook_event_name: 'Notification', message: 'Claude is waiting for your input' });
    refresh();
    check('type ABSENT + message d\'idle → PAS waiting', conv().state === 'busy', JSON.stringify(conv()));

    await runHook({ ...base, hook_event_name: 'Notification', message: 'Login successful' });
    refresh();
    check('type ABSENT + message informatif → PAS waiting', conv().state === 'busy', JSON.stringify(conv()));
  }

  // ── 5. Tri des notifications, sans process (règle pure) ──────────────────
  console.log('\n5. Règle de tri isolée');
  {
    const { isWaitingNotification } = require(path.join(__dirname, '..', 'hooks', 'hook-session-state.js'));
    const w = (o) => isWaitingNotification(o);
    check('permission_prompt', w({ notification_type: 'permission_prompt' }) === true);
    check('elicitation_dialog', w({ notification_type: 'elicitation_dialog' }) === true);
    check('worker_permission_prompt', w({ notification_type: 'worker_permission_prompt' }) === true);
    check('agent_needs_input', w({ notification_type: 'agent_needs_input' }) === true);
    check('type inventé demain', w({ notification_type: 'something_brand_new' }) === true);
    check('auth_success', w({ notification_type: 'auth_success' }) === false);
    check('computer_use_exit', w({ notification_type: 'computer_use_exit' }) === false);
    check('push_notification', w({ notification_type: 'push_notification' }) === false);
    check('sans type ni message', w({}) === false);
  }

  engine.dispose();
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
