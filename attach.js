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

// Ce message est-il assez SPÉCIFIQUE pour valoir IDENTITÉ à lui seul ?
//
// Les deux questions que looksLikeSamePrompt sert ne sont PAS de même nature, et
// c'est ce qui a manqué :
//   - matchPending (ici) demande « ce transcript est-il né du prompt que JE
//     viens d'insérer ? ». Un prompt court y est un signal légitime : je sais ce
//     que j'ai envoyé, et le couple est en plus borné par `launchedAt` et par
//     l'unicité exigée des deux côtés. D'où l'égalité stricte sous MIN_PREFIX.
//   - supersede.js demande « ces deux transcripts quelconques sont-ils la MÊME
//     conversation, resumée ? ». Là, deux premiers messages IDENTIQUES mais
//     courts — « ok », « continue », « suite », « prompt » — ne prouvent rien du
//     tout : ils se répètent d'une conversation à l'autre, ce que MIN_PREFIX
//     refuse justement à un préfixe. L'égalité stricte, elle, passait au travers.
// D'où ce prédicat, à la fois voisin du seuil qu'il applique et exigible par
// l'appelant qui en a besoin (2026-08-10 : deux conversations distinctes fondues
// l'une dans l'autre sur le mot « prompt », vague de lot bloquée à jamais).
function identifiesConversation(firstUser) {
  return normalizeForMatch(firstUser).length >= MIN_PREFIX;
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

// ── Liens MORT-NÉS : le seul cas où un membre déjà lié redevient candidat ────
//
// Incident 2026-08-04 : l'étage 1 lie un membre au premier sessionId apparu ;
// ce CLI meurt dans les secondes qui suivent (cause interne à l'extension
// officielle) ; celle-ci en respawne un autre SOUS LE MÊME ONGLET ; le membre,
// lui, garde le mort pour toujours. Le panneau annonçait alors « fermée avant
// envoi » — faux au sujet de l'onglet, qui était grand ouvert avec le prompt
// dedans — et suspendait la vague derrière un bandeau rouge.
//
// La sûreté du « lié = définitif » (lot 8) tient à ce qu'un lien protège un
// travail COMMENCÉ. Un lien mort-né n'en protège aucun : `sent === false` +
// process mort ⇒ rien n'a jamais tourné sous cet identifiant. Ces membres-là
// repassent donc par l'étage 2 — dès que l'utilisateur appuie sur Entrée dans
// l'onglet orphelin, le transcript naît sous le NOUVEL id, le préfixe de prompt
// matche, et le ticket se répare seul. Tous les autres liens (session vivante,
// ou morte AVEC transcript = vrai `stale`) restent intouchables.
//
// groups  : le tableau de groupes du store (store.all())
// truthOf : (member) => memberTruth(member, sources) — injecté, ce module reste
//           du Node pur sans dépendance sur la table de vérité.
// → même forme que store.pending() : [{ groupId, key, prompt, launchedAt }],
//   directement concaténable avant matchPending, dont le principe
//   « ambiguïté = aucun rattachement » s'applique alors tel quel aux deux
//   populations mélangées.
function pendingForRelink(groups, truthOf) {
  const out = [];
  if (!Array.isArray(groups) || typeof truthOf !== 'function') return out;
  for (const g of groups) {
    if (!g || !g.id || !Array.isArray(g.members)) continue;
    for (const m of g.members) {
      // Lié, avec un prompt à retrouver et un repère temporel : sans l'un des
      // trois, l'étage 2 n'a rien sur quoi travailler.
      if (!m || !m.sessionId || !m.prompt || m.launchedAt == null) continue;
      let t = null;
      try { t = truthOf(m); } catch { t = null; }
      if (!t || t.status !== 'unsent-lost') continue;
      out.push({ groupId: g.id, key: m.key, prompt: m.prompt, launchedAt: m.launchedAt });
    }
  }
  return out;
}

module.exports = {
  matchPending, pendingForRelink, looksLikeSamePrompt, identifiesConversation,
  normalizeForMatch, MIN_PREFIX, CMP_LEN,
};
