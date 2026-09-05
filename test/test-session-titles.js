// Banc des sources d'identité stable :
//   - live-sessions.js  : registre ~/.claude/sessions/<pid>.json
//   - session-titles.js : le memento `workbench.parts.editor` du state.vscdb
//     (quels sessionId ont un onglet Claude ouvert ICI, lequel est actif).
//
// Une troisième source vivait ici jusqu'au 2026-09-05 : `createSessionTitles`,
// la table sessionId → TITRE D'ONGLET de la clé `agentSessions.model.cache`.
// Mesurée MORTE sur le profil réel (2 entrées pour 7 onglets ouverts), elle a
// été retirée en 2.114.0 avec tout ce qu'elle seule alimentait — et ses cas de
// banc avec elle. Ce qu'elle prouvait (le schéma d'URI qui bouge, le zéro
// suspect) ne protège plus rien : il n'y a plus de lecteur à protéger.
//
// Le vscdb est FABRIQUÉ ici avec node:sqlite (aucun fichier réel de VS Code
// n'est ouvert). Si le module manque sur cette machine, la partie memento est
// sautée explicitement — c'est aussi le test de la dégradation : sans sqlite,
// les lecteurs rendent un état vide sans jamais lever.
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

const { createOpenSessionIds, EDITOR_STATE_KEY,
  analyzeEditorState, createRendererActive } =
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

// ── 2. Sessions ouvertes ICI, et onglet actif : le memento du renderer ─────
let sqlite = null;
try { sqlite = require('node:sqlite'); } catch {}

if (!sqlite) {
  skip('lecture d\'un vscdb fabriqué', 'node:sqlite indisponible — dégradation silencieuse, aucun lecteur ne lève');
} else {
  // ── Sessions ouvertes ICI : memento/workbench.parts.editor ────────────────
  // Structure mesurée le 2026-08-25 sur un vscdb réel (lot « clic par
  // identifiant ») : arbre serializedGrid.root de noeuds "branch"/"leaf",
  // chaque éditeur webview portant un `value` JSON dont `state` est LUI-MÊME
  // un JSON encodé avec `sessionID`.
  console.log('\n2. createOpenSessionIds : state.vscdb (memento/workbench.parts.editor)');
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

  // `bump()` (2026-09-04) : la cadence de 30 s ne doit pas retarder une photo
  // que le fs.watch de l'extension vient de voir écrite — le clic la relisait
  // déjà à la demande (freshLocations), le surlignage et la présence non.
  const cadenced = createOpenSessionIds(editorDbPath, { minStatIntervalMs: 60 * 1000 });
  check('lecteur cadencé : première photo servie', cadenced.get().has('sess-open-1') && !cadenced.get().has('sess-open-2'));
  writeEditor(JSON.stringify(buildGrid(['sess-open-1', 'sess-open-2'])));
  fs.utimesSync(editorDbPath, futureE + 2, futureE + 2);
  check('sans bump, la cadence retient l\'ancienne photo', !cadenced.get().has('sess-open-2'), [...cadenced.get()].join(','));
  cadenced.bump();
  check('bump() → relecture immédiate, la nouvelle photo est servie', cadenced.get().has('sess-open-2'), [...cadenced.get()].join(','));

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

  // ── 2ter. L'éditeur ACTIF du memento : « le renderer est le juge » ─────────
  // (refactor surlignage 2026-08-27) Structure mesurée sur les deux fenêtres
  // réelles de l'incident : editorpart.state porte activeGroup, chaque leaf
  // porte data.id + data.mru (indices dans editors[], tête = actif). C'est la
  // moitié « active » qu'analyzeEditorState ajoute au parcours du §2.
  console.log('\n2ter. analyzeEditorState / createRendererActive : l\'éditeur ACTIF du memento');
  const gridActive = (activeGroup, leafs) => ({
    'editorpart.state': {
      serializedGrid: { root: { type: 'branch', data: leafs } },
      activeGroup,
      mostRecentActiveGroups: [activeGroup],
    },
  });
  const leafOf = (id, editors, mru) => ({ type: 'leaf', data: { id, editors, mru } });

  {
    const parsed = gridActive(1, [
      leafOf(0, [claudeEditor('sess-a')], [0]),
      leafOf(1, [claudeEditor('sess-b'), fileEditor(), claudeEditor('sess-c')], [2, 0, 1]),
    ]);
    const a = analyzeEditorState(parsed);
    check('l\'actif est mru[0] du groupe activeGroup, par identité',
      a.active && a.active.claude === true && a.active.sessionId === 'sess-c', JSON.stringify(a.active));
    check('… et l\'ensemble des ouverts reste complet (§2 intact)',
      a.ids.size === 3 && a.ids.has('sess-a') && a.ids.has('sess-b') && a.ids.has('sess-c'),
      [...a.ids].join(','));
  }
  {
    const parsed = gridActive(1, [leafOf(1, [claudeEditor('sess-b'), fileEditor()], [1, 0])]);
    const a = analyzeEditorState(parsed);
    check('actif = un FICHIER → claude:false, jamais un sessionId deviné',
      a.active && a.active.claude === false && a.active.sessionId === null, JSON.stringify(a.active));
  }
  {
    const noMru = gridActive(0, [{ type: 'leaf', data: { id: 0, editors: [claudeEditor('sess-a')] } }]);
    check('mru absent → active null, aucune exception', analyzeEditorState(noMru).active === null);
    const wrongGroup = gridActive(7, [leafOf(0, [claudeEditor('sess-a')], [0])]);
    check('activeGroup introuvable → active null', analyzeEditorState(wrongGroup).active === null);
  }

  // createRendererActive : lecture datée du flush, bump(), dégradations.
  const rendererDbPath = path.join(SANDBOX, 'state-renderer.vscdb');
  const writeRenderer = (value) => {
    const db = new sqlite.DatabaseSync(rendererDbPath);
    db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value BLOB)');
    db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(EDITOR_STATE_KEY, value);
    db.close();
  };
  check('chemin null → { sessionId:null }, aucun accès disque',
    createRendererActive(null).get().sessionId === null);
  writeRenderer(JSON.stringify(gridActive(0, [leafOf(0, [claudeEditor('sess-truth')], [0])])));
  const flushSec = Math.floor(Date.now() / 1000) - 30;
  fs.utimesSync(rendererDbPath, flushSec, flushSec);
  const truth = createRendererActive(rendererDbPath, { minStatIntervalMs: 0 });
  let cur = truth.get();
  check('actif Claude lu par identité', cur.claude === true && cur.sessionId === 'sess-truth',
    JSON.stringify(cur));
  check('flushedAt = mtime du vscdb (à la seconde près)',
    typeof cur.flushedAt === 'number' && Math.abs(cur.flushedAt - flushSec * 1000) < 1500,
    `${cur.flushedAt} vs ${flushSec * 1000}`);
  // Réécriture avec un actif différent + mtime plus frais → la lecture suit,
  // flushedAt avance.
  writeRenderer(JSON.stringify(gridActive(0, [leafOf(0, [claudeEditor('sess-truth-2')], [0])])));
  const flushSec2 = flushSec + 10;
  fs.utimesSync(rendererDbPath, flushSec2, flushSec2);
  cur = truth.get();
  check('réécriture + mtime frais → nouvel actif, flushedAt avancé',
    cur.sessionId === 'sess-truth-2' && Math.abs(cur.flushedAt - flushSec2 * 1000) < 1500,
    JSON.stringify(cur));
  // bump() force le re-stat malgré le throttle : même mécanique que le
  // fs.watch d'extension.js (le flush du renderer est la seule horloge).
  const throttledTruth = createRendererActive(rendererDbPath, { minStatIntervalMs: 60 * 1000 });
  throttledTruth.get();
  writeRenderer(JSON.stringify(gridActive(0, [leafOf(0, [claudeEditor('sess-truth-3')], [0])])));
  const flushSec3 = flushSec2 + 10;
  fs.utimesSync(rendererDbPath, flushSec3, flushSec3);
  check('throttle actif → l\'écriture n\'est pas encore vue',
    throttledTruth.get().sessionId !== 'sess-truth-3', JSON.stringify(throttledTruth.get().sessionId));
  throttledTruth.bump();
  check('bump() → relecture immédiate malgré le throttle',
    throttledTruth.get().sessionId === 'sess-truth-3', JSON.stringify(throttledTruth.get().sessionId));
}

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} ok, ${fail} fail${skipped ? `, ${skipped} skip` : ''}`);
process.exit(fail ? 1 : 0);
