// Test bout-en-bout du relais inter-fenêtres : deux PROCESS distincts, comme
// deux fenêtres VS Code. Le process fils possède l'onglet ; le parent joue la
// fenêtre d'origine qui n'a pas trouvé la conv chez elle.
// Aucune fenêtre réelle n'est remontée : le libellé ne matche aucune fenêtre,
// raise-window.ps1 doit répondre « not-found » — ce qui prouve quand même que
// toute la chaîne va jusqu'au bout.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const REQUEST_PATH = path.join(require('os').homedir(), '.claude', 'panel-focus-request.json');
const LABEL_TITLE = 'Relais inter-fenêtres test bout-en-bout';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
};

const events = [];
const child = spawn(process.execPath, [path.join(HERE, 'relay-instance.js')], { stdio: ['ignore', 'pipe', 'pipe'] });
let buf = '';
child.stdout.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    try { events.push(JSON.parse(line)); } catch {}
  }
});
child.stderr.on('data', (c) => console.log('  [stderr]', String(c).trim()));

function write(payload) {
  const tmp = `${REQUEST_PATH}.test.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, REQUEST_PATH);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const since = (n) => events.slice(n);

async function run() {
  await wait(1200);
  const ready = events.find((e) => e.event === 'ready');
  check('instance « autre fenêtre » démarrée', !!ready);
  const childPid = ready && ready.pid;

  console.log('\n1. Requête périmée (ts vieux de 10 s) → ignorée (résidu, pas de vol de focus)');
  let n = events.length;
  write({ title: LABEL_TITLE, session_id: 's1', ts: Date.now() - 10000, origin_pid: 999999 });
  await wait(700);
  check('aucune réaction', since(n).length === 0, JSON.stringify(since(n)));

  console.log('\n2. Requête émise par CETTE instance → ignorée (pas d’auto-réponse)');
  n = events.length;
  write({ title: LABEL_TITLE, session_id: 's2', ts: Date.now(), origin_pid: childPid });
  await wait(700);
  check('aucune réaction', since(n).length === 0, JSON.stringify(since(n)));

  console.log('\n3. Requête fraîche d’une AUTRE fenêtre, onglet présent ici → focus + raise');
  n = events.length;
  write({ title: LABEL_TITLE, session_id: 's3', ts: Date.now(), origin_pid: 999999 });
  await wait(6000);
  const got = since(n);
  const cmds = got.filter((e) => e.event === 'command');
  check('focus du groupe puis openEditorAtIndex(1)',
    cmds.length === 2 && cmds[0].cmd === 'workbench.action.focusFirstEditorGroup'
    && cmds[1].cmd === 'workbench.action.openEditorAtIndex' && cmds[1].arg === 1,
    JSON.stringify(cmds));
  const raise = got.find((e) => e.event === 'log' && /raise:/.test(e.msg));
  check('raise-window.ps1 réellement invoqué et répond', !!raise, JSON.stringify(got));
  if (raise) console.log(`       → PowerShell a répondu : ${raise.msg.replace('[QuotaBar] raise: ', '')}`);

  console.log('\n4. Requête fraîche mais conv INCONNUE de cette instance → pas de réponse');
  n = events.length;
  write({ title: 'Conv qui n’existe nulle part', session_id: 's4', ts: Date.now(), origin_pid: 999999 });
  await wait(900);
  check('aucune réaction', since(n).length === 0, JSON.stringify(since(n)));

  child.kill();
  try { fs.unlinkSync(REQUEST_PATH); } catch {}
  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

run();
