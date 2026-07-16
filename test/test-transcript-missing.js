// Banc du lot 12 : une entrée hooks dont le `transcript` pointe vers un fichier
// inexistant n'est jamais rendue (incident 2026-07-16, ligne fantôme
// « Conversation »), et les débris trop vieux sont purgés de
// sessions-state.json. os.homedir monkeypatché → aucun fichier réel de
// l'utilisateur n'est lu ni écrit.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-transcript-missing-'));
os.homedir = () => SANDBOX;                       // AVANT le require de state.js
fs.mkdirSync(path.join(SANDBOX, '.claude'), { recursive: true });

const state = require(path.join(__dirname, '..', 'state.js'));
const { readState } = require(path.join(__dirname, '..', 'hooks', 'sessions-state.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

const WS = 'C:\\Users\\Test\\Projets VSCODE\\Ghost';
const projectDir = state.projectDirFor(WS);
fs.mkdirSync(projectDir, { recursive: true });
const STATE_PATH = path.join(SANDBOX, '.claude', 'sessions-state.json');

function writeSessionsState(sessions) {
  fs.writeFileSync(STATE_PATH, JSON.stringify({ version: 1, sessions }));
}

function snapshot() {
  return state.buildSnapshot({
    workspacePath: WS, recentMs: 4 * 3600 * 1000, maxItems: 12, tabs: undefined,
  }, state.createTranscriptReader());
}

console.log('\n1. Transcript inexistant → aucune ligne rendue (incident rejoué)');
{
  const ghostPath = path.join(projectDir, 'ghost.jsonl'); // jamais créé
  writeSessionsState({
    ghost: { state: 'waiting', since: Date.now(), updated_at: Date.now(), transcript: ghostPath, message: 'Quelle option ?' },
  });
  const titles = snapshot().conversations.map((c) => c.title);
  check('aucune ligne « Conversation » fantôme', titles.length === 0, JSON.stringify(titles));
}

console.log('\n2. Transcript créé après coup → la ligne apparaît');
{
  const p = path.join(projectDir, 'ghost.jsonl');
  const assistant = { type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000 } } };
  const userMsg = (t) => ({ type: 'user', message: { content: [{ type: 'text', text: t }] } });
  fs.writeFileSync(p, [userMsg('peu importe'), assistant, { type: 'ai-title', aiTitle: 'Conv réapparue' }]
    .map((l) => JSON.stringify(l)).join('\n') + '\n');
  const titles = snapshot().conversations.map((c) => c.title);
  check('la conv apparaît dès que son transcript existe', titles.includes('Conv réapparue'), JSON.stringify(titles));
  fs.unlinkSync(p);
}

console.log('\n3. Conv naissante (< délai de purge) → pas purgée, juste masquée');
{
  const ghostPath = path.join(projectDir, 'newborn.jsonl'); // jamais créé
  writeSessionsState({
    newborn: { state: 'busy', since: Date.now(), updated_at: Date.now(), transcript: ghostPath },
  });
  const titles = snapshot().conversations.map((c) => c.title);
  check('pas de ligne pour la conv naissante', titles.length === 0, JSON.stringify(titles));
  const after = readState();
  check('conv naissante toujours dans sessions-state.json (pas un débris)',
    !!after.sessions.newborn, JSON.stringify(after.sessions));
}

console.log('\n4. Débris (> 5 min sans transcript) → purgé du fichier d\'état');
{
  const ghostPath = path.join(projectDir, 'debris.jsonl'); // jamais créé
  const oldTs = Date.now() - 6 * 60 * 1000;
  writeSessionsState({
    debris: { state: 'busy', since: oldTs, updated_at: oldTs, transcript: ghostPath },
  });
  const titles = snapshot().conversations.map((c) => c.title);
  check('le débris n\'est pas rendu', titles.length === 0, JSON.stringify(titles));
  const after = readState();
  check('le débris est retiré de sessions-state.json', !after.sessions.debris, JSON.stringify(after.sessions));
}

console.log('\n5. Autres convs du workspace non affectées par la purge');
{
  const p = path.join(projectDir, 'sane.jsonl');
  const assistant = { type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000 } } };
  const userMsg = (t) => ({ type: 'user', message: { content: [{ type: 'text', text: t }] } });
  fs.writeFileSync(p, [userMsg('peu importe'), assistant, { type: 'ai-title', aiTitle: 'Conv saine' }]
    .map((l) => JSON.stringify(l)).join('\n') + '\n');
  const ghostPath = path.join(projectDir, 'debris2.jsonl');
  const oldTs = Date.now() - 6 * 60 * 1000;
  writeSessionsState({
    debris2: { state: 'busy', since: oldTs, updated_at: oldTs, transcript: ghostPath },
  });
  const titles = snapshot().conversations.map((c) => c.title);
  check('la conv saine reste affichée', titles.includes('Conv saine'), JSON.stringify(titles));
  const after = readState();
  check('le débris est purgé sans toucher au reste', !after.sessions.debris2, JSON.stringify(after.sessions));
}

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
