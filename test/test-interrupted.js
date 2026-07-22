// Banc : interruption manuelle (bouton Stop / Échap) = fin du `busy`, détectée
// par le transcript. Le hook Stop ne tire PAS sur interruption (by design,
// anthropics/claude-code#45289), donc l'entrée reste `busy` et le spinner
// tournait jusqu'à STALE_MS (5 min). Le transcript, lui, porte un message user
// « [Request interrupted by user…] ».
const fs = require('fs');
const os = require('os');
const path = require('path');

const { wasInterrupted } = require(path.join(__dirname, '..', 'hooks', 'transcript.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-interrupted-'));
const write = (name, lines) => {
  const p = path.join(SANDBOX, name);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
};
const userMsg = (t) => ({ type: 'user', message: { content: [{ type: 'text', text: t }] } });
const assistant = (t) => ({ type: 'assistant', message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: t || 'ok' }] } });
const assistantTool = (name, id) => ({ type: 'assistant', message: { model: 'claude-opus-4-8', content: [{ type: 'tool_use', name, id }] } });
const INTERRUPT_TEXT = '[Request interrupted by user]';
const INTERRUPT_TOOL_TEXT = '[Request interrupted by user for tool use]';

console.log('\n1. Dernier message = interruption user simple → interrompu');
{
  const p = write('int-simple.jsonl', [userMsg('fais un truc'), assistant('je commence…'), userMsg(INTERRUPT_TEXT)]);
  check('« [Request interrupted by user] » détecté', wasInterrupted(p) === true);
}

console.log('\n2. Interruption pendant un tool_use (forme réelle observée) → interrompu');
{
  // Réplique exacte du transcript réel : tool_result annulé, puis le texte
  // d'interruption, puis une queue-operation non conversationnelle.
  const p = write('int-tool.jsonl', [
    userMsg('go'),
    assistantTool('Bash', 'toolu_1'),
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }] } },
    { type: 'user', message: { content: [{ type: 'text', text: INTERRUPT_TOOL_TEXT }] } },
    { type: 'queue-operation' },
  ]);
  check('« …for tool use] » détecté malgré la queue-operation en dernier', wasInterrupted(p) === true);
}

console.log('\n3. Un assistant a repris APRÈS l\'interruption → plus interrompu');
{
  const p = write('int-resumed.jsonl', [userMsg('go'), userMsg(INTERRUPT_TEXT), assistant('je reprends')]);
  check('assistant postérieur = travail repris → false', wasInterrupted(p) === false);
}

console.log('\n4. Nouveau prompt user réel après l\'interruption → plus interrompu (Claude va répondre)');
{
  const p = write('int-newprompt.jsonl', [userMsg('go'), userMsg(INTERRUPT_TEXT), userMsg('en fait fais plutôt ceci')]);
  check('dernier message user = vrai prompt, pas l\'interruption → false', wasInterrupted(p) === false);
}

console.log('\n5. Conversation normale (aucune interruption) → false');
{
  const p = write('normal.jsonl', [userMsg('go'), assistant('réponse'), userMsg('merci')]);
  check('pas d\'interruption → false', wasInterrupted(p) === false);
}

console.log('\n6. Texte utilisateur qui PARLE d\'interruption sans en être une → false');
{
  const p = write('mentions.jsonl', [userMsg('go'), assistant('ok'), userMsg('comment gérer une interruption clavier ?')]);
  check('mention du mot au milieu d\'un prompt ≠ marqueur en tête → false', wasInterrupted(p) === false);
}

console.log('\n7. Intégration state.js : busy + interruption → snapshot dit interrupted (fin du spinner)');
{
  const SANDBOX2 = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-int-state-'));
  const realHomedir = os.homedir;
  os.homedir = () => SANDBOX2;
  fs.mkdirSync(path.join(SANDBOX2, '.claude'), { recursive: true });
  delete require.cache[require.resolve(path.join(__dirname, '..', 'state.js'))];
  const state = require(path.join(__dirname, '..', 'state.js'));

  const WS = 'C:\\Users\\Test\\Projets VSCODE\\IntDemo';
  const projectDir = state.projectDirFor(WS);
  fs.mkdirSync(projectDir, { recursive: true });
  const sessionId = 'sess-int';
  const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, [
    userMsg('lance un gros truc'),
    assistantTool('Bash', 'toolu_x'),
    { type: 'user', message: { content: [{ type: 'text', text: INTERRUPT_TOOL_TEXT }] } },
    { type: 'ai-title', aiTitle: 'Conv interrompue au clavier' },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');

  fs.writeFileSync(path.join(SANDBOX2, '.claude', 'sessions-state.json'), JSON.stringify({
    version: 1,
    sessions: { [sessionId]: { state: 'busy', since: Date.now(), updated_at: Date.now(), transcript: transcriptPath } },
  }));

  const snap = state.buildSnapshot({ workspacePath: WS, recentMs: 4 * 3600 * 1000, maxItems: 12 }, state.createTranscriptReader());
  const conv = snap.conversations.find((c) => c.sessionId === sessionId);
  // État PROPRE, pas `idle` : le panneau doit pouvoir distinguer « rien en
  // cours » (✓ pâle) de « coupé en plein travail » (carré stop).
  check('état hooks busy + transcript interrompu → snapshot dit interrupted (plus busy)',
    !!conv && conv.state === 'interrupted', JSON.stringify(conv && conv.state));
  check('interrupted ≠ idle : le rendu ne peut pas les confondre',
    !!conv && conv.state !== 'idle', JSON.stringify(conv && conv.state));

  // L'utilisateur relance : nouveau prompt → le travail reprend → busy.
  fs.appendFileSync(transcriptPath, JSON.stringify(userMsg('reprends et corrige')) + '\n');
  fs.appendFileSync(transcriptPath, JSON.stringify(assistantTool('Bash', 'toolu_y')) + '\n');
  const snap2 = state.buildSnapshot({ workspacePath: WS, recentMs: 4 * 3600 * 1000, maxItems: 12 }, state.createTranscriptReader());
  const conv2 = snap2.conversations.find((c) => c.sessionId === sessionId);
  check('relance après interruption → repasse busy', !!conv2 && conv2.state === 'busy', JSON.stringify(conv2 && conv2.state));

  try { fs.rmSync(SANDBOX2, { recursive: true, force: true }); } catch {}
  os.homedir = realHomedir;
  delete require.cache[require.resolve(path.join(__dirname, '..', 'state.js'))];
}

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
