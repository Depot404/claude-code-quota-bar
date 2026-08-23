#!/usr/bin/env node
// Bancs de philosophy-install.js — dépôt de la « philosophie de lot »
// (lot onboarding 4, 2026-08-19), même doctrine que test-hooks-install.js
// pour hooks-install.js : dossier home JETABLE (mkdtempSync) à chaque
// scénario, extensionRoot pointe le VRAI dossier du repo
// (philosophy/claude-convs-batching.md) — anti-dérive si le fichier source
// venait à disparaître ou changer de nom.
//
// Couverture demandée : dépôt du fichier de règles, ajout de la ligne
// d'import, idempotence, CLAUDE.md absent, CLAUDE.md déjà porteur de la
// ligne, et sauvegarde créée avant écriture. Le refus de la proposition (rien
// n'est écrit du tout) est un comportement d'extension.js, pas de ce module
// pur — couvert séparément dans test-batch-philosophy-consent.js.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { installBatchPhilosophy, PHILOSOPHY_FILE, IMPORT_LINE } = require('../philosophy-install');

const EXT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(label, ok, got) {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.error(`  FAIL ${label}${got !== undefined ? ` (obtenu: ${got})` : ''}`); }
}

function freshHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'quotabar-philosophy-'));
}

function listBackups(claudeDir) {
  if (!fs.existsSync(claudeDir)) return [];
  return fs.readdirSync(claudeDir).filter((f) => f.startsWith('CLAUDE.md.bak-'));
}

check('IMPORT_LINE est un chemin RELATIF (pas de home/lecteur en dur)', IMPORT_LINE === `@${PHILOSOPHY_FILE}` && !IMPORT_LINE.includes(':') && !IMPORT_LINE.includes(os.homedir()));

// ── 1. CLAUDE.md totalement absent (première installation) ─────────────────
console.log('\n1. ~/.claude/CLAUDE.md absent — dépôt du fichier de règles + création propre du CLAUDE.md');
{
  const home = freshHome();
  check('.claude n\'existe pas au départ', !fs.existsSync(path.join(home, '.claude')));

  const res = installBatchPhilosophy({ extensionRoot: EXT, home });
  check('changed=true à la première installation', res.changed === true);
  check('philosophyPath déposé', fs.existsSync(res.philosophyPath));
  check('contenu déposé IDENTIQUE à la source (octet pour octet)',
    fs.readFileSync(res.philosophyPath, 'utf8') === fs.readFileSync(path.join(EXT, 'philosophy', PHILOSOPHY_FILE), 'utf8'));

  check('CLAUDE.md créé', fs.existsSync(res.claudeMdPath));
  const claudeMd = fs.readFileSync(res.claudeMdPath, 'utf8');
  check('CLAUDE.md contient la ligne d\'import', claudeMd.includes(IMPORT_LINE));
  check('CLAUDE.md ne contient RIEN d\'autre que la ligne d\'import (création propre, pas de préambule)',
    claudeMd.trim() === IMPORT_LINE, JSON.stringify(claudeMd));
  check('aucun backup créé (rien à sauvegarder, le fichier n\'existait pas)', res.backupPath === null
    && listBackups(path.join(home, '.claude')).length === 0);

  fs.rmSync(home, { recursive: true, force: true });
}

// ── 2. Idempotence : relancer deux fois ne duplique rien ────────────────────
console.log('\n2. Idempotence — relancer deux fois de suite');
{
  const home = freshHome();
  const res1 = installBatchPhilosophy({ extensionRoot: EXT, home });
  const textAfterFirst = fs.readFileSync(res1.claudeMdPath, 'utf8');

  const res2 = installBatchPhilosophy({ extensionRoot: EXT, home });
  const textAfterSecond = fs.readFileSync(res2.claudeMdPath, 'utf8');

  check('changed=false au deuxième appel', res2.changed === false);
  check('CLAUDE.md strictement inchangé (octet pour octet)', textAfterFirst === textAfterSecond);
  check('aucun backup créé au deuxième appel', res2.backupPath === null
    && listBackups(path.join(home, '.claude')).length === 0);
  const occurrences = textAfterSecond.split(IMPORT_LINE).length - 1;
  check('exactement UNE occurrence de la ligne d\'import (pas de doublon)', occurrences === 1, String(occurrences));

  fs.rmSync(home, { recursive: true, force: true });
}

// ── 3. CLAUDE.md déjà porteur d'un contenu personnel — backup + append propre ─
console.log('\n3. CLAUDE.md personnel préexistant (sans la ligne) — backup AVANT écriture, contenu préservé');
{
  const home = freshHome();
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
  const before = '# My personal instructions\n\nAlways answer in Markdown.'; // pas de \n final, exprès
  fs.writeFileSync(claudeMdPath, before, 'utf8');

  const res = installBatchPhilosophy({ extensionRoot: EXT, home });
  check('changed=true (la ligne manquait)', res.changed === true);
  check('un backup a été créé', typeof res.backupPath === 'string' && fs.existsSync(res.backupPath));
  check('le backup contient EXACTEMENT le contenu d\'avant', fs.readFileSync(res.backupPath, 'utf8') === before);
  check('le nom du backup est celui de CLAUDE.md, horodaté', path.basename(res.backupPath).startsWith('CLAUDE.md.bak-'));

  const after = fs.readFileSync(claudeMdPath, 'utf8');
  check('le contenu personnel préexistant est intact', after.startsWith(before));
  check('la ligne d\'import est ajoutée sur SA PROPRE ligne (pas collée à la dernière ligne existante)',
    after === `${before}\n${IMPORT_LINE}\n`, JSON.stringify(after));

  fs.rmSync(home, { recursive: true, force: true });
}

// ── 4. CLAUDE.md déjà porteur de la ligne — rien ne bouge ───────────────────
console.log('\n4. CLAUDE.md déjà porteur de la ligne d\'import — aucune écriture, aucun backup');
{
  const home = freshHome();
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
  const before = `# Perso\n\nSome rule.\n${IMPORT_LINE}\n`;
  fs.writeFileSync(claudeMdPath, before, 'utf8');

  const res = installBatchPhilosophy({ extensionRoot: EXT, home });
  check('changed=false (déjà présent)', res.changed === false);
  check('CLAUDE.md strictement inchangé', fs.readFileSync(claudeMdPath, 'utf8') === before);
  check('aucun backup créé', res.backupPath === null && listBackups(claudeDir).length === 0);
  // Le fichier de philosophie, lui, est TOUJOURS recopié (même doctrine que
  // les hooks) — indépendant de l'état de CLAUDE.md.
  check('le fichier de philosophie est quand même (re)déposé', fs.existsSync(res.philosophyPath));

  fs.rmSync(home, { recursive: true, force: true });
}

// ── 5. ~/.claude existe déjà (hooks déployés avant), CLAUDE.md absent ───────
console.log('\n5. ~/.claude existe déjà (ex: hooks déployés avant), CLAUDE.md absent');
{
  const home = freshHome();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}', 'utf8'); // trace d'un install hooks antérieur

  const res = installBatchPhilosophy({ extensionRoot: EXT, home });
  check('changed=true', res.changed === true);
  check('CLAUDE.md créé malgré le dossier préexistant', fs.existsSync(res.claudeMdPath));
  check('aucun backup (rien à sauvegarder)', res.backupPath === null);
  check('settings.json déposé par un autre appel n\'est pas touché',
    fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8') === '{}');

  fs.rmSync(home, { recursive: true, force: true });
}

// ── 6. Source manquante → erreur claire, rien n'est écrit ───────────────────
console.log('\n6. Fichier source manquant (extensionRoot invalide) — erreur claire, aucune écriture');
{
  const home = freshHome();
  const bogusRoot = freshHome('quotabar-philosophy-bogus-root-');
  let threw = null;
  try { installBatchPhilosophy({ extensionRoot: bogusRoot, home }); } catch (err) { threw = err; }
  check('jette bien une erreur', threw !== null);
  check('le message dit quel fichier manque', threw && /Missing source file/.test(threw.message));
  check('rien n\'a été créé dans ~/.claude', !fs.existsSync(path.join(home, '.claude', PHILOSOPHY_FILE))
    && !fs.existsSync(path.join(home, '.claude', 'CLAUDE.md')));

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(bogusRoot, { recursive: true, force: true });
}

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
