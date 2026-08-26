const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { norm, convMatchesLabel, isClaudeTab } = require('./labels');
const { OPEN_COMMAND } = require('./launcher');

// ============================================================================
// Clic sur une conversation du panneau → focus de son onglet, où qu'il soit.
//
// VOIE PRINCIPALE (lot « clic par identifiant », 2026-08-25) — l'extension
// officielle enregistre `claude-vscode.editor.open(sessionId, prompt,
// viewColumn)`, dont la toute première branche revealed() le panneau déjà
// ouvert pour ce sessionId SANS AUCUNE comparaison de titre — focus EXACT.
// Danger vérifié (NOTES_api_claude_code_extension.md) : si CETTE fenêtre n'a
// pas déjà ce sessionId ouvert, la commande le traite comme une nouvelle
// conversation et EN RECRÉE UN PANNEAU (reprise de session, doublon). On ne
// l'appelle donc que dans la fenêtre dont le memento du state.vscdb
// (`session-titles.js` createOpenSessionIds, seule preuve d'identité
// d'onglet — la Tab API ne l'expose pas) confirme que ce sessionId y est
// déjà ouvert (`tryOfficialFocus`). Version de l'extension trop ancienne pour
// exposer la commande → repli intégral sur la voie historique ci-dessous.
//
// REPLI PAR LIBELLÉ (voie d'avant ce lot) — VS Code n'expose aucun mapping
// onglet↔session (microsoft/vscode#158853), aucune API pour activer un onglet
// (#162446), et aucune API pour remonter une fenêtre au premier plan (#51078,
// #74945). Il ne reste donc que : retrouver l'onglet par son LIBELLÉ,
// l'activer par son INDEX (workbench.action.openEditorAtIndex, qui n'agit que
// sur le groupe actif → focus du groupe d'abord), et remonter la fenêtre via
// Win32. Ce chemin reste le seul dès que le libellé affiché diverge du
// libellé réel de l'onglet ET que la voie principale n'a pas pu conclure.
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

// Injecté par extension.js (`createOpenSessionIds` de session-titles.js, lu
// sur LE MÊME state.vscdb que sessionTitles) : sessionId → ouvert dans CETTE
// fenêtre. Défaut = Set vide tant que rien n'est câblé (bancs, extension pas
// encore activée) → tryOfficialFocus ne peut jamais conclure « ouvert ici »
// par erreur, il retombe alors sur le repli par libellé.
let getOpenSessionIds = () => new Set();
function setOpenSessionIdsSource(fn) {
  getOpenSessionIds = typeof fn === 'function' ? fn : () => new Set();
}

// Voie principale du clic (cf. en-tête du fichier) : focus EXACT par
// sessionId, jamais par comparaison de titre. Ne réussit QUE si (1) le
// memento confirme que ce sessionId est ouvert ICI et (2) la commande
// officielle existe sur cette version de l'extension — sans ces deux gardes,
// l'appel recréerait un panneau (doublon) au lieu d'en révéler un existant.
// Toute défaillance (commande absente, exception à l'exécution) rend `false`
// sans rien avoir tenté d'autre : c'est à l'appelant de retomber sur le
// repli par libellé, jamais à cette fonction de le faire elle-même.
async function tryOfficialFocus(sessionId) {
  if (!sessionId) return false;
  if (!getOpenSessionIds().has(sessionId)) return false;
  let available = false;
  try {
    const all = await vscode.commands.getCommands(true);
    available = Array.isArray(all) && all.includes(OPEN_COMMAND);
  } catch (e) {
    log('getCommands failed: %s', e && e.message);
  }
  if (!available) return false;
  try {
    await vscode.commands.executeCommand(OPEN_COMMAND, sessionId);
    return true;
  } catch (e) {
    log('%s(%s) failed: %s — repli sur le libellé', OPEN_COMMAND, sessionId, e && e.message);
    return false;
  }
}

// Cherche l'onglet dans TOUS les groupes de CETTE fenêtre (le lot 1 ne regardait
// que le groupe actif). Garde-fou conservé : sans correspondance on ne devine
// pas — mieux vaut ne rien faire que focus la mauvaise conversation.
// `tabTitle` (2026-07-22) : titre RÉEL de l'onglet quand il diverge de celui du
// transcript (state.vscdb, cf. session-titles.js). Sans lui, un clic sur une
// conv dont l'onglet a été renommé par l'extension officielle ne trouve rien et
// reste un no-op — c'est la moitié « clic » du bug de présence.
function findTab(title, tabTitle) {
  if (!norm(title) && !norm(tabTitle)) return null;
  const conv = { title, tabTitle };
  const matches = [];
  for (const group of vscode.window.tabGroups.all) {
    const index = group.tabs.findIndex((t) => isClaudeTab(t) && convMatchesLabel(t.label, conv));
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
  // raise-window.ps1 talks Win32 (EnumWindows, SetForegroundWindow) — no
  // portable equivalent, and no other platform to test against. The tab
  // itself is already focused by focusTab() above; this only brings the OS
  // window forward, so skipping it here is a silent no-op, never a spawn of
  // a binary (powershell.exe) that doesn't exist on macOS/Linux.
  if (process.platform !== 'win32') {
    log('raise: skipped (platform %s has no window-raise support)', process.platform);
    return;
  }
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

// Fermeture de l'onglet d'une conversation. Plus AUCUN bouton du panneau ne la
// demande (cf. bas de fichier) : seule la branche action:'close' du relais y
// mène encore, pour répondre à une fenêtre voisine restée sur une version
// antérieure. `tabGroups.close` est une API PUBLIQUE (contrairement à
// openEditorAtIndex qui n'agit que sur le groupe actif) : pas de focus à voler
// pour fermer.
async function closeTab(match) {
  // preserveFocus = true : l'utilisateur vient de cliquer dans la sidebar, la
  // fermeture d'un onglet ne doit pas lui envoyer le curseur dans la zone
  // d'édition.
  await vscode.window.tabGroups.close(match.group.tabs[match.index], true);
}

// Réponse au relais : on ne remonte la fenêtre QUE si l'onglet est chez nous.
// `handlers.onActivated(label)` (2026-08-17, plan gel-tabs) : appelé après un
// focus réussi (jamais après une fermeture), sur CETTE instance — c'est ELLE
// qui possède l'onglet et dont le tracker doit savoir qu'un acte vient de s'y
// produire, cf. tabs.js `reportActivation`. La fenêtre d'origine (celle qui a
// écrit la requête) n'a rien activé chez elle : rien à lui rapporter.
function createFocusRelay(handlers = {}) {
  const onActivated = typeof handlers.onActivated === 'function' ? handlers.onActivated : () => {};
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

    // Voie principale, avant toute comparaison de libellé : une fermeture
    // (`action === 'close'`) n'a pas de sessionId à offrir à editor.open, elle
    // reste sur closeTab ci-dessous, qui a besoin du `match` de toute façon.
    if (req.action !== 'close' && await tryOfficialFocus(req.session_id)) {
      const label = req.tab_title || req.title || null;
      raiseWindow(label || '');
      try { onActivated(label); } catch {}
      return;
    }

    const match = findTab(req.title, req.tab_title);
    if (!match) return;                                // pas chez nous : une autre fenêtre répondra
    try {
      // `action` absent = focus : c'est la seule action qui existait avant le
      // lot 2, et une requête écrite par une fenêtre restée sur l'ancienne
      // version doit continuer à être comprise.
      if (req.action === 'close') await closeTab(match);
      else {
        await focusTab(match);
        raiseWindow(match.label);
        try { onActivated(match.label); } catch {}
      }
    } catch (e) {
      log('relay %s failed: %s', req.action || 'focus', e && e.message);
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

// Point d'entrée du clic panneau (message `focusConv` du webview). Retourne le
// libellé RÉELLEMENT activé (2026-08-17, plan gel-tabs) quand l'onglet est
// chez nous — null sinon (rien trouvé ici, relayé à une autre fenêtre : c'est
// elle qui activera, et donc elle qui rapportera, cf. createFocusRelay
// `onActivated`). extension.js s'en sert pour prévenir tabs.js
// (`reportActivation`) qu'une activation vient de se produire, sans attendre
// que l'API le confirme — la seule preuve qui reste vraie si sa copie miroir
// des onglets est gelée.
async function focusConversation(msg) {
  const title = msg && msg.title;
  const tabTitle = (msg && msg.tabTitle) || null;
  const sessionId = (msg && msg.id) || null;
  if (!norm(title) && !norm(tabTitle)) return null;

  // Voie principale : sessionId ouvert ICI → focus exact, aucun libellé à
  // comparer. C'est elle qui répare le no-op silencieux du 2026-08-25 (clic
  // sur une conv OUVERTE sans effet) : le libellé pouvait diverger, l'identité
  // de session, elle, ne divergera jamais.
  if (await tryOfficialFocus(sessionId)) return tabTitle || title || null;

  const match = findTab(title, tabTitle);
  if (match) {
    await focusTab(match);
    return match.label;
  }
  // Introuvable ici : l'onglet vit peut-être dans une autre fenêtre VS Code.
  // On journalise les libellés vus : c'est exactement ce qui manquait pour
  // repérer que le lot 1 ne matchait jamais rien (libellés tronqués côté Claude,
  // titre complet côté panneau) — un clic sans effet ET sans trace est invisible.
  log('no tab here for "%s" (claude tabs: %j) — relaying to the other windows', title,
    vscode.window.tabGroups.all.flatMap((g) => g.tabs.filter(isClaudeTab).map((t) => t.label)));
  writeRequest({
    title,
    tab_title: tabTitle,
    session_id: (msg && msg.id) || null,
    ts: Date.now(),
    origin_pid: process.pid,
  });
  return null;
}

// PLUS AUCUN ÉMETTEUR DE FERMETURE ICI (2026-08-07). Le panneau n'agit que sur
// les métadonnées depuis le plan repli-auto étape 15, et il ne supprime jamais
// une ligne : fermer un onglet est un geste que seul VS Code offre désormais.
// L'ancien `closeConversationTab` (badge ⨯ du webview) est donc parti avec son
// message `closeConvTab` et son câblage.
// Le RÉPONDEUR du relais, lui, reste (closeTab + la branche action:'close' de
// createFocusRelay) : une fenêtre voisine restée sur une version antérieure
// peut encore écrire une telle requête, et l'ignorer laisserait son ⨯ sans
// effet visible. Il disparaîtra quand plus aucune version émettrice ne circule.

module.exports = {
  focusConversation, createFocusRelay, findTab,
  setOpenSessionIdsSource,
  REQUEST_PATH, REQUEST_TTL_MS,
};
