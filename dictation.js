'use strict';

// Dictée des cases de prompt du formulaire « New conversation » (2.126.0).
//
// POURQUOI UN PROCESS : le webview d'une extension ne peut PAS ouvrir le micro
// (getUserMedia refusé, microsoft/vscode#250568 et #113916). La capture et la
// transcription vivent donc dans un auxiliaire lancé par l'hôte d'extension —
// dictation/whisper_dictate.py, Whisper local, dont l'en-tête décrit le
// protocole (JSON par ligne : start/stop/cancel → listening/level/interim/final/done/error).
//
// CYCLE DE VIE : lancé au premier clic sur un micro, gardé chaud tant que
// l'hôte vit (le modèle met plusieurs secondes à charger), tué au deactivate
// ou quand la commande change. C'est un ENFANT de l'hôte : s'il survivait à
// VS Code, l'OrphanWatchdog du poste doit pouvoir le ramasser — ne pas le
// protéger.
//
// Le réglage `dictationCommand` vide = aucun bouton, aucun process : rien ne
// change pour qui ne l'a pas renseigné.

const path = require('path');
const { spawn } = require('child_process');

const HELPER = path.join(__dirname, 'dictation', 'whisper_dictate.py');

// Découpe une ligne de commande en argv, guillemets doubles compris
// (`"C:\Program Files\Python\python.exe" -X utf8`). Pas de shell : rien à
// échapper, rien d'interprété.
function splitCommand(line) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(line || ''))) !== null) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

// `post(ev)` reçoit chaque événement de l'auxiliaire tel quel, plus les
// erreurs du lancement lui-même ({ ev:'error', code:'spawn', message }).
function createDictation({ getCommand, getLanguage, post }) {
  let child = null;
  let childCommand = '';
  let buf = '';
  let errTail = '';
  let current = null;          // id de la dictée en cours côté auxiliaire

  function kill() {
    if (!child) return;
    const c = child;
    child = null;
    try { c.stdin.end(); } catch {}
    try { c.kill(); } catch {}
  }

  function fail(id, message) {
    post({ ev: 'error', id, code: 'spawn', message });
    post({ ev: 'done', id });
  }

  function ensureChild(id) {
    const command = String(getCommand() || '').trim();
    if (child && childCommand === command) return child;
    kill();
    const argv = splitCommand(command);
    if (!argv.length) return null;
    const lang = String(getLanguage() || '').slice(0, 2).toLowerCase();
    let c;
    try {
      c = spawn(argv[0], argv.slice(1).concat([HELPER].concat(lang ? ['--language', lang] : [])), {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      fail(id, (e && e.message) || String(e));
      return null;
    }
    child = c;
    childCommand = command;
    buf = '';
    errTail = '';
    c.stdout.setEncoding('utf8');
    c.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev && ev.ev === 'done' && ev.id === current) current = null;
        post(ev);
      }
    });
    c.stderr.setEncoding('utf8');
    c.stderr.on('data', (chunk) => { errTail = (errTail + chunk).slice(-600); });
    const onGone = (e) => {
      if (child === c) child = null;
      if (current !== null) {
        const id = current;
        current = null;
        const why = (e && e.message) || errTail.trim().split(/\r?\n/).slice(-1)[0] || 'the dictation helper stopped';
        fail(id, why);
      }
    };
    c.on('error', onGone);
    c.on('exit', () => onGone(null));
    return c;
  }

  function send(cmd, id) {
    if (!child) return;
    try { child.stdin.write(JSON.stringify({ cmd, id }) + '\n'); } catch {}
  }

  return {
    enabled: () => !!String(getCommand() || '').trim(),
    handle(msg) {
      const id = msg && msg.id;
      const action = msg && msg.action;
      if (action === 'start') {
        if (!ensureChild(id)) return;
        current = id;
        send('start', id);
      } else if (action === 'stop' || action === 'cancel') {
        send(action, id);
      }
    },
    // Commande changée dans les réglages : le prochain clic relance avec la
    // nouvelle ; une dictée en cours est close proprement (done).
    reset() {
      if (current !== null) { const id = current; current = null; post({ ev: 'done', id }); }
      kill();
    },
    dispose: kill,
  };
}

module.exports = { createDictation, splitCommand, HELPER };
