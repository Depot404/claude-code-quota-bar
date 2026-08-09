// Banc du ✓ VIF qui survit à la mort du CLI (2026-08-06, 8e signalement).
//
// CE QUI ÉTAIT CASSÉ — SessionEnd effaçait l'entrée entière de
// sessions-state.json. Ce hook tire quand le process meurt, donc en masse au
// rechargement d'une fenêtre VS Code : `state: done` et `ack_ts` partaient
// ensemble, state.js retombait sur `idle` (« les hooks ne savent rien ») et le
// panneau peignait un ✓ ATTÉNUÉ — « déjà lue » — sur des conversations
// terminées que personne n'avait ouvertes. Le fait « il te reste ça à lire »
// était détruit par un événement qui ne dit rien de la lecture.
//
// Ce banc prouve les deux sens : la trace non lue SURVIT, tout le reste est
// toujours nettoyé (sinon le fichier se remplirait de débris, ce que la purge
// SessionEnd évitait à juste titre).
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-unread-'));
os.homedir = () => SANDBOX;                       // AVANT les require
fs.mkdirSync(path.join(SANDBOX, '.claude'), { recursive: true });

const { updateSession, readState } = require(path.join(__dirname, '..', 'hooks', 'sessions-state.js'));
const { handle } = require(path.join(__dirname, '..', 'hooks', 'hook-session-state.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}
const entry = (id) => (readState().sessions || {})[id];
const sessionEnd = (id, reason) => handle({ hook_event_name: 'SessionEnd', session_id: id, reason });

console.log('\n1. Terminée JAMAIS relue → la trace survit au rechargement de fenêtre');
{
  updateSession('unread', { state: 'done' });
  sessionEnd('unread', 'other');
  const e = entry('unread');
  check('entrée conservée', !!e, JSON.stringify(readState().sessions));
  check('… avec son état `done` (le panneau garde le ✓ VIF, pas le ✓ atténué)',
    e && e.state === 'done', JSON.stringify(e));
}

console.log('\n2. Terminée DÉJÀ relue → rien à garder, on purge comme avant');
{
  updateSession('read', { state: 'done' });
  updateSession('read', { ack_ts: Date.now() + 1000 });   // relue après la fin du tour
  sessionEnd('read', 'other');
  check('entrée purgée', !entry('read'), JSON.stringify(entry('read')));
}

console.log('\n3. Pas terminée (busy / waiting) → purge, inchangé');
{
  updateSession('busy', { state: 'busy' });
  sessionEnd('busy', 'other');
  check('busy purgée', !entry('busy'), JSON.stringify(entry('busy')));

  updateSession('wait', { state: 'waiting' });
  sessionEnd('wait', 'other');
  check('waiting purgée', !entry('wait'), JSON.stringify(entry('wait')));
}

console.log('\n4. /clear → purge même non relue (la conversation elle-même a disparu)');
{
  updateSession('cleared', { state: 'done' });
  sessionEnd('cleared', 'clear');
  check('entrée purgée malgré le non-lu', !entry('cleared'), JSON.stringify(entry('cleared')));
}

console.log('\n5. Un nouveau tour PUIS la mort du CLI → toujours vif (ack périmé)');
{
  // Séquence réelle : la conv est lue (ack), puis Claude repart et refinit —
  // `since` repasse devant `ack_ts`, il y a de nouveau quelque chose à lire.
  updateSession('again', { state: 'done' });
  updateSession('again', { ack_ts: Date.now() });
  updateSession('again', { state: 'busy' });
  updateSession('again', { state: 'done' });        // nouveau `since`, postérieur à l'ack
  sessionEnd('again', 'other');
  const e = entry('again');
  check('trace conservée (le ✓ s\'était rallumé)', !!e && e.state === 'done', JSON.stringify(e));
}

console.log('\n6. Session inconnue → aucun débris créé');
{
  sessionEnd('jamais-vue', 'other');
  check('rien n\'apparaît', !entry('jamais-vue'), JSON.stringify(readState().sessions));
}

console.log(`\n${pass} ok, ${fail} fail`);
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
