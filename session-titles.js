// ============================================================================
// Table sessionId → TITRE D'ONGLET RÉEL (state.vscdb du workspace).
//
// POURQUOI — le titre affiché par le panneau venait du transcript (`ai-title`),
// et le matching onglet↔conv comparait le libellé de l'onglet à ce titre-là.
// Relevé 2026-07-22 : les deux DIVERGENT. Transcript « Afficher ? au lieu du
// loading… », onglet « Upload Error TF400898: … » — jamais écrit dans le
// transcript. Le titre d'onglet vit dans le state.vscdb du workspace
// (clé `agentSessions.model.cache`, tableau d'entrées
// `{resource: "claude-code:/<sessionId>", label, timing, metadata}`), que
// l'extension officielle régénère sans réécrire d'`ai-title`. C'est la SEULE
// table sessionId → titre d'onglet connue.
//
// Conséquence : sans elle, le filtre de présence de state.js masque une conv
// ouverte dès que son onglet a été renommé, le clic-focus devient un no-op, et
// le panneau affiche un nom que l'utilisateur ne voit nulle part.
//
// ⚠️ Internal non documenté, sur un fichier dont VS Code est propriétaire :
//   - lecture SEULE, jamais d'écriture ;
//   - ouverture/lecture/FERMETURE à chaque rafraîchissement, aucun handle
//     persistant sur un fichier que VS Code réécrit dans notre dos ;
//   - toute erreur (module node:sqlite absent, base verrouillée, schéma
//     changé) → on garde la dernière table connue et on continue. Jamais
//     d'exception, jamais de masquage EN PLUS : le doute profite à l'affichage.
// ============================================================================

const fs = require('fs');

// Le vscdb est flushé paresseusement par VS Code : re-stater plus souvent que
// le tick d'horloge du moteur (30 s) ne rendrait rien de plus frais, alors que
// `get()` est appelé à CHAQUE snapshot (donc plusieurs fois par seconde pendant
// qu'une conv travaille).
const MIN_STAT_INTERVAL_MS = 30 * 1000;

// Le schéma d'URI des sessions Claude a CHANGÉ sous nos pieds (relevé le
// 2026-08-20) : `agent-host-claude:/<uuid>` là où c'était `claude-code:/<uuid>`.
// Un seul préfixe en dur, et la table entière devient illisible SANS erreur —
// 411 entrées présentes, 0 retenue sur le workspace Octopus, pendant que
// d'autres workspaces plus anciens répondaient encore : la panne se lit comme
// une dégradation silencieuse normale, ce qui la rend indétectable de
// l'intérieur. C'est un internal non documenté ; il rebougera. On accepte donc
// TOUS les schémas connus, du plus récent au plus ancien, et on n'en retire
// jamais un tant qu'un workspace peut encore le porter (le vscdb d'un dossier
// qu'on n'a pas rouvert depuis des mois garde l'ancien format pour toujours).
//
// Conséquence en cascade quand cette source tombe, et raison de ne pas la
// laisser muette : elle est la SEULE preuve d'onglet indépendante du titre.
// Sans elle, une conversation sans ai-title n'a plus aucun moyen d'être
// reconnue fermée — c'est le bug des lignes barrées immortelles du 2026-08-20.
const RESOURCE_PREFIXES = ['agent-host-claude:/', 'claude-code:/'];
const CACHE_KEY = 'agentSessions.model.cache';

// Deuxième table lue dans le MÊME state.vscdb (focus.js, lot « clic par
// identifiant ») : le memento de la grille d'éditeurs, seule source qui dit
// quels sessionId ont un onglet Claude ouvert DANS CETTE FENÊTRE — la Tab API
// de VS Code n'expose que `label`, jamais l'identité de session portée par le
// webview. Mesuré le 2026-08-25 : `{"editorpart.state":{"serializedGrid":
// {"root":{type,data:[...]}}}}`, arbre de noeuds "branch" (data = enfants) et
// "leaf" (data.editors[]) ; chaque éditeur webview Claude a un `value` JSON
// dont `state` est LUI-MÊME un JSON encodé portant `sessionID`.
const EDITOR_STATE_KEY = 'memento/workbench.parts.editor';
const CLAUDE_EXTENSION_ID = 'Anthropic.claude-code';

// L'identifiant de session porté par une URI de ressource, quel que soit son
// schéma — null si aucun schéma connu ne la porte (autre provider d'agent).
function sessionIdFromResource(resource) {
  if (typeof resource !== 'string') return null;
  for (const prefix of RESOURCE_PREFIXES) {
    if (resource.startsWith(prefix)) return resource.slice(prefix.length) || null;
  }
  return null;
}

function log(fmt, ...args) { console.log('[QuotaBar] ' + fmt, ...args); }

// node:sqlite est expérimental (Node 22) et peut manquer selon la version de
// Node embarquée par VS Code : un seul log pour TOUT le module (les deux
// tables partagent ce constat), puis dégradation définitive.
let sqlite;
let sqliteChecked = false;
function loadSqlite() {
  if (sqliteChecked) return sqlite;
  sqliteChecked = true;
  try { sqlite = require('node:sqlite'); }
  catch (e) {
    sqlite = null;
    log('sqlite unavailable (node:sqlite missing): %s', e && e.message);
  }
  return sqlite;
}

// Lecture bas niveau d'UNE clé du state.vscdb, partagée par les deux tables
// qu'on y lit — même fichier, même garantie de dégradation (jamais
// d'exception qui remonte). `ok:false, error:null` = sqlite indisponible
// (déjà loggé par loadSqlite, ne pas re-logger) ; `ok:false, error` = lecture
// ratée (base verrouillée, schéma inattendu) ; `ok:true, value:null` = clé
// absente (table vide, pas une panne).
function readVscdbKey(stateDbPath, key) {
  const mod = loadSqlite();
  if (!mod) return { ok: false, error: null };
  let db = null;
  try {
    db = new mod.DatabaseSync(stateDbPath, { readOnly: true });
    const row = db.prepare(`SELECT value FROM ItemTable WHERE key = ?`).get(key);
    if (!row || row.value == null) return { ok: true, value: null };
    const raw = typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf8');
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: e };
  } finally {
    if (db) { try { db.close(); } catch {} }
  }
}

// Le label peut se terminer par un marqueur de troncature ou un caractère de
// remplacement (U+FFFD) quand VS Code coupe au milieu d'une paire de substituts.
// On ne nettoie QUE pour l'affichage : le matching, lui, travaille sur la chaîne
// brute (norm()/labelMatches de labels.js absorbent déjà la troncature).
function cleanLabel(label) {
  if (typeof label !== 'string') return null;
  const cleaned = label.replace(/[\uFFFD\u0000-\u001F\u007F]+$/, '').trim();
  return cleaned || null;
}

// createSessionTitles(path) → { get(): Map<sessionId, label> }
// `stateDbPath` null/absent (pas de workspace ouvert) → Map vide pour toujours,
// sans un seul accès disque.
function createSessionTitles(stateDbPath, options = {}) {
  const minStatIntervalMs = options.minStatIntervalMs != null
    ? options.minStatIntervalMs : MIN_STAT_INTERVAL_MS;
  let titles = new Map();
  let key = null;          // (mtimeMs, size) du fichier déjà chargé
  let lastStatAt = 0;
  let warned = false;

  function read() {
    const res = readVscdbKey(stateDbPath, CACHE_KEY);
    if (!res.ok) {
      // Base verrouillée (SQLITE_BUSY), schéma changé, JSON inattendu : on
      // conserve la dernière table connue. Un seul log (sqlite indisponible
      // est déjà loggé une fois par loadSqlite, ne pas doubler).
      if (res.error && !warned) { warned = true; log('session titles read failed: %s', res.error.message); }
      return null;
    }
    const entries = Array.isArray(res.value) ? res.value : [];
    const map = new Map();
    for (const e of entries) {
      if (!e || typeof e.label !== 'string') continue;
      const sessionId = sessionIdFromResource(e.resource);
      if (sessionId) map.set(sessionId, e.label);
    }
    return map;
  }

  return {
    get() {
      if (!stateDbPath) return titles;
      const now = Date.now();
      if (lastStatAt && now - lastStatAt < minStatIntervalMs) return titles;
      lastStatAt = now;
      let stat;
      try { stat = fs.statSync(stateDbPath); } catch { return titles; }
      const k = `${stat.mtimeMs}:${stat.size}`;
      if (k === key) return titles;
      const next = read();
      if (!next) return titles;   // lecture ratée → on ne mémorise pas la clé
      // …et une lecture qui rend ZÉRO là où l'on connaissait des sessions n'est
      // pas une lecture réussie non plus. Relevé le 2026-08-24 sur la base du
      // workspace ouvert : deux lectures à trois minutes d'écart, 369 entrées
      // puis 0, puis 369 de nouveau — sans la moindre erreur levée (SQLite rend
      // simplement un instantané où la ligne n'est pas visible pendant que VS
      // Code réécrit). Écraser la table pour autant, c'est perdre la seule
      // preuve d'identité d'onglet le temps d'un tick, donc faire reparaître
      // toutes les lignes sans onglet que cette preuve fait disparaître.
      // On garde la dernière table connue et on ne mémorise pas la clé : le
      // prochain rafraîchissement relira. Un workspace qui perd RÉELLEMENT
      // toutes ses sessions garde une table périmée, sans conséquence — une
      // identité publiée en trop ne fait jamais afficher une conv de plus,
      // elle ne sert qu'à conclure une fermeture déjà prouvée par l'absence
      // d'onglet.
      if (next.size === 0 && titles.size > 0) {
        if (!warned) { warned = true; log('session titles read returned 0 (kept %d known)', titles.size); }
        return titles;
      }
      key = k;
      warned = false;
      titles = next;
      return titles;
    },
  };
}

// Un éditeur sérialisé du memento : est-ce un panneau Claude, et quel
// sessionID porte-t-il. `{ claude:false, sessionId:null }` pour tout le reste
// (fichier, diff, webview d'une autre extension, JSON malformé) — jamais
// d'exception, un éditeur illisible n'est pas fatal pour les autres.
function editorSessionInfo(editor) {
  const none = { claude: false, sessionId: null };
  if (!editor || typeof editor.value !== 'string') return none;
  let outer;
  try { outer = JSON.parse(editor.value); } catch { return none; }
  if (!outer || outer.extensionId !== CLAUDE_EXTENSION_ID || typeof outer.state !== 'string') return none;
  let inner;
  try { inner = JSON.parse(outer.state); } catch { return { claude: true, sessionId: null }; }
  const sid = inner && typeof inner.sessionID === 'string' && inner.sessionID ? inner.sessionID : null;
  return { claude: true, sessionId: sid };
}

// Parcourt l'arbre `serializedGrid.root` (noeuds "branch"/"leaf", cf.
// EDITOR_STATE_KEY ci-dessus) et rend :
//   ids    — l'ensemble des sessionId dont un onglet webview Claude est ouvert ICI ;
//   active — l'éditeur ACTIF de la fenêtre (groupe `activeGroup`, puis tête de
//            son `mru` — l'ordre most-recently-used que le renderer tient à
//            jour), au format editorSessionInfo ; null si irrésolu (memento
//            absent, groupe actif introuvable, mru vide/malformé).
// C'est la moitié « active » qui fonde la doctrine « le renderer est le juge »
// (refactor surlignage 2026-08-27) : ce memento est écrit par le PROCESSUS QUI
// PEINT L'ÉCRAN — vérifié sur l'incident du 2026-08-27, où il disait vrai
// (mru[0] = l'onglet réellement affiché) pendant que la copie miroir
// tabGroups de l'hôte d'extension mentait depuis 14 minutes.
// Aucune exception ne doit remonter : un noeud/éditeur malformé (schéma qui
// bouge, une extension tierce dont le JSON diffère) est simplement ignoré.
function analyzeEditorState(parsed) {
  const out = { ids: new Set(), active: null, locations: new Map() };
  const state = parsed && parsed['editorpart.state'];
  const root = state && state.serializedGrid && state.serializedGrid.root;
  if (!root) return out;
  const activeGroupId = state.activeGroup;
  // Parcours ORDONNÉ (gauche → droite), pas la pile LIFO d'avant : `locations`
  // a besoin du rang du groupe pour le traduire en `viewColumn` (1-based, ordre
  // d'affichage). Les deux autres sorties se moquent de l'ordre — elles ne
  // changent pas de valeur pour autant.
  const leaves = [];
  (function walk(node) {
    if (!node) return;
    if (node.type === 'branch' && Array.isArray(node.data)) {
      for (const child of node.data) walk(child);
      return;
    }
    if (node.type === 'leaf' && node.data && Array.isArray(node.data.editors)) leaves.push(node.data);
  })(root);

  // Rang de l'onglet parmi TOUS les onglets Claude de la fenêtre, groupes
  // enchaînés dans l'ordre : c'est l'index que publie tabs.js (`localActiveIndex`
  // / `claudeTabLabels`), et donc celui que state.js apparie. Distinct de
  // `index`, qui compte TOUS les éditeurs du groupe (fichiers compris) parce que
  // c'est ce qu'attend `openEditorAtIndex`. Confondre les deux fait viser un
  // onglet pour un autre dès qu'un fichier est ouvert à côté d'une conversation.
  let flat = 0;
  leaves.forEach((leaf, leafRank) => {
    // Nombre d'onglets Claude de ce groupe : sert de somme de contrôle au
    // consommateur (focus.js) — un memento en retard se trahit d'abord par un
    // compte qui ne correspond plus à ce que l'API montre.
    let claudeCount = 0;
    leaf.editors.forEach((editor, index) => {
      const info = editorSessionInfo(editor);
      if (!info.claude) return;
      const flatIndex = flat++;
      claudeCount++;
      if (!info.sessionId) return;
      out.ids.add(info.sessionId);
      // POSITION EXACTE de l'onglet portant cette session. C'est elle qui
      // permet un focus par identité SANS jamais appeler une commande capable
      // d'OUVRIR (mesuré le 2026-08-29 : `claude-vscode.editor.open` recrée un
      // panneau quand le webview restauré n'a pas encore été réaffiché depuis
      // un reload — VS Code ne le désérialise qu'à la première visite).
      // `viewColumn` 1-based, comme vscode.window.tabGroups.
      out.locations.set(info.sessionId, { viewColumn: leafRank + 1, index, flatIndex });
    });
    for (const sid of out.locations.keys()) {
      const loc = out.locations.get(sid);
      if (loc && loc.viewColumn === leafRank + 1) loc.claudeCount = claudeCount;
    }
    if (activeGroupId != null && leaf.id === activeGroupId
        && Array.isArray(leaf.mru) && leaf.mru.length) {
      const activeEditor = leaf.editors[leaf.mru[0]];
      if (activeEditor) {
        out.active = editorSessionInfo(activeEditor);
        // Rang de l'ACTIF parmi les onglets Claude, dans le même comptage que
        // `flatIndex` : c'est la somme de contrôle qui dit si cette photo décrit
        // encore le monde d'aujourd'hui (cf. tab-positions.js).
        if (out.active && out.active.sessionId) {
          const loc = out.locations.get(out.active.sessionId);
          out.activeFlatIndex = loc ? loc.flatIndex : null;
        }
      }
    }
  });
  return out;
}

// createOpenSessionIds(path) → { get(): Set<sessionId> } — les sessions dont
// CETTE fenêtre a un onglet Claude ouvert, au sens du memento sur disque.
//
// ⚠️ Ce memento est flushé PARESSEUSEMENT par VS Code (mesuré empiriquement au
// lot « clic par identifiant », délai réel à documenter dans le rapport de ce
// lot) : une fermeture d'onglet toute récente peut rester invisible ici
// quelques secondes. Contrairement à `createSessionTitles` (où un zéro
// suspect après une lecture fraîche est ignoré), ce Set n'a PAS ce garde-fou :
// un zéro réel est un résultat honnête (fenêtre sans onglet Claude), et
// l'exposer tel quel est SANS DANGER — il ne fait au pire que renvoyer
// focus.js vers son repli par libellé. Le sens dangereux est l'inverse (un
// sessionId qui apparaît encore alors que l'onglet vient de fermer) : voir
// focus.js `tryOfficialFocus` pour ce qu'on en fait.
function createOpenSessionIds(stateDbPath, options = {}) {
  const minStatIntervalMs = options.minStatIntervalMs != null
    ? options.minStatIntervalMs : MIN_STAT_INTERVAL_MS;
  let ids = new Set();
  let locations = { byId: new Map(), activeFlatIndex: null };
  let key = null;
  let lastStatAt = 0;
  let warned = false;

  function refresh() {
    if (!stateDbPath) return;
    const now = Date.now();
    if (lastStatAt && now - lastStatAt < minStatIntervalMs) return;
    lastStatAt = now;
    let stat;
    try { stat = fs.statSync(stateDbPath); } catch { return; }
    const k = `${stat.mtimeMs}:${stat.size}`;
    if (k === key) return;
    const res = readVscdbKey(stateDbPath, EDITOR_STATE_KEY);
    if (!res.ok) {
      if (res.error && !warned) { warned = true; log('open-session ids read failed: %s', res.error.message); }
      return;   // lecture ratée → on garde le dernier ensemble connu
    }
    key = k;
    warned = false;
    const analyzed = analyzeEditorState(res.value);
    ids = analyzed.ids;
    locations = {
      byId: analyzed.locations,
      activeFlatIndex: analyzed.activeFlatIndex != null ? analyzed.activeFlatIndex : null,
    };
  }

  return {
    get() { refresh(); return ids; },
    // La PHOTO des positions : { byId: Map<sessionId, {viewColumn,index,flatIndex}>,
    // activeFlatIndex }. Même lecture, même cadence — c'est le même memento, il
    // serait absurde de le rouvrir pour la question voisine. Elle n'est jamais
    // consommée telle quelle : `tab-positions.js` la valide d'abord contre
    // l'état frais, en bloc.
    locations() { refresh(); return locations; },
    // Un clic est rare et doit viser juste : on force alors une relecture, au
    // lieu de servir une photo qui peut avoir jusqu'à MIN_STAT_INTERVAL_MS de
    // retard alors que le fichier a déjà été flushé. Sans ça, le cache de
    // cadence — utile pour les dizaines de lectures par seconde du moteur —
    // devenait lui-même une source de positions périmées.
    freshLocations() { lastStatAt = 0; refresh(); return locations; },
  };
}

// createRendererActive(path) → { get(): { sessionId, claude, flushedAt }, bump() }
// — la session Claude dont l'onglet est ACTIF dans cette fenêtre, au sens du
// memento sur disque (cf. analyzeEditorState), datée du flush qui l'a écrite.
//
// C'est la SEULE source d'onglet actif étrangère à la copie miroir tabGroups
// de l'hôte d'extension — celle-ci a prouvé qu'elle sait mentir des minutes
// durant, fenêtre focusée, sans qu'aucun événement ne vienne jamais la
// corriger (journal 2026-08-27, fenêtre « 142 modifications »). state.js s'en
// sert comme JUGE du surlignage : une divergence n'est tranchée par ce lecteur
// que si son flush est POSTÉRIEUR au dernier changement adopté par le tracker
// d'onglets (l'arbitrage vit dans buildSnapshot, pas ici).
//
// `flushedAt` = mtime le plus récent du couple state.vscdb / state.vscdb-wal :
// SQLite en mode WAL écrit d'abord dans le -wal, le fichier principal ne bouge
// qu'au checkpoint — dater le seul principal, c'est se croire plus vieux qu'on
// est, donc perdre des arbitrages légitimes. La clé de relecture couvre les
// deux fichiers pour la même raison.
//
// `bump()` : force la prochaine lecture à re-stater tout de suite (appelé par
// le fs.watch d'extension.js sur le state.vscdb — le flush du renderer est la
// seule horloge de cette vérité, le guetter rend la réconciliation quasi
// immédiate au lieu d'attendre le tick 30 s du moteur).
//
// Sens de l'échec, comme partout dans ce module : toute lecture ratée garde le
// dernier état connu ; un memento illisible/absent rend { sessionId:null,
// claude:false } — l'arbitre ne fait alors RIEN, comportement d'avant ce lot.
const RENDERER_ACTIVE_STAT_MS = 1000;
function createRendererActive(stateDbPath, options = {}) {
  const minStatIntervalMs = options.minStatIntervalMs != null
    ? options.minStatIntervalMs : RENDERER_ACTIVE_STAT_MS;
  let current = { sessionId: null, claude: false, flushedAt: null };
  let key = null;
  let lastStatAt = 0;
  let warned = false;

  return {
    bump() { lastStatAt = 0; },
    get() {
      if (!stateDbPath) return current;
      const now = Date.now();
      if (lastStatAt && now - lastStatAt < minStatIntervalMs) return current;
      lastStatAt = now;
      let main;
      try { main = fs.statSync(stateDbPath); } catch { return current; }
      let wal = null;
      try { wal = fs.statSync(stateDbPath + '-wal'); } catch {}
      const k = `${main.mtimeMs}:${main.size}:${wal ? wal.mtimeMs : 0}:${wal ? wal.size : 0}`;
      if (k === key) return current;
      const res = readVscdbKey(stateDbPath, EDITOR_STATE_KEY);
      if (!res.ok) {
        if (res.error && !warned) { warned = true; log('renderer-active read failed: %s', res.error.message); }
        return current;
      }
      key = k;
      warned = false;
      const active = analyzeEditorState(res.value).active;
      current = {
        sessionId: (active && active.claude && active.sessionId) || null,
        claude: !!(active && active.claude),
        flushedAt: Math.max(main.mtimeMs, wal ? wal.mtimeMs : 0),
      };
      return current;
    },
  };
}

module.exports = {
  createSessionTitles, cleanLabel, MIN_STAT_INTERVAL_MS, CACHE_KEY,
  createOpenSessionIds, EDITOR_STATE_KEY,
  analyzeEditorState, createRendererActive, RENDERER_ACTIVE_STAT_MS,
};
