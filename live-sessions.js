// ============================================================================
// Registre des sessions CLI VIVANTES — ~/.claude/sessions/<pid>.json
//
// POURQUOI — jusqu'ici, l'appartenance d'une conversation à « ce qui est ouvert »
// se jugeait uniquement sur le LIBELLÉ de l'onglet (labels.js). Or ce libellé
// peut diverger du titre du transcript (l'extension officielle renomme ses
// onglets depuis une table à part, cf. session-titles.js) : plus rien ne matche,
// et le filtre de présence de state.js masque une conversation pourtant ouverte
// et vivante. Incident 2026-07-22 : conv disparue du panneau, onglet ouvert,
// process CLI au travail.
//
// Le CLI écrit un fichier par process vivant : {pid, sessionId, cwd, startedAt,
// entrypoint, …}. Le fichier disparaît avec le process. C'est une identité
// sessionId↔process STABLE, indépendante de tout libellé — donc exactement ce
// qui manquait. Invariant qui en découle (state.js) : session vivante ⇒ jamais
// masquée.
//
// ⚠️ Ce dossier appartient au CLI, PAS à nous : on ne l'écrit ni ne le nettoie
// jamais (contrairement à ~/.claude/panel-tabs/, dont nous sommes propriétaires
// et où tabs.js unlink les fichiers d'instances mortes). Un fichier résiduel
// (pid réattribué par Windows) ne fait qu'AFFICHER une conv de plus — le doute
// profite à l'affichage, comme partout ailleurs.
//
// ⚠️ « VIVANTE » NE SUFFIT PAS : IL FAUT UNE FENÊTRE VS CODE (2026-08-17).
// Toutes les sessions du registre ne naissent pas d'un onglet. Le champ
// `entrypoint` dit laquelle : `claude-vscode` pour un onglet, `sdk-cli` pour le
// serveur Remote Control (sessions ouvertes depuis le mobile, qui s'exécutent
// ici — cf. Tools/RemoteControl), `cli` pour un terminal, `sdk-ts`/`sdk-py`,
// `mcp`, `local-agent`, `remote*`… (vocabulaire relevé dans le binaire du CLI).
// Une session sans onglet n'aura JAMAIS de ligne cliquable : la garder affiche
// une conversation vers laquelle on ne peut pas naviguer, et lui fait consommer
// une des `maxItems` places au détriment d'une vraie conv. D'où le partage :
//   - liveSessionIds / liveSessionEntries → sessions d'une FENÊTRE VS CODE, les
//     seules qui valent une exemption de masquage (invariant de state.js) et le
//     seul vivier du rattachement d'une conv qu'on vient d'ouvrir (launcher.js) ;
//   - foreignSessionIds → sessions vivantes dont on SAIT qu'elles ne sont pas
//     une fenêtre VS Code, à masquer positivement.
// Dégradation : `entrypoint` absent ou inconnu ⇒ traité comme VS Code, jamais
// comme étranger. Un CLI qui cesserait d'écrire ce champ nous ramène au
// comportement d'avant ce lot, il ne fait pas disparaître le panneau — c'est
// l'exigence « source absente = comportement d'avant, jamais de masquage en
// plus » qui vaut déjà pour session-titles.js.
// Why : 2026-08-17, quatre conversations mobiles (RC) affichées en permanence
// dans le panneau, sans onglet, signalées par l'user.
//
// Internal non documenté (relevé sur CLI 2.1.217) : toute lecture est en
// dégradation silencieuse — dossier absent, JSON illisible, permission refusée
// → ensemble vide, jamais d'exception.
// ============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');

// process.kill(pid, 0) ne tue rien : il teste l'existence. EPERM = le process
// existe mais ne nous appartient pas → vivant (cas d'une autre session Windows).
//
// Vérité UNIQUE pour tout le projet (tabs.js la consommait dans sa propre copie
// avant ce lot) : deux définitions de « ce pid est-il vivant » = deux réponses
// possibles à « cette conv est-elle encore là », exactement le genre d'écart
// silencieux que labels.js documente déjà pour le matching de libellés.
function pidAlive(pid) {
  if (!pid) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; }
}

// Entrées complètes du registre (sessions vivantes seulement) :
// { sessionId, pid, cwd, startedAt }. Le `cwd` sert au rattachement d'une
// conversation qu'on vient d'ouvrir (batch du lot 1 : la session neuve est
// celle qui apparaît APRÈS le lancement, avec le cwd du workspace) — d'où
// cette variante à côté de liveSessionIds, qui n'expose que les identifiants.
//
// Vérifié empiriquement le 2026-07-22 (test du lot 1) : le CLI est spawné dès
// l'OUVERTURE de l'onglet, avant tout envoi de message — donc ce registre
// connaît la session bien avant que son transcript n'existe.
// Entrypoints qui prouvent qu'une session N'EST PAS née d'un onglet VS Code.
// Liste FERMÉE et positive, à l'inverse d'une liste blanche : c'est ce qui rend
// la dégradation sûre (valeur inconnue ⇒ on ne masque pas). Chaque entrée est un
// littéral relevé dans le binaire du CLI, pas une supposition.
const FOREIGN_ENTRYPOINTS = new Set([
  'cli',            // terminal lancé à la main
  'sdk-cli',        // Agent SDK — dont le serveur Remote Control (mobile)
  'sdk-ts', 'sdk-py',
  'mcp',
  'local-agent',
  'bench',
  'claude-desktop', 'claude-desktop-3p',
  'claude-in-teams',
  'claude-code-github-action',
]);

// `entrypoint` commençant par « remote » (remote, remote_cowork, remote_trigger,
// remote_cowork_trigger…) : même famille, jamais un onglet d'ici.
function isForeignEntrypoint(entrypoint) {
  if (typeof entrypoint !== 'string' || !entrypoint) return false;
  return FOREIGN_ENTRYPOINTS.has(entrypoint) || entrypoint.startsWith('remote');
}

// Toutes les sessions vivantes du registre, sans distinction d'origine —
// interne au module. Les deux exports ci-dessous en sont les deux moitiés.
function allLiveEntries(dir) {
  const out = [];
  let files;
  try { files = fs.readdirSync(dir); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!data || typeof data.sessionId !== 'string' || !data.sessionId) continue;
    // Le pid du NOM de fichier n'est pas la source : c'est le champ `pid` qui
    // fait foi (le CLI les garde alignés, mais un fichier renommé à la main ne
    // doit pas faire disparaître une session).
    if (!pidAlive(data.pid)) continue;
    out.push({
      sessionId: data.sessionId,
      pid: data.pid,
      cwd: typeof data.cwd === 'string' ? data.cwd : null,
      startedAt: data.startedAt || 0,
      entrypoint: typeof data.entrypoint === 'string' ? data.entrypoint : null,
      foreign: isForeignEntrypoint(data.entrypoint),
    });
  }
  return out;
}

// Sessions vivantes nées d'une FENÊTRE VS CODE (cf. avertissement en tête).
function liveSessionEntries(dir = SESSIONS_DIR) {
  return allLiveEntries(dir).filter((e) => !e.foreign);
}

// Set des sessionId dont le process CLI tourne encore DANS UNE FENÊTRE VS CODE,
// tous workspaces confondus (le filtrage par workspace est déjà fait en amont
// par le dossier projet des transcripts — un sessionId est unique, aucun risque
// de collision).
function liveSessionIds(dir = SESSIONS_DIR) {
  return new Set(liveSessionEntries(dir).map((e) => e.sessionId));
}

// L'autre moitié : sessions vivantes dont l'origine PROUVE qu'aucun onglet ne
// les porte ici. Un même sessionId peut figurer dans les deux ensembles (une
// conversation mobile reprise dans VS Code garde son identifiant, et le registre
// porte alors deux process) : la fenêtre VS Code gagne, cf. isGone.
function foreignSessionIds(dir = SESSIONS_DIR) {
  return new Set(allLiveEntries(dir).filter((e) => e.foreign).map((e) => e.sessionId));
}

module.exports = {
  liveSessionIds, liveSessionEntries, foreignSessionIds,
  isForeignEntrypoint, pidAlive, SESSIONS_DIR,
};
