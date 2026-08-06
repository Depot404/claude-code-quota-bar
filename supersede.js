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
// ============================================================================

const { norm } = require('./labels');
const { looksLikeSamePrompt } = require('./attach');

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

  for (const c of group) {
    if (c === succ) continue;
    // Un HUSK : mort, et strictement plus ancien que le successeur. Un second
    // VIVANT homonyme (deux vrais onglets concurrents) n'est JAMAIS fold — ce
    // sont deux conversations réelles, pas un artefact de reload/respawn.
    if (!c.live && (c.mtime || 0) < (succ.mtime || 0)) {
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
  const withPrompt = list.filter((c) => c.firstUser && !resolvedByTitle.has(c.sessionId));
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
