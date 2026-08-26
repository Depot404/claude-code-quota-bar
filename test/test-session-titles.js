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

const { createSessionTitles, cleanLabel, CACHE_KEY, createOpenSessionIds, EDITOR_STATE_KEY } =
  require(path.join(__dirname, '..', 'session-titles.js'));
const { liveSessionIds, foreignSessionIds, isForeignEntrypoint, pidAlive } =
  require(path.join(__dirname, '..', 'live-sessions.js'));

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

// ── 1bis. Origine de la session : fenêtre VS Code ou ailleurs ───────────────
// Toutes les sessions vivantes ne naissent pas d'un onglet. Le serveur Remote
// Control (conversations ouvertes depuis le mobile) exécute les siennes ICI,
// dans le même dossier de travail : sans ce tri elles s'affichent dans le
// panneau, sans onglet, indéfiniment. Signalé par l'user le 2026-08-17.
console.log('\n1bis. live-sessions : origine (entrypoint)');
const originDir = path.join(SANDBOX, 'sessions-origin');
fs.mkdirSync(originDir, { recursive: true });
const writeOrigin = (name, sessionId, entrypoint) => {
  const body = { pid: process.pid, sessionId, cwd: 'C:\\ws' };
  if (entrypoint !== undefined) body.entrypoint = entrypoint;
  fs.writeFileSync(path.join(originDir, `${name}.json`), JSON.stringify(body));
};
writeOrigin('a', 'vscode-1', 'claude-vscode');
writeOrigin('b', 'rc-1', 'sdk-cli');          // Remote Control / agent SDK
writeOrigin('c', 'term-1', 'cli');            // terminal lancé à la main
writeOrigin('d', 'remote-1', 'remote_cowork');
writeOrigin('e', 'nofield-1', undefined);     // champ absent → dégradation
writeOrigin('f', 'unknown-1', 'entrypoint-du-futur');

const vs = liveSessionIds(originDir);
const foreign = foreignSessionIds(originDir);
check('une session VS Code est vivante', vs.has('vscode-1'), [...vs].join(','));
check('la session du serveur RC (sdk-cli) en est écartée', !vs.has('rc-1'));
check('… et se retrouve dans l\'ensemble étranger', foreign.has('rc-1'), [...foreign].join(','));
check('un terminal (cli) est étranger', foreign.has('term-1') && !vs.has('term-1'));
check('la famille remote* est étrangère', foreign.has('remote-1') && !vs.has('remote-1'));
check('entrypoint ABSENT → traité comme VS Code, jamais masqué en plus',
  vs.has('nofield-1') && !foreign.has('nofield-1'));
check('entrypoint INCONNU → traité comme VS Code (liste fermée, dégradation sûre)',
  vs.has('unknown-1') && !foreign.has('unknown-1'));
check('les deux ensembles sont disjoints ici', [...vs].every((id) => !foreign.has(id)));
check('isForeignEntrypoint ne se déclenche pas sur une valeur vide',
  !isForeignEntrypoint('') && !isForeignEntrypoint(null) && !isForeignEntrypoint(undefined));

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
    // Schéma d'URI RÉCENT, relevé le 2026-08-20 sur le vscdb du workspace
    // Octopus (411 entrées, toutes sous ce schéma). Un seul préfixe en dur et
    // la table entière redevient illisible sans la moindre erreur : ce cas est
    // le témoin de cette panne-là, à garder même quand le vieux schéma aura
    // disparu des workspaces récents.
    { providerType: 'agent-host-claude', resource: 'agent-host-claude:/sess-4', label: 'Conversation au schéma récent' },
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
  check('schéma agent-host-claude:/ (2026-08) reconnu aussi',
    map.get('sess-4') === 'Conversation au schéma récent', String(map.get('sess-4')));
  check('les entrées non-Claude sont ignorées', !map.has('abcdef') && map.size === 3, String(map.size));
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

  // Zéro entrée là où l'on en connaissait déjà : PANNE, pas dégradation.
  // Relevé le 2026-08-24 sur le vscdb RÉEL du workspace ouvert — 369 entrées,
  // puis 0, puis 369 de nouveau à trois minutes d'écart, sans la moindre erreur
  // levée (instantané SQLite pris pendant que VS Code réécrit). Écraser la table
  // pour autant, c'est perdre la seule preuve d'identité d'onglet le temps d'un
  // tick, donc faire reparaître toutes les lignes sans onglet qu'elle écarte.
  write(JSON.stringify([]));
  const future3 = future2 + 5;
  fs.utimesSync(dbPath, future3, future3);
  check('lecture à zéro entrée → dernière table connue conservée',
    titles.get().get('sess-1') === 'Titre renommé entre-temps',
    String(titles.get().get('sess-1')));

  // …et la clé n'a pas été mémorisée : le rafraîchissement suivant relit pour de
  // vrai, la table repart dès que la lecture redevient bonne.
  entries[0].label = 'Titre revenu';
  write(JSON.stringify(entries));
  const future4 = future3 + 5;
  fs.utimesSync(dbPath, future4, future4);
  check('lecture bonne après un zéro → table remise à jour',
    titles.get().get('sess-1') === 'Titre revenu', String(titles.get().get('sess-1')));

  // Throttle : `get()` est appelé à chaque snapshot, il ne doit pas re-stater
  // le fichier à chaque fois.
  const throttled = createSessionTitles(dbPath, { minStatIntervalMs: 60000 });
  throttled.get();
  const statSync = fs.statSync;
  let stats = 0;
  fs.statSync = (...a) => { stats++; return statSync(...a); };
  try { throttled.get(); throttled.get(); } finally { fs.statSync = statSync; }
  check('appels rapprochés : aucun re-stat du vscdb', stats === 0, String(stats));

  // ── 2bis. Sessions ouvertes ICI : memento/workbench.parts.editor ──────────
  // Structure mesurée le 2026-08-25 sur un vscdb réel (lot « clic par
  // identifiant ») : arbre serializedGrid.root de noeuds "branch"/"leaf",
  // chaque éditeur webview portant un `value` JSON dont `state` est LUI-MÊME
  // un JSON encodé avec `sessionID`.
  console.log('\n2bis. createOpenSessionIds : state.vscdb (memento/workbench.parts.editor)');
  const editorDbPath = path.join(SANDBOX, 'state-editor.vscdb');
  const claudeEditor = (sessionID) => ({
    id: 'workbench.editors.webviewInput',
    value: JSON.stringify({
      extensionId: 'Anthropic.claude-code',
      state: JSON.stringify({ isFullEditor: true, sessionID }),
    }),
  });
  const foreignEditor = () => ({
    id: 'workbench.editors.webviewInput',
    value: JSON.stringify({ extensionId: 'Some.other-extension', state: '{}' }),
  });
  const fileEditor = () => ({ id: 'workbench.editors.files.textFileEditor', value: '{}' });
  const buildGrid = (sessionIds) => ({
    'editorpart.state': {
      serializedGrid: {
        root: {
          type: 'branch',
          data: [
            { type: 'leaf', data: { id: 0, editors: [claudeEditor(sessionIds[0]), foreignEditor(), fileEditor()] } },
            {
              type: 'branch',
              data: [
                { type: 'leaf', data: { id: 1, editors: sessionIds[1] ? [claudeEditor(sessionIds[1])] : [] } },
              ],
            },
          ],
        },
      },
    },
  });
  const writeEditor = (value) => {
    const db = new sqlite.DatabaseSync(editorDbPath);
    db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value BLOB)');
    db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(EDITOR_STATE_KEY, value);
    db.close();
  };

  check('chemin null → Set vide, aucun accès disque', createOpenSessionIds(null).get().size === 0);
  check('fichier inexistant → Set vide, aucune exception',
    createOpenSessionIds(path.join(SANDBOX, 'absent2.vscdb')).get().size === 0);

  writeEditor(JSON.stringify(buildGrid(['sess-open-1', 'sess-open-2'])));
  const openIds = createOpenSessionIds(editorDbPath, { minStatIntervalMs: 0 });
  let ids2 = openIds.get();
  check('sessionId trouvé dans un noeud "leaf" direct', ids2.has('sess-open-1'), [...ids2].join(','));
  check('sessionId trouvé au fond d\'un noeud "branch" imbriqué', ids2.has('sess-open-2'), [...ids2].join(','));
  check('éditeur non-Claude ignoré, éditeur de fichier ignoré, exactement 2 sessions',
    ids2.size === 2, String(ids2.size));

  // Onglet fermé entre-temps (le noeud correspondant disparaît du memento) →
  // le fichier bouge, la lecture suit.
  writeEditor(JSON.stringify(buildGrid(['sess-open-1', null])));
  const futureE = Date.now() / 1000 + 5;
  fs.utimesSync(editorDbPath, futureE, futureE);
  ids2 = openIds.get();
  check('memento réécrit sans sess-open-2 → disparaît de l\'ensemble',
    ids2.has('sess-open-1') && !ids2.has('sess-open-2'), [...ids2].join(','));

  // Valeur illisible : jamais d'exception, dernier ensemble connu conservé —
  // un Set VIDE serait aussi sûr ici (cf. commentaire de createOpenSessionIds :
  // l'absence n'est jamais dangereuse), mais garder le dernier connu évite de
  // perdre le bénéfice de la voie principale sur un simple hoquet de lecture.
  writeEditor('{ pas du json');
  const futureE2 = futureE + 5;
  fs.utimesSync(editorDbPath, futureE2, futureE2);
  check('valeur corrompue → dernier ensemble connu conservé',
    openIds.get().has('sess-open-1'), [...openIds.get()].join(','));

  // Arbre malformé (pas d'exception, ensemble vide) — extension tierce ou
  // schéma qui a bougé.
  writeEditor(JSON.stringify({ 'editorpart.state': { serializedGrid: { root: { type: 'leaf' } } } }));
  const futureE3 = futureE2 + 5;
  fs.utimesSync(editorDbPath, futureE3, futureE3);
  check('noeud racine sans data.editors → Set vide, aucune exception',
    openIds.get().size === 0, String(openIds.get().size));
}

console.log('\n3. cleanLabel (affichage seulement)');
check('caractère de remplacement final retiré', cleanLabel('Titre tronqué�') === 'Titre tronqué');
check('points de suspension conservés (l\'onglet aussi les montre)',
  cleanLabel('Titre tronqué…') === 'Titre tronqué…');
check('non-chaîne → null', cleanLabel(undefined) === null);

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} ok, ${fail} fail${skipped ? `, ${skipped} skip` : ''}`);
process.exit(fail ? 1 : 0);
