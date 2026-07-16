// Banc du lot 11 : question posée (AskUserQuestion/ExitPlanMode) = waiting
// immédiat, détecté par le transcript — AucUN hook ne tire sur ces outils
// (anthropics/claude-code#13830, #13024), le seul signal hooks (Notification
// idle_prompt) arrivant 60 s plus tard, délai fixe non configurable (#13922).
const fs = require('fs');
const os = require('os');
const path = require('path');

const { hasPendingInteractiveTool } = require(path.join(__dirname, '..', 'hooks', 'transcript.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-waiting-tool-'));
const write = (name, lines) => {
  const p = path.join(SANDBOX, name);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
};
const userMsg = (t) => ({ type: 'user', message: { content: [{ type: 'text', text: t }] } });
const assistantTool = (name, id) => ({
  type: 'assistant',
  message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', name, id }] },
});
const toolResult = (id) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } });

console.log('\n1. Transcript fabriqué finissant sur tool_use AskUserQuestion sans result → waiting');
{
  const p = write('ask-pending.jsonl', [userMsg('fais un truc'), assistantTool('AskUserQuestion', 'toolu_1')]);
  check('pending détecté', hasPendingInteractiveTool(p) === true);
}

console.log('\n2. Avec tool_result ensuite → plus waiting');
{
  const p = write('ask-answered.jsonl', [
    userMsg('fais un truc'), assistantTool('AskUserQuestion', 'toolu_2'), toolResult('toolu_2'),
  ]);
  check('pending retombe une fois répondu', hasPendingInteractiveTool(p) === false);
}

console.log('\n3. tool_use Bash sans result → PAS waiting (outil non interactif)');
{
  const p = write('bash-pending.jsonl', [userMsg('lance un test'), assistantTool('Bash', 'toolu_3')]);
  check('Bash en cours ne déclenche jamais waiting', hasPendingInteractiveTool(p) === false);
}

console.log('\n4. ExitPlanMode sans result → waiting (approbation de plan = même attente)');
{
  const p = write('plan-pending.jsonl', [userMsg('planifie'), assistantTool('ExitPlanMode', 'toolu_4')]);
  check('ExitPlanMode pending détecté', hasPendingInteractiveTool(p) === true);
}

console.log('\n5. tool_use interactif PAS en dernier bloc du dernier message → pas de faux positif');
{
  const p = write('not-last-block.jsonl', [{
    type: 'assistant',
    message: {
      model: 'claude-sonnet-5',
      content: [{ type: 'tool_use', name: 'AskUserQuestion', id: 'toolu_5' }, { type: 'text', text: 'et ensuite ceci' }],
    },
  }]);
  check('seul le DERNIER bloc du dernier message assistant compte', hasPendingInteractiveTool(p) === false);
}

console.log('\n6. Aucun message assistant → pas de crash, pas de waiting');
{
  const p = write('no-assistant.jsonl', [userMsg('rien encore')]);
  check('pas de message assistant → false', hasPendingInteractiveTool(p) === false);
}

console.log('\n7. Événement postérieur quelconque (pas juste le tool_result exact) referme l\'attente');
{
  const p = write('later-event.jsonl', [
    userMsg('fais un truc'), assistantTool('AskUserQuestion', 'toolu_7'),
    { type: 'assistant', message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'je continue' }] } },
  ]);
  check('un message assistant postérieur (reprise) referme aussi l\'attente',
    hasPendingInteractiveTool(p) === false);
}

console.log('\n8. Intégration state.js : priorité waiting sur busy, via buildSnapshot');
{
  const SANDBOX2 = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-waiting-state-'));
  const realHomedir = os.homedir;
  os.homedir = () => SANDBOX2;
  fs.mkdirSync(path.join(SANDBOX2, '.claude'), { recursive: true });
  delete require.cache[require.resolve(path.join(__dirname, '..', 'state.js'))];
  const state = require(path.join(__dirname, '..', 'state.js'));

  const WS = 'C:\\Users\\Test\\Projets VSCODE\\WaitingDemo';
  const projectDir = state.projectDirFor(WS);
  fs.mkdirSync(projectDir, { recursive: true });
  const sessionId = 'sess-ask';
  const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, [
    userMsg('pose une question'),
    assistantTool('AskUserQuestion', 'toolu_8'),
    { type: 'ai-title', aiTitle: 'Conv avec question posée' },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');

  fs.writeFileSync(path.join(SANDBOX2, '.claude', 'sessions-state.json'), JSON.stringify({
    version: 1,
    sessions: {
      [sessionId]: { state: 'busy', since: Date.now(), updated_at: Date.now(), transcript: transcriptPath },
    },
  }));

  const snap = state.buildSnapshot({
    workspacePath: WS, recentMs: 4 * 3600 * 1000, maxItems: 12,
  }, state.createTranscriptReader());
  const conv = snap.conversations.find((c) => c.sessionId === sessionId);
  check('état hooks busy + tool_use AskUserQuestion pendant → snapshot dit waiting',
    !!conv && conv.state === 'waiting', JSON.stringify(conv));

  // Le tool_result arrive (l'user a répondu) : retour à l'état normal (busy).
  fs.appendFileSync(transcriptPath, JSON.stringify(toolResult('toolu_8')) + '\n');
  const snap2 = state.buildSnapshot({
    workspacePath: WS, recentMs: 4 * 3600 * 1000, maxItems: 12,
  }, state.createTranscriptReader());
  const conv2 = snap2.conversations.find((c) => c.sessionId === sessionId);
  check('tool_result arrivé → repasse busy (reprise du travail, pas de rebond figé)',
    !!conv2 && conv2.state === 'busy', JSON.stringify(conv2));

  try { fs.rmSync(SANDBOX2, { recursive: true, force: true }); } catch {}
  os.homedir = realHomedir;
  delete require.cache[require.resolve(path.join(__dirname, '..', 'state.js'))];
}

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
