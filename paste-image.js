'use strict';

// Image collée dans une case de prompt (2.127.0).
//
// La conversation s'ouvre par `claude-vscode.editor.open(sessionId,
// initialPrompt)`, qui ne transporte que du TEXTE : aucune pièce jointe ne peut
// voyager avec le prompt. L'image est donc écrite sur disque et son chemin
// inséré dans le texte ; Claude la lit avec son outil de lecture, qui sait
// lire les images.
//
// Où : `<dossier de travail>/.claude/pasted-images/`. DANS le dossier de
// travail parce que Claude Code y lit sans demander de permission (ailleurs, la
// première lecture la demanderait). Le dossier s'ignore lui-même (`.gitignore`
// à `*`) : rien n'apparaît dans le git de l'utilisateur. Sans dossier ouvert,
// repli sur le dossier temporaire du système.
//
// Ménage : à chaque écriture, les images de plus de RETAIN_MS partent — une
// conversation lancée a lu la sienne depuis longtemps.

const fs = require('fs');
const os = require('os');
const path = require('path');

const RETAIN_MS = 7 * 24 * 3600 * 1000;
const MAX_BYTES = 20 * 1024 * 1024;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' };

function imageDir(workspaceRoot) {
  return workspaceRoot
    ? path.join(workspaceRoot, '.claude', 'pasted-images')
    : path.join(os.tmpdir(), 'quotasaver-pasted-images');
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function prune(dir, now) {
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith('paste-')) continue;
    const f = path.join(dir, name);
    try { if (now - fs.statSync(f).mtimeMs > RETAIN_MS) fs.unlinkSync(f); } catch {}
  }
}

// → chemin absolu du fichier écrit. Lève une Error lisible sinon.
function savePastedImage({ workspaceRoot, mime, base64, now = Date.now() }) {
  const ext = EXT[mime];
  if (!ext) throw new Error('unsupported image type ' + mime);
  const buf = Buffer.from(String(base64 || ''), 'base64');
  if (!buf.length) throw new Error('empty image');
  if (buf.length > MAX_BYTES) throw new Error('image larger than 20 MB');
  const dir = imageDir(workspaceRoot);
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  try { prune(dir, now); } catch {}
  const file = path.join(dir, 'paste-' + stamp(new Date(now)) + '-' + Math.random().toString(36).slice(2, 6) + '.' + ext);
  fs.writeFileSync(file, buf);
  return file;
}

module.exports = { savePastedImage, imageDir, RETAIN_MS };
