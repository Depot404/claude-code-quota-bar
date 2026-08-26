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

// Parcourt l'arbre `serializedGrid.root` (noeuds "branch"/"leaf", cf.
// EDITOR_STATE_KEY ci-dessus) et rend l'ensemble des sessionId dont un onglet
// webview Claude est ouvert ICI. Aucune exception ne doit remonter : un
// noeud/éditeur malformé (schéma qui bouge, une extension tierce dont le JSON
// diffère) est simplement ignoré, jamais fatal pour les autres.
function sessionIdsFromEditorState(parsed) {
  const ids = new Set();
  const root = parsed && parsed['editorpart.state'] && parsed['editorpart.state'].serializedGrid
    && parsed['editorpart.state'].serializedGrid.root;
  if (!root) return ids;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.type === 'branch' && Array.isArray(node.data)) {
      for (const child of node.data) stack.push(child);
      continue;
    }
    if (node.type !== 'leaf' || !node.data || !Array.isArray(node.data.editors)) continue;
    for (const editor of node.data.editors) {
      if (!editor || typeof editor.value !== 'string') continue;
      let outer;
      try { outer = JSON.parse(editor.value); } catch { continue; }
      if (!outer || outer.extensionId !== CLAUDE_EXTENSION_ID || typeof outer.state !== 'string') continue;
      let inner;
      try { inner = JSON.parse(outer.state); } catch { continue; }
      if (inner && typeof inner.sessionID === 'string' && inner.sessionID) ids.add(inner.sessionID);
    }
  }
  return ids;
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
  let key = null;
  let lastStatAt = 0;
  let warned = false;

  return {
    get() {
      if (!stateDbPath) return ids;
      const now = Date.now();
      if (lastStatAt && now - lastStatAt < minStatIntervalMs) return ids;
      lastStatAt = now;
      let stat;
      try { stat = fs.statSync(stateDbPath); } catch { return ids; }
      const k = `${stat.mtimeMs}:${stat.size}`;
      if (k === key) return ids;
      const res = readVscdbKey(stateDbPath, EDITOR_STATE_KEY);
      if (!res.ok) {
        if (res.error && !warned) { warned = true; log('open-session ids read failed: %s', res.error.message); }
        return ids;   // lecture ratée → on garde le dernier ensemble connu
      }
      key = k;
      warned = false;
      ids = sessionIdsFromEditorState(res.value);
      return ids;
    },
  };
}

module.exports = {
  createSessionTitles, cleanLabel, MIN_STAT_INTERVAL_MS, CACHE_KEY,
  createOpenSessionIds, EDITOR_STATE_KEY,
};
