// ============================================================================
// Correspondance « libellé d'onglet VS Code » ↔ « titre de conversation ».
//
// Module à part, et sans require('vscode'), parce que TROIS chemins s'en
// servent et qu'un seul d'entre eux tourne forcément dans l'hôte d'extension :
//   - focus.js  (clic panneau → onglet)          — hôte d'extension
//   - tabs.js   (onglet fermé → conv retirée)    — hôte d'extension
//   - state.js  (filtre de présence du snapshot) — doit rester testable en Node pur
// Une deuxième copie de labelMatches serait une deuxième vérité, et c'est elle
// qui décide si une conversation reste affichée : la dupliquer, c'est signer un
// écart silencieux entre « le clic ne trouve pas l'onglet » et « la conv est
// masquée parce qu'elle n'a pas d'onglet ».
// ============================================================================

function norm(s) {
  return typeof s === 'string' ? s.toLowerCase().replace(/\s+/g, ' ').trim() : '';
}

// L'extension Claude TRONQUE le libellé de l'onglet (~24 caractères suivis d'un
// « … »), alors que le panneau affiche le titre complet (`ai-title`). Vérifié le
// 2026-07-15 : onglet « Refactor auth middlewar… » pour la conv « Implémenter
// lot 4 burn-rate et clic-focus multi-fenêtres ». La comparaison stricte du lot 1
// ne pouvait donc JAMAIS matcher une conv au titre long — le clic était un no-op.
// On compare par préfixe dès que le libellé est tronqué, à l'identique sinon.
function labelMatches(label, title) {
  const l = norm(label);
  const t = norm(title);
  if (!l || !t) return false;
  if (l === t) return true;
  const truncated = l.match(/^(.+?)(?:…|\.\.\.)$/);
  return !!truncated && t.startsWith(truncated[1]);
}

// Onglet de conversation Claude (webview de l'extension officielle), par
// opposition à un fichier, un diff, un terminal…
function isClaudeTab(tab) {
  return !!(tab && tab.input && tab.input.viewType && tab.input.viewType.includes
    && tab.input.viewType.includes('claudeVSCodePanel'));
}

// Libellés des onglets Claude d'un ensemble de groupes. Prend les groupes en
// paramètre (vscode.window.tabGroups.all) au lieu de les lire : le module reste
// utilisable hors VS Code, et testable avec des groupes fabriqués.
function claudeTabLabels(groups) {
  const out = [];
  for (const g of groups || []) {
    for (const t of (g && g.tabs) || []) {
      if (isClaudeTab(t) && t.label) out.push(t.label);
    }
  }
  return out;
}

module.exports = { norm, labelMatches, isClaudeTab, claudeTabLabels };
