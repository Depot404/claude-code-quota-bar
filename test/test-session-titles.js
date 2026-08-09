// Banc des DEUX sources d'identité stable ajoutées le 2026-07-22 :
//   - live-sessions.js  : registre ~/.claude/sessions/<pid>.json
//   - session-titles.js : table sessionId → titre d'onglet réel (state.vscdb)
//
// Le vscdb est FABRIQUÉ ici avec node:sqlite (aucun fichier réel de VS Code
// n'est ouvert). Si le module manque sur cette machine, la partie titres est
// sautée explicitement — c'est aussi le test de la dégradation : sans sqlite,
// createSessionTitles doit rendre une Map vide sans jamais lever.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-titles-'));

let pass = 0, fail = 0, skipped = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}
function skip(name, why) { skipped++; console.log(`  skip ${name} (${why})`); }

const { createSessionTitles, cleanLabel, CACHE_KEY } = require(path.join(__dirname, '..', 'session-titles.js'));
const { liveSessionIds, pidAlive } = require(path.join(__dirname, '..', 'live-sessions.js'));

// ── 1. Registre des sessions vivantes ──────────────────────────────────────
console.log('\n1. live-sessions : ~/.claude/sessions/<pid>.json');
const sessionsDir = path.join(SANDBOX, 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });

check('dossier absent → ensemble vide, aucune exception',
  liveSessionIds(path.join(SANDBOX, 'nope')).size === 0);

// pid vivant garanti : le nôtre. pid mort garanti : un pid libre trouvé par
// tâtonnement (pidAlive dit non), donc jamais un process réel de la machine.
let deadPid = 0;
for (let p = 999999; p > 900000; p--) { if (!pidAlive(p)) { deadPid = p; break; } }

const writeSession = (pid, sessionId, extra = {}) => fs.writeFileSync(
  path.join(sessionsDir, `${pid}.json`),
  JSON.stringify({ pid, sessionId, cwd: 'C:\\ws', kind: 'interactive', entrypoint: 'claude-vscode', ...extra })
);
writeSession(process.pid, 'alive-1');
writeSession(deadPid, 'dead-1');
fs.writeFileSync(path.join(sessionsDir, 'garbage.json'), '{ pas du json');
fs.writeFileSync(path.join(sessionsDir, 'notes.txt'), 'ignoré');

let ids = liveSessionIds(sessionsDir);
check('la session d\'un pid vivant est retenue', ids.has('alive-1'), [...ids].join(','));
check('celle d\'un pid mort est écartée', !ids.has('dead-1'), [...ids].join(','));
check('fichier illisible ignoré sans lever', ids.size === 1, String(ids.size));
check('les fichiers du CLI ne sont JAMAIS supprimés par nous',
  fs.existsSync(path.join(sessionsDir, `${deadPid}.json`)));

// ── 2. Titres d'onglet réels ───────────────────────────────────────────────
console.log('\n2. session-titles : state.vscdb (agentSessions.model.cache)');

check('chemin null → Map vide, aucun accès disque',
  createSessionTitles(null).get().size === 0);
check('fichier inexistant → Map vide, aucune exception',
  createSessionTitles(path.join(SANDBOX, 'absent.vscdb')).get().size === 0);

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch {}

if (!sqlite) {
  skip('lecture d\'un vscdb fabriqué', 'node:sqlite indisponible — dégradation vérifiée ci-dessus');
} else {
  const dbPath = path.join(SANDBOX, 'state.vscdb');
  // Même forme que le vrai fichier : entrées Claude ET entrées d'autres
  // fournisseurs (chat local VS Code), qui ne doivent PAS entrer dans la table.
  const entries = [
    { providerType: 'claude-code', resource: 'claude-code:/sess-1', label: 'Upload Error TF400898: An Internal…' },
    { providerType: 'claude-code', resource: 'claude-code:/sess-2', label: 'Autre conversation Claude' },
    { providerType: 'local', resource: 'vscode-chat-session://local/abcdef', label: 'Chat VS Code local' },
    { providerType: 'claude-code', resource: 'claude-code:/sess-3' },   // sans label
  ];
  const write = (value) => {
    const db = new sqlite.DatabaseSync(dbPath);
    db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value BLOB)');
    db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(CACHE_KEY, value);
    db.close();
  };
  write(JSON.stringify(entries));

  const titles = createSessionTitles(dbPath, { minStatIntervalMs: 0 });
  let map = titles.get();
  check('sessionId → libellé d\'onglet', map.get('sess-1') === 'Upload Error TF400898: An Internal…',
    String(map.get('sess-1')));
  check('les entrées non-Claude sont ignorées', !map.has('abcdef') && map.size === 2, String(map.size));
  check('entrée sans label ignorée', !map.has('sess-3'));

  // Le fichier bouge → la table suit (le cache est indexé sur (mtime, size)).
  entries[0].label = 'Titre renommé entre-temps';
  write(JSON.stringify(entries));
  // Les mtimeMs peuvent être identiques à la ms près sur Windows : on force la
  // date pour prouver l'invalidation, pas la résolution de l'horloge.
  const future = Date.now() / 1000 + 5;
  fs.utimesSync(dbPath, future, future);
  check('réécriture du vscdb → nouvelle table',
    titles.get().get('sess-1') === 'Titre renommé entre-temps', String(titles.get().get('sess-1')));

  // Clé absente / valeur illisible : jamais d'exception, on garde le dernier
  // état connu plutôt que d'effacer les titres.
  write('{ pas du json');
  const future2 = future + 5;
  fs.utimesSync(dbPath, future2, future2);
  check('valeur corrompue → dernière table connue conservée',
    titles.get().get('sess-1') === 'Titre renommé entre-temps');

  // Throttle : `get()` est appelé à chaque snapshot, il ne doit pas re-stater
  // le fichier à chaque fois.
  const throttled = createSessionTitles(dbPath, { minStatIntervalMs: 60000 });
  throttled.get();
  const statSync = fs.statSync;
  let stats = 0;
  fs.statSync = (...a) => { stats++; return statSync(...a); };
  try { throttled.get(); throttled.get(); } finally { fs.statSync = statSync; }
  check('appels rapprochés : aucun re-stat du vscdb', stats === 0, String(stats));
}

console.log('\n3. cleanLabel (affichage seulement)');
check('caractère de remplacement final retiré', cleanLabel('Titre tronqué�') === 'Titre tronqué');
check('points de suspension conservés (l\'onglet aussi les montre)',
  cleanLabel('Titre tronqué…') === 'Titre tronqué…');
check('non-chaîne → null', cleanLabel(undefined) === null);

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} ok, ${fail} fail${skipped ? `, ${skipped} skip` : ''}`);
process.exit(fail ? 1 : 0);
