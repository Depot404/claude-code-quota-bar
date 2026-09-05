// ============================================================================
// Lecteurs du state.vscdb du workspace : QUELS ONGLETS CLAUDE SONT OUVERTS ICI,
// et lequel est ACTIF — par IDENTITÉ de session, jamais par texte.
//
// ⚠️ Internal non documenté, sur un fichier dont VS Code est propriétaire :
//   - lecture SEULE, jamais d'écriture ;
//   - ouverture/lecture/FERMETURE à chaque rafraîchissement, aucun handle
//     persistant sur un fichier que VS Code réécrit dans notre dos ;
//   - toute erreur (module node:sqlite absent, base verrouillée, schéma
//     changé) → on garde le dernier état connu et on continue. Jamais
//     d'exception, jamais de masquage EN PLUS : le doute profite à l'affichage.
//
// ── LE STORE D'ONGLETS `agentSessions.model.cache` EST PARTI (2.114.0) ───────
// Ce module portait aussi `createSessionTitles`, la table sessionId → TITRE
// D'ONGLET lue dans la clé `agentSessions.model.cache` du même fichier. Elle
// alimentait `tabTitle`, `titleSource:'tab-store'` et la preuve « identité
// publiée + aucun onglet ⇒ conversation fermée ». MESURÉE MORTE le 2026-09-04
// sur le profil réel (rapport test/real-bench/RAPPORT_2026-09-04.md), re-mesurée
// le 2026-09-05 avant ce retrait : 2 entrées, dont UNE SEULE des 7 sessions dont
// un onglet est ouvert (14 %) — l'extension officielle n'y écrit plus. Une
// source qui ne parle plus ne dégrade pas : elle publie des identités PÉRIMÉES,
// donc elle conclut des fermetures fausses sur les deux conversations qu'elle
// connaît encore. Le lecteur est retiré plutôt que gardé (rien à garder), et
// personne ne le remplace : l'ouverture d'un onglet se lit désormais sur le
// memento ci-dessous (`createOpenSessionIds`), qui, lui, nomme les 7.
// S'il redevenait vivant un jour : `git show 98735301:Tools/ClaudeCodeQuotaBar/
// session-titles.js` en garde le code entier.
// ============================================================================

const fs = require('fs');

// Le vscdb est flushé paresseusement par VS Code : re-stater plus souvent que
// le tick d'horloge du moteur (30 s) ne rendrait rien de plus frais, alors que
// `get()` est appelé à CHAQUE snapshot (donc plusieurs fois par seconde pendant
// qu'une conv travaille).
const MIN_STAT_INTERVAL_MS = 30 * 1000;

// La table lue dans le state.vscdb (focus.js, lot « clic par
// identifiant ») : le memento de la grille d'éditeurs, seule source qui dit
// quels sessionId ont un onglet Claude ouvert DANS CETTE FENÊTRE — la Tab API
// de VS Code n'expose que `label`, jamais l'identité de session portée par le
// webview. Mesuré le 2026-08-25 : `{"editorpart.state":{"serializedGrid":
// {"root":{type,data:[...]}}}}`, arbre de noeuds "branch" (data = enfants) et
// "leaf" (data.editors[]) ; chaque éditeur webview Claude a un `value` JSON
// dont `state` est LUI-MÊME un JSON encodé portant `sessionID`.
const EDITOR_STATE_KEY = 'memento/workbench.parts.editor';
const CLAUDE_EXTENSION_ID = 'Anthropic.claude-code';

function log(fmt, ...args) { console.log('[QuotaBar] ' + fmt, ...args); }

// node:sqlite est expérimental (Node 22) et peut manquer selon la version de
// Node embarquée par VS Code : un seul log pour TOUT le module (les deux
// lecteurs partagent ce constat), puis dégradation définitive.
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

// Lecture bas niveau d'UNE clé du state.vscdb, partagée par les lecteurs
// qu'on y branche — même fichier, même garantie de dégradation (jamais
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
// lot « clic par identifiant », délai réel documenté dans
// test/real-bench/RAPPORT_2026-09-04.md — 12 à 51 s) : une fermeture d'onglet
// toute récente peut rester invisible ici quelques secondes. Ce Set n'a AUCUN
// garde-fou contre un zéro : un zéro réel est un résultat honnête (fenêtre sans
// onglet Claude), et l'exposer tel quel est SANS DANGER — il ne fait au pire
// que renvoyer focus.js vers son repli par libellé. Le sens dangereux est
// l'inverse (un
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
    // Même rôle que createRendererActive.bump() (2026-09-04) : le fs.watch
    // d'extension.js sur le state.vscdb voit chaque flush du renderer — la
    // photo des positions doit se relire à cet instant, pas au prochain tick
    // de la cadence. Sans ça, le clic (freshLocations) et le surlignage /
    // la présence (locations) lisaient le MÊME memento à deux fraîcheurs et
    // pouvaient se contredire jusqu'à 30 s (journal 2026-09-04 21:22:09 :
    // clic résolu par identité, surlignage `via:none` pendant 19 s).
    bump() { lastStatAt = 0; },
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
  MIN_STAT_INTERVAL_MS,
  createOpenSessionIds, EDITOR_STATE_KEY,
  analyzeEditorState, createRendererActive, RENDERER_ACTIVE_STAT_MS,
};
