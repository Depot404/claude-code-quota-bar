'use strict';
// ============================================================================
// Portage Node de install.ps1 (lot onboarding 2026-08-19) — déploie les hooks
// Claude Code + la commande /handoffs, et câble ~/.claude/settings.json.
// Appelé directement, EN PROCESS, par installHooks() dans extension.js.
//
// POURQUOI CE PORTAGE — install.ps1 n'était lancé que via
// execFile('powershell.exe', ...) : sur macOS/Linux, powershell.exe n'existe
// pas, donc le bouton « Install Hooks » échouait purement et simplement, pour
// une extension publiée au Marketplace pour tout le monde. Ce module fait
// EXACTEMENT ce que fait install.ps1 (même liste de fichiers, même câblage
// idempotent de settings.json, mêmes précautions) en Node pur — aucune
// dépendance à `vscode` ni à `child_process` : testable tel quel, comme
// batch.js/state.js. install.ps1 reste dans le dossier pour l'usage manuel ou
// scripté (README § Setup), mais n'est plus le chemin par défaut du bouton.
//
// GARDE-FOU NON NÉGOCIABLE — ne jamais écrire un settings.json qu'on n'a pas
// réussi à parser. Un settings.json existant illisible (JSON invalide, ou dont
// la racine n'est pas un objet) fait échouer proprement AVANT toute écriture,
// avec un message qui dit quoi faire : c'est le fichier personnel de
// l'utilisateur, jamais un fichier qu'on écrase sur un pari. La copie des
// hooks/de la commande /handoffs, elle, précède ce contrôle (comme dans
// install.ps1) : ce sont des fichiers gérés par l'extension, recopiés à
// l'identique à chaque appel, sans risque pour les données de l'utilisateur.
//
// AUCUNE HYPOTHÈSE WINDOWS — le dossier home vient de `os.homedir()` (jamais
// `process.env.USERPROFILE` seul, absent sur macOS/Linux), tout chemin passe
// par `path.join`/`path.sep`, et les commandes écrites dans settings.json sont
// toujours à `/` (Claude Code les exécute via un shell, `/` fonctionne partout
// y compris dans un `cmd` Windows moderne — c'est déjà ce que faisait
// install.ps1 avec `-replace '\\', '/'`).
// ============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');

// Même liste que install.ps1 ($hookFiles) — à garder synchronisée à la main,
// c'est le seul autre endroit qui énumère les hooks déployés. hook-session-
// state.js/track-active-session.js/usage-statusline.js sont les hooks
// proprement dits ; sessions-state.js/model-id.js/transcript.js/turn-cost.js/
// cost-history.js sont des libs require()es par les précédents (même dossier
// de déploiement obligatoire).
const HOOK_FILES = [
  'usage-statusline.js',
  'track-active-session.js',
  'hook-session-state.js',
  'sessions-state.js',
  'model-id.js',
  'transcript.js',
  'turn-cost.js',
  'cost-history.js',
];

// cost.js vit à la racine du repo (module de l'extension) et turn-cost.js le
// require : la grille tarifaire et la définition d'une borne de tour n'existent
// qu'à un seul endroit. Déployé lui aussi, à plat, aux côtés des hooks — même
// motif que install.ps1 ($rootLibs).
const ROOT_LIBS = ['cost.js'];

// Événements routés vers hook-session-state.js (même liste que le `foreach` de
// install.ps1). PermissionRequest est le seul signal IMMÉDIAT d'un dialogue de
// permission ; PermissionDenied/ElicitationResult referment l'attente.
// PreCompact/PostCompact (lot QuotaBar 2.62.0) : posent/lèvent le marqueur
// `compacting` de sessions-state.json (cf. hook-session-state.js) — le
// spinner busy existant couvre ainsi la compaction AUTOMATIQUE, invisible
// jusque-là (elle ne passe pas par UserPromptSubmit).
const SESSION_STATE_EVENTS = [
  'Stop',
  'Notification',
  'SessionEnd',
  'PermissionRequest',
  'PermissionDenied',
  'Elicitation',
  'ElicitationResult',
  'PreCompact',
  'PostCompact',
];

// Distinct d'une erreur de copie de fichier : le SEUL cas où l'appelant doit
// afficher « répare ton fichier, je n'ai touché à rien » plutôt qu'une erreur
// générique.
class SettingsParseError extends Error {
  constructor(settingsPath, cause) {
    super(
      `${settingsPath} exists but could not be parsed as JSON — nothing was ` +
      `written. Fix or rename this file by hand, then retry. ` +
      `Parse error: ${cause && cause.message ? cause.message : cause}`
    );
    this.name = 'SettingsParseError';
    this.settingsPath = settingsPath;
    this.cause = cause;
  }
}

function backupSuffix(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

// Les commandes écrites dans settings.json sont TOUJOURS à `/`, quel que soit
// l'OS d'installation (cf. note d'en-tête) — `path.sep` vaut `\` seulement sur
// Windows, donc ce split/join est un no-op sur macOS/Linux.
function toForwardSlash(p) {
  return p.split(path.sep).join('/');
}

// Un même script peut être câblé sur plusieurs événements : l'idempotence ne
// peut PAS se tester par recherche de texte dans le fichier brut (le premier
// événement trouvé ferait croire que tous y sont) — on teste événement par
// événement dans l'objet parsé, comme Test-HookPresent de install.ps1.
function hasHookEntry(settings, eventName, needle) {
  if (!settings || typeof settings !== 'object') return false;
  if (!settings.hooks || typeof settings.hooks !== 'object') return false;
  const groups = settings.hooks[eventName];
  if (!Array.isArray(groups)) return false;
  for (const g of groups) {
    if (!g) continue;
    const hooks = Array.isArray(g.hooks) ? g.hooks : [];
    for (const h of hooks) {
      if (h && typeof h.command === 'string' && h.command.includes(needle)) return true;
    }
  }
  return false;
}

// Ajoute TOUJOURS notre propre groupe (matcher '' = tous les cas) plutôt que
// d'appender au groupe existant — même motif que Add-HookEntry de install.ps1 :
// sur Notification/SessionEnd un groupe peut porter un matcher restrictif
// ('permission_prompt'), et s'y greffer limiterait silencieusement notre hook
// à ce seul cas.
function addHookEntry(settings, eventName, cmd) {
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  const existing = Array.isArray(settings.hooks[eventName]) ? settings.hooks[eventName] : [];
  settings.hooks[eventName] = existing.filter((g) => g != null)
    .concat([{ matcher: '', hooks: [{ type: 'command', command: cmd }] }]);
}

function copyOne(src, destDir, name) {
  if (!fs.existsSync(src)) throw new Error(`Missing source file: ${src}`);
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, path.join(destDir, name));
}

// Déploie les hooks + la commande /handoffs, câble settings.json — idempotent,
// backup horodaté avant toute écriture, relecture/validation du JSON après.
//
// opts.extensionRoot (obligatoire) — dossier de l'extension (context.
//   extensionPath côté VS Code), racine de hooks/ et commands/.
// opts.home — dossier home à utiliser (os.homedir() par défaut ; les bancs le
//   redirigent vers un dossier jetable).
// opts.now — horodatage à utiliser pour le nom du backup (Date.now() par
//   défaut ; les bancs le fixent pour des assertions stables).
// opts.log — callback(message) optionnel, appelé pour chaque étape (même
//   contenu que les Write-Host de install.ps1) — l'appelant décide où ça part.
//
// Retourne { changed, messages, scriptsDir, commandsDir, settingsPath,
//   backupPath }. Jette SettingsParseError si settings.json existe et n'a pas
//   pu être parsé (rien n'a été écrit) ; jette une Error simple pour toute
//   autre défaillance (fichier source manquant, écriture invalide relue).
function installClaudeHooks(opts = {}) {
  const home = opts.home || os.homedir();
  const extensionRoot = opts.extensionRoot;
  if (!extensionRoot) throw new Error('installClaudeHooks: opts.extensionRoot is required');
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const now = opts.now instanceof Date ? opts.now : new Date();

  const claudeDir = path.join(home, '.claude');
  const scriptsDir = path.join(claudeDir, 'scripts');
  const commandsDir = path.join(claudeDir, 'commands');
  const settingsPath = path.join(claudeDir, 'settings.json');
  const srcHooks = path.join(extensionRoot, 'hooks');
  const srcCommands = path.join(extensionRoot, 'commands');

  const messages = [];
  const say = (m) => { messages.push(m); log(m); };

  // --- 1. Copie des hooks + libs partagées vers ~/.claude/scripts/ ---
  for (const f of HOOK_FILES) {
    copyOne(path.join(srcHooks, f), scriptsDir, f);
    say(`Copied: ${f} -> ${scriptsDir}`);
  }
  for (const f of ROOT_LIBS) {
    copyOne(path.join(extensionRoot, f), scriptsDir, f);
    say(`Copied: ${f} -> ${scriptsDir}`);
  }

  // --- 1bis. Commande /handoffs (raccourci de frappe seulement : le collage
  // brut fonctionne sans elle — décision du plan création-groupes) ---
  copyOne(path.join(srcCommands, 'handoffs.md'), commandsDir, 'handoffs.md');
  say(`Copied: handoffs.md -> ${commandsDir}`);

  const scriptsFwd = toForwardSlash(scriptsDir);
  const statusLineCmd = `node ${scriptsFwd}/usage-statusline.js`;
  const trackCmd = `node ${scriptsFwd}/track-active-session.js`;
  const sessionStateCmd = `node ${scriptsFwd}/hook-session-state.js`;

  // --- 2. Câblage settings.json (idempotent) ---
  let rawText = '{}';
  let settingsExisted = false;
  if (fs.existsSync(settingsPath)) {
    settingsExisted = true;
    rawText = fs.readFileSync(settingsPath, 'utf8');
  }

  // GARDE-FOU : un settings.json existant qu'on ne sait pas relire ne doit
  // jamais être écrasé — on jette AVANT toute tentative d'écriture, jamais de
  // backup à créer puisqu'on ne va rien remplacer.
  let settings;
  try {
    settings = JSON.parse(rawText);
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error('settings.json root is not a JSON object');
    }
  } catch (err) {
    if (settingsExisted) throw new SettingsParseError(settingsPath, err);
    settings = {}; // fichier absent : '{}' est notre propre défaut, pas une lecture ratée.
  }

  const hasStatusLine = rawText.includes('usage-statusline.js');
  const needed = [];
  if (!hasHookEntry(settings, 'UserPromptSubmit', 'track-active-session.js')) {
    needed.push({ event: 'UserPromptSubmit', cmd: trackCmd });
  }
  for (const ev of SESSION_STATE_EVENTS) {
    if (!hasHookEntry(settings, ev, 'hook-session-state.js')) {
      needed.push({ event: ev, cmd: sessionStateCmd });
    }
  }

  if (hasStatusLine && needed.length === 0) {
    say('settings.json: statusLine + hooks already wired (no change).');
    return { changed: false, messages, scriptsDir, commandsDir, settingsPath, backupPath: null };
  }

  // Backup AVANT toute écriture — seulement si un fichier préexiste (rien à
  // sauvegarder pour un settings.json qu'on crée).
  let backupPath = null;
  if (settingsExisted) {
    backupPath = `${settingsPath}.bak-${backupSuffix(now)}`;
    fs.copyFileSync(settingsPath, backupPath);
    say(`Backup settings.json -> ${backupPath}`);
  }

  if (!hasStatusLine) {
    settings.statusLine = { type: 'command', command: statusLineCmd, refreshInterval: 60 };
    say('settings.json: statusLine added.');
  }
  for (const n of needed) {
    addHookEntry(settings, n.event, n.cmd);
    say(`settings.json: hook ${n.event} added.`);
  }

  const json = JSON.stringify(settings, null, 2);
  fs.writeFileSync(settingsPath, json, 'utf8'); // utf8 sans BOM : Node ne préfixe jamais de BOM ici.

  // Validation : re-parse, sinon restauration du backup (ou nettoyage si le
  // fichier n'existait pas avant — jamais laisser un settings.json cassé là où
  // il n'y avait rien).
  try {
    JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    say('settings.json: written and re-validated (JSON OK).');
  } catch (err) {
    if (backupPath && fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, settingsPath);
      throw new Error(`settings.json invalid after write - backup restored (${backupPath}). Error: ${err.message}`);
    }
    try { fs.unlinkSync(settingsPath); } catch {}
    throw new Error(`settings.json invalid after write, and there was no existing file to restore - removed the broken file. Error: ${err.message}`);
  }

  return { changed: true, messages, scriptsDir, commandsDir, settingsPath, backupPath };
}

module.exports = {
  installClaudeHooks,
  SettingsParseError,
  HOOK_FILES,
  ROOT_LIBS,
  SESSION_STATE_EVENTS,
};
