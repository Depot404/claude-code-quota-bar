'use strict';
// Coût estimé ($) consommé par une conversation depuis son début.
//
// POURQUOI — le %ctx d'une ligne est une PHOTO (ce que pèse le contexte à
// l'instant t) ; il ne dit rien de l'INTÉGRALE, c.-à-d. de ce que la
// conversation a réellement consommé depuis son premier prompt. Une conv à 20 %
// de contexte qui a compacté trois fois a coûté bien plus qu'une conv à 70 %
// ouverte il y a dix minutes.
//
// ZÉRO TOKEN DÉPENSÉ POUR LE CALCUL : pur parsing local des transcripts
// ~/.claude/projects/<ws>/<session>.jsonl, qui portent déjà `message.usage`
// sur chaque message assistant. Aucun appel réseau, aucune API d'usage.
//
// CONTRAINTE DURE — un transcript fait couramment des dizaines de Mo et le
// moteur recalcule au moins toutes les 30 s : on ne relit JAMAIS le fichier
// entier à chaque tick. L'accumulateur ci-dessous garde, par fichier, l'octet
// où il s'est arrêté et les totaux acquis ; un tick ne parse que l'APPEND.

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Grille tarifaire ────────────────────────────────────────────────────────
// $/Mtok, tarif de LISTE de l'API Anthropic (référence embarquée de la skill
// claude-api, cachée 2026-06-24, relue 2026-08-18). Match par SOUS-CHAÎNE de
// l'id de modèle, jamais un id complet figé : `claude-opus-4-8`,
// `claude-opus-5`, un `claude-opus-6` à venir — tous « opus ». Figer des ids
// complets voudrait dire une mise à jour de l'extension à chaque modèle.
//
// Le tarif de LANCEMENT de Sonnet 5 (2/10 jusqu'au 2026-08-31) est
// délibérément ignoré : il est temporaire et ne s'applique pas à tout le monde
// — on affiche le tarif de liste, et le montant est étiqueté « ≈ ».
const FAMILIES = [
  { key: 'fable', input: 10, output: 50 },
  { key: 'mythos', input: 10, output: 50 },
  { key: 'opus', input: 5, output: 25 },
  { key: 'sonnet', input: 3, output: 15 },
  { key: 'haiku', input: 1, output: 5 },
];
// Famille inconnue (modèle sorti après cette version de l'extension) → tarif
// opus, médian de la grille. C'est une ESTIMATION, le tooltip commence par ≈ :
// mieux vaut un ordre de grandeur qu'un blanc ou un zéro trompeur.
const UNKNOWN_FAMILY = { input: 5, output: 25 };
// Fast mode (research preview, Opus 5 / Opus 4.8) : même modèle, sortie plus
// rapide, tarif premium 10/50. `usage.speed === 'fast'` le dit message par
// message — un utilisateur qui bascule /fast en cours de conversation voit donc
// ses derniers tours facturés au bon prix, pas au prix moyen.
const FAST_MODE = { input: 10, output: 50 };

// Ratios de cache, communs à tous les modèles : une lecture de cache coûte
// 0,1× le tarif d'entrée, une écriture 1,25× (TTL 5 min) ou 2× (TTL 1 h).
const CACHE_READ_RATIO = 0.1;
const CACHE_WRITE_5M_RATIO = 1.25;
const CACHE_WRITE_1H_RATIO = 2;
// Outil serveur de recherche web : 10 $ / 1000 requêtes.
const WEB_SEARCH_COST = 0.01;

const PER_MTOK = 1e6;

// Tarif applicable à UN message : sa famille de modèle et sa vitesse, jamais
// « le modèle de la conversation » — une conv qui change de modèle en cours de
// route (/model) mélange les tarifs, et c'est le bon comportement.
function priceFor(modelId, speed) {
  const id = typeof modelId === 'string' ? modelId.toLowerCase() : '';
  const fam = FAMILIES.find((f) => id.includes(f.key));
  if (speed === 'fast' && fam && (fam.key === 'opus' || fam.key === 'mythos' || fam.key === 'fable')) return FAST_MODE;
  return fam || UNKNOWN_FAMILY;
}

function num(v) {
  return typeof v === 'number' && isFinite(v) && v > 0 ? v : 0;
}

// Décomposition du coût d'un `message.usage`. Rendue en QUATRE postes, ceux que
// le tooltip du panneau montre : l'entrée fraîche, le cache (lecture +
// écriture, les deux faces d'une même mécanique), la sortie, et les outils
// serveur. Le total est leur somme — jamais recalculé ailleurs.
function costOfUsage(usage, modelId) {
  if (!usage || typeof usage !== 'object') return null;
  const price = priceFor(modelId, usage.speed);
  const cacheCreation = usage.cache_creation && typeof usage.cache_creation === 'object' ? usage.cache_creation : null;
  // `cache_creation` détaille les deux TTL ; sur les transcripts d'avant son
  // introduction seul le total `cache_creation_input_tokens` existe — on le
  // traite alors comme du 5 min (le TTL par défaut), donc au ratio le plus
  // bas : sous-estimer une estimation vaut mieux que la gonfler.
  const w5m = cacheCreation ? num(cacheCreation.ephemeral_5m_input_tokens) : num(usage.cache_creation_input_tokens);
  const w1h = cacheCreation ? num(cacheCreation.ephemeral_1h_input_tokens) : 0;
  const server = usage.server_tool_use && typeof usage.server_tool_use === 'object' ? usage.server_tool_use : null;

  const input = (num(usage.input_tokens) * price.input) / PER_MTOK;
  const cacheRead = (num(usage.cache_read_input_tokens) * CACHE_READ_RATIO * price.input) / PER_MTOK;
  const cacheWrite = ((w5m * CACHE_WRITE_5M_RATIO + w1h * CACHE_WRITE_1H_RATIO) * price.input) / PER_MTOK;
  const output = (num(usage.output_tokens) * price.output) / PER_MTOK;
  const tools = server ? num(server.web_search_requests) * WEB_SEARCH_COST : 0;

  return {
    input, cacheRead, cacheWrite, output, tools,
    total: input + cacheRead + cacheWrite + output + tools,
  };
}

function emptyTotals() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, tools: 0, total: 0, messages: 0 };
}

function addTotals(totals, c) {
  totals.input += c.input;
  totals.cacheRead += c.cacheRead;
  totals.cacheWrite += c.cacheWrite;
  totals.output += c.output;
  totals.tools += c.tools;
  totals.total += c.total;
  totals.messages += 1;
}

// UN tour = tous les messages assistant entre deux prompts de l'utilisateur.
// La borne d'un tour est une entrée `type:"user"` qui n'est ni un résultat
// d'outil (`toolUseResult`, présent dès qu'un outil répond) ni une entrée
// système (`isMeta:true`, ex. l'annotation de taille d'une image collée) —
// vérifié sur transcript réel le 2026-08-18, jamais supposé. Le filtre est
// une simple recherche de sous-chaîne, AVANT tout JSON.parse : sur les grosses
// lignes de résultat d'outil, `"toolUseResult"` apparaît tôt et le indexOf
// s'arrête aussitôt, donc pas de coût de scan supplémentaire.
function isTurnBoundary(line) {
  return line.indexOf('"type":"user"') !== -1 &&
    line.indexOf('"toolUseResult"') === -1 &&
    line.indexOf('"isMeta":true') === -1;
}

// UN message assistant, PLUSIEURS lignes de transcript — piège vérifié sur
// transcript réel le 2026-08-17 : un message qui contient du thinking, du texte
// et un appel d'outil est écrit en trois entrées JSONL CONSÉCUTIVES portant le
// même `message.id` et le MÊME objet `usage` (79 ids dupliqués sur 267 entrées
// d'un transcript témoin). Compter chaque ligne triplerait la facture de ces
// tours. Les duplicats étant toujours consécutifs (vérifié : 0 duplicat non
// consécutif), se souvenir du DERNIER id suffit — pas besoin d'un Set qui
// grossirait sans fin, et ça survit à une coupure d'append (l'id est gardé dans
// l'état de l'accumulateur).
function consumeLine(line, state, sink) {
  // Détection de borne AVANT le filtre "usage" : un prompt utilisateur n'a
  // jamais d'`usage`, donc la couleur de rythme le raterait sinon.
  if (isTurnBoundary(line)) {
    // La couleur suit le dernier tour COMPLET, jamais le tour en cours : on ne
    // bascule `currentTurn` dans `lastTurn` qu'à la borne SUIVANTE, quand ce
    // tour est fini. La toute première borne ouvre le premier tour sans rien
    // clore (il n'y a encore rien à clore).
    if (state.turnOpen) {
      state.lastTurn = state.currentTurn;
      state.turns += 1;
    }
    state.currentTurn = 0;
    state.turnOpen = true;
  }
  // Filtre bon marché AVANT le JSON.parse : la majorité des lignes d'un
  // transcript sont des messages user / résultats d'outils, parfois de
  // plusieurs centaines de Ko. Les parser toutes coûterait le plus gros du
  // temps de lecture pour rien.
  if (line.indexOf('"usage"') === -1) return;
  let e;
  try { e = JSON.parse(line); } catch { return; }
  const msg = e && e.message;
  if (!msg || !msg.usage) return;
  const id = msg.id || null;
  if (id && id === state.lastMsgId) return;
  state.lastMsgId = id;
  const c = costOfUsage(msg.usage, msg.model);
  if (!c) return;
  addTotals(state.totals, c);
  state.currentTurn += c.total;
  // Second consommateur de la MÊME lecture (cf. createCostReader) : la
  // timeline globale, qui date chaque montant pour que les lignes de quota
  // puissent en resommer une fenêtre. `timestamp` est l'heure d'écriture de
  // l'entrée, en ISO — absente ou illisible, le montant compte pour la
  // conversation mais pour aucune fenêtre : on ne devine pas une date.
  if (sink) sink(Date.parse(e.timestamp), c.total, msg.model);
}

// 1 Mio : on lit l'append par tranches plutôt que d'allouer un buffer de la
// taille du fichier — le tout premier passage sur un transcript de 40 Mo ne
// doit pas réclamer 40 Mo d'un coup à l'hôte d'extension.
const CHUNK = 1 << 20;

// Consomme l'append de `filePath` dans `state`. Découpage sur les octets 0x0A
// en Buffer (jamais sur une chaîne) : un chunk peut tomber au milieu d'un
// caractère UTF-8 multi-octets, et décoder trop tôt le remplacerait par un
// caractère de remplacement — donc une ligne JSON invalide, donc un message
// perdu.
function consumeAppend(filePath, state, size, sink) {
  let fd;
  try { fd = fs.openSync(filePath, 'r'); } catch { return; }
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let rest = null;              // reliquat : ligne coupée entre deux chunks
    let pos = state.offset;
    let consumed = 0;             // octets validés (jusqu'au dernier \n inclus)
    while (pos < size) {
      const want = Math.min(CHUNK, size - pos);
      const n = fs.readSync(fd, buf, 0, want, pos);
      if (n <= 0) break;
      pos += n;
      let data = rest ? Buffer.concat([rest, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
      rest = null;
      let start = 0;
      let nl;
      while ((nl = data.indexOf(0x0a, start)) !== -1) {
        consumeLine(data.subarray(start, nl).toString('utf8'), state, sink);
        consumed += nl - start + 1;
        start = nl + 1;
      }
      // Queue sans saut de ligne : soit une ligne coupée par le chunk, soit la
      // DERNIÈRE ligne du fichier, en cours d'écriture par le CLI. Dans les
      // deux cas on ne la consomme pas — l'offset reste avant elle et le
      // prochain tick la relira, complète.
      if (start < data.length) rest = Buffer.from(data.subarray(start));
    }
    state.offset += consumed;
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

// ── Timeline globale : ce qu'une FENÊTRE DE QUOTA a coûté ───────────────────
// Le montant d'une conversation répond à « combien celle-ci a mangé » ; une
// ligne de quota demande « combien la fenêtre ENTIÈRE a mangé, toutes
// conversations du compte confondues ». Deux questions, une seule lecture : le
// lecteur ci-dessous alimente les deux, parce que relire une seconde fois les
// mêmes centaines de Mo pour la seconde question serait absurde.
//
// Granularité : des seaux de 5 minutes (début de seau → montant). Une fenêtre
// se recalcule en sommant les seaux ≥ sa borne de début — imprécision maximale
// de 5 min sur cette borne, invisible à l'échelle d'une fenêtre de 5 h, et 2016
// seaux suffisent à couvrir 7 jours.
const BUCKET_MS = 5 * 60 * 1000;
// La plus longue fenêtre (7 j) plus une heure de marge : au-delà, un seau ne
// peut plus entrer dans aucun calcul — on le jette.
const TIMELINE_SPAN_MS = 7 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000;

function defaultProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

// Fenêtre SCOPÉE par modèle (« Fable (7d) »). Piège vérifié dans le cache réel
// de l'API : `limits[].scope.model.id` vaut **null**, seul `display_name` est
// renseigné. Le filtre part donc de ce libellé, en minuscules : on y cherche
// d'abord une famille connue (« Opus 4.8 » → opus), et c'est elle qu'on compare
// aux ids de modèle des messages, avec exactement la logique de sous-chaîne de
// priceFor. Libellé sans famille connue → le libellé entier sert de
// sous-chaîne ; s'il ne matche rien, la fenêtre n'affiche AUCUN montant, jamais
// un chiffre faux ni un zéro trompeur (même règle que l'effort absent).
function modelMatcher(displayName) {
  const d = typeof displayName === 'string' ? displayName.toLowerCase().trim() : '';
  if (!d) return null;
  const fam = FAMILIES.find((f) => d.includes(f.key));
  const needle = fam ? fam.key : d;
  return (id) => typeof id === 'string' && id.includes(needle);
}

// Lecteur à état, à créer UNE fois et à garder à travers les recomputes du
// moteur — comme le cache de scan d'ai-title de state.js, et pour la même
// raison : une instance neuve à chaque tick relirait tout depuis l'octet 0,
// c'est-à-dire exactement ce que ce module existe pour éviter.
function createCostReader(options = {}) {
  const acc = new Map();   // filePath -> { offset, lastMsgId, totals, mtime }
  // Timeline globale partagée : début de seau (5 min) -> { total, byModel }.
  // `byModel` sert aux fenêtres scopées ; les ids y sont bruts et en
  // minuscules, jamais réduits à une famille — c'est le matcher de la requête
  // qui décide ce qui compte, pas l'écriture.
  const timeline = new Map();
  const projectsDir = typeof options.projectsDir === 'string' ? options.projectsDir : defaultProjectsDir();
  const now = typeof options.now === 'function' ? options.now : Date.now;
  // Tant qu'aucun scan GLOBAL n'a eu lieu, la timeline ne porte que les
  // conversations de la vue de CETTE fenêtre VS Code — une fraction de ce que
  // le compte a consommé. Répondre alors à windowCost() rendrait un montant
  // faux ; on rend null, et la ligne de quota garde exactement sa tête d'avant.
  let scanned = false;
  // Cf. ingest() : une reprise à zéro a pollué les seaux, il faut les refaire.
  let rebuild = false;

  function sink(ts, total, modelId) {
    if (!Number.isFinite(ts)) return;
    const b = Math.floor(ts / BUCKET_MS) * BUCKET_MS;
    let e = timeline.get(b);
    if (!e) { e = { total: 0, byModel: new Map() }; timeline.set(b, e); }
    e.total += total;
    const id = typeof modelId === 'string' ? modelId.toLowerCase() : '';
    e.byModel.set(id, (e.byModel.get(id) || 0) + total);
  }

  // Lecture de l'append d'UN fichier, dans les DEUX accumulateurs à la fois.
  function ingest(filePath, stat) {
    let state = acc.get(filePath);
    // Fichier plus PETIT que là où on s'était arrêté : troncature, rotation ou
    // remplacement du transcript — l'offset ne veut plus rien dire et les
    // totaux non plus. On repart de zéro, seule lecture sûre.
    if (!state || stat.size < state.offset) {
      // Mais une reprise à zéro ré-injecte dans les seaux des lignes DÉJÀ
      // comptées. Les en retirer une par une demanderait un registre par
      // fichier sur le chemin chaud (chaque message écrirait deux structures) :
      // on marque plutôt la timeline à refaire, et le prochain scan global la
      // reconstruit d'un bloc, hors du chemin de rendu. Cas rare par nature —
      // un transcript ne fait qu'ajouter, seul un remplacement le rétrécit.
      if (state) rebuild = true;
      state = {
        offset: 0, lastMsgId: null, totals: emptyTotals(), mtime: 0,
        currentTurn: 0, lastTurn: 0, turns: 0, turnOpen: false,
      };
      acc.set(filePath, state);
    }
    state.mtime = stat.mtimeMs;
    if (stat.size > state.offset) consumeAppend(filePath, state, stat.size, sink);
    return state;
  }

  function read(filePath) {
    if (!filePath) return null;
    let stat;
    try { stat = fs.statSync(filePath); } catch { return null; }
    const state = ingest(filePath, stat);
    // Conversation sans la moindre donnée d'usage (transcript tout juste créé,
    // premier tour pas encore répondu) -> rien, jamais un « 0,00 $ » qui
    // laisserait croire à une conversation gratuite. Même règle que l'effort
    // absent : on n'affiche pas une valeur qu'on n'a pas.
    if (!state.totals.messages) return null;
    const t = state.totals;
    return {
      total: t.total, input: t.input, cacheRead: t.cacheRead,
      cacheWrite: t.cacheWrite, output: t.output, tools: t.tools,
      messages: t.messages,
      // Coût du dernier tour COMPLET (0 tant qu'aucun n'est clos) et nombre de
      // tours clos — cf. isTurnBoundary. `currentTurn` (tour en cours) n'est
      // délibérément PAS exposé : la couleur ne doit jamais suivre un tour
      // encore ouvert.
      lastTurn: state.lastTurn, turns: state.turns,
    };
  }

  // Purge des fichiers qui ne sont plus candidats (conv sortie de la fenêtre du
  // panneau) : même motif que la purge de tabOpenMisses dans state.js — un
  // process de longue vie ne doit pas accumuler indéfiniment.
  read.forget = function (keep) {
    const floor = now() - TIMELINE_SPAN_MS;
    for (const [f, state] of [...acc.entries()]) {
      if (keep.has(f)) continue;
      // JAMAIS un fichier dont le mtime tombe dans la période couverte par la
      // timeline : réadmis plus tard (une conv qui revient dans la vue, ou le
      // scan global), il repartirait de l'octet 0 et ré-injecterait TOUTES ses
      // lignes dans les seaux — la fenêtre le compterait deux fois. Sous ce
      // plancher, au contraire, tout son contenu est antérieur au plancher
      // lui-même (le timestamp d'une ligne ne dépasse jamais le mtime du
      // fichier) : le relire n'ajoutera rien à aucune fenêtre vivante.
      if (state.mtime >= floor) continue;
      acc.delete(f);
    }
  };
  read.size = () => acc.size;

  // Scan GLOBAL : tous les transcripts du compte, pas seulement ceux de la vue
  // — le quota, lui, est global au compte. Les candidats sont filtrés au mtime
  // (le scan tombe de plusieurs centaines de fichiers à la centaine réellement
  // touchée sur 7 jours), puis lus en incrémental comme les autres.
  //
  // Coûteux la PREMIÈRE fois seulement (~0,6 s mesuré sur 117 fichiers,
  // 187 Mo) : l'appelant ne le déclenche qu'à la première ouverture VISIBLE du
  // panneau, et en différé — une fenêtre VS Code dont le panneau reste fermé ne
  // lit rien.
  read.scanAll = function () {
    let dirs;
    try { dirs = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { return false; }
    const floor = now() - TIMELINE_SPAN_MS;
    if (rebuild) {
      timeline.clear();
      rebuild = false;
      // Relire depuis l'octet 0 tout ce qu'on suivait : sans ça, les totaux par
      // conversation repartiraient à zéro et les lignes perdraient leur montant
      // jusqu'au recompute suivant.
      for (const [f, st] of [...acc.entries()]) {
        st.offset = 0; st.lastMsgId = null; st.totals = emptyTotals();
        st.currentTurn = 0; st.lastTurn = 0; st.turns = 0; st.turnOpen = false;
        let stat;
        try { stat = fs.statSync(f); } catch { acc.delete(f); continue; }
        ingest(f, stat);
      }
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const sub = path.join(projectsDir, d.name);
      let names;
      try { names = fs.readdirSync(sub); } catch { continue; }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue;
        const f = path.join(sub, n);
        let stat;
        try { stat = fs.statSync(f); } catch { continue; }
        // Le mtime borne tous les timestamps du fichier : un transcript qui n'a
        // plus bougé depuis la plus longue fenêtre ne peut rien y ajouter.
        if (stat.mtimeMs < floor) continue;
        ingest(f, stat);
      }
    }
    for (const b of [...timeline.keys()]) if (b < floor) timeline.delete(b);
    scanned = true;
    return true;
  };

  // Montant consommé depuis `startMs` (borne de début d'une fenêtre de quota,
  // = reset moins la durée de la fenêtre). `modelName` non vide -> seule cette
  // famille compte (fenêtre scopée). Rend `null` — jamais 0 — tant qu'aucun
  // scan global n'a eu lieu, et quand rien ne tombe dans la période : une
  // fenêtre sans montant calculable garde exactement la tête qu'elle avait.
  read.windowCost = function (startMs, modelName) {
    if (!scanned || !Number.isFinite(startMs)) return null;
    const match = modelName ? modelMatcher(modelName) : null;
    if (modelName && !match) return null;
    let sum = 0;
    let matched = false;
    for (const [b, e] of timeline) {
      if (b < startMs) continue;
      if (!match) { sum += e.total; matched = true; continue; }
      for (const [id, amt] of e.byModel) if (match(id)) { sum += amt; matched = true; }
    }
    return matched ? sum : null;
  };
  read.scanned = () => scanned;
  read.buckets = () => timeline.size;
  return read;
}

module.exports = {
  createCostReader, costOfUsage, priceFor, modelMatcher, isTurnBoundary,
  FAMILIES, UNKNOWN_FAMILY, FAST_MODE, WEB_SEARCH_COST, BUCKET_MS, TIMELINE_SPAN_MS,
};
