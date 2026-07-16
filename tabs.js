const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isClaudeTab, claudeTabLabels } = require('./labels');

// ============================================================================
// Suivi des onglets de conversation (lot 5).
//
// POURQUOI — fermer l'onglet d'une conv doit la faire disparaître du panneau
// tout de suite. On ne peut PAS s'appuyer sur le hook SessionEnd : il ne tire
// ni sur /exit ni sur /clear (anthropics/claude-code#17885, #6428) et reste
// erratique à la fermeture d'un onglet (#14760, #45424). Quand il ne tire pas,
// la conv ne sort qu'à l'expiration de recentMs (4 h) ou du fade `done`
// (30 min) — la « grosse latence » signalée. La seule source fiable est ici,
// côté VS Code : onDidChangeTabs.
//
// POURQUOI UN FICHIER PAR INSTANCE — le panneau liste les convs du WORKSPACE,
// pas celles de la fenêtre : une conv du même workspace peut très bien avoir son
// onglet dans une AUTRE fenêtre VS Code, dont les tabGroups nous sont
// invisibles (chaque fenêtre a son propre hôte d'extension). La présence se
// juge donc sur l'UNION des onglets de toutes les instances — sinon chaque
// fenêtre masquerait les convs ouvertes chez les autres.
//
// Un fichier PAR PID (~/.claude/panel-tabs/<pid>.json) plutôt qu'un fichier
// partagé : chaque fichier n'a qu'un seul écrivain, donc aucun read-modify-write
// concurrent à arbitrer — pas de lock du tout, contrairement à
// sessions-state.json où N hooks fusionnent dans le même objet. Le nettoyage
// d'une instance morte se réduit à un unlink. Le rename atomique reste, lui,
// indispensable : un lecteur ne doit jamais voir un JSON tronqué.
//
// SENS DE L'ÉCHEC — un fichier résiduel (pid réattribué par Windows) fait
// croire à des onglets qui n'existent plus : la conv reste affichée, soit
// exactement le comportement d'avant le lot 5. L'inverse (masquer une conv
// vivante) serait une perte d'information. Le doute profite donc à l'affichage.
// ============================================================================

const TABS_DIR = path.join(os.homedir(), '.claude', 'panel-tabs');
const OWN_FILE = path.join(TABS_DIR, `${process.pid}.json`);

// Délai avant de CONFIRMER qu'un onglet signalé fermé l'est vraiment.
//
// Un onglet déplacé (d'un groupe à l'autre, voire vers une autre fenêtre) est
// signalé fermé puis rouvert, et rien ne garantit que VS Code livre les deux
// dans le même événement : la doc de TabChangeEvent ne dit pas ce que valent
// `closed`/`opened` sur un déplacement, et microsoft/vscode#146786 (classé
// « as-designed ») montre que split/drop émettent PLUSIEURS événements. Plutôt
// que de parier sur cet ordre, on relit l'union un instant plus tard : si le
// libellé est revenu (ici ou chez une voisine), il n'a jamais été fermé.
// 150 ms est invisible à l'œil et laisse ~850 ms de marge sur l'exigence « la
// conv disparaît en moins d'une seconde ».
const CLOSE_CONFIRM_MS = 150;

function log(fmt, ...args) { console.log('[QuotaBar] ' + fmt, ...args); }

function localLabels() {
  try { return claudeTabLabels(vscode.window.tabGroups.all); } catch { return []; }
}

// process.kill(pid, 0) ne tue rien : il teste l'existence. EPERM = le process
// existe mais ne nous appartient pas → vivant (cas d'une autre session Windows).
function pidAlive(pid) {
  if (!pid) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; }
}

function publish(labels) {
  const tmp = `${OWN_FILE}.tmp`;
  try {
    fs.mkdirSync(TABS_DIR, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, ts: Date.now(), labels }));
    fs.renameSync(tmp, OWN_FILE);
  } catch (e) {
    log('tabs publish failed: %s', e && e.message);
  }
}

// Libellés publiés par les AUTRES fenêtres, en nettoyant au passage les fichiers
// d'instances mortes (VS Code fermé brutalement : dispose() n'a pas tourné).
function otherLabels() {
  let files;
  try { files = fs.readdirSync(TABS_DIR); } catch { return []; }
  const out = [];
  for (const f of files) {
    const m = /^(\d+)\.json$/.exec(f);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid) continue;
    const file = path.join(TABS_DIR, f);
    if (!pidAlive(pid)) {
      try { fs.unlinkSync(file); } catch {}
      continue;
    }
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(data.labels)) out.push(...data.labels.filter((l) => typeof l === 'string'));
    } catch {}
  }
  return out;
}

// onTabsClosed(labels) : onglets Claude réellement disparus de CETTE fenêtre.
// onChange() : quelque chose a bougé (ici ou ailleurs) → recompute du snapshot.
function createTabTracker(handlers = {}) {
  const onTabsClosed = typeof handlers.onTabsClosed === 'function' ? handlers.onTabsClosed : () => {};
  const onChange = typeof handlers.onChange === 'function' ? handlers.onChange : () => {};
  let watcher = null;
  let disposed = false;
  const pendingClosed = new Set();
  let confirmTimer = null;

  publish(localLabels());

  function allLabels() {
    return [...localLabels(), ...otherLabels()];
  }

  // Un libellé n'est déclaré fermé que s'il a disparu de PARTOUT : le comparer à
  // l'union et non aux seuls onglets locaux couvre du même coup l'onglet glissé
  // vers une autre fenêtre, et la conv ouverte en double dans deux fenêtres
  // (fermer l'une ne la fait pas disparaître tant que l'autre l'a encore).
  // Comparaison exacte, sans labelMatches : on compare ici deux libellés
  // d'onglets, pas un libellé à un titre — même source, même troncature.
  function confirmClosed() {
    confirmTimer = null;
    if (disposed || !pendingClosed.size) return;
    const candidates = [...pendingClosed];
    pendingClosed.clear();
    const present = new Set(allLabels());
    const gone = candidates.filter((l) => !present.has(l));
    if (!gone.length) return;
    log('claude tab(s) closed: %j', gone);
    try { onTabsClosed(gone); } catch (err) { log('onTabsClosed failed: %s', err && err.message); }
  }

  const sub = vscode.window.tabGroups.onDidChangeTabs((e) => {
    if (disposed) return;
    // Republier AVANT tout le reste : les autres fenêtres doivent voir la
    // nouvelle réalité tout de suite. `changed` compte aussi — c'est par lui que
    // passe « le libellé vient de basculer du prompt au vrai ai-title » ; sans
    // republication, l'union resterait sur l'ancien libellé et la conv
    // paraîtrait sans onglet.
    publish(localLabels());

    for (const t of (e && e.closed) || []) {
      if (isClaudeTab(t) && t.label) pendingClosed.add(t.label);
    }
    if (pendingClosed.size && !confirmTimer) {
      confirmTimer = setTimeout(confirmClosed, CLOSE_CONFIRM_MS);
    }
    onChange();
  });

  // Les autres fenêtres republient sur leurs propres changements d'onglets :
  // il faut recomputer ici aussi, sinon une conv rouverte ailleurs resterait
  // masquée chez nous jusqu'au prochain tick.
  try {
    watcher = fs.watch(TABS_DIR, () => { if (!disposed) onChange(); });
  } catch (e) {
    log('tabs watch failed: %s', e && e.message);
  }

  return {
    // Contrat consommé par state.js (buildSnapshot) : `known` dit si l'on sait
    // quelque chose des onglets. À false, AUCUNE conv n'est masquée.
    getTabs() {
      return { known: !disposed, labels: allLabels() };
    },
    dispose() {
      disposed = true;
      clearTimeout(confirmTimer);
      try { sub.dispose(); } catch {}
      try { if (watcher) watcher.close(); } catch {}
      // Notre fenêtre s'en va : ses onglets ne doivent plus compter dans l'union
      // des autres. En cas de crash, otherLabels() nettoie via pidAlive().
      try { fs.unlinkSync(OWN_FILE); } catch {}
    },
  };
}

module.exports = { createTabTracker, TABS_DIR, OWN_FILE };
