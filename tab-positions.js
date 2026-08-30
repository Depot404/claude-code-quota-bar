// ============================================================================
// « Cette photo du memento décrit-elle ENCORE le monde d'aujourd'hui ? »
//
// Le memento `workbench.parts.editor` est la seule source qui dise QUELLE
// session est portée par QUEL onglet (la Tab API de VS Code n'expose qu'un
// libellé, et deux conversations peuvent partager le même au caractère près).
// Mais il est flushé PARESSEUSEMENT : entre deux flushs, l'utilisateur a pu
// fermer, ouvrir ou déplacer un onglet, et ses positions désignent alors des
// voisins. Mesuré au banc d'intégration (test-click-highlight-loop.js) : une
// photo périmée mélangée aux libellés frais du tracker fabrique des positions
// qui n'ont JAMAIS existé — le surlignage désignait une troisième conversation,
// ni celle affichée ni celle cliquée. C'est PIRE que l'appariement par libellé
// qu'elle remplace.
//
// D'où ce module, et la règle qu'il tient : LA PHOTO S'ACCEPTE EN BLOC OU PAS
// DU TOUT. Trois accords doivent exister avec l'état frais, faute de quoi on
// rend `null` et l'appelant retombe sur son comportement d'avant, à l'octet
// près :
//
//   1. MÊME POPULATION — autant d'onglets Claude aujourd'hui que de positions
//      dans la photo. Une fermeture ou une ouverture se voit d'abord ici.
//   2. RANGS PLAUSIBLES — aucune position ne tombe hors du monde connu.
//   3. LIBELLÉS COMPATIBLES — quand l'appelant peut fournir de quoi comparer
//      (state.js connaît les titres des conversations ; focus.js n'a que
//      l'onglet visé, et fait ce contrôle-là chez lui).
//
// UN SEUL MODULE POUR DEUX APPELANTS, délibérément : le clic (focus.js) et le
// surlignage (state.js) doivent accepter ou rejeter la MÊME photo au même
// instant. Les laisser juger chacun de leur côté, c'est reproduire l'incident
// du 2026-08-24 — « un fait d'affichage doit avoir UNE source ; si deux modules
// le déduisent séparément, les corriger séparément ne se voit pas ».
// ============================================================================

// validatePositions(positions, world) → Map<sessionId, position> | null
//
// `positions` : { byId: Map<sessionId, {viewColumn,index,flatIndex}>,
//                 activeFlatIndex: number|null }  — la photo (session-titles.js).
// `world`     : { claudeCount: number, activeFlatIndex: number|null } — l'état
//               frais, tel que l'appelant le voit (API des onglets, ou tracker).
//
// Rend la table des positions si elle est utilisable, `null` sinon. Ne jette
// jamais : une entrée malformée vaut un rejet, pas une exception.
function validatePositions(positions, world) {
  if (!positions || !positions.byId || typeof positions.byId.get !== 'function') return null;
  if (!positions.byId.size || !world) return null;

  // 1. même population
  if (typeof world.claudeCount !== 'number' || positions.byId.size !== world.claudeCount) return null;

  // ⚠️ CE QU'ON NE CONTRÔLE PAS, ET POURQUOI — on a essayé d'exiger que l'ACTIF
  // de la photo tombe au rang de l'actif d'aujourd'hui, pour attraper un
  // déplacement d'onglets. Mesuré : ce contrôle rejette la photo la plupart du
  // temps, parce que le memento retarde ÉNORMÉMENT sur l'onglet actif (jusqu'à
  // 27,4 s relevées le 2026-08-27) alors que ses POSITIONS, elles, restent
  // justes. Il confondait « l'utilisateur a changé d'onglet » (constant, sans
  // conséquence ici) avec « les onglets ont bougé » (rare). Les positions se
  // seraient donc tues presque toujours, et le surlignage serait retombé sur
  // l'appariement par ordre — c'est-à-dire sur le bug qu'on corrige.
  // Reste une limite ASSUMÉE, faute d'information : deux onglets HOMONYMES
  // permutés à la souris entre deux flushs sont indiscernables (même compte,
  // mêmes libellés). Le clic vise alors la sœur voisine jusqu'au flush suivant,
  // qui répare tout. Aucun autre cas de figure n'échappe aux trois contrôles.

  // 2 & 3. rangs plausibles (une position hors du monde connu rejette tout)
  for (const loc of positions.byId.values()) {
    if (!loc || typeof loc.flatIndex !== 'number') return null;
    if (loc.flatIndex < 0 || loc.flatIndex >= world.claudeCount) return null;
  }
  return positions.byId;
}

module.exports = { validatePositions };
