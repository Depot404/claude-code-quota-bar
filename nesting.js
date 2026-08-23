// ============================================================================
// RELATIONS DÉRIVÉES ENTRE LOTS — deux questions, une seule résolution :
//   • FILIATION : quel groupe se rend IMBRIQUÉ sous la ligne d'un autre
//     (plan PLAN_arbre_filiation_2026-08-15.md, lot 1) ;
//   • RÔLE DE LA MAÎTRESSE : quand plusieurs lots revendiquent la MÊME
//     conversation maîtresse, lequel la rend en tête et lequel la cède
//     (plan PLAN_maitresse_dernier_lot_2026-08-15.md).
// Les deux se décident sur le même matériau (qui héberge quelle conversation,
// à quelle date le lien a été posé) et se contrediraient à coup sûr si elles
// vivaient dans deux modules — c'est la classe d'erreur que member-truth.js
// documente en tête.
//
// LE FAIT — la conversation maîtresse d'un lot B est très souvent MEMBRE d'un
// lot A : c'est le cas nominal d'un chantier en lots, où le lot N propose les
// handoffs du lot N+1 (groups.js le dit déjà en tête : une maîtresse est un
// POINTEUR vers une conversation qui vit là où elle est, et `setMaster`
// l'accepte explicitement quand elle est membre d'un AUTRE groupe).
//
// LE BUG QUE ÇA PRODUIT — la même conversation est alors revendiquée par deux
// blocs : A veut la rendre dans son emplacement de membre, B veut la rendre en
// tête. Il n'y a qu'UN nœud de conversation (invariant « UN nœud, UN endroit »
// du CLAUDE.md du dossier) : celui qui sert en dernier prend le nœud, et l'autre
// garde un emplacement VIDE (`emptySlots:1`, constaté au banc de la maquette).
//
// LA SORTIE — `nestedUnder: {groupId, memberKey}` : « ce lot se rend sous la
// ligne de CE membre de CE lot ». La ligne reste celle du membre de A (donc UN
// seul nœud, à SA place) et devient la tête du sous-lot. Le rendu, lui, est le
// lot 2 : ce module ne décrit qu'une filiation, il ne dessine rien.
//
// CE QUE CE MODULE NE FAIT PAS — aucune résolution de son côté. Il consomme la
// forme DÉJÀ ENVOYÉE AU WEBVIEW (convId de membre, master.convId/listed), donc
// des identifiants déjà redirigés husk→successeur par supersede.js et un
// `listed` déjà tranché par masterState(). Recalculer ici une vérité
// « équivalente » serait exactement la classe d'erreur que member-truth.js
// documente en tête : deux résolutions pour un même fait ne peuvent que
// diverger. Corollaire : rien à faire de spécial pour la supplantation — si les
// deux côtés (maîtresse de B, membre de A) ont été redirigés vers le successeur,
// ils s'égalent tout seuls ; si un seul l'a été, ils ne s'égalent pas et le
// rendu classique reprend (dégradation silencieuse, règle du projet).
//
// Node PUR — aucun require, aucun accès disque, aucune connaissance de VS Code :
// testable cas par cas (test/test-nesting.js), comme group-done.js et waves.js.
// ============================================================================

// Statut d'un membre dont panel.js ne rend PLUS la ligne (« ce qui reste à
// faire », plan repli-auto étape 11 : `visibleMembers` filtre exactement ce
// statut). Un tel membre ne peut pas accueillir de sous-lot : sa ligne n'existe
// pas, donc le sous-lot n'aurait pas de tête et disparaîtrait avec elle.
//
// Cette règle a une conséquence qu'on ne veut surtout pas perdre de vue, parce
// qu'elle rend VRAI par construction le « on ne cache jamais du travail en
// cours » du plan : un groupe A n'est `done` (donc non rendu, group-done.js) que
// si TOUS ses membres sont `done-closed` — or accueillir un sous-lot exige un
// membre qui ne l'est PAS. Un parent qui héberge un enfant ne peut donc jamais
// être masqué, sans aucune suspension à écrire ; et le jour où sa dernière
// ligne s'éteint, l'enfant perd son hôte et redevient un bloc autonome — visible
// — avant que le parent ne disparaisse. Aucun état où l'un cache l'autre.
const HIDDEN_MEMBER_STATUS = 'done-closed';

// computeNesting(groups) → { nestedUnder, childrenOf, masterRole }
//   groups      : les groupes TELS QUE RENDUS (sortie de groupsState), soit
//                 { id, master: {convId, listed, linkedAt}|null,
//                   members: [{key, convId, status}] }.
//   nestedUnder : { [groupId]: {groupId, memberKey} } — le parent de chaque lot
//                 imbriqué ; les autres n'y figurent pas (rendu classique).
//   childrenOf  : { [groupId]: [groupId, …] } — l'inverse, dans l'ordre des
//                 groupes reçus (deux sous-lots sous la même ligne se suivent
//                 dans l'ordre du store, jamais dans un ordre inventé ici).
//   masterRole  : { [groupId]: {role, latest} } pour les seuls groupes qui
//                 DÉSIGNENT une maîtresse — cf. section 5 ci-dessous.
function computeNesting(groups) {
  const list = (Array.isArray(groups) ? groups : []).filter((g) => g && g.id);

  // ── 1. Qui peut ACCUEILLIR quelle conversation ? ────────────────────────
  // Un sessionId n'appartient qu'à UN membre (garde d'unicité de groups.js
  // `attach`) — mais la redirection husk→successeur, elle, est appliquée au
  // rendu et peut faire converger deux membres stockés sur le même successeur.
  // Deux hôtes possibles pour une même conversation = ambiguïté, donc AUCUN
  // hôte : même principe que matchPending (attach.js), où une ambiguïté ne se
  // tranche jamais au hasard.
  const seen = new Map();                 // convId → {groupId, memberKey, renders} | null (ambigu)
  for (const g of list) {
    for (const m of (Array.isArray(g.members) ? g.members : [])) {
      const convId = m && m.convId;
      if (!convId) continue;
      if (seen.has(convId)) { seen.set(convId, null); continue; }
      seen.set(convId, {
        groupId: g.id,
        memberKey: m.key,
        renders: m.status !== HIDDEN_MEMBER_STATUS,
      });
    }
  }

  // ── 2. Filiation candidate ──────────────────────────────────────────────
  const parentOf = new Map();             // groupId → {groupId, memberKey}
  for (const g of list) {
    const master = g.master;
    // `listed` faux = la maîtresse est hors de la fenêtre du panneau : le
    // groupe rend alors son propre repli dégradé (titre persisté), il n'y a
    // aucune ligne de A à habiter. Fallback intégral, décision du plan.
    if (!master || !master.listed || !master.convId) continue;
    const host = seen.get(master.convId);
    if (!host || !host.renders) continue;
    // « un AUTRE groupe » : une maîtresse qui serait membre de son propre
    // groupe s'imbriquerait sous elle-même. `setMaster` l'interdit déjà, mais
    // une redirection peut la fabriquer après coup — c'est le cas dégénéré du
    // cycle à 1, traité ici plutôt que laissé au parcours ci-dessous.
    if (host.groupId === g.id) continue;
    parentOf.set(g.id, { groupId: host.groupId, memberKey: host.memberKey });
  }

  // ── 3. Cycles ───────────────────────────────────────────────────────────
  // A maîtresse de B et B maîtresse de A est parfaitement constructible :
  // `setMaster` ne refuse que la maîtresse membre du MÊME groupe. Imbriquer les
  // deux demanderait de rendre chacun à l'intérieur de l'autre — le rendu
  // partirait en récursion. Règle : tout groupe qui appartient à un cycle perd
  // sa filiation (les deux redeviennent des blocs frères, comme aujourd'hui).
  // Un groupe qui POINTE vers un cycle sans en faire partie, lui, la garde : sa
  // chaîne, une fois le cycle cassé, est finie.
  //
  // Parcours itératif (pas de récursion : une chaîne de lots est courte, mais
  // rien ne garantit sa profondeur) — on remonte de parent en parent ; retomber
  // sur un nœud de la pile courante = cycle, et tout le segment depuis ce nœud
  // perd sa filiation. Retomber sur un nœud déjà résolu par un parcours
  // antérieur = rien à faire, il l'est déjà.
  const settled = new Set();
  for (const g of list) {
    if (settled.has(g.id)) continue;
    const stack = [];
    const at = new Map();                 // groupId → index dans `stack`
    let cur = g.id;
    while (cur && !settled.has(cur)) {
      if (at.has(cur)) {
        for (let i = at.get(cur); i < stack.length; i++) parentOf.delete(stack[i]);
        break;
      }
      at.set(cur, stack.length);
      stack.push(cur);
      const p = parentOf.get(cur);
      cur = p ? p.groupId : null;
    }
    for (const id of stack) settled.add(id);
  }

  // ── 4. Rôle de la maîtresse — « elle n'engage que son DERNIER lot » ──────
  // Une conversation de cadrage enchaîne les lots : elle est alors la maîtresse
  // désignée de plusieurs groupes à la fois. C'est un usage NOMINAL (c'est même
  // ce que la filiation outille), et le store a raison de l'accepter — mais le
  // rendu, lui, ne peut pas la mettre en tête de deux blocs : il n'y a qu'UN
  // nœud de conversation (`rowFor`), le dernier bloc rendu le prend et l'autre
  // garde une capsule VIDE. Et tant qu'elle vit — elle pilote le lot suivant —
  // sa présence empêche les DEUX groupes de se retirer une fois finis.
  //
  // Règle : le claimant le plus RÉCEMMENT lié garde la ligne de tête (ou son
  // repli dégradé quand la conv est hors de la fenêtre du panneau) ; les plus
  // anciens la CÈDENT — ils se
  // rendent alors comme un lot sans maîtresse (branche existante de panel.js,
  // aucun rendu neuf) et ne dépendent plus que de leurs propres membres, si
  // bien qu'un vieux lot tout terminé s'efface enfin de lui-même.
  //   • « le plus récent » = `master.linkedAt` (posé par setMaster, avec le
  //     createdAt du groupe pour défaut legacy) ; à égalité, l'ordre du store
  //     tranche — le DERNIER gagne, exactement ce que le rendu faisait déjà
  //     par accident, en moins arbitraire.
  //   • un lot à claimant UNIQUE est strictement inchangé (il est, seul, le
  //     plus récent).
  //   • la redirection husk→successeur est déjà appliquée dans `convId` : deux
  //     revendications qui convergent sur le même successeur comptent bien
  //     pour la MÊME conversation.
  //   • EXCEPTION filiation : si la conv est rendue comme MEMBRE d'un autre
  //     lot, aucun claimant ne rend de tête propre — ils nestent tous sous
  //     cette ligne (`childrenOf` est un tableau, le plan filiation le prévoit
  //     déjà). Le rôle vaut alors 'nested', et `latest` reste la seule marque
  //     du claimant le plus récent.
  //
  // NB (2026-08-18) : ce départage ne porte plus QUE sur le rendu. Le retrait
  // d'un lot terminé, lui, ne regarde plus la maîtresse du tout — il ne dépend
  // que de ses membres (group-done.js). D'où le nom `latest` : ce booléen ne
  // bloque plus rien, il dit seulement « c'est ce lot-ci qui l'a liée en
  // dernier ».
  const claims = new Map();               // convId → [{ id, at, i }]
  list.forEach((g, i) => {
    const m = g.master;
    if (!m || !m.convId) return;
    const at = Number.isFinite(m.linkedAt) ? m.linkedAt : 0;
    if (!claims.has(m.convId)) claims.set(m.convId, []);
    claims.get(m.convId).push({ id: g.id, at, i });
  });
  const latest = new Set();
  for (const arr of claims.values()) {
    let best = arr[0];
    for (const c of arr) if (c.at > best.at || (c.at === best.at && c.i > best.i)) best = c;
    latest.add(best.id);
  }

  // ── 5. Sortie ───────────────────────────────────────────────────────────
  const nestedUnder = {};
  const childrenOf = {};
  const masterRole = {};
  for (const g of list) {                 // itéré sur `list`, pas sur la Map :
    const p = parentOf.get(g.id);         // l'ordre des enfants est celui du store
    if (p) {
      nestedUnder[g.id] = { groupId: p.groupId, memberKey: p.memberKey };
      (childrenOf[p.groupId] || (childrenOf[p.groupId] = [])).push(g.id);
    }
    if (!g.master) continue;
    // Maîtresse sans convId : rien à départager (aucun autre lot ne peut
    // revendiquer « rien ») — elle garde la tête.
    const isLatest = !g.master.convId || latest.has(g.id);
    masterRole[g.id] = {
      role: p ? 'nested' : (isLatest ? 'host' : 'ceded'),
      latest: isLatest,
    };
  }
  return { nestedUnder, childrenOf, masterRole };
}

module.exports = { computeNesting, HIDDEN_MEMBER_STATUS };
