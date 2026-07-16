const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { acquireLock, releaseLock } = require('./hooks/sessions-state.js');

// ============================================================================
// Sons de notification (plan 2026-07-16, lot 1).
//
// Joués côté EXTENSION HOST, jamais depuis le webview : le JS du panneau est
// suspendu quand celui-ci est masqué ou fermé, exactement le moment où le son
// est utile (on ne regarde pas l'écran). System.Media.SystemSounds via un
// PowerShell détaché — pas de .wav embarqué, pas de dépendance audio Node.
//
// DÉDOUBLONNAGE MULTI-FENÊTRES — chaque fenêtre VS Code observe le même
// sessions-state.json ; une conv qui finit ferait sonner N fenêtres. Un
// fichier ~/.claude/sound-claims.json, écrit sous le lock DÉJÀ utilisé par
// sessions-state.json (jamais une écriture directe), sert de claim partagé :
// clé = `sessionId:state:since`, la première instance qui la pose joue, les
// autres se taisent. `since` (l'entrée dans l'état) rend la clé unique par
// transition — la répétition du même état ne rejoue jamais le même son.
//
// ANTI-FAUX-`done` — le state engine corrige lui-même un rebond Stop→busy
// (Stop hook à feedback qui relance Claude, cf. README § state engine) après
// ~2 s ; ce module rajoute une marge à son niveau : un `done` arme un timer,
// annulé si la conv repasse `busy` dans la fenêtre. `waiting` est urgent —
// aucun débounce, il joue à la transition même.
// ============================================================================

const CLAIMS_PATH = path.join(os.homedir(), '.claude', 'sound-claims.json');
const PRUNE_MS = 24 * 60 * 60 * 1000; // même règle que sessions-state.json
const DONE_DEBOUNCE_MS = 2500;

// SystemSound.Play() est ASYNCHRONE (PlaySound SND_ASYNC) : sans le sleep,
// powershell.exe se termine juste après l'appel et tue la lecture avant
// qu'elle démarre — silence total, constaté le 2026-07-16. Le process est
// détaché (fire-and-forget), le sleep ne coûte rien à personne.
const SOUND_COMMANDS = {
  // ding.wav choisi a l'oreille par l'user le 2026-07-16 (vs Windows Ding,
  // Windows Notify, chimes) : le plus court/leger de la palette testee.
  // PlaySync() est synchrone -> pas besoin du Start-Sleep requis par
  // SystemSounds.Play() (asynchrone, cf. hotfix 2.12.2 plus haut).
  done: "(New-Object System.Media.SoundPlayer 'C:\\Windows\\Media\\ding.wav').PlaySync()",
  waiting: '[System.Media.SystemSounds]::Exclamation.Play(); Start-Sleep -Milliseconds 1500',
};

function readClaims() {
  try {
    const c = JSON.parse(fs.readFileSync(CLAIMS_PATH, 'utf8'));
    if (c && typeof c === 'object') return c;
  } catch {}
  return {};
}

function writeClaims(claims) {
  const tmp = `${CLAIMS_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(claims));
  fs.renameSync(tmp, CLAIMS_PATH);
}

function prune(claims, now) {
  for (const [key, ts] of Object.entries(claims)) {
    if (now - ts > PRUNE_MS) delete claims[key];
  }
}

// true = cette instance est la première à poser `key` → elle joue le son.
function claimSound(key) {
  const locked = acquireLock();
  let claimed = false;
  try {
    const now = Date.now();
    const claims = readClaims();
    prune(claims, now);
    if (!claims[key]) {
      claims[key] = now;
      claimed = true;
    }
    writeClaims(claims);
  } catch {
    // Lock/fichier indisponible : best-effort, on préfère un son en double à
    // un son perdu (silence = régression invisible).
    claimed = true;
  } finally {
    if (locked) releaseLock();
  }
  return claimed;
}

// Fire-and-forget : jamais bloquer l'extension host sur le round-trip
// PowerShell, et jamais laisser un échec de spawn remonter à l'appelant.
function playSoundImpl(kind) {
  const cmd = SOUND_COMMANDS[kind];
  if (!cmd) return;
  try {
    // JAMAIS `detached: true` ici : sous Windows il prive powershell.exe de
    // console et le process meurt en ~150 ms (code 0) sans exécuter la
    // commande — mesuré le 2026-07-16 (50-152 ms avec detached, 1,6 s sans).
    // Même recette que focus.js/raiseWindow, qui n'a jamais eu le problème.
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', cmd],
      { stdio: 'ignore', windowsHide: true }
    );
    child.on('error', () => {});
    child.unref();
  } catch {}
}

// deps.isEnabled() / deps.play(kind) sont injectables pour les tests — un
// banc ne doit jamais réellement lancer PowerShell ni son gestionnaire de
// son, mais doit exercer le vrai débounce et le vrai claim (fichier réel).
function createSoundPlayer(deps = {}) {
  const isEnabled = typeof deps.isEnabled === 'function' ? deps.isEnabled : () => false;
  const play = typeof deps.play === 'function' ? deps.play : playSoundImpl;
  // Débounce configurable pour les bancs (comme ack.js/tabs.js) — jamais
  // utilisé en usage réel, où le défaut de 2,5 s s'applique.
  const doneDebounceMs = deps.doneDebounceMs != null ? deps.doneDebounceMs : DONE_DEBOUNCE_MS;
  const pendingDone = new Map(); // sessionId → timer armé à la transition `done`

  function cancelPendingDone(sessionId) {
    const t = pendingDone.get(sessionId);
    if (t) {
      clearTimeout(t);
      pendingDone.delete(sessionId);
    }
  }

  return {
    // Appelé sur CHAQUE transition d'état observée (before !== after), jamais
    // sur un recompute qui ne change rien — c'est à l'appelant (extension.js)
    // de ne le brancher que là, sur le même signal que le fetch événementiel.
    onTransition(sessionId, state, since) {
      if (state === 'busy') {
        // Rebond Stop→busy (correction transcript-après-Stop, cf. état
        // engine) : le `done` qui vient d'être armé décrivait un tour encore
        // en cours, on ne le joue jamais.
        cancelPendingDone(sessionId);
        return;
      }
      if (state !== 'done' && state !== 'waiting') return;
      if (!isEnabled()) return;

      const key = `${sessionId}:${state}:${since}`;

      if (state === 'waiting') {
        if (claimSound(key)) play('waiting');
        return;
      }

      cancelPendingDone(sessionId);
      const timer = setTimeout(() => {
        pendingDone.delete(sessionId);
        if (claimSound(key)) play('done');
      }, doneDebounceMs);
      pendingDone.set(sessionId, timer);
    },
    dispose() {
      for (const t of pendingDone.values()) clearTimeout(t);
      pendingDone.clear();
    },
  };
}

module.exports = {
  createSoundPlayer,
  claimSound,
  CLAIMS_PATH,
  DONE_DEBOUNCE_MS,
  playSoundImpl,
};
