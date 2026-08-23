'use strict';
// Historisation JOURNALIÈRE (jour civil local) du coût de TOUTES les
// conversations du compte — ce que cost.js ne garde jamais : son lecteur
// vivant (createCostReader) ne conserve que 7 jours + 1 h en mémoire
// (TIMELINE_SPAN_MS), purgés à chaque scan, et rien de tout ça n'est écrit
// sur disque. Ce module ajoute la brique qui MANQUE : un fichier qui
// s'alimente seul, jour après jour, et qui survit aux redémarrages de VS
// Code — base de données pour une future analyse d'optimisation, rien de
// plus (pas de vue, pas de panneau : décision explicite du chantier).
//
// SOURCE DE VÉRITÉ — les transcripts `~/.claude/projects/<ws>/<session>.jsonl`
// restent sur le disque indéfiniment (le CLI ne les fait jamais tourner) :
// l'historique n'est donc pas borné à « depuis l'installation de cette
// fonctionnalité », il se reconstruit RÉTROACTIVEMENT sur tout ce qui existe
// déjà au premier passage.
//
// PAS D'ACCUMULATEUR INCRÉMENTAL — contrairement à cost.js (un lecteur vivant
// gardé en mémoire par l'hôte d'extension, un seul process tout du long), ce
// module tourne depuis un hook : un process Node NEUF à chaque appel, rien ne
// survit en mémoire d'un appel à l'autre. Un rebalayage complet est donc la
// seule lecture SÛRE — et il est bon marché (cost.js le mesure à ~0,6 s pour
// 187 Mo / 117 fichiers) dès lors qu'on ne le déclenche pas à chaque prompt :
// `updateDailyHistory` ne relit qu'une fois que le jour civil a changé depuis
// la dernière écriture (`dueToday`).

const fs = require('fs');
const os = require('os');
const path = require('path');

// cost.js est la source unique de la grille tarifaire — même motif que
// turn-cost.js : deux emplacements possibles selon qu'on tourne depuis le
// dépôt (repli `../cost.js`) ou depuis la copie déployée à plat dans
// ~/.claude/scripts/ (`./cost.js`).
function loadCost() {
  try { return require('./cost.js'); } catch {}
  return require('../cost.js');
}
const { costOfUsage } = loadCost();

const HISTORY_FILE = 'quotabar-cost-daily.json';

function homeDir(env) {
  const e = env || process.env;
  return e.USERPROFILE || e.HOME || os.homedir();
}

function historyPath(env) {
  return path.join(homeDir(env), '.claude', HISTORY_FILE);
}

function defaultProjectsDir(env) {
  return path.join(homeDir(env), '.claude', 'projects');
}

// Jour civil LOCAL (celui du poste qui exécute le calcul), format YYYY-MM-DD —
// `Date` restitue ses champs en heure locale du process, donc aucune
// bibliothèque de fuseau n'est nécessaire ici (même principe que les recettes
// PowerShell/Python du CLAUDE.md : jamais d'UTC brut affiché).
function dayKey(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function emptyDay() {
  return { total: 0, messages: 0, byModel: {} };
}

// Scan complet d'UN fichier transcript, message par message, accumulé dans
// `days` (Map jour civil -> totaux). Dédoublonnage par `message.id`
// consécutif : un message thinking+texte+tool_use s'écrit sur plusieurs
// lignes JSONL consécutives partageant le même id ET le même usage (piège
// vérifié dans cost.js/turn-cost.js sur transcript réel) — compter chaque
// ligne triplerait la facture de ces tours.
function scanFile(filePath, days) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return; }
  let lastMsgId = null;
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i < text.length && text.charCodeAt(i) !== 10) continue; // '\n'
    const line = text.slice(start, i);
    start = i + 1;
    if (!line || line.indexOf('"usage"') === -1) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const msg = e && e.message;
    if (!msg || !msg.usage) continue;
    const id = msg.id || null;
    if (id && id === lastMsgId) continue;
    lastMsgId = id;
    const c = costOfUsage(msg.usage, msg.model);
    if (!c) continue;
    const key = dayKey(Date.parse(e.timestamp));
    if (!key) continue; // timestamp absent/illisible : on ne devine pas un jour
    let d = days.get(key);
    if (!d) { d = emptyDay(); days.set(key, d); }
    d.total += c.total;
    d.messages += 1;
    const modelId = typeof msg.model === 'string' ? msg.model.toLowerCase() : 'unknown';
    d.byModel[modelId] = (d.byModel[modelId] || 0) + c.total;
  }
}

// Reconstruit l'historique complet à partir de TOUS les transcripts du
// compte. Idempotent par construction (aux arrondis flottants près) : deux
// exécutions consécutives, mêmes fichiers, produisent le même résultat —
// aucun état à faire diverger entre deux appels.
function rescan(env) {
  const projectsDir = defaultProjectsDir(env);
  const days = new Map();
  let dirs;
  try { dirs = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { return days; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const sub = path.join(projectsDir, d.name);
    let names;
    try { names = fs.readdirSync(sub); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      scanFile(path.join(sub, n), days);
    }
  }
  return days;
}

function serializeDays(days) {
  const out = {};
  for (const k of [...days.keys()].sort()) {
    const v = days.get(k);
    out[k] = { total: v.total, messages: v.messages, byModel: v.byModel };
  }
  return out;
}

// Ne redéclenche le rebalayage complet que si le jour courant n'a pas encore
// été écrit AUJOURD'HUI — jamais à chaque prompt (même contrainte de budget
// que turn-cost.js, qui tire lui aussi depuis UserPromptSubmit). Fichier
// absent ou illisible -> dû (premier passage = backfill complet).
function dueToday(file, todayKey) {
  let st;
  try { st = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return true; }
  return !st || st.updatedAt !== todayKey;
}

// Point d'entrée : régénère et persiste l'historique si le jour courant n'a
// pas encore été écrit. Ne lève JAMAIS — mêmes garanties que turn-cost.js,
// appelé depuis un hook qui ne doit jamais faire échouer la saisie. Retourne
// true si une écriture a eu lieu (utile aux bancs), false sinon.
function updateDailyHistory(env, now) {
  try {
    const file = historyPath(env);
    const nowMs = typeof now === 'number' ? now : Date.now();
    const todayKey = dayKey(nowMs);
    if (!todayKey || !dueToday(file, todayKey)) return false;
    const days = rescan(env);
    const out = { updatedAt: todayKey, days: serializeDays(days) };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out));
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

// ── Totaux dérivés ───────────────────────────────────────────────────────
// Jamais stockés — recalculés à la lecture depuis `history.days`, la seule
// donnée persistée. Semaine ISO 8601 (lundi -> dimanche, numérotée par le
// jeudi de la semaine, algorithme standard) : un jour donné n'appartient
// qu'à UNE semaine, jamais ambigu autour d'un 1er janvier.
function isoWeekKey(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const isoDay = (date.getDay() + 6) % 7; // lundi=0 ... dimanche=6
  date.setDate(date.getDate() - isoDay + 3); // jeudi de cette semaine
  const firstThursday = new Date(date.getFullYear(), 0, 4);
  const fIsoDay = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - fIsoDay + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return `${date.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

function monthKey(dateKey) {
  return dateKey.slice(0, 7);
}

function rollup(days, keyFn) {
  const out = {};
  for (const [dk, v] of Object.entries(days || {})) {
    const key = keyFn(dk);
    if (!out[key]) out[key] = emptyDay();
    out[key].total += v.total;
    out[key].messages += v.messages;
    for (const [model, amt] of Object.entries(v.byModel || {})) {
      out[key].byModel[model] = (out[key].byModel[model] || 0) + amt;
    }
  }
  return out;
}

function weeklyTotals(history) {
  return rollup(history && history.days, isoWeekKey);
}

function monthlyTotals(history) {
  return rollup(history && history.days, monthKey);
}

function readHistory(env) {
  try { return JSON.parse(fs.readFileSync(historyPath(env), 'utf8')); } catch { return null; }
}

module.exports = {
  updateDailyHistory, rescan, serializeDays, dayKey, historyPath, readHistory,
  weeklyTotals, monthlyTotals, isoWeekKey, monthKey,
  HISTORY_FILE,
};
