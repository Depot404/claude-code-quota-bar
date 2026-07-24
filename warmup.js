// ============================================================================
// FENÊTRE DE STABILISATION du tout premier rendu du panneau (lot
// micro-allègements, 2026-07-24).
//
// POURQUOI — constat user : quelques secondes après un reload de fenêtre, une
// vieille conversation FERMÉE apparaît dans la liste puis disparaît. Piste (à
// vérifier, pas une conclusion établie) : juste après le reload, les sources
// dont dépend l'affichage — l'union des onglets publiée par tabs.js (dont le
// nettoyage des fichiers d'instances mortes, cf. otherLabels()), le registre
// live-sessions, le cache de titres d'onglet de session-titles.js — n'ont pas
// forcément toutes convergé vers l'état réel dès le premier calcul ; un vieux
// transcript matche un instant un onglet restauré avant de se faire filtrer
// normalement (isGone() de state.js).
//
// PRINCIPE — retenir l'affichage tant que l'ensemble des conversations
// calculées ne s'est pas stabilisé entre deux recomputations successives,
// plutôt que de deviner un délai fixe ou de patcher un heuristique de plus :
// ce module ne sait RIEN du domaine (aucune conv, aucun état) — il compare une
// SIGNATURE fournie par l'appelant à deux instants espacés d'un court délai, et
// ne déclenche `onSettled` qu'une fois qu'elle n'a pas bougé (ou au bout d'un
// plafond — dégradation silencieuse : on ne bloque jamais indéfiniment, c'est
// exactement le comportement d'avant ce lot). Une fois stabilisé, plus aucun
// report : les pushs suivants (événements normaux) restent immédiats, comme
// avant — ce module ne s'applique qu'au tout premier rendu.
//
// Node PUR, testable sans vscode (time/scheduler injectés) — voir
// test/test-warmup.js.
// ============================================================================

const DEFAULT_STEP_MS = 200;
const DEFAULT_MAX_MS = 1200;

function createBootSettler(options = {}) {
  const stepMs = options.stepMs != null ? options.stepMs : DEFAULT_STEP_MS;
  const maxMs = options.maxMs != null ? options.maxMs : DEFAULT_MAX_MS;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const scheduleFn = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
  let settled = false;

  // `signature()` : instantané comparable de ce qui serait affiché (ex. les
  // sessionId triés/joints des conversations du snapshot courant).
  // `onTick()` : optionnel — force une recomputation avant de relire la
  // signature (ex. stateEngine.refresh()).
  // `onSettled()` : appelée UNE seule fois, quand stable ou au plafond.
  function run(signature, onTick, onSettled) {
    const done = typeof onSettled === 'function' ? onSettled : () => {};
    if (settled) { done(); return; }
    const deadline = now() + maxMs;
    let prev = signature();
    const tick = () => {
      if (settled) return;
      if (typeof onTick === 'function') onTick();
      const cur = signature();
      if (cur === prev || now() >= deadline) {
        settled = true;
        done();
        return;
      }
      prev = cur;
      scheduleFn(tick, stepMs);
    };
    scheduleFn(tick, stepMs);
  }

  return { run, isSettled: () => settled };
}

module.exports = { createBootSettler };
