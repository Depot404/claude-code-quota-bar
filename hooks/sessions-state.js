#!/usr/bin/env node
// Lib partagée des hooks : écriture de ~/.claude/sessions-state.json.
//
// Ce fichier N'EST PAS un hook : il est require() par track-active-session.js
// (UserPromptSubmit) et hook-session-state.js (Stop/Notification/SessionEnd),
// tous deux déployés dans le même dossier ~/.claude/scripts/ par install.ps1.
//
// Source canonique : Tools/ClaudeCodeQuotaBar/hooks/. Ne pas éditer la copie
// déployée dans ~/.claude/scripts/ — éditer ici puis relancer install.ps1.
//
// Format du fichier (lu par state.js côté extension) :
//   {
//     "version": 1,
//     "sessions": {
//       "<session_id>": {
//         "state": "busy" | "waiting" | "done",
//         "since": 1752580000000,       // ms epoch, entrée dans CET état
//         "updated_at": 1752580000000,  // ms epoch, dernière écriture
//         "cwd": "C:\\...",             // workspace de la session
//         "transcript": "C:\\...\\<id>.jsonl",
//         "message": "...",             // texte de la Notification (état waiting)
//         "ack_ts": 1752580000000,      // ms epoch, onglet consulté après le
//                                       // dernier `done` (lot 6). Écrit par
//                                       // l'EXTENSION, pas par un hook :
//                                       // « j'ai lu » n'est pas un événement du
//                                       // CLI. Non-lu = since > ack_ts.
//         "busy_since": 1752580000000  // ms epoch, démarrage du run en cours
//                                       // (posé par track-active-session.js à
//                                       // chaque UserPromptSubmit, PAS réécrit
//                                       // par le Stop qui suit). Sert à l'ack
//                                       // strict (lot 10) : distingue « arrivé
//                                       // sur l'onglet pendant que ça tourne »
//                                       // de « déjà là avant même le lancement ».
//       }
//     }
//   }
//
// Concurrence : plusieurs sessions Claude écrivent ce fichier EN MÊME TEMPS, et
// depuis le lot 6 l'extension aussi (ack_ts). D'où lock + read-modify-write +
// rename atomique (jamais de fichier tronqué visible par le lecteur). Tout
// écrivain DOIT passer par updateSession/removeSession — une écriture directe
// écraserait l'état posé par un hook concurrent.

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_PATH = path.join(os.homedir(), '.claude', 'sessions-state.json');
const LOCK_PATH = STATE_PATH + '.lock';
const LOCK_TIMEOUT_MS = 1500;   // au-delà : écriture best-effort sans lock
const LOCK_STALE_MS = 5000;     // lock plus vieux = process mort avant release
const PRUNE_MS = 24 * 60 * 60 * 1000;

// Pause synchrone : les hooks sont des process courts, pas de boucle async ici.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock() {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(LOCK_PATH, 'wx'));
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return false;
      try {
        if (Date.now() - fs.statSync(LOCK_PATH).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(LOCK_PATH);
          continue;
        }
      } catch {}
      if (Date.now() > deadline) return false;
      sleepSync(20);
    }
  }
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_PATH); } catch {}
}

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (s && typeof s.sessions === 'object' && s.sessions) return s;
  } catch {}
  return { version: 1, sessions: {} };
}

// Écriture atomique : tmp + rename. Le lecteur (extension) voit soit l'ancien
// fichier complet, soit le nouveau — jamais un JSON tronqué.
function writeState(state) {
  const tmp = `${STATE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_PATH);
}

// Sessions oubliées (crash, SessionEnd jamais reçu) : le fichier ne grossit pas.
function prune(state, now) {
  for (const [id, s] of Object.entries(state.sessions)) {
    if (!s || now - (s.updated_at || 0) > PRUNE_MS) delete state.sessions[id];
  }
}

// Merge du patch sur l'entrée existante. `since` n'est réarmé d'office que sur
// un vrai changement d'état → l'anti-zombie reste juste (un `busy` répété ne
// rajeunit pas un zombie). Un appelant pour qui la RÉPÉTITION du même état est
// un fait neuf — deux Stop d'affilée, deux Notifications — passe `since` dans
// son patch : il est alors respecté (cf. hook-session-state.js).
function updateSession(sessionId, patch) {
  if (!sessionId) return;
  const locked = acquireLock();
  try {
    const state = readState();
    const now = Date.now();
    const prev = state.sessions[sessionId] || {};
    const next = { ...prev, ...patch, updated_at: now };
    if (!prev.since || (patch.state && patch.state !== prev.state)) next.since = now;
    for (const k of Object.keys(next)) if (next[k] == null) delete next[k];
    state.sessions[sessionId] = next;
    prune(state, now);
    writeState(state);
  } catch {} finally {
    if (locked) releaseLock();
  }
}

function removeSession(sessionId) {
  if (!sessionId) return;
  const locked = acquireLock();
  try {
    const state = readState();
    if (!state.sessions[sessionId]) return;
    delete state.sessions[sessionId];
    prune(state, Date.now());
    writeState(state);
  } catch {} finally {
    if (locked) releaseLock();
  }
}

// Lit le payload JSON du hook sur stdin. Les hooks n'écrivent rien sur stdout :
// tout output serait injecté dans le contexte de la conversation.
function readHookInput(cb) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => {
    let data = {};
    try { data = input.trim() ? JSON.parse(input) : {}; } catch { return; }
    try { cb(data); } catch {}
  });
}

// Lock exporté (lot sons) : `sound-claims.json` (côté extension, hors hooks) a
// besoin du même read-modify-write-sous-lock que sessions-state.json, mais
// c'est un fichier distinct. Plutôt qu'un second fichier `.lock` (donc une
// seconde section critique à auditer), il réutilise CE lock — les deux
// fichiers ne sont de toute façon jamais écrits à haute fréquence.
module.exports = { STATE_PATH, updateSession, removeSession, readHookInput, readState, acquireLock, releaseLock };
