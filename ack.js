const vscode = require('vscode');
const { isClaudeTab } = require('./labels');

// ============================================================================
// Accusé de lecture d'une conversation terminée (lot 6a).
//
// POURQUOI — le lot 2 éteignait le ✓ « terminée » au bout de 30 min, par timer.
// Un délai arbitraire ne sait rien de l'utilisateur : il efface le ✓ d'un
// résultat jamais lu, et garde vif celui d'un résultat lu depuis 29 minutes. Le
// seul signal qui veut dire « j'ai vu » est d'être allé sur l'onglet, une fois
// le tour fini.
//
// CE QU'ON OBSERVE — l'onglet Claude actif DU GROUPE ACTIF, la fenêtre ayant le
// focus. Un onglet actif dans un groupe voisin, ou dans une fenêtre en
// arrière-plan, n'est pas consulté : il est simplement affiché.
//
// POURQUOI UN DWELL — deux façons de « visiter » un onglet sans le lire :
// Ctrl+Tab qui le traverse, et l'activation automatique du voisin quand on
// ferme un onglet. Les deux durent moins d'une seconde. Un séjour de 2 s les
// écarte sans jamais gêner une lecture réelle.
//
// POURQUOI DEUX SORTIES — `onDwell` couvre « j'arrive sur l'onglet après coup »,
// `dwellLabel()` couvre le cas symétrique, invisible autrement : l'onglet est
// DÉJÀ actif pendant que Claude finit. Aucune bascule ne viendra jamais, donc
// aucun événement — c'est à l'arrivée du `done` d'aller interroger le séjour en
// cours. Sans cette seconde sortie, lire un résultat en direct laisserait le ✓
// vif indéfiniment.
//
// ACK STRICT (lot 10) — incident 2026-07-15 : un onglet posé là depuis 1 h,
// pendant qu'on travaille ailleurs dans la MÊME fenêtre, satisfaisait déjà ces
// deux critères (actif + focus + 2 s) sans qu'on l'ait jamais regardé au moment
// où Claude finissait. Ce module ne peut PAS trancher seul : il ignore quand le
// run en cours a démarré. `dwellSince()` expose donc le début du séjour brut,
// que l'appelant (extension.js) compare à `busySince` de la conv — le séjour
// ne compte comme un acte observé que s'il a commencé APRÈS ce démarrage.
// Décision user : un faux « non lu » est acceptable, un faux « lu » ne l'est
// pas — donc en cas de doute, ne pas acquitter.
// ============================================================================

const DWELL_MS = 2000;

// Un abonnement qui n'existe pas (API absente d'une version de VS Code) ne doit
// pas emporter l'activation de l'extension : au pire l'ack rate un signal.
function subscribe(register, cb) {
  try { return register(cb) || { dispose() {} }; } catch { return { dispose() {} }; }
}

function activeClaudeLabel() {
  try {
    const group = vscode.window.tabGroups.activeTabGroup;
    const tab = group && group.activeTab;
    return tab && isClaudeTab(tab) && tab.label ? tab.label : null;
  } catch { return null; }
}

function windowFocused() {
  try { return !!(vscode.window.state && vscode.window.state.focused); } catch { return false; }
}

// handlers : { onDwell(label), dwellMs? }
function createAckTracker(handlers = {}) {
  const onDwell = typeof handlers.onDwell === 'function' ? handlers.onDwell : () => {};
  const dwellMs = handlers.dwellMs != null ? handlers.dwellMs : DWELL_MS;
  let current = null;   // { label, since } — séjour en cours
  let timer = null;
  let disposed = false;

  function reevaluate() {
    if (disposed) return;
    const label = windowFocused() ? activeClaudeLabel() : null;
    // Même onglet, même situation : surtout ne pas réarmer le compteur, sinon un
    // événement périodique (une frappe, un changement d'onglet ailleurs) le
    // remettrait à zéro et le dwell ne serait jamais atteint.
    if ((current && current.label) === label) return;
    clearTimeout(timer);
    timer = null;
    current = label ? { label, since: Date.now() } : null;
    if (!current) return;
    timer = setTimeout(() => {
      timer = null;
      if (disposed || !current) return;
      try { onDwell(current.label); } catch {}
    }, dwellMs);
  }

  const subs = [
    subscribe((cb) => vscode.window.tabGroups.onDidChangeTabs(cb), reevaluate),
    subscribe((cb) => vscode.window.tabGroups.onDidChangeTabGroups(cb), reevaluate),
    subscribe((cb) => vscode.window.onDidChangeWindowState(cb), reevaluate),
  ];
  reevaluate();

  return {
    // Libellé de l'onglet consulté depuis assez longtemps pour compter comme lu,
    // ou null. À interroger quand une conv vient de passer `done`.
    dwellLabel() {
      if (disposed || !current) return null;
      return Date.now() - current.since >= dwellMs ? current.label : null;
    },
    // Début du séjour en cours (indépendant du seuil du dwell) — lot 10 : l'ack
    // strict compare CE timestamp au démarrage du run (`busySince`), pas la fin
    // du dwell. Sans lui, l'appelant ne peut pas distinguer « arrivé pendant que
    // ça tournait » de « déjà là depuis avant le lancement ».
    dwellSince() {
      return disposed || !current ? null : current.since;
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      current = null;
      for (const s of subs) { try { s.dispose(); } catch {} }
    },
  };
}

module.exports = { createAckTracker, DWELL_MS };
