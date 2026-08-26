#!/usr/bin/env node
// Bancs de hooks-install.js — portage Node de install.ps1 (lot onboarding
// 2026-08-19, cf. hooks-install.js pour le pourquoi : install.ps1 était lancé
// via execFile('powershell.exe', ...), absent sur macOS/Linux, donc le bouton
// « Install Hooks » échouait purement et simplement hors Windows).
//
// Couverture demandée : dossier ~/.claude absent, settings.json absent,
// settings.json illisible (ne doit RIEN écraser), entrées déjà présentes
// (idempotence), et absence de toute hypothèse Windows dans les chemins.
//
// Chaque scénario travaille dans un dossier home JETABLE (mkdtempSync) —
// jamais le ~/.claude réel de la machine qui lance le banc. extensionRoot
// pointe le VRAI dossier du repo (hooks/, commands/) : ça vaut aussi de
// garde-fou anti-dérive — si HOOK_FILES s'écarte un jour des fichiers réels de
// hooks/, ce banc casse avant tout poste utilisateur.

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  installClaudeHooks,
  SettingsParseError,
  HOOK_FILES,
  ROOT_LIBS,
  SESSION_STATE_EVENTS,
} = require('../hooks-install');

const EXT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(label, ok, got) {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.error(`  FAIL ${label}${got !== undefined ? ` (obtenu: ${got})` : ''}`); }
}

function freshHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'quotabar-hooks-install-'));
}

function readSettings(settingsPath) {
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
}

function listBackups(claudeDir) {
  if (!fs.existsSync(claudeDir)) return [];
  return fs.readdirSync(claudeDir).filter((f) => f.startsWith('settings.json.bak-'));
}

// ── 1. ~/.claude absent (première installation) ────────────────────────────
console.log('\n1. Dossier ~/.claude totalement absent');
{
  const home = freshHome();
  check('.claude n\'existe pas au départ', !fs.existsSync(path.join(home, '.claude')));

  const res = installClaudeHooks({ extensionRoot: EXT, home });
  check('changed=true à la première installation', res.changed === true);
  check('scriptsDir créé', fs.existsSync(res.scriptsDir));
  check('commandsDir créé', fs.existsSync(res.commandsDir));

  for (const f of HOOK_FILES) {
    const dst = path.join(res.scriptsDir, f);
    check(`hook copié: ${f}`, fs.existsSync(dst)
      && fs.readFileSync(dst, 'utf8') === fs.readFileSync(path.join(EXT, 'hooks', f), 'utf8'));
  }
  for (const f of ROOT_LIBS) {
    const dst = path.join(res.scriptsDir, f);
    check(`lib racine copiée: ${f}`, fs.existsSync(dst)
      && fs.readFileSync(dst, 'utf8') === fs.readFileSync(path.join(EXT, f), 'utf8'));
  }
  const handoffsDst = path.join(res.commandsDir, 'handoffs.md');
  check('handoffs.md copié', fs.existsSync(handoffsDst)
    && fs.readFileSync(handoffsDst, 'utf8') === fs.readFileSync(path.join(EXT, 'commands', 'handoffs.md'), 'utf8'));

  check('settings.json créé', fs.existsSync(res.settingsPath));
  const settings = readSettings(res.settingsPath);
  check('statusLine câblé', settings.statusLine && settings.statusLine.command.includes('usage-statusline.js'));
  check('UserPromptSubmit câblé', Array.isArray(settings.hooks.UserPromptSubmit)
    && settings.hooks.UserPromptSubmit.some((g) => g.hooks.some((h) => h.command.includes('track-active-session.js'))));
  let allEvents = true;
  for (const ev of SESSION_STATE_EVENTS) {
    const ok = Array.isArray(settings.hooks[ev])
      && settings.hooks[ev].some((g) => g.hooks.some((h) => h.command.includes('hook-session-state.js')));
    if (!ok) allEvents = false;
  }
  check('les 9 événements Stop/Notification/.../PostCompact sont câblés', allEvents);
  check('aucun backup créé (rien à sauvegarder, le fichier n\'existait pas)', res.backupPath === null
    && listBackups(path.join(home, '.claude')).length === 0);

  fs.rmSync(home, { recursive: true, force: true });
}

// ── 2. Idempotence : relancer ne duplique rien ──────────────────────────────
console.log('\n2. Idempotence — relancer deux fois de suite');
{
  const home = freshHome();
  const res1 = installClaudeHooks({ extensionRoot: EXT, home });
  const textAfterFirst = fs.readFileSync(res1.settingsPath, 'utf8');

  const res2 = installClaudeHooks({ extensionRoot: EXT, home });
  const textAfterSecond = fs.readFileSync(res2.settingsPath, 'utf8');

  check('changed=false au deuxième appel', res2.changed === false);
  check('settings.json strictement inchangé (octet pour octet)', textAfterFirst === textAfterSecond);
  check('aucun backup créé au deuxième appel', res2.backupPath === null
    && listBackups(path.join(home, '.claude')).length === 0);

  const settings = readSettings(res2.settingsPath);
  check('exactement UN groupe pour UserPromptSubmit (pas de doublon)', settings.hooks.UserPromptSubmit.length === 1);
  check('exactement UN groupe pour Stop (pas de doublon)', settings.hooks.Stop.length === 1);

  fs.rmSync(home, { recursive: true, force: true });
}

// ── 3. settings.json absent mais ~/.claude existe déjà ──────────────────────
console.log('\n3. ~/.claude existe déjà (scripts déployés à la main), settings.json absent');
{
  const home = freshHome();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  check('settings.json absent au départ', !fs.existsSync(path.join(home, '.claude', 'settings.json')));

  const res = installClaudeHooks({ extensionRoot: EXT, home });
  check('changed=true', res.changed === true);
  check('settings.json créé malgré le dossier préexistant', fs.existsSync(res.settingsPath));
  check('aucun backup (rien à sauvegarder)', res.backupPath === null);

  fs.rmSync(home, { recursive: true, force: true });
}

// ── 4. settings.json illisible → NE DOIT RIEN ÉCRASER ───────────────────────
console.log('\n4. settings.json illisible (JSON invalide) — garde-fou de non-écrasement');
{
  const home = freshHome();
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsPath = path.join(claudeDir, 'settings.json');
  const garbage = '{ "statusLine": { this is not valid json,,, ';
  fs.writeFileSync(settingsPath, garbage, 'utf8');

  let threw = null;
  try {
    installClaudeHooks({ extensionRoot: EXT, home });
  } catch (err) {
    threw = err;
  }
  check('jette bien une erreur', threw !== null);
  check('erreur = SettingsParseError', threw instanceof SettingsParseError);
  check('le message dit quoi faire (fix/rename)', /fix|rename/i.test(threw ? threw.message : ''));
  check('le message mentionne le chemin réel de settings.json', threw && threw.message.includes(settingsPath));

  const stillThere = fs.readFileSync(settingsPath, 'utf8');
  check('settings.json est resté BYTE POUR BYTE identique (rien écrasé)', stillThere === garbage);
  check('aucun fichier .bak créé', listBackups(claudeDir).length === 0);

  // Parité avec install.ps1 : la copie des hooks (fichiers gérés par
  // l'extension, sans risque pour les données utilisateur) précède le
  // contrôle de settings.json et n'est donc pas bloquée par lui.
  check('les hooks ont quand même été déployés (indépendant de settings.json)',
    fs.existsSync(path.join(claudeDir, 'scripts', 'hook-session-state.js')));

  fs.rmSync(home, { recursive: true, force: true });
}

// ── 4bis. Racine JSON valide mais pas un objet (ex: un tableau) ────────────
console.log('\n4bis. settings.json = JSON valide mais racine non-objet');
{
  const home = freshHome();
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsPath = path.join(claudeDir, 'settings.json');
  fs.writeFileSync(settingsPath, '[1, 2, 3]', 'utf8');

  let threw = null;
  try { installClaudeHooks({ extensionRoot: EXT, home }); } catch (err) { threw = err; }
  check('un tableau à la racine est traité comme illisible, pas comme un objet vide', threw instanceof SettingsParseError);
  check('le fichier original est intact', fs.readFileSync(settingsPath, 'utf8') === '[1, 2, 3]');

  fs.rmSync(home, { recursive: true, force: true });
}

// ── 5. settings.json partiel : seules les entrées manquantes sont ajoutées ─
console.log('\n5. settings.json partiel — n\'ajoute QUE ce qui manque, ne touche pas au reste');
{
  const home = freshHome();
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsPath = path.join(claudeDir, 'settings.json');
  const before = {
    statusLine: { type: 'command', command: 'node /already/there/usage-statusline.js', refreshInterval: 60 },
    hooks: {
      UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: 'node /already/there/track-active-session.js' }] }],
      // Groupe étranger avec un matcher restrictif : ne doit JAMAIS être fusionné.
      Notification: [{ matcher: 'permission_prompt', hooks: [{ type: 'command', command: 'node /some/other-tool.js' }] }],
    },
  };
  fs.writeFileSync(settingsPath, JSON.stringify(before, null, 2), 'utf8');
  const rawBefore = fs.readFileSync(settingsPath, 'utf8');

  const res = installClaudeHooks({ extensionRoot: EXT, home });
  check('changed=true (des entrées manquaient)', res.changed === true);
  check('un backup a été créé', typeof res.backupPath === 'string' && fs.existsSync(res.backupPath));
  check('le backup contient EXACTEMENT le contenu d\'avant', fs.readFileSync(res.backupPath, 'utf8') === rawBefore);

  const settings = readSettings(settingsPath);
  check('statusLine déjà présent n\'est pas remplacé', settings.statusLine.command === 'node /already/there/usage-statusline.js');
  check('UserPromptSubmit déjà présent n\'est pas dupliqué (toujours 1 groupe)', settings.hooks.UserPromptSubmit.length === 1);
  check('le groupe Notification étranger (matcher restrictif) est toujours là, intact',
    settings.hooks.Notification.some((g) => g.matcher === 'permission_prompt'
      && g.hooks.some((h) => h.command === 'node /some/other-tool.js')));
  check('notre propre groupe Notification (matcher vide) est AJOUTÉ à côté, pas fusionné',
    settings.hooks.Notification.length === 2
    && settings.hooks.Notification.some((g) => g.matcher === '' && g.hooks.some((h) => h.command.includes('hook-session-state.js'))));
  check('Stop (absent avant) est maintenant câblé', Array.isArray(settings.hooks.Stop)
    && settings.hooks.Stop.some((g) => g.hooks.some((h) => h.command.includes('hook-session-state.js'))));

  fs.rmSync(home, { recursive: true, force: true });
}

// ── 6. Aucune hypothèse Windows dans les chemins ────────────────────────────
console.log('\n6. Absence d\'hypothèse Windows dans les chemins');
{
  const src = fs.readFileSync(path.join(EXT, 'hooks-install.js'), 'utf8');
  // Les commentaires du module CITENT délibérément powershell/.ps1/USERPROFILE
  // pour expliquer ce qu'on évite (cf. son en-tête) — seul le CODE compte ici,
  // donc on retire les commentaires `//` ligne par ligne avant de chercher.
  const codeOnly = src.split('\n').map((line) => {
    const idx = line.indexOf('//');
    return idx === -1 ? line : line.slice(0, idx);
  }).join('\n');
  check('aucune référence à powershell/.ps1/cmd.exe dans le CODE (hors commentaires)',
    !/powershell|\.ps1|cmd\.exe/i.test(codeOnly));
  check('aucun require de child_process (pas de process enfant, tout est fait en process)',
    !/require\(['"]child_process['"]\)/.test(codeOnly));
  check('le home vient de os.homedir() (jamais process.env.USERPROFILE en dur dans le code)',
    codeOnly.includes('os.homedir()') && !codeOnly.includes('USERPROFILE'));
  check('pas de chemin Windows câblé en dur (C:\\\\, backslash littéral en dehors de toForwardSlash)',
    !/['"`][A-Za-z]:\\\\/.test(codeOnly));

  // Fonctionnel : un home avec un espace ET une apostrophe (courant sur macOS,
  // ex. "/Users/Jo O'Brien") — vérifie que scriptsDir/commandsDir résolvent
  // via path.join (jamais une concaténation supposant `\`), et que les
  // commandes écrites dans settings.json sont TOUJOURS à `/`, y compris sur ce
  // poste Windows où path.sep vaut `\`.
  const home = freshHome("quotabar-hooks-install-Jo O'Brien ");
  const res = installClaudeHooks({ extensionRoot: EXT, home });
  check('scriptsDir = path.join(home, ".claude", "scripts") exactement',
    res.scriptsDir === path.join(home, '.claude', 'scripts'));
  const settings = readSettings(res.settingsPath);
  const allCommands = [
    settings.statusLine.command,
    ...Object.values(settings.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command))),
  ];
  check('aucune commande câblée ne contient de backslash, même avec un home à espace/apostrophe',
    allCommands.every((c) => !c.includes('\\')), JSON.stringify(allCommands[0]));
  check('chaque commande pointe bien vers scriptsDir en slashes', allCommands.every((c) => c.startsWith('node ' + res.scriptsDir.split(path.sep).join('/'))));

  fs.rmSync(home, { recursive: true, force: true });
}

// ── 7. HOOK_FILES/ROOT_LIBS/SESSION_STATE_EVENTS n'ont pas dérivé de install.ps1 ─
console.log('\n7. Parité avec install.ps1 (anti-dérive, "chasser les frères")');
{
  const ps1 = fs.readFileSync(path.join(EXT, 'install.ps1'), 'utf8');
  const hookFilesBlock = ps1.match(/\$hookFiles = @\(([\s\S]*?)\)/);
  const rootLibsBlock = ps1.match(/\$rootLibs = @\(([\s\S]*?)\)/);
  const eventsBlock = ps1.match(/foreach \(\$ev in @\(([\s\S]*?)\)\)/);

  const extract = (block) => (block ? block[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1)) : []);
  const ps1HookFiles = extract(hookFilesBlock);
  const ps1RootLibs = extract(rootLibsBlock);
  const ps1Events = extract(eventsBlock);

  check('HOOK_FILES == $hookFiles de install.ps1',
    JSON.stringify(HOOK_FILES) === JSON.stringify(ps1HookFiles), JSON.stringify({ js: HOOK_FILES, ps1: ps1HookFiles }));
  check('ROOT_LIBS == $rootLibs de install.ps1',
    JSON.stringify(ROOT_LIBS) === JSON.stringify(ps1RootLibs), JSON.stringify({ js: ROOT_LIBS, ps1: ps1RootLibs }));
  check('SESSION_STATE_EVENTS == la liste foreach de install.ps1',
    JSON.stringify(SESSION_STATE_EVENTS) === JSON.stringify(ps1Events), JSON.stringify({ js: SESSION_STATE_EVENTS, ps1: ps1Events }));
}

// ── 8. extension.js appelle bien installClaudeHooks(), plus powershell.exe ─
console.log('\n8. extension.js: installHooks() ne shelle plus vers powershell.exe');
{
  const src = fs.readFileSync(path.join(EXT, 'extension.js'), 'utf8');
  const start = src.indexOf('async function installHooks(context)');
  const end = src.indexOf('\nasync function toggleSounds', start);
  check('la fonction installHooks est repérée dans extension.js', start !== -1 && end !== -1);
  const body = start !== -1 && end !== -1 ? src.slice(start, end) : '';
  check('installHooks() appelle installClaudeHooks(...)', body.includes('installClaudeHooks('));
  check('installHooks() ne référence plus powershell.exe/install.ps1', !/powershell\.exe|install\.ps1/.test(body));
  check('la modale de consentement est toujours là (showWarningMessage + modal:true)',
    body.includes('showWarningMessage') && body.includes('modal: true'));
}

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
