// Moteur d'état des conversations (lot 2).
//
// Agrège, pour le workspace courant :
//   - ~/.claude/sessions-state.json  → état posé par les hooks (busy/waiting/done)
//   - ~/.claude/projects/<ws>/*.jsonl → modèle réel, ctx%, titre, activité (mtime)
//   - ~/.claude/active-session.json  → quelle conv a reçu le dernier prompt
//     (repli du surlignage seulement — le surlignage suit l'onglet sélectionné)
//
// Réactif : fs.watch sur les deux dossiers → push instantané, AUCUN poll 5 min
// pour l'état (le poll réseau ne subsiste que pour le quota, dans extension.js).
//
// Aucune dépendance à `vscode` : le workspace est injecté → module testable en
// Node pur (node -e "require('./state.js')...").
//
// Une conv sans onglet ouvert nulle part est masquée (lot 5, cf. isGone) : la
// présence d'onglet est injectée via `tabs`, jamais lue ici — c'est ce qui garde
// le module hors de `vscode`.
//
// API :
//   const { createStateEngine } = require('./state.js');
//   const engine = createStateEngine({ workspacePath, tabs, onChange: (snap) => {} });
//   engine.getSnapshot();        // { conversations: [...], activeSessionId, generatedAt }
//   engine.markClosed([ids]);    // onglets fermés → retrait immédiat
//   engine.dispose();
//   tabs: () => ({ known: boolean, labels: string[], activeLabel: string|null })
//         — union de toutes les fenêtres ; activeLabel = onglet Claude
//           sélectionné dans CETTE fenêtre (surlignage par fenêtre)
//
// Une conversation du snapshot :
//   { sessionId, title, state, acked, since, busySince, model, modelId,
//     ctx: {tokens, denom, pct}, message, isActive, transcript, mtime }
//   state ∈ busy | waiting | done | stale | idle
//   acked : le ✓ a-t-il été lu (onglet consulté après la fin du tour) — lot 6

const fs = require('fs');
const os = require('os');
const path = require('path');
const { modelIdToDisplay, detectContextWindow } = require('./hooks/model-id.js');
const { usageTokens, extractLastAssistant, extractTitleInfo, scanAiTitleIncremental, hasPendingInteractiveTool, wasInterrupted } = require('./hooks/transcript.js');
const { labelMatches } = require('./labels.js');
const { removeSession } = require('./hooks/sessions-state.js');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SESSIONS_STATE_PATH = path.join(CLAUDE_DIR, 'sessions-state.json');
const ACTIVE_SESSION_PATH = path.join(CLAUDE_DIR, 'active-session.json');

// Une conv `busy` dont le transcript n'a rien écrit depuis 5 min est un zombie
// (process tué, crash, VS Code fermé sans SessionEnd) → affichée `stale`.
// Affichage seulement : on ne tue rien (garde-fou du plan).
const STALE_MS = 5 * 60 * 1000;
// Marge avant de lire une écriture transcript comme une REPRISE du travail
// (après une permission accordée, ou après un Stop qui n'a pas fini le tour).
// Elle absorbe le voisinage immédiat du hook : le dernier message assistant du
// tour s'écrit à quelques centaines de ms du Stop.
const RESUME_GRACE_MS = 2000;
// Entrée d'état sans transcript actif depuis ce délai → on ne l'affiche plus.
const STATE_ENTRY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Onglet fermé (lot 5) : une écriture transcript dans les secondes qui suivent
// est un reliquat de la session qu'on vient de tuer, pas une reprise. Au-delà,
// c'est que la conv est repartie (resume) → elle a le droit de réapparaître.
const CLOSE_GRACE_MS = 10 * 1000;
// Entrée hooks avec un `transcript` renseigné mais dont le FICHIER n'existe pas
// encore (lot 12) : une conv toute neuve peut légitimement précéder de quelques
// secondes la première écriture de son transcript — pas un débris. Au-delà de ce
// délai sans que le fichier apparaisse (session avortée : incident du 2026-07-16,
// entrée jamais suivie d'un transcript), c'est un reliquat → purgé.
const TRANSCRIPT_MISSING_PURGE_MS = 5 * 60 * 1000;

const DEFAULTS = { recentMs: 4 * 60 * 60 * 1000, maxItems: 12, debounceMs: 250, tickMs: 30000 };

// ~/.claude/projects/<dir> : VS Code workspace → nom de dossier projet.
// c:\Users\X\Projets → c--Users-X-Projets (même dérivation que Claude Code).
function projectDirFor(workspacePath) {
  if (!workspacePath) return null;
  const dirName = workspacePath
    .replace(/^([A-Za-z]):[\\/]/, (_, d) => d.toLowerCase() + '--')
    .replace(/[\\/\s]/g, '-');
  return path.join(CLAUDE_DIR, 'projects', dirName);
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function readSessionsState() {
  const s = readJson(SESSIONS_STATE_PATH);
  return s && s.sessions ? s.sessions : {};
}

function readActiveSessionId() {
  const a = readJson(ACTIVE_SESSION_PATH);
  return a && a.session_id ? a.session_id : null;
}

function statMtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

// busy vs zombie : seul le transcript dit si ça travaille encore.
function busyOrStale(mtime, now) {
  return now - mtime > STALE_MS ? 'stale' : 'busy';
}

// Le transcript écrit ENCORE, et il écrit APRÈS le hook : le travail a repris.
// La condition de fraîcheur n'est pas cosmétique — sans elle, une entrée d'état
// ancienne dont la dernière écriture est postérieure de 3 s au hook serait lue
// comme « en train de travailler » pour l'éternité.
function isResuming(since, mtime, now) {
  return mtime > since + RESUME_GRACE_MS && now - mtime <= STALE_MS;
}

// État affiché = état posé par les hooks, corrigé par l'activité réelle du
// transcript. Trois corrections indispensables, toutes fondées sur le même
// constat : les hooks disent ce qui s'est passé, le transcript dit ce qui se
// passe.
//  - `waiting` : quand l'user accorde une permission, Claude reprend le travail
//    mais AUCUN hook ne le signale (pas d'événement « permission accordée »).
//    Une écriture transcript postérieure au passage en waiting = reprise.
//  - `done` : le hook Stop tire AUSSI quand le tour continue — Stop hook à
//    feedback (un exit 2 qui relance Claude, ex. doc-commit-reminder), message
//    envoyé en cours de tour. La conv affichait alors ✓ en pleine bosse. Même
//    remède : l'écriture postérieure fait foi. Mais le repli est `done`, JAMAIS
//    `stale` : quand les écritures cessent, le tour est bel et bien terminé —
//    prétendre le contraire serait remplacer un faux ✓ par un faux zombie.
//  - `busy` : vieillissement (process mort → zombie), cf. busyOrStale.
function effectiveState(entry, mtime, now) {
  if (!entry || !entry.state) return 'idle';
  const since = entry.since || entry.updated_at || 0;
  switch (entry.state) {
    case 'waiting':
      return mtime > since + RESUME_GRACE_MS ? busyOrStale(mtime, now) : 'waiting';
    case 'busy':
      return busyOrStale(mtime, now);
    case 'done':
      return isResuming(since, mtime, now) ? 'busy' : 'done';
    default:
      return 'idle';
  }
}

// « Lu » : l'onglet a été consulté après la fin du tour (ack_ts posé par ack.js,
// via l'extension). Le ✓ vif ne s'éteint donc plus par un timer arbitraire — le
// lot 2 le passait en gris au bout de 30 min, que l'user l'ait vu ou non.
// Un nouveau Stop réarme le vif tout seul : `since` repasse devant `ack_ts`.
// Pas d'entrée `done` connue (conv d'avant les hooks, ou simple idle) → rien à
// relire → « lu ».
function isAcked(entry) {
  if (!entry || entry.state !== 'done') return true;
  const since = entry.since || entry.updated_at || 0;
  return (entry.ack_ts || 0) >= since;
}

// ── Présence d'onglet (lot 5) ──────────────────────────────────────────────
// La disparition d'une conv ne repose PLUS sur le hook SessionEnd, qui ne tire
// ni sur /exit ni sur /clear (anthropics/claude-code#17885, #6428) et reste
// erratique à la fermeture d'onglet (#14760, #45424) : sans lui, la conv
// traînait jusqu'à recentMs (4 h) ou au fade `done` (30 min) — la latence
// signalée par l'user. La vérité, c'est l'onglet.
//
// Ce filtre s'applique à CHAQUE snapshot, pas au seul démarrage : il couvre donc
// par construction tout l'historique — convs fermées extension éteinte, convs
// antérieures au lot 5, convs antérieures à l'installation des hooks (jamais
// entrées dans sessions-state.json, vues via leur transcript seul, donc `idle`,
// donc filtrées comme les autres).
//
// `tabs.known` à false = on ne sait rien des onglets (option absente, tracker
// mort) → on ne masque RIEN : le doute profite à l'affichage.
const NO_TABS = { known: false, labels: [] };

function hasOpenTab(title, tabs) {
  return tabs.labels.some((l) => labelMatches(l, title));
}

// c : { sessionId, title, titleSource, state, mtime }
function isGone(c, tabs, closedAt) {
  if (!tabs.known) return false;
  // Ouverte ici ou dans une autre fenêtre (union publiée par tabs.js).
  if (hasOpenTab(c.title, tabs)) return false;

  // Onglet fermé sous nos yeux : règle user explicite, ça prime sur l'état —
  // une conv fermée en plein travail disparaît quand même.
  const closed = closedAt.get(c.sessionId);
  if (closed != null) {
    if ((c.mtime || 0) <= closed + CLOSE_GRACE_MS) return true;
    // Écriture postérieure à la grâce : la session est repartie ailleurs.
    closedAt.delete(c.sessionId);
  }

  // Sans onglet mais vivante = session CLI/terminal légitime → on garde.
  // `stale` n'en est pas : c'est « plus rien d'écrit depuis 5 min », donc on ne
  // peut pas la dire vivante — et c'est justement l'état où atterrit une conv
  // fermée pendant que VS Code était éteint (SessionEnd n'ayant pas tiré).
  if (c.state === 'busy' || c.state === 'waiting') return false;

  // Titre de repli : il ne peut PAS matcher un libellé d'onglet de façon fiable,
  // donc son absence de correspondance ne prouve rien.
  if (c.titleSource !== 'ai-title') return false;

  return true;
}

// Lecture d'un transcript avec cache : pendant qu'une conv travaille, fs.watch
// tire un recompute à chaque écriture. Sans ce cache on relirait 64 Ko × N convs
// plusieurs fois par seconde. Clé d'invalidation : (mtime, size).
//
// `titleScans` (lot 8) est un cache SÉPARÉ, à part : contrairement au cache
// value ci-dessus (jetable, une entrée par (mtime,size)), le scan d'ai-title
// doit survivre à travers les recomputes pour rester incrémental — sinon
// chaque écriture relirait le fichier depuis l'octet 0. Coût : O(delta) par
// écriture au lieu de O(fichier) ; premier passage = scan complet, une fois.
function createTranscriptReader() {
  const cache = new Map();
  const titleScans = new Map();
  // Dernier état assistant connu par fichier (modèle + ctx), CONSERVÉ à travers
  // les recomputes — comme titleScans, contrairement au cache (mtime,size)
  // jetable ci-dessus. extractLastAssistant ne lit que TAIL_BYTES (64 Ko) : un
  // seul tool_result géant en queue (screenshot base64, gros fichier lu, longue
  // sortie de commande) tient sur une ligne > 64 Ko et pousse le dernier message
  // assistant hors de la fenêtre → extractLastAssistant rend null, et le modèle
  // ET le ctx% disparaissaient du panneau (« — » intermittent, signalé
  // 2026-07-22 : « finit par s'afficher au bout d'un moment », c.-à-d. quand un
  // assistant repasse dans la fenêtre). On réaffiche alors le dernier connu :
  // jamais faux (le modèle d'une session ne change pas), ctx% éventuellement un
  // peu ancien — préférable à un blanc clignotant. La toute première ouverture
  // (aucun assistant encore écrit) reste « — » quelques secondes : rien à
  // mémoriser tant que le premier tour n'a pas produit de réponse.
  const lastAssistant = new Map();
  return function read(filePath) {
    let stat;
    try { stat = fs.statSync(filePath); } catch { return null; }
    const key = `${stat.mtimeMs}:${stat.size}`;
    const hit = cache.get(filePath);
    if (hit && hit.key === key) return hit.value;

    let value = { title: null, titleSource: null, modelId: null, model: null, ctx: null, mtime: stat.mtimeMs, pendingInteractive: false, interrupted: false };
    try {
      value.pendingInteractive = hasPendingInteractiveTool(filePath);
      value.interrupted = wasInterrupted(filePath);
      const last = extractLastAssistant(filePath);
      if (last) {
        value.modelId = last.modelId;
        value.model = modelIdToDisplay(last.modelId);
        const tokens = usageTokens(last.usage);
        if (tokens > 0) {
          const denom = detectContextWindow(last.modelId, tokens);
          value.ctx = { tokens, denom, pct: Math.min(100, (tokens / denom) * 100) };
        }
        lastAssistant.set(filePath, { modelId: value.modelId, model: value.model, ctx: value.ctx });
      } else {
        // Dernier assistant hors des 64 Ko (gros tool_result en queue) : garder
        // l'affichage précédent plutôt que l'effacer.
        const prev = lastAssistant.get(filePath);
        if (prev) { value.modelId = prev.modelId; value.model = prev.model; value.ctx = prev.ctx; }
      }
      let titleState = titleScans.get(filePath);
      if (!titleState) {
        titleState = { scannedBytes: 0, aiTitle: null };
        titleScans.set(filePath, titleState);
      }
      scanAiTitleIncremental(filePath, titleState);
      const t = extractTitleInfo(filePath, titleState.aiTitle);
      value.title = t.title;
      value.titleSource = t.source;
    } catch {}

    cache.set(filePath, { key, value });
    return value;
  };
}

// Une session appartient au workspace si son transcript vit dans le dossier
// projet du workspace. Repli sur cwd quand le hook n'a pas transmis de
// transcript_path (payload partiel).
function belongsToWorkspace(entry, projectDir, workspacePath) {
  if (entry.transcript) {
    try {
      return path.resolve(path.dirname(entry.transcript)).toLowerCase()
           === path.resolve(projectDir).toLowerCase();
    } catch { return false; }
  }
  if (entry.cwd && workspacePath) {
    return path.resolve(entry.cwd).toLowerCase() === path.resolve(workspacePath).toLowerCase();
  }
  return false;
}

function listTranscripts(projectDir) {
  try {
    return fs.readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ sessionId: f.slice(0, -6), file: path.join(projectDir, f) }));
  } catch { return []; }
}

// Construit le snapshot : union des sessions connues des hooks et des
// transcripts récents du workspace (une conv ouverte avant l'installation des
// hooks n'a pas d'entrée d'état — elle doit quand même apparaître, en idle).
function buildSnapshot(opts, readTranscript) {
  const { workspacePath, recentMs, maxItems } = opts;
  const now = Date.now();
  const projectDir = projectDirFor(workspacePath);
  const activeSessionId = readActiveSessionId();
  const entries = readSessionsState();
  const byId = new Map();

  if (projectDir) {
    for (const { sessionId, file } of listTranscripts(projectDir)) {
      const mtime = statMtime(file);
      const entry = entries[sessionId];
      const fresh = entry && now - (entry.updated_at || 0) < STATE_ENTRY_MAX_AGE_MS;
      if (!fresh && now - mtime > recentMs) continue;
      byId.set(sessionId, { sessionId, transcript: file, mtime, entry: fresh ? entry : null });
    }
  }

  // Sessions connues des hooks dont le transcript n'a pas été listé (fichier
  // pas encore créé au tout 1er prompt) : on les garde, sans données transcript
  // — SAUF si l'entrée pointe vers un fichier transcript qui n'existe pas :
  // sans fichier, pas de titre, pas de modèle, pas de matching d'onglet possible
  // ni de retrait fiable par le filtre de présence (lot 5) → une ligne fantôme
  // « Conversation » irrécupérable (incident 2026-07-16). Ces entrées ne sont
  // jamais rendues ; celles qui dépassent le délai de grâce sont purgées du
  // fichier d'état (débris — SessionEnd n'est pas fiable, cf. lot 5).
  const debrisIds = [];
  for (const [sessionId, entry] of Object.entries(entries)) {
    if (byId.has(sessionId) || !entry) continue;
    if (now - (entry.updated_at || 0) > STATE_ENTRY_MAX_AGE_MS) continue;
    if (!belongsToWorkspace(entry, projectDir, workspacePath)) continue;
    if (entry.transcript && !fs.existsSync(entry.transcript)) {
      const bornAt = entry.updated_at || entry.since || now;
      if (now - bornAt > TRANSCRIPT_MISSING_PURGE_MS) debrisIds.push(sessionId);
      continue;
    }
    byId.set(sessionId, {
      sessionId,
      transcript: entry.transcript || null,
      mtime: entry.transcript ? statMtime(entry.transcript) : (entry.updated_at || 0),
      entry,
    });
  }
  for (const id of debrisIds) removeSession(id);

  // Trier sur mtime (connu par statSync, aucune lecture) puis lire les
  // transcripts UN PAR UN jusqu'à tenir maxItems convs VISIBLES — et pas lire
  // les maxItems premiers en bloc. La lecture (64 Ko/fichier) est de loin
  // l'étape chère : mesuré sur un dossier projet à 374 transcripts, 209 ms si on
  // lit tout contre 15 ms pour 12. Le cas nominal (rien de masqué) en lit donc
  // toujours exactement maxItems.
  //
  // Pourquoi pas simplement filtrer après troncature : le filtre de présence
  // masque désormais l'essentiel de l'historique, et les convs masquées
  // consommeraient les 12 places. Vérifié — 12 convs fermées plus récentes
  // qu'une conv OUVERTE donnaient un panneau VIDE, la seule conv ouverte étant
  // 13e au tri. SCAN_LIMIT borne le coût du cas dégradé (tout est masqué) au
  // lieu de relire les 374.
  const candidates = [...byId.values()].sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  const SCAN_LIMIT = maxItems * 4;

  const tabs = (typeof opts.tabs === 'function' && opts.tabs()) || NO_TABS;
  const closedAt = opts.closedAt instanceof Map ? opts.closedAt : new Map();

  const conversations = [];
  for (const c of candidates.slice(0, SCAN_LIMIT)) {
    if (conversations.length >= maxItems) break;
    const t = c.transcript ? readTranscript(c.transcript) : null;
    let state = effectiveState(c.entry, c.mtime, now);
    // Interruption manuelle (bouton Stop / Échap) : aucun hook ne tire (by
    // design, anthropics/claude-code#45289), donc l'entrée reste `busy` — le
    // transcript est seul à savoir (wasInterrupted). Prioritaire sur le détour
    // interactif ci-dessous (le dernier message n'est plus un tool_use en
    // attente mais l'interruption elle-même) ET sur le vieillissement
    // busy→stale : on retombe `idle` tout de suite, fin du spinner qui tournait
    // jusqu'à STALE_MS (5 min) dans le vide. `idle` et pas `done` : l'user vient
    // de couper lui-même, il regarde déjà la conv — aucun ✓ vif « va voir » à
    // armer, et aucun son (onTransition n'émet que sur done/waiting).
    //
    // Lot 11 : AskUserQuestion/ExitPlanMode ne déclenchent AUCUN hook non plus —
    // sans ce détour, la conv reste `busy` (voire `stale` après STALE_MS) jusqu'au
    // hook Notification `idle_prompt`, qui ne tire qu'après 60 s fixes. Ne
    // s'applique qu'aux sessions posées `busy` par les hooks — un `waiting`
    // (permission) ou `done` (déjà fini) ne doit pas être perturbé.
    if (c.entry && c.entry.state === 'busy' && t && t.interrupted) state = 'idle';
    else if (c.entry && c.entry.state === 'busy' && t && t.pendingInteractive) state = 'waiting';
    const title = (t && t.title) || 'Conversation';
    const gone = isGone(
      { sessionId: c.sessionId, title, titleSource: t && t.titleSource, state, mtime: c.mtime },
      tabs, closedAt
    );
    if (gone) continue;
    conversations.push({
      sessionId: c.sessionId,
      title,
      state,
      acked: isAcked(c.entry),
      since: (c.entry && (c.entry.since || c.entry.updated_at)) || c.mtime || null,
      // Démarrage du run en cours (lot 10, posé par le hook UserPromptSubmit) —
      // distinct de `since` ci-dessus, qui est réécrit à chaque `done`/`waiting`.
      // Sert uniquement à l'ack strict côté extension.js ; absent (conv
      // d'avant ce lot) → l'appelant ne doit RIEN en déduire, pas un skip.
      busySince: (c.entry && c.entry.busy_since) || null,
      model: (t && t.model) || null,
      modelId: (t && t.modelId) || null,
      ctx: (t && t.ctx) || null,
      message: state === 'waiting' && c.entry ? (c.entry.message || null) : null,
      isActive: false,
      transcript: c.transcript,
      mtime: c.mtime,
    });
  }

  // Surlignage « conversation courante » = la conv dont l'ONGLET est sélectionné
  // dans cette fenêtre (tabs.activeLabel, mémorisé par tabs.js). Avant le
  // 2026-07-19 il suivait active-session.json — la conv du DERNIER PROMPT
  // SOUMIS — et ne bougeait donc jamais au clic sur un onglet. Ce fichier ne
  // sert plus que de repli quand la fenêtre n'a encore jamais eu d'onglet Claude
  // sélectionné (fenêtre fraîche, panneau seul). Un activeLabel qui ne matche
  // AUCUNE conv listée (titre renommé onglet inactif, conv hors maxItems) ne se
  // rabat PAS sur le repli : aucun surlignage vaut mieux qu'un surlignage faux.
  // findIndex = premier match dans l'ordre du tri (le plus récemment actif),
  // même arbitrage d'ambiguïté de préfixe tronqué que focus.js.
  const activeLabel = (tabs && tabs.activeLabel) || null;
  if (activeLabel) {
    const i = conversations.findIndex((c) => labelMatches(activeLabel, c.title));
    if (i >= 0) conversations[i].isActive = true;
  } else {
    for (const c of conversations) c.isActive = c.sessionId === activeSessionId;
  }

  // Déjà trié (plus récemment actif en tête) et borné à maxItems ci-dessus.
  return { conversations, activeSessionId, generatedAt: now };
}

// Ce que le webview AFFICHE, et rien d'autre. Le snapshot porte aussi des champs
// qui bougent sans rien changer à l'écran — au premier chef `mtime`, réécrit à
// chaque ligne du transcript pendant qu'une conv travaille. Les inclure ici
// revenait à notifier le panneau en boucle pendant un run, donc à re-rendre ses
// nœuds, donc à remettre l'animation du spinner à zéro (lot 6c) : le rendu
// incrémental de panel.js encaisse déjà ce cas, autant ne pas produire le bruit.
function renderKey(convs) {
  return JSON.stringify(convs.map((c) => [
    c.sessionId, c.title, c.state, c.acked, c.model,
    c.ctx ? Math.round(c.ctx.pct) : null, c.isActive, c.message,
  ]));
}

function createStateEngine(options = {}) {
  // Onglets fermés observés par tabs.js : sessionId → instant de fermeture.
  // Le moteur en est propriétaire ; isGone() y purge les sessions reparties.
  const closedAt = new Map();
  const opts = { ...DEFAULTS, ...options, closedAt };
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
  const readTranscript = createTranscriptReader();
  const watchers = [];
  let snapshot = buildSnapshot(opts, readTranscript);
  let lastKey = renderKey(snapshot.conversations);
  let debounce = null;
  let disposed = false;

  function recompute() {
    if (disposed) return;
    const next = buildSnapshot(opts, readTranscript);
    const key = renderKey(next.conversations);
    snapshot = next;
    // generatedAt et mtime bougent en permanence : ne notifier que si le RENDU
    // change vraiment (cf. renderKey).
    if (key === lastKey) return;
    lastKey = key;
    try { onChange(snapshot); } catch {}
  }

  function schedule() {
    if (disposed) return;
    clearTimeout(debounce);
    debounce = setTimeout(recompute, opts.debounceMs);
  }

  function watch(dir, filter) {
    try {
      const w = fs.watch(dir, (_evt, filename) => {
        if (!filename || filter(filename)) schedule();
      });
      watchers.push(w);
    } catch {}
  }

  watch(CLAUDE_DIR, (f) => f === 'sessions-state.json' || f === 'active-session.json');
  const projectDir = projectDirFor(opts.workspacePath);
  if (projectDir && fs.existsSync(projectDir)) watch(projectDir, (f) => f.endsWith('.jsonl'));

  // Tick d'horloge — PAS un poll de données : busy→stale et done→idle sont des
  // transitions PUREMENT temporelles, qui ne produisent aucun événement fichier
  // (un process mort n'écrit plus, justement). Sans ce tick, un zombie resterait
  // « au travail » à l'écran indéfiniment. Coût : quelques statSync/30 s, et
  // onChange n'est appelé que si le rendu change réellement.
  const ticker = setInterval(recompute, opts.tickMs);

  return {
    getSnapshot: () => snapshot,
    refresh: recompute,
    // Onglet(s) fermé(s) : on retire tout de suite, SANS attendre la purge de
    // sessions-state.json que fait l'appelant derrière — celle-ci prend un lock
    // inter-process et peut traîner ; l'affichage, lui, doit tomber sous la
    // seconde (exigence du lot).
    markClosed(sessionIds) {
      const now = Date.now();
      let touched = false;
      for (const id of sessionIds || []) {
        if (!id) continue;
        closedAt.set(id, now);
        touched = true;
      }
      if (!touched) return;
      for (const [id, ts] of closedAt) {
        if (now - ts > STATE_ENTRY_MAX_AGE_MS) closedAt.delete(id);
      }
      recompute();
    },
    dispose() {
      disposed = true;
      clearTimeout(debounce);
      clearInterval(ticker);
      for (const w of watchers) { try { w.close(); } catch {} }
      watchers.length = 0;
    },
  };
}

module.exports = {
  createStateEngine,
  buildSnapshot,
  projectDirFor,
  effectiveState,
  isAcked,
  isGone,
  readSessionsState,
  readActiveSessionId,
  createTranscriptReader,
  SESSIONS_STATE_PATH,
  STALE_MS,
  RESUME_GRACE_MS,
  CLOSE_GRACE_MS,
  TRANSCRIPT_MISSING_PURGE_MS,
  DEFAULTS,
};
