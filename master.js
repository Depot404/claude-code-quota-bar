// ============================================================================
// Conversation MAÎTRESSE d'un groupe (lot 11 du plan
// PLAN_creation_groupes_2026-07-22.md) — résolution, Node PUR.
//
// CE QUE CE MODULE N'EST PAS : une détection permanente dans les transcripts.
// Le cadrage l'a explicitement rejetée (décision 2 du plan : « jamais de
// parsing de prose libre, jamais rien attendu du comportement du modèle »). La
// recherche menée ici est PONCTUELLE — déclenchée par un collage, exécutée une
// fois, jamais rejouée en tâche de fond — et DÉTERMINISTE : elle ne conclut que
// sur une correspondance exacte, et se tait dès qu'il y en a zéro ou plusieurs.
//
// DEUX ÉTAGES, dans l'ordre (même doctrine que le rattachement des membres,
// attach.js : on ne devine jamais, on constate ou on se tait) :
//
//   0. JETON DE SESSION. Un hook UserPromptSubmit (track-active-session.js)
//      reconnaît un prompt `/handoffs` et injecte en additionalContext le
//      `session_id` que le CLI lui a passé ; la commande demande au modèle de le
//      RECOPIER en tête de bloc (`session: <uuid>`). Le modèle ne GÉNÈRE donc
//      jamais d'identifiant — il en TRANSPORTE un vrai. Et on ne le CROIT pas
//      pour autant : à l'arrivée, le jeton n'est retenu que si la session
//      existe ET que son transcript contient réellement le bloc collé. Un jeton
//      inventé, recopié d'un exemple ou périmé échoue à cette revalidation et
//      retombe sur l'étage 1, sans erreur affichée.
//
//   1. RECHERCHE DU BLOC. Le texte collé, normalisé, doit se retrouver comme
//      sous-chaîne d'un message assistant d'un transcript du workspace. UN SEUL
//      transcript correspond → c'est la conv maîtresse. Zéro ou plusieurs → pas
//      de parent, jamais deviné (l'utilisateur a toujours « Set master… »).
//
// NORMALISATION — le texte collé ne peut pas être identique au texte du
// transcript : copier un bloc de code depuis le rendu du chat perd les ``` qui
// l'entourent (constat du lot 6), et Windows sème des \r. On compare donc des
// formes normalisées : \r\n → \n, espaces de fin de ligne retirés, lignes de
// fence retirées des DEUX côtés, extrémités trimées. Rien de plus — pas de
// minuscules, pas de blancs recondensés : deux blocs qui ne diffèrent que par
// la casse ne sont pas le même bloc.
// ============================================================================

// Longueur minimale du texte normalisé pour tenter une recherche. Un « bloc »
// de trois mots se retrouverait par hasard dans plusieurs transcripts (ou dans
// un seul, par pur hasard, ce qui est pire : un lien faux). En dessous, on ne
// cherche pas — l'action manuelle « Set master… » reste le chemin.
const MIN_MATCH_CHARS = 60;

// Un session_id du CLI est un UUID v4. Filtre de salubrité sur le jeton de
// l'étage 0 : une valeur qui n'a pas cette forme n'est même pas soumise à la
// revalidation (le modèle a écrit autre chose que ce qu'on lui a donné).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Une ligne de fence (```claude-convs, ```) est retirée des deux côtés de la
// comparaison : présente dans le transcript (le modèle l'a écrite), absente du
// collage (le bouton Copy du chat ne la donne pas). Les retirer PARTOUT, y
// compris à l'intérieur d'un prompt qui contiendrait du code, garde la
// contiguïté — la même ligne disparaît des deux côtés.
const FENCE_LINE_RE = /^```/;

function normalizeForMatch(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => !FENCE_LINE_RE.test(l.trim()))
    .join('\n')
    .trim();
}

function isUuid(v) { return typeof v === 'string' && UUID_RE.test(v.trim()); }

// `candidates` : [{ sessionId, text }] — `text` = les messages assistant du
// transcript, concaténés par l'appelant (extension.js lit une queue bornée de
// chaque transcript de la fenêtre du panneau ; ce module ne touche pas au
// disque). L'ordre n'a aucune importance : la seule conclusion possible est
// « exactement un ».
//
// Rend { sessionId, via, matches, reason } — `sessionId` non nul SEULEMENT
// quand la conclusion est certaine. `reason` n'est qu'un mot pour le journal.
function resolveMaster(input) {
  const { pasted, token, candidates } = input || {};
  const needle = normalizeForMatch(pasted);
  const list = Array.isArray(candidates) ? candidates : [];

  if (needle.length < MIN_MATCH_CHARS) {
    return { sessionId: null, via: null, matches: 0, reason: 'block-too-short' };
  }

  const contains = (c) => {
    if (!c || !c.sessionId) return false;
    return normalizeForMatch(c.text).indexOf(needle) !== -1;
  };

  // Étage 0 — le jeton n'est qu'une PISTE : il désigne un transcript, c'est ce
  // transcript qui prouve (ou non) qu'il est bien la source du bloc.
  if (isUuid(token)) {
    const id = token.trim();
    const c = list.find((x) => x && x.sessionId === id);
    if (c && contains(c)) return { sessionId: id, via: 'token', matches: 1, reason: 'token-verified' };
    // Jeton présent mais invérifiable (session inconnue de la fenêtre du
    // panneau, ou transcript sans le bloc) : on ne le suit PAS, et on ne crie
    // pas non plus — l'étage 1 reprend la main, exactement comme si le jeton
    // n'avait jamais existé (poste sans nos hooks, bloc écrit à la main).
  }

  // Étage 1 — recherche du bloc lui-même.
  const hits = list.filter(contains).map((c) => c.sessionId);
  if (hits.length === 1) return { sessionId: hits[0], via: 'search', matches: 1, reason: 'single-match' };
  return {
    sessionId: null,
    via: null,
    matches: hits.length,
    reason: hits.length ? 'ambiguous' : 'not-found',
  };
}

module.exports = { normalizeForMatch, resolveMaster, isUuid, MIN_MATCH_CHARS };
