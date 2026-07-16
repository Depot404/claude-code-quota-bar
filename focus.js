const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { norm, labelMatches, isClaudeTab } = require('./labels');

// ============================================================================
// Clic sur une conversation du panneau → focus de son onglet, où qu'il soit.
//
// POURQUOI C'EST INDIRECT — VS Code n'expose aucun mapping onglet↔session
// (microsoft/vscode#158853), aucune API pour activer un onglet (#162446), et
// aucune API pour remonter une fenêtre au premier plan (#51078, #74945).
// L'extension Claude ne contribue aucune commande ciblant un session_id.
// Il ne reste donc que : retrouver l'onglet par son LIBELLÉ, l'activer par son
// INDEX (workbench.action.openEditorAtIndex, qui n'agit que sur le groupe
// actif → focus du groupe d'abord), et remonter la fenêtre via Win32.
//
// POURQUOI UN RELAIS FICHIER — le panneau liste les conversations du WORKSPACE,
// pas celles de la fenêtre : une conv du même workspace peut très bien avoir son
// onglet dans une AUTRE fenêtre VS Code. Chaque fenêtre a son propre hôte
// d'extension, qui ne voit que ses propres tabGroups. D'où la requête déposée
// dans ~/.claude/panel-focus-request.json, que toutes les instances observent :
// celle qui possède l'onglet répond, les autres ignorent.
// ============================================================================

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const REQUEST_NAME = 'panel-focus-request.json';
const REQUEST_PATH = path.join(CLAUDE_DIR, REQUEST_NAME);
const RAISE_SCRIPT = path.join(__dirname, 'raise-window.ps1');

// Au-delà, la requête est un résidu (fenêtre fermée avant d'avoir répondu, reste
// d'une session précédente) : y répondre volerait le focus sans que personne
// n'ait cliqué.
const REQUEST_TTL_MS = 3000;

// workbench.action.focusNthEditorGroup n'existe que jusqu'au 8e groupe.
const GROUP_FOCUS_COMMANDS = [
  'workbench.action.focusFirstEditorGroup',
  'workbench.action.focusSecondEditorGroup',
  'workbench.action.focusThirdEditorGroup',
  'workbench.action.focusFourthEditorGroup',
  'workbench.action.focusFifthEditorGroup',
  'workbench.action.focusSixthEditorGroup',
  'workbench.action.focusSeventhEditorGroup',
  'workbench.action.focusEighthEditorGroup',
];

function log(fmt, ...args) { console.log('[QuotaBar] ' + fmt, ...args); }

// Cherche l'onglet dans TOUS les groupes de CETTE fenêtre (le lot 1 ne regardait
// que le groupe actif). Garde-fou conservé : sans correspondance on ne devine
// pas — mieux vaut ne rien faire que focus la mauvaise conversation.
function findTab(title) {
  if (!norm(title)) return null;
  const matches = [];
  for (const group of vscode.window.tabGroups.all) {
    const index = group.tabs.findIndex((t) => isClaudeTab(t) && labelMatches(t.label, title));
    if (index >= 0) matches.push({ group, index, label: group.tabs[index].label });
  }
  if (!matches.length) return null;
  if (matches.length > 1) log('ambiguous title "%s" in %d groups — picking the active one', title, matches.length);
  // Ambiguïté (deux libellés tronqués au même préfixe, groupes différents) : le
  // groupe actif est le seul « récemment utilisé » que l'API expose.
  return matches.find((m) => m.group.isActive) || matches[0];
}

async function focusTab(match) {
  // Toujours passer par le focus de groupe, même s'il est déjà actif :
  // openEditorAtIndex agit sur le groupe actif, et un clic dans le panneau met
  // le focus dans la sidebar, pas dans la zone d'édition.
  const cmd = GROUP_FOCUS_COMMANDS[match.group.viewColumn - 1];
  if (cmd) {
    try { await vscode.commands.executeCommand(cmd); } catch {}
  }
  await vscode.commands.executeCommand('workbench.action.openEditorAtIndex', match.index);
}

// Écriture entière + rename atomique — même garantie que hooks/sessions-state.js :
// le lecteur voit l'ancien fichier complet ou le nouveau, jamais un JSON tronqué.
// Pas de lock ici, contrairement à sessions-state.json : aucun read-modify-write
// à protéger, la requête la plus récente écrase, c'est exactement ce qu'on veut.
function writeRequest(payload) {
  const tmp = `${REQUEST_PATH}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, REQUEST_PATH);
  } catch (e) {
    log('focus relay write failed: %s', e && e.message);
  }
}

// Remontée de la fenêtre au premier plan — aucune API VS Code (#51078), donc
// Win32 via PowerShell. On passe le LIBELLÉ DE L'ONGLET, pas le titre de la
// conversation : le titre de la fenêtre vaut « <onglet actif> - <dossier> -
// Visual Studio Code », et l'onglet porte le libellé tronqué (cf. labelMatches).
// Il transite par variable d'environnement : aucun échappement de ligne de
// commande à faire (ces libellés viennent des prompts de l'utilisateur).
// Le script se rabat sur un flash de la barre des tâches si Windows refuse la
// prise de focus.
function raiseWindow(tabLabel) {
  try {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', RAISE_SCRIPT,
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        QB_FOCUS_TITLE: tabLabel,
        // « Code », « Code - Insiders »… : l'hôte d'extension tourne dans le
        // binaire de l'application, donc son execPath donne le bon nom.
        QB_FOCUS_PROCESS: path.basename(process.execPath, '.exe'),
      },
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('close', () => log('raise: %s', out.trim() || '(no output)'));
    child.on('error', (e) => log('raise failed: %s', e && e.message));
  } catch (e) {
    log('raise spawn failed: %s', e && e.message);
  }
}

// Réponse au relais : on ne remonte la fenêtre QUE si l'onglet est chez nous.
function createFocusRelay() {
  let watcher = null;
  let lastTs = 0;

  async function onRequest() {
    let req = null;
    try { req = JSON.parse(fs.readFileSync(REQUEST_PATH, 'utf8')); } catch { return; }
    if (!req || !req.ts) return;
    if (req.origin_pid === process.pid) return;        // notre propre requête
    if (req.ts <= lastTs) return;                      // fs.watch émet plusieurs events par écriture
    if (Date.now() - req.ts > REQUEST_TTL_MS) return;  // résidu
    lastTs = req.ts;
    const match = findTab(req.title);
    if (!match) return;                                // pas chez nous : une autre fenêtre répondra
    try {
      await focusTab(match);
      raiseWindow(match.label);
    } catch (e) {
      log('relay focus failed: %s', e && e.message);
    }
  }

  try {
    watcher = fs.watch(CLAUDE_DIR, (_evt, filename) => {
      if (filename === REQUEST_NAME) onRequest();
    });
  } catch (e) {
    log('focus relay watch failed: %s', e && e.message);
  }

  return { dispose() { try { if (watcher) watcher.close(); } catch {} } };
}

// Point d'entrée du clic panneau (message `focusConv` du webview).
async function focusConversation(msg) {
  const title = msg && msg.title;
  if (!norm(title)) return;
  const match = findTab(title);
  if (match) {
    await focusTab(match);
    return;
  }
  // Introuvable ici : l'onglet vit peut-être dans une autre fenêtre VS Code.
  // On journalise les libellés vus : c'est exactement ce qui manquait pour
  // repérer que le lot 1 ne matchait jamais rien (libellés tronqués côté Claude,
  // titre complet côté panneau) — un clic sans effet ET sans trace est invisible.
  log('no tab here for "%s" (claude tabs: %j) — relaying to the other windows', title,
    vscode.window.tabGroups.all.flatMap((g) => g.tabs.filter(isClaudeTab).map((t) => t.label)));
  writeRequest({
    title,
    session_id: (msg && msg.id) || null,
    ts: Date.now(),
    origin_pid: process.pid,
  });
}

module.exports = { focusConversation, createFocusRelay, findTab, REQUEST_PATH, REQUEST_TTL_MS };
