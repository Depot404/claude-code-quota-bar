'use strict';
// Dépôt de la « philosophie de lot » (lot onboarding 4, 2026-08-19) — même
// doctrine que hooks-install.js, pour un fichier de nature différente :
//   1. philosophy/claude-convs-batching.md (ce dossier) est recopié TEL QUEL
//      dans ~/.claude/claude-convs-batching.md à CHAQUE appel — fichier GÉRÉ
//      PAR L'EXTENSION, comme les hooks : une future version l'améliore chez
//      tout le monde sans qu'on ait à recopier quoi que ce soit soi-même.
//   2. ~/.claude/CLAUDE.md — le fichier PERSONNEL de l'utilisateur — reçoit
//      UNE SEULE LIGNE d'import, ajoutée UNE SEULE FOIS : la syntaxe `@chemin`
//      documentée par Claude Code (code.claude.com/docs/en/memory § Import
//      additional files). Un chemin RELATIF dans un import se résout par
//      rapport au fichier qui importe, pas au répertoire de travail — donc
//      `@claude-convs-batching.md`, posé à côté du fichier qu'il importe
//      (les deux vivent dans ~/.claude/), n'écrit jamais de chemin absolu
//      propre à une machine dans le fichier personnel de l'utilisateur.
//
// STATUT DIFFÉRENT DES HOOKS — jamais le même consentement. Les hooks sont
// REQUIS (sans eux le panneau reste en `idle`) ; cette philosophie est
// FACULTATIVE et FORTEMENT CONSEILLÉE (l'extension fonctionne entièrement
// sans elle — elle apporte le jugement « quand découper », que `/handoffs`
// ne porte pas : `/handoffs` ne fait que METTRE EN FORME un découpage déjà
// décidé). L'appelant (extension.js) obtient donc un consentement DISTINCT de
// celui des hooks avant d'appeler installBatchPhilosophy() — jamais la même
// modale, jamais un « et aussi » silencieux.
//
// COÛT — le fichier déposé est un IMPORT CLAUDE.md : relu et refacturé à
// CHAQUE conversation, pour toujours, sur chaque machine qui l'accepte. Le
// garder très court n'est pas un style, c'est un budget — voir
// philosophy/claude-convs-batching.md, qui ne doit jamais grossir en exemples
// ou en préambule.
//
// GARDE-FOU NON NÉGOCIABLE — même esprit que hooks-install.js pour
// settings.json : le fichier personnel de l'utilisateur (CLAUDE.md) n'est
// JAMAIS écrasé. S'il existe déjà, un backup horodaté précède toute écriture ;
// s'il n'existe pas, il est créé proprement plutôt que de faire échouer
// l'appel.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Nom du fichier déposé dans ~/.claude/ — sibling de CLAUDE.md, pour que
// l'import relatif ci-dessous se résolve sans jamais écrire de chemin absolu.
const PHILOSOPHY_FILE = 'claude-convs-batching.md';

// Ligne ajoutée UNE SEULE FOIS dans ~/.claude/CLAUDE.md (chemin RELATIF, cf.
// commentaire d'en-tête — jamais un chemin absolu propre à une machine).
const IMPORT_LINE = `@${PHILOSOPHY_FILE}`;

// Même helper que hooks-install.js (dupliqué à dessein : deux modules
// indépendants, testés indépendamment — pas de dépendance croisée pour un
// horodatage de 6 lignes).
function backupSuffix(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

// Dépose (ou met à jour) philosophy/claude-convs-batching.md dans ~/.claude/,
// et ajoute sa ligne d'import à ~/.claude/CLAUDE.md si elle n'y est pas déjà —
// idempotent, jamais appelé sans consentement explicite (cf. extension.js
// promptBatchPhilosophy()).
//
// opts.extensionRoot (obligatoire) — dossier de l'extension, racine de
//   philosophy/.
// opts.home — dossier home à utiliser (os.homedir() par défaut ; les bancs le
//   redirigent vers un dossier jetable).
// opts.now — horodatage à utiliser pour le nom du backup (Date.now() par
//   défaut ; les bancs le fixent pour des assertions stables).
// opts.log — callback(message) optionnel, appelé pour chaque étape.
//
// Retourne { changed, messages, philosophyPath, claudeMdPath, backupPath }.
// `changed` ne porte QUE sur CLAUDE.md — le fichier de philosophie est
// TOUJOURS recopié (comme les hooks dans hooks-install.js), donc rien
// d'observable à signaler dessus : c'est un fichier géré par l'extension.
function installBatchPhilosophy(opts = {}) {
  const home = opts.home || os.homedir();
  const extensionRoot = opts.extensionRoot;
  if (!extensionRoot) throw new Error('installBatchPhilosophy: opts.extensionRoot is required');
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const now = opts.now instanceof Date ? opts.now : new Date();

  const claudeDir = path.join(home, '.claude');
  const philosophyPath = path.join(claudeDir, PHILOSOPHY_FILE);
  const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
  const srcPhilosophy = path.join(extensionRoot, 'philosophy', PHILOSOPHY_FILE);

  const messages = [];
  const say = (m) => { messages.push(m); log(m); };

  // --- 1. Copie du fichier de philosophie — TOUJOURS, comme les hooks ---
  if (!fs.existsSync(srcPhilosophy)) throw new Error(`Missing source file: ${srcPhilosophy}`);
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.copyFileSync(srcPhilosophy, philosophyPath);
  say(`Copied: ${PHILOSOPHY_FILE} -> ${claudeDir}`);

  // --- 2. CLAUDE.md — lecture, idempotence, écriture protégée ---
  let existing = '';
  let claudeMdExisted = false;
  if (fs.existsSync(claudeMdPath)) {
    claudeMdExisted = true;
    existing = fs.readFileSync(claudeMdPath, 'utf8');
  }

  if (existing.includes(IMPORT_LINE)) {
    say('CLAUDE.md: import line already present (no change).');
    return { changed: false, messages, philosophyPath, claudeMdPath, backupPath: null };
  }

  // Backup AVANT toute écriture — seulement si un fichier préexiste (rien à
  // sauvegarder pour un CLAUDE.md qu'on crée).
  let backupPath = null;
  if (claudeMdExisted) {
    backupPath = `${claudeMdPath}.bak-${backupSuffix(now)}`;
    fs.copyFileSync(claudeMdPath, backupPath);
    say(`Backup CLAUDE.md -> ${backupPath}`);
  }

  let next = existing;
  if (next && !next.endsWith('\n')) next += '\n';
  next += `${IMPORT_LINE}\n`;

  fs.writeFileSync(claudeMdPath, next, 'utf8');
  say(claudeMdExisted ? 'CLAUDE.md: import line added.' : 'CLAUDE.md: created with the import line.');

  // Revalidation : le fichier réécrit doit bien contenir la ligne — même
  // doctrine que hooks-install.js pour settings.json (ne jamais laisser une
  // écriture non conforme sans le dire), même si le risque est bien moindre
  // sur du texte brut sans syntaxe à respecter.
  const reread = fs.readFileSync(claudeMdPath, 'utf8');
  if (!reread.includes(IMPORT_LINE)) {
    if (backupPath && fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, claudeMdPath);
      throw new Error(`CLAUDE.md write did not stick - backup restored (${backupPath}).`);
    }
    try { fs.unlinkSync(claudeMdPath); } catch {}
    throw new Error('CLAUDE.md write did not stick, and there was no existing file to restore - removed it.');
  }

  return { changed: true, messages, philosophyPath, claudeMdPath, backupPath };
}

module.exports = {
  installBatchPhilosophy,
  PHILOSOPHY_FILE,
  IMPORT_LINE,
};
