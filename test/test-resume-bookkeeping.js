// Banc : écriture de COMPTABILITÉ ≠ reprise de travail (incident 2026-08-07).
// Au reload de la fenêtre VS Code, l'extension officielle respawne le CLI de
// chaque onglet restauré ; ce respawn appende au transcript des lignes non
// conversationnelles (constaté en réel : `last-prompt` SANS timestamp, 86 s
// après le Stop) — le mtime bouge sans le moindre travail. isResuming ne
// regardait que le mtime : chaque conversation `done` non lue repartait en
// spinner pour STALE_MS (5 min) à CHAQUE reload. La correction fonde la
// détection de reprise sur le timestamp du dernier MESSAGE conversationnel
// (lastActivityTs), le mtime ne restant que le repli quand ce timestamp
// n'existe pas — et le signal de vie busy→stale, lui, reste sur le mtime.
const fs = require('fs');
const os = require('os');
const path = require('path');

const { lastActivityTs } = require(path.join(__dirname, '..', 'hooks', 'transcript.js'));
const { effectiveState } = require(path.join(__dirname, '..', 'state.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-resume-'));
const write = (name, lines) => {
  const p = path.join(SANDBOX, name);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
};
const iso = (ms) => new Date(ms).toISOString();
const userMsg = (t, ms) => ({ type: 'user', timestamp: ms ? iso(ms) : undefined, message: { content: [{ type: 'text', text: t }] } });
const assistant = (t, ms) => ({ type: 'assistant', timestamp: ms ? iso(ms) : undefined, message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: t || 'ok' }] } });

const NOW = Date.now();
const T0 = NOW - 90 * 1000; // le Stop, 90 s avant « maintenant » — l'incident réel

console.log('\n1. lastActivityTs : seuls les messages conversationnels datés comptent');
{
  const p = write('a.jsonl', [userMsg('go', T0 - 20000), assistant('réponse', T0)]);
  check('dernier assistant daté → son timestamp', lastActivityTs(p) === T0, String(lastActivityTs(p)));

  // La forme EXACTE de l'incident : le respawn appende une ligne sans timestamp.
  fs.appendFileSync(p, JSON.stringify({ type: 'last-prompt', prompt: 'x' }) + '\n');
  fs.appendFileSync(p, JSON.stringify({ type: 'queue-operation' }) + '\n');
  fs.appendFileSync(p, JSON.stringify({ type: 'ai-title', aiTitle: 'Titre' }) + '\n');
  check('les lignes de comptabilité appendues ensuite ne changent RIEN', lastActivityTs(p) === T0, String(lastActivityTs(p)));

  const meta = write('b.jsonl', [assistant('réponse', T0), { type: 'user', isMeta: true, timestamp: iso(NOW), message: { content: [{ type: 'text', text: 'ctx' }] } }]);
  check('un user isMeta (contexte injecté par hook) est ignoré', lastActivityTs(meta) === T0, String(lastActivityTs(meta)));

  const undated = write('c.jsonl', [userMsg('go'), assistant('réponse')]);
  check('dernier message conversationnel NON daté → null (le caller repliera sur le mtime)',
    lastActivityTs(undated) === null, String(lastActivityTs(undated)));

  check('fichier absent → null', lastActivityTs(path.join(SANDBOX, 'absent.jsonl')) === null);
}

console.log('\n1bis. Une <task-notification> stopped livrée au respawn n\'est pas une activité (incident 2026-08-22)');
{
  // Forme RÉELLE relevée sur le transcript témoin f04f6836 (2026-08-22 23:12:43,
  // spinner post-reload n°3) : content en STRING brute, pas en blocs, livrée
  // 77 s avant le screenshot de l'user — aucun assistant ne suit jamais.
  const stoppedNotif = (ms) => ({
    type: 'user', timestamp: iso(ms),
    message: { role: 'user', content: '<task-notification>\n<task-id>bk000demo</task-id>\n<tool-use-id>toolu_demo</tool-use-id>\n<status>stopped</status>\n<summary>No completion record was found for this background shell command from the previous session.</summary>\n</task-notification>' },
  });
  const p = write('notif-stopped.jsonl', [assistant('réponse finale', T0), stoppedNotif(NOW - 77 * 1000)]);
  check('notification stopped livrée après le Stop → l\'activité reste le Stop', lastActivityTs(p) === T0, String(lastActivityTs(p)));
  const entry = { state: 'done', since: T0 };
  const verdict = effectiveState(entry, NOW, NOW, true, lastActivityTs(p));
  check('done + notification stopped fraîche → reste done (plus de spinner post-reload)', verdict === 'done', verdict);

  // Le jumeau completed annonce une VRAIE ré-invocation : il reste une
  // activité — l'ignorer rouvrirait le faux-done de l'incident vagues.
  const completedNotif = { type: 'user', timestamp: iso(NOW - 3000), message: { role: 'user', content: '<task-notification>\n<task-id>bk000demo</task-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>' } };
  const p2 = write('notif-completed.jsonl', [assistant('réponse finale', T0), completedNotif]);
  check('notification completed → compte comme activité (la reprise réelle reste busy)',
    effectiveState({ state: 'done', since: T0 }, NOW, NOW, true, lastActivityTs(p2)) === 'busy');

  // Une CITATION de la balise au fil d'un vrai message user ne doit rien
  // changer non plus dans l'autre sens : message non ancré = vraie activité.
  const citing = { type: 'user', timestamp: iso(NOW - 3000), message: { role: 'user', content: 'regarde, le harnais écrit <task-notification>…<status>stopped</status> dans le transcript' } };
  const p3 = write('notif-cite.jsonl', [assistant('réponse finale', T0), citing]);
  check('un vrai message user qui CITE la balise reste une activité', lastActivityTs(p3) === NOW - 3000, String(lastActivityTs(p3)));
}

console.log('\n2. effectiveState : le write de respawn ne relance plus le spinner');
{
  const entry = { state: 'done', since: T0 };
  // mtime « frais » (le respawn vient d'écrire), activité réelle figée au Stop.
  const verdict = effectiveState(entry, NOW, NOW, true, T0);
  check('done + mtime frais + dernier message daté du Stop → reste done', verdict === 'done', verdict);
  // Contre-preuve : le chemin d'AVANT (pas d'activityTs → mtime fait foi)
  // rendait busy — c'est exactement le bug que ce banc verrouille.
  const old = effectiveState(entry, NOW, NOW, true);
  check('(contre-preuve) sans activityTs, le mtime seul aurait dit busy', old === 'busy', old);
}

console.log('\n3. Une VRAIE reprise (message daté postérieur au Stop) repasse busy');
{
  const entry = { state: 'done', since: T0 };
  const verdict = effectiveState(entry, NOW, NOW, true, NOW - 1000);
  check('assistant daté après le Stop → busy', verdict === 'busy', verdict);
}

console.log('\n4. Même règle pour waiting (la permission accordée reste détectée, pas le respawn)');
{
  const entry = { state: 'waiting', since: T0 };
  check('waiting + write de comptabilité seulement → reste waiting',
    effectiveState(entry, NOW, NOW, true, T0) === 'waiting');
  check('waiting + message daté postérieur (permission accordée, le travail repart) → busy',
    effectiveState(entry, NOW, NOW, true, NOW - 1000) === 'busy');
}

console.log('\n5. Intégration buildSnapshot : le scénario reload de bout en bout');
{
  const SANDBOX2 = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-resume-state-'));
  const realHomedir = os.homedir;
  os.homedir = () => SANDBOX2;
  fs.mkdirSync(path.join(SANDBOX2, '.claude'), { recursive: true });
  delete require.cache[require.resolve(path.join(__dirname, '..', 'state.js'))];
  const state = require(path.join(__dirname, '..', 'state.js'));

  const WS = 'C:\\Users\\Test\\Projets VSCODE\\ResumeDemo';
  const projectDir = state.projectDirFor(WS);
  fs.mkdirSync(projectDir, { recursive: true });
  const sessionId = 'sess-resume';
  const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, [
    userMsg('dernier prompt', T0 - 20000),
    assistant('réponse finale', T0),
    { type: 'ai-title', aiTitle: 'Conv finie avant le reload' },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');

  fs.writeFileSync(path.join(SANDBOX2, '.claude', 'sessions-state.json'), JSON.stringify({
    version: 1,
    sessions: { [sessionId]: { state: 'done', since: T0, updated_at: T0, transcript: transcriptPath } },
  }));

  // Le reload : le CLI respawné appende sa ligne de comptabilité (mtime frais).
  fs.appendFileSync(transcriptPath, JSON.stringify({ type: 'last-prompt', prompt: 'dernier prompt' }) + '\n');

  const snap = state.buildSnapshot({ workspacePath: WS, recentMs: 4 * 3600 * 1000, maxItems: 12 }, state.createTranscriptReader());
  const conv = snap.conversations.find((c) => c.sessionId === sessionId);
  check('conv done + write de respawn → le snapshot dit TOUJOURS done (plus de spinner fantôme)',
    !!conv && conv.state === 'done', JSON.stringify(conv && conv.state));

  // L'user relance vraiment : message daté → busy.
  fs.appendFileSync(transcriptPath, JSON.stringify(assistant('je reprends', Date.now())) + '\n');
  const snap2 = state.buildSnapshot({ workspacePath: WS, recentMs: 4 * 3600 * 1000, maxItems: 12 }, state.createTranscriptReader());
  const conv2 = snap2.conversations.find((c) => c.sessionId === sessionId);
  check('un message daté postérieur → repasse busy (la vraie reprise reste détectée)',
    !!conv2 && conv2.state === 'busy', JSON.stringify(conv2 && conv2.state));

  try { fs.rmSync(SANDBOX2, { recursive: true, force: true }); } catch {}
  os.homedir = realHomedir;
  delete require.cache[require.resolve(path.join(__dirname, '..', 'state.js'))];
}

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
