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

// ────────────────────────────────────────────────────────────────────────────
// 8. MATRICE DES CAS DE FIGURE (2026-08-08)
//
// Le §7 ci-dessus ne couvrait QUE le cas où l'entrée hooks dit littéralement
// `busy` — c'était aussi la condition du code, et c'est exactement ce qui a
// laissé passer le bug : un hook Stop à FEEDBACK (exit 2, qui relance Claude)
// pose `done` en plein tour, et l'affichage `busy` n'est plus qu'une déduction
// de state.js (isResuming). Interrompre pendant cette reprise ne corrigeait
// plus rien : spinner éternel, puis faux ✓ + son de fin 5 min après.
//
// Chaque ligne ci-dessous est un état RÉEL du système, monté de bout en bout
// (entrée hooks + transcript daté + mtime) et jugé sur l'état que le panneau
// AFFICHERAIT — jamais sur un booléen intermédiaire.
// ────────────────────────────────────────────────────────────────────────────
const STATE_PATH = require.resolve(path.join(__dirname, '..', 'state.js'));
const at = (ts, o) => ({ ...o, timestamp: new Date(ts).toISOString() });

function stateFor(name, { hook, lines, mtimeMs }) {
  const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-int-matrix-'));
  const realHomedir = os.homedir;
  os.homedir = () => SB;
  fs.mkdirSync(path.join(SB, '.claude'), { recursive: true });
  delete require.cache[STATE_PATH];
  const state = require(STATE_PATH);

  const WS = 'C:\\Users\\Test\\Projets VSCODE\\Matrix';
  const projectDir = state.projectDirFor(WS);
  fs.mkdirSync(projectDir, { recursive: true });
  const sessionId = `sess-${name}`;
  const tp = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(tp, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  // mtime imposé : c'est lui qui décide du vieillissement busy→stale, et aucune
  // écriture de banc ne peut le vieillir autrement.
  if (mtimeMs) fs.utimesSync(tp, new Date(mtimeMs), new Date(mtimeMs));

  const sessions = {};
  if (hook) sessions[sessionId] = { ...hook, transcript: tp };
  fs.writeFileSync(path.join(SB, '.claude', 'sessions-state.json'), JSON.stringify({ version: 1, sessions }));

  const snap = state.buildSnapshot({ workspacePath: WS, recentMs: 4 * 3600 * 1000, maxItems: 12 }, state.createTranscriptReader());
  const conv = snap.conversations.find((c) => c.sessionId === sessionId);

  os.homedir = realHomedir;
  delete require.cache[STATE_PATH];
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch {}
  return conv ? conv.state : null;
}

const NOW = Date.now();
const T = (secondsAgo) => NOW - secondsAgo * 1000;
const INT = (ts, text) => at(ts, { type: 'user', message: { content: [{ type: 'text', text: text || INTERRUPT_TEXT }] } });
const ASK = (ts, id) => at(ts, { type: 'assistant', message: { model: 'claude-opus-4-8', content: [{ type: 'tool_use', name: 'AskUserQuestion', id }] } });

console.log('\n8. Interruption pendant une reprise après Stop à feedback (LE bug du 2026-08-08)');
{
  // Chronologie exacte du transcript témoin : Stop hook feedback à -420 s
  // (l'entrée passe `done`), Claude repart, l'utilisateur coupe à -60 s.
  const got = stateFor('stop-feedback', {
    hook: { state: 'done', since: T(420), updated_at: T(420) },
    lines: [
      at(T(600), userMsg('cadre le chantier')),
      at(T(430), assistant('voilà mon analyse')),
      at(T(415), userMsg('Stop hook feedback: […]')),
      at(T(400), assistantTool('Grep', 'toolu_a')),
      at(T(399), { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_a' }] } }),
      INT(T(60)),
    ],
    mtimeMs: T(60),
  });
  check('hooks `done` (Stop à feedback) + interruption postérieure → interrupted', got === 'interrupted', String(got));
}

console.log('\n9. Interruption pendant une attente de permission');
{
  const got = stateFor('perm', {
    hook: { state: 'waiting', since: T(300), updated_at: T(300), message: 'Claude needs your permission to use Bash' },
    lines: [
      at(T(600), userMsg('go')),
      at(T(310), assistantTool('Bash', 'toolu_b')),
      INT(T(120), INTERRUPT_TOOL_TEXT),
    ],
    mtimeMs: T(120),
  });
  check('hooks `waiting` + interruption postérieure → interrupted (plus de « ? » fantôme)', got === 'interrupted', String(got));
}

console.log('\n10. Interruption survivant à un rechargement de fenêtre (entrée hooks purgée)');
{
  // SessionEnd purge l'entrée à chaque reload : sans preuve hooks, le repli est
  // `idle` → ✓ pâle « rien à faire ici », l'exact contraire de la vérité.
  const got = stateFor('reload', {
    hook: null,
    lines: [at(T(900), userMsg('go')), at(T(880), assistant('je commence')), INT(T(600))],
    mtimeMs: T(600),
  });
  check('aucune entrée hooks + interruption → interrupted (pas idle)', got === 'interrupted', String(got));
}

console.log('\n11. Interruption ancienne : le vieillissement busy→stale ne la recouvre pas');
{
  const got = stateFor('aged', {
    hook: { state: 'busy', since: T(1800), updated_at: T(1800) },
    lines: [at(T(1800), userMsg('go')), at(T(1700), assistant('je commence')), INT(T(1500))],
    mtimeMs: T(1500), // 25 min de silence, CLI mort → sinon `stale`
  });
  check('interruption + silence > 5 min + CLI mort → interrupted (pas stale)', got === 'interrupted', String(got));
}

console.log('\n12. Relance : les hooks reprennent la main (pas de carré clignotant)');
{
  // UserPromptSubmit repose `busy` AVANT que le CLI n'écrive le nouveau prompt :
  // pendant cet interstice, le dernier mot du transcript est encore
  // l'interruption. L'événement hooks est plus frais → il gagne.
  const got = stateFor('relance', {
    hook: { state: 'busy', since: T(1), updated_at: T(1) },
    lines: [at(T(600), userMsg('go')), at(T(300), assistant('je commence')), INT(T(120))],
    mtimeMs: T(120),
  });
  check('entrée hooks POSTÉRIEURE à l\'interruption → busy (le transcript n\'est plus le plus frais)', got === 'busy', String(got));
}

console.log('\n13. Question interactive posée pendant une reprise après Stop à feedback');
{
  // Même trou, autre symptôme : sans correction, spinner puis faux ✓ alors
  // qu'une question attend une réponse à l'écran.
  const got = stateFor('ask-after-stop', {
    hook: { state: 'done', since: T(400), updated_at: T(400) },
    lines: [
      at(T(600), userMsg('go')),
      at(T(410), assistant('presque fini')),
      at(T(395), userMsg('Stop hook feedback: […]')),
      ASK(T(380), 'toolu_q'),
    ],
    mtimeMs: T(380),
  });
  check('hooks `done` + AskUserQuestion sans réponse → waiting (le « ? »)', got === 'waiting', String(got));
}

console.log('\n14. Interruption APRÈS une question interactive → l\'interruption prime');
{
  const got = stateFor('ask-then-int', {
    hook: { state: 'busy', since: T(600), updated_at: T(600) },
    lines: [at(T(600), userMsg('go')), ASK(T(300), 'toolu_q2'), INT(T(60))],
    mtimeMs: T(60),
  });
  check('question puis interruption → interrupted (pas « ? » : plus rien n\'attend)', got === 'interrupted', String(got));
}

console.log('\n15. Non-régression : une fin de tour normale reste `done`');
{
  const got = stateFor('normal-done', {
    hook: { state: 'done', since: T(120), updated_at: T(120) },
    lines: [at(T(600), userMsg('go')), at(T(125), assistant('terminé'))],
    mtimeMs: T(120),
  });
  check('Stop réel, aucune interruption → done (aucun faux carré)', got === 'done', String(got));
}

console.log('\n16. Non-régression : un tour en cours reste `busy`');
{
  const got = stateFor('normal-busy', {
    hook: { state: 'busy', since: T(60), updated_at: T(60) },
    lines: [at(T(60), userMsg('go')), at(T(30), assistantTool('Bash', 'toolu_c'))],
    mtimeMs: T(30),
  });
  check('travail en cours, aucune interruption → busy (le spinner reste légitime)', got === 'busy', String(got));
}

console.log('\n17. Table de vérité des membres de groupe : elle suit la vue');
{
  const { memberTruth } = require(path.join(__dirname, '..', 'member-truth.js'));
  const truth = memberTruth({ sessionId: 'm1', launchedAt: NOW - 60000 }, {
    isLive: () => true,
    hasTranscript: () => true,
    getConv: () => ({ state: 'interrupted', tabOpen: true }),
  });
  check('membre dont la conv est interrompue → statut interrupted', truth.status === 'interrupted', truth.status);
  check('une vague ne se croit pas terminée sur une interruption', truth.waveStatus === 'launched', truth.waveStatus);
}

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
