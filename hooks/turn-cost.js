#!/usr/bin/env node
'use strict';
// Coût du DERNIER TOUR d'UNE conversation, lu au moment où l'utilisateur
// soumet le prompt suivant. Lib du hook `UserPromptSubmit`
// (track-active-session.js) — jamais un scan global.
//
// POURQUOI — le montant cumulé d'une conversation dit ce qui est déjà dépensé,
// donc irréversible. Le coût du dernier tour dit ce que le PROCHAIN coûtera
// (le contexte ne fait que grossir) : c'est le seul chiffre sur lequel on peut
// encore agir, et le bon moment pour l'entendre est juste avant de repartir.
//
// CONTRAINTE DURE — ce code tire à CHAQUE prompt de CHAQUE conversation. Son
// budget est de quelques millisecondes, et il ne doit JAMAIS faire échouer un
// prompt : tout est en try/catch, toute panne se solde par « pas de notice ».
//   - lecture INCRÉMENTALE : l'offset et les compteurs sont persistés entre
//     deux appels (le process meurt à chaque fois) ;
//   - premier contact avec un gros transcript (conversation reprise) : on ne
//     lit que la QUEUE du fichier, jamais les 40 Mo (cf. COLD_TAIL).

const fs = require('fs');
const os = require('os');
const path = require('path');

// cost.js est la source unique de la grille tarifaire ET de la définition
// d'une borne de tour. Deux emplacements possibles : à côté (copie déployée
// dans ~/.claude/scripts/ par install.ps1) ou à la racine du repo (source).
// Dupliquer les prix ici serait la garantie d'une divergence silencieuse.
function loadCost() {
  try { return require('./cost.js'); } catch {}
  return require('../cost.js');
}
const { costOfUsage, isTurnBoundary } = loadCost();

// Seuil par défaut de la notice, réglage `relayNoticeDollars`. Volontairement
// DISTINCT du `costTurnRedDollars` qui colore la ligne du panneau (2 $) : une
// couleur est un signal passif qu'on regarde ou pas, une notice interrompt le
// fil pour proposer d'arrêter et de recommencer ailleurs. Mesuré sur ce poste
// le 2026-08-18 : à 2 $, 3 conversations de travail sur 4 déclenchaient dès le
// premier prompt.
const DEFAULT_RELAY_DOLLARS = 5;
// ⛔ Garde de MATURITÉ, et c'est elle qui compte le plus. Un tour cher sur une
// conversation jeune ne dit rien : il peut venir d'un seul gros outil (vingt
// fichiers lus d'un coup) sur un contexte encore léger — proposer un relais là
// n'économise rien et discrédite la notice. Ce qu'on veut détecter est un
// RYTHME, or un rythme suppose d'avoir vu plusieurs tours. Vaut aussi comme
// garde-fou du départ à froid : une conversation reprise démarre à `turns: 0`,
// elle ne peut donc rien déclencher avant d'avoir été observée pour de vrai.
const MIN_TURNS = 2;
// Queue lue lors du tout premier passage sur un transcript déjà gros. Un tour
// entier tient très largement dedans ; couper au milieu d'un tour ne peut que
// SOUS-estimer son coût (des messages manquent), jamais le surestimer — donc
// jamais de fausse alerte. Le tour tronqué est de toute façon écarté tant
// qu'aucune borne réelle n'a été vue.
const COLD_TAIL = 2 * 1024 * 1024;
const CHUNK = 1 << 20;
// Dossier d'état : un fichier par session. Volontairement PAS
// sessions-state.json — sa purge à SessionEnd est déjà un sujet délicat, et le
// marqueur « notice déjà émise » doit survivre à un rechargement de fenêtre.
const DIR_NAME = 'quotabar-turns';
const PURGE_MS = 7 * 24 * 60 * 60 * 1000;

function homeDir(env) {
  const e = env || process.env;
  return e.USERPROFILE || e.HOME || os.homedir();
}

function stateDir(env) {
  return path.join(homeDir(env), '.claude', DIR_NAME);
}

// Un sessionId vient du CLI, mais il finit en nom de fichier : tout ce qui
// n'est pas [A-Za-z0-9._-] est neutralisé plutôt que concaténé tel quel.
function stateFileFor(sessionId, env) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return path.join(stateDir(env), safe + '.json');
}

function freshState() {
  return {
    v: 1,
    offset: 0,
    lastMsgId: null,
    total: 0,        // cumul de la conversation, tel que lu depuis notre offset
    open: 0,         // coût accumulé depuis la dernière borne (tour en cours)
    last: 0,         // coût du dernier tour COMPLET
    turns: 0,        // nombre de tours complets vus
    turnSeen: false, // au moins une borne VRAIE rencontrée
    notified: false, // notice de relais déjà émise pour cette conversation
  };
}

function readState(file) {
  try {
    const st = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!st || st.v !== 1) return null;
    return Object.assign(freshState(), st);
  } catch { return null; }
}

function writeState(file, st) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(st));
    fs.renameSync(tmp, file);
  } catch {}
}

// Ménage : un fichier d'état par conversation, ça s'accumule. Purge déclenchée
// UNIQUEMENT à la naissance d'un état (premier prompt d'une session) — un
// readdir à chaque prompt de chaque conversation serait exactement le genre de
// coût que ce hook doit s'interdire.
function purgeOldStates(dir, nowMs) {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const p = path.join(dir, name);
      try {
        if (nowMs - fs.statSync(p).mtimeMs > PURGE_MS) fs.unlinkSync(p);
      } catch {}
    }
  } catch {}
}

// Même logique que cost.js `consumeLine`, réduite à ce dont ce hook a besoin :
// pas de timeline, pas de ventilation input/cache/output — juste le cumul et
// le découpage en tours.
function consumeLine(line, st) {
  if (isTurnBoundary(line)) {
    // Une borne CLÔT le tour précédent. La toute première borne n'a rien à
    // clore ; celle qui suit un démarrage à froid non plus (le tour ouvert est
    // tronqué, donc faux).
    if (st.turnSeen) { st.last = st.open; st.turns += 1; }
    st.open = 0;
    st.turnSeen = true;
  }
  if (line.indexOf('"usage"') === -1) return;
  let e;
  try { e = JSON.parse(line); } catch { return; }
  const msg = e && e.message;
  if (!msg || !msg.usage) return;
  const id = msg.id || null;
  // Un message assistant s'écrit sur plusieurs lignes consécutives portant le
  // même id et le même usage (cf. cost.js) : compter chaque ligne triplerait
  // le tour.
  if (id && id === st.lastMsgId) return;
  st.lastMsgId = id;
  const c = costOfUsage(msg.usage, msg.model);
  if (!c) return;
  st.total += c.total;
  st.open += c.total;
}

function consumeAppend(filePath, st, size) {
  let fd;
  try { fd = fs.openSync(filePath, 'r'); } catch { return; }
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let rest = null;
    let pos = st.offset;
    let consumed = 0;
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
        consumeLine(data.subarray(start, nl).toString('utf8'), st);
        consumed += nl - start + 1;
        start = nl + 1;
      }
      // Dernière ligne sans \n : soit coupée par le chunk, soit en cours
      // d'écriture par le CLI. On ne la consomme pas, l'offset reste avant.
      if (start < data.length) rest = Buffer.from(data.subarray(start));
    }
    st.offset += consumed;
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

// Départ à froid sur un fichier déjà volumineux : on se place vers la fin, sur
// le PREMIER début de ligne rencontré (jamais au milieu d'une ligne : le JSON
// serait invalide et le tour, faux).
function coldOffset(filePath, size) {
  if (size <= COLD_TAIL) return 0;
  let fd;
  try { fd = fs.openSync(filePath, 'r'); } catch { return 0; }
  try {
    const from = size - COLD_TAIL;
    const probe = Buffer.allocUnsafe(Math.min(CHUNK, size - from));
    const n = fs.readSync(fd, probe, 0, probe.length, from);
    if (n <= 0) return 0;
    const nl = probe.indexOf(0x0a, 0);
    if (nl === -1) return 0;   // aucune fin de ligne dans la sonde : on relit tout
    return from + nl + 1;
  } catch { return 0; } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

// Coût du dernier tour, vu depuis un `UserPromptSubmit`.
//
// L'ordre d'écriture n'est pas garanti : selon que le CLI a déjà écrit
// l'entrée du prompt courant ou non, le tour qui vient de se terminer est
//   - encore OUVERT (rien d'écrit) → c'est `open` ;
//   - déjà CLOS par cette entrée   → c'est `last`, et `open` vaut 0.
// La règle « open s'il n'est pas nul, sinon last » répond juste dans les deux
// cas, sans dépendre d'un ordre qu'on ne contrôle pas. Seul cas dégradé : deux
// prompts d'affilée sans réponse (interruption) dans le premier ordre — on
// citerait alors le tour d'avant. La notice n'étant qu'une PROPOSITION, et
// émise une seule fois, le coût de cette erreur est nul.
function lastTurnDollars(st) {
  if (!st.turnSeen) return 0;
  return st.open > 0 ? st.open : st.last;
}

// Lit le transcript de CETTE session et met l'état à jour. Retourne l'état.
function updateFromTranscript(sessionId, transcriptPath, env) {
  const file = stateFileFor(sessionId, env);
  let st = readState(file);
  if (!st) {
    st = freshState();
    purgeOldStates(stateDir(env), Date.now());
  }
  let stat = null;
  try { stat = fs.statSync(transcriptPath); } catch { return st; }
  if (!stat.isFile()) return st;
  // Fichier rétréci (rotation, réécriture) : tout ce qu'on croyait acquis est
  // faux — on repart d'un état vierge, en gardant le marqueur de notice.
  if (stat.size < st.offset) {
    const notified = st.notified;
    st = freshState();
    st.notified = notified;
  }
  if (st.offset === 0 && stat.size > COLD_TAIL) st.offset = coldOffset(transcriptPath, stat.size);
  if (stat.size > st.offset) consumeAppend(transcriptPath, st, stat.size);
  writeState(file, st);
  return st;
}

// ── Seuil ───────────────────────────────────────────────────────────────────
// Le hook tourne HORS de VS Code : il n'a pas accès à l'API de configuration.
// Il relit donc le settings.json utilisateur, à la même clé que le panneau —
// un seuil réglé dans l'UI vaut aussi pour la notice. Introuvable ou illisible
// → défaut, jamais d'erreur.
function stripJsonc(text) {
  let out = '';
  let inStr = false, esc = false, line = false, block = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], d = text[i + 1];
    if (line) { if (c === '\n') { line = false; out += c; } continue; }
    if (block) { if (c === '*' && d === '/') { block = false; i++; } continue; }
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && d === '/') { line = true; i++; continue; }
    if (c === '/' && d === '*') { block = true; i++; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function vscodeSettingsPaths(env) {
  const e = env || process.env;
  const home = homeDir(e);
  const dirs = [];
  if (process.platform === 'win32') {
    const appData = e.APPDATA || path.join(home, 'AppData', 'Roaming');
    dirs.push(path.join(appData, 'Code', 'User'), path.join(appData, 'Code - Insiders', 'User'));
  } else if (process.platform === 'darwin') {
    const base = path.join(home, 'Library', 'Application Support');
    dirs.push(path.join(base, 'Code', 'User'), path.join(base, 'Code - Insiders', 'User'));
  } else {
    const base = path.join(home, '.config');
    dirs.push(path.join(base, 'Code', 'User'), path.join(base, 'Code - Insiders', 'User'));
  }
  return dirs.map((d) => path.join(d, 'settings.json'));
}

// Un seuil à 0 DÉSACTIVE la notice (documenté dans le réglage) : on rend 0 tel
// quel plutôt que de le traiter comme « non réglé », sinon la seule façon de se
// débarrasser du message serait de désinstaller les hooks.
function readThreshold(env) {
  const e = env || process.env;
  const forced = Number(e.QUOTABAR_RELAY_DOLLARS);
  if (Number.isFinite(forced) && forced >= 0) return forced;
  for (const p of vscodeSettingsPaths(e)) {
    try {
      const cfg = JSON.parse(stripJsonc(fs.readFileSync(p, 'utf8')));
      const v = Number(cfg['claudeCodeQuotaBar.relayNoticeDollars']);
      if (Number.isFinite(v) && v >= 0) return v;
    } catch {}
  }
  return DEFAULT_RELAY_DOLLARS;
}

function formatDollars(n) {
  return n >= 100 ? '$' + Math.round(n) : '$' + n.toFixed(2);
}

// Trois lignes, pas quatre : une consigne qui prêche l'économie de contexte ne
// peut pas se permettre d'en manger. Elle PROPOSE — la décision reste à
// l'utilisateur, comme toute bascule de conversation.
function noticeText(dollars) {
  return [
    'QuotaSaver: the last turn of this conversation cost about ' + formatDollars(dollars) +
      ' at API list prices, and the next one will cost more - a turn is re-billed for everything the context holds.',
    'Before going further, offer the user (never act on it unasked) to commit what is done and hand the rest to a fresh conversation, with a claude-convs block ready to paste.',
    'Shown once per conversation; if the work is nearly finished, just carry on.',
  ].join('\n');
}

// Point d'entrée du hook. Retourne le texte à injecter, ou null.
// Ne lève JAMAIS : un hook qui casse la saisie serait pire que le problème
// qu'il résout.
function relayNotice(input, env) {
  try {
    const sessionId = input && input.session_id;
    const transcript = input && input.transcript_path;
    if (!sessionId || !transcript) return null;
    const st = updateFromTranscript(sessionId, transcript, env);
    if (st.notified) return null;
    if (st.turns < MIN_TURNS) return null;
    const threshold = readThreshold(env);
    if (!(threshold > 0)) return null;
    const dollars = lastTurnDollars(st);
    if (!(dollars >= threshold)) return null;
    st.notified = true;
    writeState(stateFileFor(sessionId, env), st);
    return noticeText(dollars);
  } catch { return null; }
}

module.exports = {
  relayNotice, updateFromTranscript, lastTurnDollars, readThreshold, noticeText,
  stateFileFor, stateDir, stripJsonc, formatDollars,
  DEFAULT_RELAY_DOLLARS, MIN_TURNS, COLD_TAIL, PURGE_MS,
};
