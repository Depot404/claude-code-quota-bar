// ============================================================================
// Lancement d'un lot de conversations (lot 1 du plan
// PLAN_creation_groupes_2026-07-22.md).
//
// Ce module ne DÉCIDE rien : le métier est dans batch.js (Node pur). Il
// orchestre, et toutes ses dépendances VS Code sont INJECTÉES — donc il se
// teste sans VS Code (test/test-batch-create.js).
//
// ── Ce qui a été vérifié empiriquement le 2026-07-22 (test obligatoire du lot)
// Ouvrir une conversation SANS rien envoyer :
//   • un `claude.exe` de plus (12 → 13) et un `~/.claude/sessions/<pid>.json`
//     de plus apparaissent — le CLI est spawné À L'OUVERTURE de l'onglet, pas
//     au premier Entrée ;
//   • ce fichier de session porte déjà le `sessionId` définitif, alors que le
//     transcript `.jsonl`, lui, n'existe PAS encore (5 sessions vivantes sans
//     transcript relevées sur ce poste).
// Conséquences directes, et c'est toute la stratégie de ce fichier :
//   1. les variables d'environnement doivent être posées AVANT l'appel de
//      commande et peuvent être retirées dès l'apparition du fichier de
//      session (l'environnement a déjà été recopié par le spawn) ;
//   2. l'apparition de ce fichier donne le sessionId de la conversation qu'on
//      vient d'ouvrir, tout de suite — c'est l'étage 1 du rattachement (plan
//      lot 2), disponible dès maintenant, et c'est ce qui permet au panneau de
//      comparer l'intention au réel sans jamais rien deviner.
//
// ── Garde-fous
//   • SÉRIALISÉ : une seule pose d'environnement à la fois. `process.env` est
//     partagé par tout l'hôte d'extension ; deux lancements simultanés se
//     voleraient leurs variables.
//   • Restauration en `finally`, y compris au timeout (le fichier de session
//     peut ne jamais apparaître : CLI plus ancien, dossier absent).
//   • `claude-vscode.editor.open` est un internal non documenté : absent ou en
//     échec ⇒ repli presse-papier + message, jamais d'exception qui remonte,
//     jamais d'état inventé (décision 7 du plan).
// ============================================================================

const { envForTask, applyEnv } = require('./batch.js');
const { liveSessionEntries } = require('./live-sessions.js');

const OPEN_COMMAND = 'claude-vscode.editor.open';
const NEW_CONVERSATION_COMMAND = 'claude-vscode.newConversation';
// Le fichier de session apparaît en ~1 s sur ce poste ; 10 s est une marge de
// sécurité, pas une attente nominale (on sort dès qu'il est là).
const SESSION_WAIT_MS = 10000;
const SESSION_POLL_MS = 150;

function samePath(a, b) {
  if (!a || !b) return false;
  return String(a).replace(/[\\/]+$/, '').toLowerCase()
      === String(b).replace(/[\\/]+$/, '').toLowerCase();
}

// deps injectées :
//   executeCommand(cmd, ...args) → Promise
//   listCommands()               → Promise<string[]>  (vscode.commands.getCommands(true))
//   env                          → objet type process.env
//   listSessions()               → [{sessionId, cwd, …}]  (live-sessions.js)
//   workspacePath                → filtre du diff de registre (null = pas de filtre)
//   writeClipboard(text)         → Promise      (repli)
//   showMessage(text)            → void         (repli / diagnostic)
//   viewColumn                   → 3e argument d'editor.open
//   t(message, ...args)          → string       (vscode.l10n.t, lot 15 ; par
//                                                défaut identité + substitution
//                                                {0}/{1} — mêmes bancs sans VS Code)
function createBatchLauncher(deps = {}) {
  const {
    executeCommand,
    listCommands = async () => [],
    env = process.env,
    listSessions = liveSessionEntries,
    workspacePath = null,
    writeClipboard = async () => {},
    showMessage = () => {},
    viewColumn,
    waitMs = SESSION_WAIT_MS,
    pollMs = SESSION_POLL_MS,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    t = (message, ...args) => (args.length ? message.replace(/\{(\d+)\}/g, (_, i) => (args[i] !== undefined ? args[i] : '')) : message),
  } = deps;

  // Sessions du workspace connues à l'instant t. Le filtre par cwd évite
  // d'attribuer à notre lancement une conversation ouverte au même moment dans
  // une AUTRE fenêtre VS Code (chaque fenêtre a son propre hôte d'extension,
  // vérifié 2026-07-22 — mais elles partagent ce registre).
  function snapshotIds() {
    const out = new Set();
    let entries = [];
    try { entries = listSessions() || []; } catch { entries = []; }
    for (const e of entries) {
      if (!e || !e.sessionId) continue;
      if (workspacePath && e.cwd && !samePath(e.cwd, workspacePath)) continue;
      out.add(e.sessionId);
    }
    return out;
  }

  // Premier sessionId apparu depuis `before`. `null` au timeout : ce n'est pas
  // une erreur, juste une conversation qu'on n'a pas su nommer (le membre
  // restera « non lié » au lot 2, avec son action manuelle).
  async function waitForNewSession(before) {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const now = snapshotIds();
      for (const id of now) if (!before.has(id)) return id;
      if (Date.now() >= deadline) return null;
      await sleep(pollMs);
    }
  }

  let chain = Promise.resolve();

  // Un lancement = une tâche. Sérialisé par une chaîne de promesses : c'est
  // l'invariant qui rend la pose d'environnement sûre.
  function launchOne(task, canOpen) {
    return {
      run: async () => {
        const vars = envForTask(task);
        const before = snapshotIds();
        const restore = applyEnv(env, vars);
        let sessionId = null;
        try {
          if (!canOpen) throw new Error(OPEN_COMMAND + ' unavailable');
          await executeCommand(OPEN_COMMAND, undefined, task.prompt, viewColumn);
          sessionId = await waitForNewSession(before);
        } finally {
          restore();
        }
        return { ok: true, sessionId, task, asked: vars };
      },
    };
  }

  // Repli (décision 7) : conversation VIDE + prompt dans le presse-papier +
  // message. Le presse-papier ne tient qu'un texte : on s'arrête donc au
  // premier échec et on dit combien de tâches n'ont pas été lancées, plutôt
  // que d'écraser silencieusement le prompt précédent.
  async function fallback(task, remaining, reason) {
    try { await writeClipboard(task.prompt); } catch {}
    try { await executeCommand(NEW_CONVERSATION_COMMAND); } catch {}
    const more = remaining > 0 ? t(' {0} more task(s) were not started.', remaining) : '';
    showMessage(
      t('Claude Convs: could not open the conversation with its prompt ({0}). An empty conversation was opened and the prompt is in your clipboard — paste it there.', reason)
      + more
    );
  }

  return {
    // tasks : sortie de normalizeTasks (prompts non vides, vagues contiguës).
    // Rend { launched: [{sessionId, task, asked}], fallbackAt: index|null }.
    launch(tasks) {
      const run = async () => {
        const list = Array.isArray(tasks) ? tasks : [];
        const launched = [];
        let fallbackAt = null;
        let commands = [];
        try { commands = (await listCommands()) || []; } catch { commands = []; }
        const canOpen = commands.includes(OPEN_COMMAND);

        for (let i = 0; i < list.length; i++) {
          const task = list[i];
          try {
            const res = await launchOne(task, canOpen).run();
            launched.push(res);
          } catch (e) {
            fallbackAt = i;
            await fallback(task, list.length - i - 1, (e && e.message) || 'unknown error');
            break;
          }
        }
        return { launched, fallbackAt, total: list.length };
      };
      // La chaîne garde la sérialisation MÊME entre deux appels de launch()
      // (deux « Create » enchaînés), pas seulement à l'intérieur d'un lot.
      const next = chain.then(run, run);
      chain = next.then(() => {}, () => {});
      return next;
    },
  };
}

module.exports = { createBatchLauncher, OPEN_COMMAND, NEW_CONVERSATION_COMMAND, SESSION_WAIT_MS };
