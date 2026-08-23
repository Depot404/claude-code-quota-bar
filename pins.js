// ============================================================================
// Marques « à relire » — persistance (lot 1 du plan
// PLAN_marque_a_relire_2026-08-22.md).
//
// Node PUR, même doctrine que groups.js : la persistance est INJECTÉE
// (`load`/`save`), donc ce module se teste sans VS Code. En production
// l'adaptateur est le `workspaceState` de l'extension — une marque appartient
// au workspace, exactement comme les conversations qu'elle désigne.
//
// CE QU'EST UNE MARQUE — un simple drapeau posé À LA MAIN sur un sessionId,
// sans aucune heuristique de lecture (décision 7 du plan : la pose et le
// retrait sont 100 % manuels, jamais une extinction automatique). Ce module ne
// connaît donc que deux gestes : `isPinned` (lecture) et `toggle` (le seul
// écrivain, côté extension.js le message `togglePinConv` du webview).
// ============================================================================

// Nettoyage défensif de ce qui sort du stockage, même esprit que sanitizeGroup
// (groups.js) : workspaceState peut porter du JSON écrit par une version
// antérieure — une entrée qui n'est pas une chaîne non vide est jetée, jamais
// interprétée à moitié.
function sanitizePinned(raw) {
  const out = new Set();
  for (const id of Array.isArray(raw) ? raw : []) {
    if (typeof id === 'string' && id) out.add(id);
  }
  return out;
}

// deps :
//   load()        → tableau brut lu du stockage (workspaceState.get)
//   save(ids)      → écriture (workspaceState.update) ; peut rendre une
//                    Promise, qu'on n'attend jamais : l'état en mémoire fait
//                    foi pour le rendu, l'écriture ne fait que le survivre au
//                    reload.
function createPinStore(deps = {}) {
  const { load = () => [], save = () => {} } = deps;

  let pinned;
  try { pinned = sanitizePinned(load()); } catch { pinned = new Set(); }

  function persist() {
    try { save([...pinned]); } catch {}
  }

  return {
    isPinned(sessionId) {
      return !!sessionId && pinned.has(sessionId);
    },

    // Bascule pose ⇄ retrait, retourne le nouvel état (pour un appelant qui
    // voudrait s'en servir sans relire isPinned juste après). `sessionId`
    // absent : no-op, rien à persister.
    toggle(sessionId) {
      if (!sessionId) return false;
      if (pinned.has(sessionId)) pinned.delete(sessionId);
      else pinned.add(sessionId);
      persist();
      return pinned.has(sessionId);
    },

    // Tous les sessionId marqués — sert au lot 3 (une marque doit survivre à
    // la fermeture de l'onglet, donc rester listée même hors du snapshot).
    list() {
      return [...pinned];
    },
  };
}

module.exports = { createPinStore, sanitizePinned };
