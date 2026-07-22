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
//
// SÉJOUR IDENTIFIÉ PAR L'ONGLET, PAS PAR SON LIBELLÉ (2026-07-22) — incident
// « le ✓ vif passe pâle tout seul ~2,3 s après la fin, sans qu'on ait regardé »,
// signalé plusieurs fois. Cause : l'extension Claude officielle réécrit l'onglet
// à la fin de chaque tour (message `rename_tab` : `panelTab.title` réaffecté ET
// `iconPath` basculé sur `claude-logo-done.svg` — vérifié dans
// anthropic.claude-code-2.1.217/extension.js). Cette réécriture déclenche
// `onDidChangeTabs` ~250 ms après le `done`. Or le séjour était identifié par le
// LIBELLÉ : la moindre variation le faisait naître à nouveau, `since` repartait
// à cet instant, et le dwell de 2 s expirait 2 s plus tard → accusé de lecture
// posé par un événement DE L'OUTIL, jamais par un acte de l'utilisateur (d'où
// l'offset constant `since + 2266 ms` mesuré dans sessions-state.json).
// Un séjour est désormais identifié par l'onglet lui-même (référence de l'objet
// `Tab`, à défaut sa position colonne#index) ; le libellé n'est plus qu'une
// étiquette rafraîchie en place, incapable de créer ou de réarmer un séjour.
// ============================================================================

const DWELL_MS = 2000;

// Un abonnement qui n'existe pas (API absente d'une version de VS Code) ne doit
// pas emporter l'activation de l'extension : au pire l'ack rate un signal.
function subscribe(register, cb) {
  try { return register(cb) || { dispose() {} }; } catch { return { dispose() {} }; }
}

// Onglet Claude actif du groupe actif, avec son groupe — on a besoin des deux
// pour situer l'onglet (cf. tabIdentity).
function activeClaudeTab() {
  try {
    const group = vscode.window.tabGroups.activeTabGroup;
    const tab = group && group.activeTab;
    return tab && isClaudeTab(tab) && tab.label ? { group, tab } : null;
  } catch { return null; }
}

// Identité de l'onglet actif INDÉPENDANTE de son libellé et de son icône : sa
// position (colonne du groupe + rang dans le groupe). Un `rename_tab` n'y touche
// pas ; un changement d'onglet actif, si. `null` quand l'API ne permet pas de la
// calculer — l'appelant retombe alors sur la comparaison de libellés.
function tabIdentity(group, tab) {
  try {
    if (!group || !Array.isArray(group.tabs)) return null;
    const idx = group.tabs.indexOf(tab);
    if (idx < 0) return null;
    return `${group.viewColumn != null ? group.viewColumn : '?'}#${idx}`;
  } catch { return null; }
}

// Le séjour en cours porte-t-il sur le MÊME onglet que ce qu'on observe ?
// Trois preuves, de la plus forte à la plus faible : l'objet `Tab` est le même
// (VS Code mute ses instances en place lors d'un rename), à défaut sa position,
// à défaut son libellé (dernier repli, celui d'avant ce correctif).
function sameTab(stay, tab, identity, label) {
  if (stay.tab && tab && stay.tab === tab) return true;
  if (stay.identity && identity) return stay.identity === identity;
  return stay.label === label;
}

function windowFocused() {
  try { return !!(vscode.window.state && vscode.window.state.focused); } catch { return false; }
}

// handlers : { onDwell(label), dwellMs? }
function createAckTracker(handlers = {}) {
  const onDwell = typeof handlers.onDwell === 'function' ? handlers.onDwell : () => {};
  const dwellMs = handlers.dwellMs != null ? handlers.dwellMs : DWELL_MS;
  let current = null;   // { tab, identity, label, since } — séjour en cours
  let timer = null;
  let disposed = false;

  function reevaluate() {
    if (disposed) return;
    const found = windowFocused() ? activeClaudeTab() : null;
    const tab = found ? found.tab : null;
    const label = tab ? tab.label : null;
    const identity = found ? tabIdentity(found.group, tab) : null;

    // Plus d'onglet Claude consulté (focus perdu, bascule vers un fichier…) :
    // le séjour s'arrête net.
    if (!label) {
      clearTimeout(timer);
      timer = null;
      current = null;
      return;
    }

    // Même onglet : on ne réarme surtout pas le compteur, sinon un événement
    // périodique (une frappe, un changement d'onglet ailleurs) le remettrait à
    // zéro et le dwell ne serait jamais atteint. On rafraîchit en revanche
    // l'étiquette et l'identité en place — c'est ici que passe le `rename_tab`
    // de fin de tour, qui ne doit RIEN redémarrer.
    if (current && sameTab(current, tab, identity, label)) {
      current.tab = tab;
      current.identity = identity;
      current.label = label;
      return;
    }

    clearTimeout(timer);
    current = { tab, identity, label, since: Date.now() };
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
    // Libellé de l'onglet où l'on séjourne EN CE MOMENT, sans condition de
    // durée. L'appelant compare lui-même `dwellSince()` à la fin du tour :
    // le seuil doit courir à partir de l'affichage du résultat, pas à partir de
    // l'arrivée sur l'onglet (un séjour antérieur au `done` ne prouve rien sur
    // ce qui s'affiche après).
    stayLabel() {
      return disposed || !current ? null : current.label;
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
