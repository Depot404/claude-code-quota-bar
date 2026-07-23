// ============================================================================
// Rattachement d'un membre de groupe à sa conversation — étage 2 (lot 2 du plan
// PLAN_creation_groupes_2026-07-22.md).
//
// Rappel des trois étages, dans l'ordre :
//   1. DIFF DU REGISTRE ~/.claude/sessions — le CLI est spawné à l'ouverture de
//      l'onglet (vérifié empiriquement au lot 1) : la session apparue juste
//      après notre lancement, avec le cwd du workspace, EST la nôtre. C'est
//      launcher.js, et c'est le chemin nominal.
//   2. CE FICHIER — quand l'étage 1 n'a rien vu (fichier de session jamais
//      apparu, timeout, CLI plus ancien) : le prompt qu'on a inséré se retrouve
//      en PREMIER MESSAGE USER du transcript, dès que l'utilisateur a appuyé
//      sur Entrée. C'est un repli déclaré faillible : l'utilisateur peut avoir
//      édité le prompt avant de l'envoyer, et alors rien ne matche — c'est
//      prévu, on retombe sur l'étage 3.
//   3. MANUEL — « lier à une conversation », liste des convs non groupées.
//      Aucun quatrième étage : hors de ces trois-là, un membre reste « non lié ».
//
// LE PRINCIPE QUI GOUVERNE TOUT CE FICHIER : ambiguïté = aucun rattachement.
// Deux membres au prompt identique, ou un prompt qui matche deux transcripts,
// ne produisent RIEN. Un mauvais rattachement est bien pire qu'un membre non
// lié : il colle un badge d'écart et un état sur la mauvaise conversation, et
// l'utilisateur n'a aucun moyen de savoir que c'est faux.
// ============================================================================

// Comparaison tolérante aux différences que la chaîne d'insertion introduit
// (fins de ligne, indentation recopiée, espaces avalés par le champ de saisie)
// mais à RIEN d'autre : pas de fuzzy, pas de distance d'édition. On veut un
// préfixe littéral, à la casse et aux blancs près.
function normalizeForMatch(s) {
  return String(s == null ? '' : s)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// En dessous, un « préfixe » n'identifie plus rien : « ok », « continue »,
// « go » matcheraient la moitié des conversations du dossier.
const MIN_PREFIX = 16;
// Au-delà, on ne gagne rien : le premier message user d'un transcript peut être
// tronqué ou enrobé, et comparer 4 000 caractères ne rend pas le test plus sûr.
const CMP_LEN = 200;

// Le premier message user commence-t-il par notre prompt (ou l'inverse) ?
// Les deux sens comptent : le transcript peut contenir PLUS que le prompt
// (l'IDE y ajoute son contexte de sélection) et le prompt peut, lui, être plus
// long que ce qu'on a pu lire du transcript.
function looksLikeSamePrompt(prompt, firstUser) {
  const a = normalizeForMatch(prompt).slice(0, CMP_LEN);
  const b = normalizeForMatch(firstUser).slice(0, CMP_LEN);
  if (!a || !b) return false;
  const n = Math.min(a.length, b.length);
  if (n < MIN_PREFIX) return a === b;      // prompt très court : égalité stricte
  return a.slice(0, n) === b.slice(0, n);
}

// members    : [{ groupId, key, prompt, launchedAt }]  (store.pending())
// candidates : [{ sessionId, firstUser, mtime }]       conversations NON rattachées
// → [{ groupId, key, sessionId }] — uniquement les couples SANS ambiguïté.
function matchPending(members, candidates) {
  const mem = Array.isArray(members) ? members.filter((m) => m && m.prompt) : [];
  const cand = Array.isArray(candidates) ? candidates.filter((c) => c && c.sessionId && c.firstUser) : [];
  if (!mem.length || !cand.length) return [];

  // Matrice des correspondances plausibles. Le filtre temporel écarte les
  // transcripts ÉCRITS AVANT notre lancement : ils ne peuvent pas être la conv
  // qu'on vient d'ouvrir. (`launchedAt` absent = membre ajouté à la main, pas
  // de repère temporel → pas de filtre, seul le préfixe décide.)
  const pairs = [];
  for (const m of mem) {
    for (const c of cand) {
      if (m.launchedAt && c.mtime && c.mtime < m.launchedAt) continue;
      if (looksLikeSamePrompt(m.prompt, c.firstUser)) pairs.push({ m, c });
    }
  }

  const byMember = new Map();
  const bySession = new Map();
  for (const p of pairs) {
    const mk = p.m.groupId + '/' + p.m.key;
    byMember.set(mk, (byMember.get(mk) || 0) + 1);
    bySession.set(p.c.sessionId, (bySession.get(p.c.sessionId) || 0) + 1);
  }

  const out = [];
  for (const p of pairs) {
    const mk = p.m.groupId + '/' + p.m.key;
    // Un membre qui matche deux transcripts, ou un transcript revendiqué par
    // deux membres : on ne tranche pas, l'étage 3 (manuel) prendra la main.
    if (byMember.get(mk) !== 1 || bySession.get(p.c.sessionId) !== 1) continue;
    out.push({ groupId: p.m.groupId, key: p.m.key, sessionId: p.c.sessionId });
  }
  return out;
}

module.exports = { matchPending, looksLikeSamePrompt, normalizeForMatch, MIN_PREFIX, CMP_LEN };
