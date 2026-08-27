// ============================================================================
// SUPPLANTATION DE SESSION, AVEC OU SANS RELOAD DE FENÊTRE (2026-07-24,
// durci 2026-08-05).
//
// POURQUOI — recharger la fenêtre VS Code tue les CLI ; l'extension Claude
// officielle RESTAURE ses onglets, et il arrive qu'elle relance la
// conversation sous un NOUVEAU sessionId : un nouveau transcript qui REJOUE le
// même premier prompt, porte donc le même ai-title, et prend la place de
// l'onglet. L'ancien transcript subsiste : un HUSK, figé à l'instant du reload,
// MORT (plus aucun process CLI), mais toujours listé par state.js — qui fait
// UNE conversation par transcript. Constaté en vrai le 2026-07-24 (ids et
// titre remaniés) :
//   aaaa1111 « Implement part 1 panel cleanup » (02:01, husk)
//   bbbb2222 « Implement part 1 panel cleanup » (03:30, resumé)
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
// transcripts du même dossier projet, l'un MORT et plus ancien, l'autre plus
// frais ET vivant OU dont un onglet porte encore son identité : le mort est
// SUPPLANTÉ par le frais.
//
// RÉCIDIVE 2026-08-05 — un respawn SANS reload (session successeur née à
// 02:56:39, aucune fenêtre rechargée, husk mort proprement en `done`) a
// échappé au groupement par titre : les deux ai-titles DIVERGENT d'un mot
// (« …repli auto groupes terminés » vs « …repli auto DES groupes terminés » —
// l'IA qui pose le titre ne le reproduit pas toujours mot pour mot d'une
// session à l'autre). `computeSupersededBy` conclut par titre EXACT (après
// normalisation d'espaces/casse) : un mot de différence et le groupement ne se
// forme jamais, donc aucune redirection n'est publiée — la même conversation
// reste rendue deux fois (membre de groupe collé au husk mort, ET ligne plate
// sur le successeur), symptôme identique au bug 3 d'origine mais qui échappait
// au fix du 2026-07-24.
//
// Second signal d'identité, INDÉPENDANT du titre : le PREMIER MESSAGE USER du
// transcript. Un `resume` (avec ou sans reload) REJOUE ce message tel quel —
// c'est la même mécanique, déjà éprouvée, que l'étage 2 du rattachement des
// membres de groupe (attach.js `looksLikeSamePrompt`/`normalizeForMatch` :
// comparaison de préfixe tolérante aux blancs/casse, jamais floue, jamais en
// dessous de MIN_PREFIX). Le titre reste le signal PRIMAIRE (bon marché, déjà
// dans le snapshot) ; le premier message ne s'évalue qu'entre convs qu'aucun
// groupe de titre n'a déjà réunies, et seulement par paire NON AMBIGUË — un
// message qui matche plus d'un autre transcript ne fold personne, même
// principe que matchPending (« ambiguïté = aucun rattachement »).
//
// Dégradation silencieuse conservée sur les deux signaux : titre absent/de
// repli → ignoré par le groupement titre ; `firstUser` absent (pas fourni par
// l'appelant, ou transcript illisible) → ignoré par le groupement prompt.
// Rien qui matche nulle part = aucune supplantation, comportement d'avant.
//
// SEUIL DU SECOND SIGNAL (2026-08-10) — un premier message plus COURT que
// MIN_PREFIX ne vaut jamais identité, même identique au caractère près : « ok »,
// « continue », « suite » ouvrent des dizaines de conversations différentes.
// C'est ce que MIN_PREFIX interdit déjà à un préfixe ; l'égalité stricte que
// looksLikeSamePrompt applique en dessous du seuil est légitime là où elle est
// née (attach.js compare le prompt qu'on VIENT d'insérer, borné par
// `launchedAt`), jamais ici. Deux conversations distinctes d'un même lot ont été
// fondues l'une dans l'autre sur le mot « prompt » — la vague ne s'est plus
// jamais complétée, donc la suivante ne s'est plus jamais ouverte.
// ============================================================================

const { norm } = require('./labels');
const { looksLikeSamePrompt, identifiesConversation } = require('./attach');

// Mêmes sources que state.js MATCHABLE_TITLE_SOURCES : un titre qui PEUT porter
// un libellé d'onglet, donc dont l'égalité entre deux convs est une identité
// fiable. Le repli (`first-message`, `last-prompt`…) en est exclu.
const RELIABLE_TITLE_SOURCES = new Set(['ai-title', 'tab-store']);

// Un groupe de ≥ 2 convs candidates à la supplantation → { husk: succ, ... }
// pour ce groupe, vide si aucune ne prouve la continuité (successeur ni vivant
// ni à onglet ouvert). Factorisé : la même résolution sert au groupement par
// titre et à celui par premier message — un seul endroit décide qui est le
// successeur et qui est un vrai husk.
function resolveGroup(group, out) {
  if (group.length < 2) return;

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
  // l'écran : son process tourne, OU un onglet porte encore son identité. Deux
  // transcripts morts homonymes sans onglet ne prouvent pas une continuité —
  // on n'en fold aucun (jamais de fusion devinée sans preuve).
  if (!succ.live && !succ.tabOpen) return;

  // Y a-t-il assez d'onglets pour tout le monde ? Une supplantation SUPPOSE
  // qu'un onglet a été REPRIS : le successeur occupe celui du husk. S'il y a
  // autant d'onglets ouverts que de conversations qui les revendiquent,
  // personne n'a rien repris — ce sont des conversations distinctes qui
  // partagent un titre. `tabMatches` absent (appelant qui ne le fournit pas,
  // bancs) → 0 → cette garde ne se déclenche jamais : comportement d'avant, à
  // l'octet près, comme pour les deux autres signaux.
  const claimants = group.filter((c) => c.tabOpen).length;
  const tabsAvailable = group.reduce((n, c) => Math.max(n, c.tabMatches || 0), 0);
  const enoughTabsForEveryone = tabsAvailable >= claimants;

  for (const c of group) {
    if (c === succ) continue;
    // Un HUSK : mort, et strictement plus ancien que le successeur. Un second
    // VIVANT homonyme (deux vrais onglets concurrents) n'est JAMAIS fold — ce
    // sont deux conversations réelles, pas un artefact de reload/respawn.
    if (!c.live && (c.mtime || 0) < (succ.mtime || 0)) {
      // ONGLET REPRIS, ou onglet de plus ? (2026-08-10) Quand le successeur
      // n'est prouvé QUE par un onglet (son process ne tourne pas) et que le
      // husk présumé en revendique un lui aussi, `tabOpen` ne tranche pas : il
      // vient d'un matching par LIBELLÉ (state.js `hasOpenTab`), et deux
      // homonymes matchent le même onglet aussi bien que le leur. Le COMPTE, si.
      // Autant d'onglets que de prétendants ⇒ personne n'a repris l'onglet de
      // personne ⇒ deux conversations réelles qui partagent un titre, jamais un
      // husk. Doute → aucun fold, comme partout ailleurs ici : une ligne en trop
      // est bénigne, une conversation escamotée ne l'est pas — elle sort de la
      // liste (state.js ampute le husk) et tout membre de lot qui la désigne
      // résout son statut contre sa voisine, ce qui fige la vague pour toujours
      // (test-group-master-focus.js, rouge une fois sur deux avant ce
      // correctif : deux conversations distinctes au même titre, un onglet
      // chacune). Un successeur VIVANT, lui, prouve la continuité par son
      // process : le fold reste, c'est la forme même de l'incident d'origine.
      if (!succ.live && c.tabOpen && enoughTabsForEveryone) continue;
      // VETO PAR LE PREMIER MESSAGE (2026-08-27). Le groupement secondaire, plus
      // bas, tient deux premiers messages identiques pour une IDENTITÉ : un
      // resume REJOUE ce message tel quel. La réciproque doit donc valoir ICI —
      // deux premiers messages qui DIVERGENT prouvent deux conversations
      // distinctes, quoi qu'en dise leur titre, et aucune preuve de continuité
      // (successeur vivant compris) ne peut rattraper ça : un process vivant
      // prouve que le SUCCESSEUR travaille, jamais qu'il est né de ce husk-là.
      // Relevé le 2026-08-27 : deux lots différents, lancés à 10 h d'intervalle
      // sur deux plans différents, fondus l'un dans l'autre sur le titre commun
      // « Lot 4 contrats & doc » — titre qui venait du STORE D'ONGLETS de VS
      // Code (`agentSessions.model.cache`, cf. session-titles.js), lequel garde
      // ses entrées POUR TOUJOURS, onglet fermé compris : `titleSource`
      // 'tab-store' est donc « fiable » sans qu'aucun onglet n'existe encore, et
      // la garde du COMPTE d'onglets juste au-dessus ne pouvait rien voir (le
      // husk n'en revendiquait aucun). Conséquences constatées : la vieille
      // conversation amputée de la liste, et son lot réduit à une poignée seule
      // (sa ligne rendue par le lot voisin, cf. panel.js `rowOwner`).
      // Dégradation silencieuse conservée : un seul des deux `firstUser`
      // manquant (transcript illisible, appelant qui ne les fournit pas) ⇒ aucun
      // veto, comportement d'avant à l'octet près.
      if (c.firstUser && succ.firstUser && !looksLikeSamePrompt(c.firstUser, succ.firstUser)) continue;
      out[c.sessionId] = succ.sessionId;
    }
  }
}

// `convs` : [{ sessionId, title, titleSource, mtime, live, tabOpen, firstUser }]
// `firstUser` est OPTIONNEL (rétro-compatible : absent partout ⇒ comportement
// du groupement par titre seul, inchangé). Rend un objet plain
// { [huskSessionId]: successorSessionId } — vide si rien à supplanter.
// Fonction PURE : aucun accès disque, aucun `vscode`, testable cas par cas
// (test/test-supersede.js).
function computeSupersededBy(convs) {
  const list = (convs || []).filter(Boolean);

  // 1) Groupement PRIMAIRE : titre fiable identique (norm() gomme espaces et
  // casse). Cas majoritaire, signal le moins cher.
  const byTitle = new Map();
  for (const c of list) {
    if (!RELIABLE_TITLE_SOURCES.has(c.titleSource)) continue;
    const key = norm(c.title);
    if (!key) continue;
    let group = byTitle.get(key);
    if (!group) { group = []; byTitle.set(key, group); }
    group.push(c);
  }

  const out = {};
  const resolvedByTitle = new Set();
  for (const group of byTitle.values()) {
    if (group.length < 2) continue;
    resolveGroup(group, out);
    for (const c of group) resolvedByTitle.add(c.sessionId);
  }

  // 2) Groupement SECONDAIRE : premier message user rejoué à l'identique,
  // entre convs qu'aucun groupe-titre n'a déjà réunies (le titre, exact,
  // prime — on ne recalcule rien pour les paires qu'il a déjà tranchées).
  // Paire NON ambiguë seulement : chaque côté ne doit matcher qu'UN seul autre
  // transcript, sinon aucun des deux ne fold (ambiguïté = aucune conclusion).
  // `identifiesConversation` (attach.js) : un premier message plus court que
  // MIN_PREFIX n'est PAS un signal d'identité, même répété au caractère près.
  // Sans ce filtre, deux conversations distinctes ouvertes par « ok »,
  // « continue » ou « suite » se fondaient l'une dans l'autre — la plus ancienne
  // sortait de la liste (state.js ampute le husk) et tout membre de lot qui la
  // désignait résolvait son statut contre la conversation d'à côté, encore
  // `busy` : vague jamais complète, vague suivante jamais ouverte, pour
  // toujours. Diagnostiqué le 2026-08-10 par test-wave-advance.js, qui échouait
  // une fois sur trois — l'écart tenait au seul `mtime` des deux transcripts
  // (égal à la milliseconde = pas de husk, donc pas de fold).
  const withPrompt = list.filter((c) => c.firstUser && identifiesConversation(c.firstUser) && !resolvedByTitle.has(c.sessionId));
  const pairs = [];
  for (let i = 0; i < withPrompt.length; i++) {
    for (let j = i + 1; j < withPrompt.length; j++) {
      if (looksLikeSamePrompt(withPrompt[i].firstUser, withPrompt[j].firstUser)) {
        pairs.push([withPrompt[i], withPrompt[j]]);
      }
    }
  }
  const matchCount = new Map();
  for (const [a, b] of pairs) {
    matchCount.set(a.sessionId, (matchCount.get(a.sessionId) || 0) + 1);
    matchCount.set(b.sessionId, (matchCount.get(b.sessionId) || 0) + 1);
  }
  for (const [a, b] of pairs) {
    if (matchCount.get(a.sessionId) !== 1 || matchCount.get(b.sessionId) !== 1) continue;
    resolveGroup([a, b], out);
  }

  return out;
}

module.exports = { computeSupersededBy, RELIABLE_TITLE_SOURCES };
