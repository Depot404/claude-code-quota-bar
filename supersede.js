// ============================================================================
// SUPPLANTATION DE SESSION À TRAVERS UN RELOAD DE FENÊTRE (2026-07-24).
//
// POURQUOI — recharger la fenêtre VS Code tue les CLI ; l'extension Claude
// officielle RESTAURE ses onglets, et il arrive qu'elle relance la
// conversation sous un NOUVEAU sessionId : un nouveau transcript qui REJOUE le
// même premier prompt, porte donc le même ai-title, et prend la place de
// l'onglet. L'ancien transcript subsiste : un HUSK, figé à l'instant du reload,
// MORT (plus aucun process CLI), mais toujours listé par state.js — qui fait
// UNE conversation par transcript. Constaté en vrai le 2026-07-24 :
//   7c5741cb « Implémenter lot 1 allègement panneau vagues » (02:01, husk)
//   c6df1573 « Implémenter lot 1 allègement panneau vagues » (03:30, resumé)
//
// De cette cause unique, trois symptômes :
//   - la même conversation apparaît DEUX FOIS dans la liste (bug 3) ;
//   - un membre de groupe rattaché à l'ANCIEN sessionId résout son statut
//     contre le husk mort — plus de chip de fermeture, cible de fermeture
//     erronée (bugs 1 & 2, corrigés côté extension.js par la redirection que
//     ce module publie).
//
// PRINCIPE — la liste du panneau est une VUE (règle du projet) : on ne réécrit
// AUCUN identifiant stocké (un lien deviné ne se persiste jamais — cf. groups.js
// « toute ambiguïté se solde par non-lié »), on RÉSOUT au rendu. Deux
// transcripts du même dossier projet au même titre, l'un MORT et plus ancien,
// l'autre plus frais ET vivant OU dont un onglet porte encore le titre : le mort
// est SUPPLANTÉ par le frais.
//
// Signal d'identité = le TITRE, et seulement quand il vient d'une source fiable
// (l'ai-title du transcript, ou le libellé réel de l'onglet — les deux seules
// que l'extension officielle met sur ses onglets, cf. state.js
// MATCHABLE_TITLE_SOURCES / labels.js). Un titre de repli (1er message, dernier
// prompt) ne fold jamais. Dégradation silencieuse : rien qui matche = aucune
// supplantation, comportement d'avant.
// ============================================================================

const { norm } = require('./labels');

// Mêmes sources que state.js MATCHABLE_TITLE_SOURCES : un titre qui PEUT porter
// un libellé d'onglet, donc dont l'égalité entre deux convs est une identité
// fiable. Le repli (`first-message`, `last-prompt`…) en est exclu.
const RELIABLE_TITLE_SOURCES = new Set(['ai-title', 'tab-store']);

// `convs` : [{ sessionId, title, titleSource, mtime, live, tabOpen }]
// Rend un objet plain { [huskSessionId]: successorSessionId } — vide si rien à
// supplanter. Fonction PURE : aucun accès disque, aucun `vscode`, testable cas
// par cas (test/test-supersede.js).
function computeSupersededBy(convs) {
  const byTitle = new Map();
  for (const c of convs || []) {
    if (!c || !RELIABLE_TITLE_SOURCES.has(c.titleSource)) continue;
    const key = norm(c.title);
    if (!key) continue;
    let group = byTitle.get(key);
    if (!group) { group = []; byTitle.set(key, group); }
    group.push(c);
  }

  const out = {};
  for (const group of byTitle.values()) {
    if (group.length < 2) continue;

    // Successeur = un vivant (le CLI resumé tourne encore), à défaut le plus
    // frais. Départage stable : vivant d'abord, puis mtime décroissant.
    let succ = null;
    for (const c of group) {
      if (!succ) { succ = c; continue; }
      const better = (c.live && !succ.live)
        || (!!c.live === !!succ.live && (c.mtime || 0) > (succ.mtime || 0));
      if (better) succ = c;
    }

    // On ne supplante QUE si le successeur est bien une conversation VIVE à
    // l'écran : son process tourne, OU un onglet porte encore son titre. Deux
    // transcripts morts homonymes sans onglet ne prouvent pas un reload — on
    // n'en fold aucun (jamais de fusion devinée sans preuve de continuité).
    if (!succ.live && !succ.tabOpen) continue;

    for (const c of group) {
      if (c === succ) continue;
      // Un HUSK : mort, et strictement plus ancien que le successeur. Un second
      // VIVANT homonyme (deux vrais onglets concurrents) n'est JAMAIS fold —
      // ce sont deux conversations réelles, pas un artefact de reload.
      if (!c.live && (c.mtime || 0) < (succ.mtime || 0)) {
        out[c.sessionId] = succ.sessionId;
      }
    }
  }
  return out;
}

module.exports = { computeSupersededBy, RELIABLE_TITLE_SOURCES };
