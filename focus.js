const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { norm, convMatchesLabel, isClaudeTab, labelNamesAnother } = require('./labels');
const { validatePositions } = require('./tab-positions');
// Instrumentation du clic (2026-09-03, PLAN_titre_onglet_divergent_2026-09-02.md
// fait 2 : « le clic vise le mauvais onglet », cause non établie faute de
// capture assez détaillée). Même journal que focus-click/highlight-verdict —
// un `grep` autour de l'heure signalée doit suffire, cf. règle « le JOURNAL
// tranche » du CLAUDE.md. Observateur seul : aucune décision ci-dessous n'en
// dépend.
const { logEvent } = require('./ack-journal');

// ============================================================================
// Clic sur une conversation du panneau → focus de son onglet, où qu'il soit.
//
// ── VOIE PRINCIPALE : L'IDENTITÉ, JAMAIS LE TEXTE (2026-08-29) ──────────────
// Onzième reprise du même symptôme, et la première qui change de GRANDEUR
// MESURÉE. Toutes les précédentes affinaient la comparaison de libellés ;
// aucune ne pouvait aboutir, parce que deux conversations peuvent porter le
// même libellé au caractère près. Mesuré ce jour dans le memento du renderer,
// deux onglets voisins (exemple transposé) :
//
//   idx 7  <uuid A>  'Rename scanned invoic…'
//   idx 8  <uuid B>  'Rename scanned invoic…'
//
// Les deux clics de l'utilisateur atterrissaient sur l'onglet de l'AUTRE sœur
// (journal : `focus-click` sur A suivi d'un `stay-start` à l'index de B, et
// réciproquement).
//
// LA VOIE RETENUE — le memento du renderer donne, pour chaque session, la
// POSITION de son onglet (groupe + index, cf. session-titles.js `locations`).
// On sélectionne cet onglet-là par `openEditorAtIndex`. Rien n'est comparé, et
// surtout rien ne peut être OUVERT : cette commande ne sait que choisir parmi
// les onglets existants. Les trois contrôles de concordance qui protègent du
// retard du memento sont décrits sur `focusByIdentity` plus bas.
//
// ⚠️ POURQUOI PAS `claude-vscode.editor.open(sessionId)`, qui semblait pourtant
// la voie royale (sa première branche est `sessionPanels.get(id).reveal()`,
// focus exact sans aucun texte) — MESURÉ le 2026-08-29, et c'est un fait
// nouveau que NOTES_api_claude_code_extension.md ne disait pas : elle ne
// retrouve PAS un webview restauré qui n'a jamais été réaffiché depuis un
// rechargement de fenêtre. VS Code désérialise ces panneaux paresseusement, à
// la première visite ; tant qu'ils dorment ils sont absents de `sessionPanels`,
// et la commande les traite comme une reprise de session : elle OUVRE. Observé
// au journal — un onglet neuf titré « Claude Code » apparaissant à chaque clic,
// refermé dans la foulée par le filet qui gardait alors l'appel. Le filet
// marchait ; c'est l'action qu'il gardait qui était mauvaise. Un onglet
// restauré est justement le cas le PLUS fréquent après un reload, donc cette
// commande est inutilisable comme voie de focus, quelle que soit sa garde.
//
// Corollaire de méthode : la preuve d'appartenance par filiation de process
// (owned-sessions.js, retirée le même jour) et le filet de fermeture ont
// disparu avec elle — ils ne gardaient que cet appel. Une garde n'a pas de
// valeur en soi ; quand l'action qu'elle protège s'en va, elle s'en va aussi.
//
// REPLI PAR LIBELLÉ (voie d'avant ce lot, conservée entière) — VS Code n'expose aucun mapping
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

// Injecte par extension.js (`createOpenSessionIds` de session-titles.js, lu
// sur LE MEME state.vscdb que sessionTitles) : sessionId → ouvert dans CETTE
// fenetre. Ne sert plus a decider d'un focus (voir l'en-tete) ; conserve comme
// source de verite d'identite d'onglet pour les appelants qui l'interrogent.
let getOpenSessionIds = () => new Set();
function setOpenSessionIdsSource(fn) {
  getOpenSessionIds = typeof fn === 'function' ? fn : () => new Set();
}

// POSITION de l'onglet de chaque session, lue dans le memento du renderer
// (session-titles.js `locations`) : { viewColumn, index, claudeCount }.
let getSessionLocations = () => null;
function setSessionLocationsSource(fn) {
  getSessionLocations = typeof fn === 'function' ? fn : () => null;
}

// Les conversations LISTÉES par le panneau ({ sessionId, title, tabTitle }),
// injectées par extension.js depuis le snapshot du moteur. Elles ne servent
// qu'à UNE question (labels.js `labelNamesAnother`) : le libellé trouvé à la
// position que l'identité désigne nomme-t-il une AUTRE conversation ? Sans
// source (bancs, moteur pas encore prêt) : personne d'autre n'est nommé, et
// l'identité garde la main — c'est le sens par défaut voulu.
let getListedConversations = () => [];
function setListedConversationsSource(fn) {
  getListedConversations = typeof fn === 'function' ? fn : () => [];
}

// L'état FRAIS des onglets de cette fenêtre, dans le comptage qu'attend
// tab-positions.js : combien d'onglets Claude, et à quel rang est l'actif —
// rang parmi les onglets Claude, groupes enchaînés dans l'ordre, exactement
// comme `flatIndex` du memento et `activeIndex` de tabs.js.
function worldTabs() {
  const out = { claudeCount: 0, activeFlatIndex: null };
  let active = null;
  try {
    const g = vscode.window.tabGroups.activeTabGroup;
    active = g && g.activeTab;
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of (group && group.tabs) || []) {
        if (!isClaudeTab(tab)) continue;
        if (tab === active) out.activeFlatIndex = out.claudeCount;
        out.claudeCount++;
      }
    }
  } catch { return { claudeCount: -1, activeFlatIndex: null }; }
  return out;
}

// Photo de TOUS les onglets Claude de cette fenêtre (groupe, index, libellé) —
// coûte une seule traversée de l'API temps réel, jamais du memento. Sert
// uniquement à l'instrumentation ci-dessous : voir d'un coup d'œil, au moment
// exact d'un clic, si un AUTRE onglet que celui visé porte un libellé qui
// pourrait expliquer une confusion (ex. un onglet redevenu un prompt, cf. NOTES
// « Pourquoi un onglet redevient un PROMPT »).
function claudeTabsSnapshot() {
  const out = [];
  try {
    for (const g of vscode.window.tabGroups.all) {
      for (const t of (g && g.tabs) || []) {
        if (isClaudeTab(t)) out.push({ viewColumn: g.viewColumn, label: t.label });
      }
    }
  } catch { return null; }
  return out;
}

// Voie principale du clic : révéler l'onglet dont le memento dit qu'il porte CE
// sessionId, en le SÉLECTIONNANT à sa position — jamais en demandant à qui que
// ce soit de l'ouvrir.
//
// Rend le libellé réellement activé, ou `null` — auquel cas l'appelant retombe
// sur le repli par libellé. Cette fonction ne décide de rien d'autre qu'elle-même.
//
// ── LA CONCORDANCE EST VÉRIFIÉE, PAS SUPPOSÉE ────────────────────────────────
// Le memento est flushé paresseusement : entre deux flushs, l'utilisateur a pu
// fermer ou déplacer un onglet, et l'index désignerait alors son voisin. Trois
// contrôles, tous sur l'API TEMPS RÉEL, avant d'agir :
//   1. le groupe existe encore ;
//   2. il porte exactement autant d'onglets Claude que le memento en comptait —
//      une fermeture ou une ouverture depuis le flush se voit d'abord là ;
//   3. l'onglet à cette position est bien un onglet Claude, et son libellé ne
//      NOMME PAS UNE AUTRE conversation listée (labels.js `labelNamesAnother`).
//      ⚠️ Ce n'était pas ça avant le 2026-09-03 : le contrôle exigeait que le
//      libellé corresponde à la conversation cliquée, et le journal a montré
//      (00:59:53, `focus-identity outcome:label-mismatch`, loc juste, libellé
//      réel « ok go ») qu'il annulait une identité exacte au seul motif que
//      l'extension officielle avait renommé l'onglet avec le dernier prompt —
//      d'où un clic sans effet sur la conversation qu'on vient de recharger.
//      Un texte qui ne matche PERSONNE n'est pas une preuve contre l'identité ;
//      un texte qui nomme QUELQU'UN D'AUTRE, si (onglets réordonnés depuis le
//      flush). Qui porte donc la garde du memento périmé désormais : le compte
//      en bloc (1-2) et ce contrôle-ci sous sa forme positive.
// Un seul contrôle qui échoue ⇒ `null`, repli. On ne devine jamais une position.
//
// `origin` (2026-09-03, instrumentation fait 2) : 'click' ou 'relay' — juste de
// quoi distinguer au journal QUI a appelé, jamais lu par la logique.
async function focusByIdentity(sessionId, conv, origin) {
  const done = (outcome, extra) => {
    logEvent('focus-identity', {
      origin: origin || 'unknown', sessionId, title: conv && conv.title, tabTitle: conv && conv.tabTitle,
      outcome, ...extra,
    });
  };
  if (!sessionId) { done('no-session-id'); return null; }
  // La photo du memento est validée EN BLOC contre l'état frais des onglets
  // (tab-positions.js) — même juge que le surlignage, au même instant.
  let byId = null;
  try {
    byId = validatePositions(getSessionLocations(), worldTabs());
  } catch { done('validate-threw'); return null; }
  if (!byId) {
    log('identity focus: tab positions stale — falling back to labels');
    done('positions-stale');
    return null;
  }
  const loc = byId.get(sessionId);
  if (!loc || typeof loc.index !== 'number') { done('no-loc', { tabs: claudeTabsSnapshot() }); return null; }

  let group = null;
  try {
    group = vscode.window.tabGroups.all.find((g) => g.viewColumn === loc.viewColumn) || null;
  } catch { done('group-lookup-threw', { loc }); return null; }
  if (!group || !Array.isArray(group.tabs)) { done('no-group', { loc }); return null; }

  const tab = group.tabs[loc.index];
  if (!tab || !isClaudeTab(tab)) {
    done('no-tab-at-index', { loc, labelThere: tab ? tab.label : null, tabs: claudeTabsSnapshot() });
    return null;
  }
  const labelMatched = convMatchesLabel(tab.label, conv);
  if (!labelMatched) {
    let others = [];
    try { others = getListedConversations() || []; } catch { others = []; }
    if (labelNamesAnother(tab.label, { sessionId, title: conv && conv.title, tabTitle: conv && conv.tabTitle }, others)) {
      log('identity focus: label at index %d is "%s", which names another conversation — falling back', loc.index, tab.label);
      done('label-names-another', { loc, labelThere: tab.label, tabs: claudeTabsSnapshot() });
      return null;
    }
  }

  await focusTab({ group, index: loc.index, label: tab.label });
  done('resolved', { loc, resolvedLabel: tab.label, labelMatched });
  return tab.label;
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

    // Identité d'abord, ici aussi (2026-08-29). Le gain propre au relais : deux
    // fenêtres portant chacune un onglet au libellé identique répondaient TOUTES
    // LES DEUX à la même requête, et la dernière servie emportait le focus.
    // `ownsSession` ne peut être vrai que dans une seule fenêtre.
    if (req.action !== 'close') {
      const label = await focusByIdentity(req.session_id, { title: req.title, tabTitle: req.tab_title }, 'relay');
      if (label) {
        raiseWindow(label);
        // 2e argument : l'identité activée, connue ici avec certitude (c'est
        // par elle qu'on a révélé l'onglet). Le chemin par libellé plus bas ne
        // peut pas la fournir — il ne sait justement pas quelle sœur il a
        // désignée.
        try { onActivated(label, req.session_id || null); } catch {}
        return;
      }
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
        try { onActivated(match.label, null); } catch {}
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
  // L'identité se suffit à elle-même : une conversation sans titre exploitable
  // (transcript pas encore né) reste cliquable par ce seul chemin.
  if (!sessionId && !norm(title) && !norm(tabTitle)) return null;

  // 1. IDENTITÉ — seule voie capable de départager deux onglets homonymes (cf.
  // en-tête). Gardée par la preuve d'appartenance, et surtout filetée : si elle
  // ouvre quoi que ce soit, elle le referme et rend `null`. Le contrat « le
  // panneau n'ouvre jamais d'onglet » (décision user 2026-08-26) est donc tenu
  // par vérification de l'effet, plus par l'abstinence.
  const byIdentity = await focusByIdentity(sessionId, { title, tabTitle }, 'click');
  if (byIdentity) return byIdentity;

  // 2. REPLI PAR LIBELLÉ — inchangé, et toujours nécessaire : identité inconnue
  // (conv d'une autre fenêtre, sonde indisponible, version d'extension sans la
  // commande). Ne peut pas départager des homonymes, par construction.
  const match = findTab(title, tabTitle);
  if (match) {
    // Journalisé (2026-09-03, instrumentation fait 2) : c'est CE chemin — celui
    // qui apparie par TEXTE au lieu de l'identité — qui peut viser un onglet
    // sans rapport si son libellé matche par coïncidence (ex. un onglet
    // renommé avec un prompt qui cite le titre visé). `tabs` = tout ce que
    // cette fenêtre voyait au même instant, pour vérifier après coup si un
    // autre onglet portait déjà ce libellé.
    logEvent('focus-label-fallback', {
      sessionId, title, tabTitle,
      resolvedLabel: match.label, resolvedViewColumn: match.group.viewColumn, resolvedIndex: match.index,
      tabs: claudeTabsSnapshot(),
    });
    await focusTab(match);
    return match.label;
  }
  // Introuvable ici : l'onglet vit peut-être dans une autre fenêtre VS Code.
  // On journalise les libellés vus : c'est exactement ce qui manquait pour
  // repérer que le lot 1 ne matchait jamais rien (libellés tronqués côté Claude,
  // titre complet côté panneau) — un clic sans effet ET sans trace est invisible.
  log('no tab here for "%s" (claude tabs: %j) — relaying to the other windows', title,
    vscode.window.tabGroups.all.flatMap((g) => g.tabs.filter(isClaudeTab).map((t) => t.label)));
  logEvent('focus-not-here', { sessionId, title, tabTitle, tabs: claudeTabsSnapshot() });
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

// `sessionsWithTabHere` : les sessions dont un onglet est ouvert dans CETTE
// fenêtre, par IDENTITÉ (positions validées contre l'état frais) — `null` quand
// la photo n'est pas utilisable. Exporté pour extension.js `closeConversations`,
// qui doit départager deux conversations au même libellé quand l'une des deux
// vient de fermer son onglet : c'est la même question que le clic, donc la même
// réponse, lue au même endroit.
function sessionsWithTabHere() {
  try {
    const byId = validatePositions(getSessionLocations(), worldTabs());
    return byId ? new Set(byId.keys()) : null;
  } catch { return null; }
}

module.exports = {
  focusConversation, createFocusRelay, findTab,
  setOpenSessionIdsSource, setSessionLocationsSource, setListedConversationsSource,
  focusByIdentity, sessionsWithTabHere,
  REQUEST_PATH, REQUEST_TTL_MS,
};
