// Banc du lot 11 — conversation MAÎTRESSE d'un groupe (master.js).
//
// Ce qu'il prouve : la recherche ne conclut QUE sur une correspondance
// certaine (exactement un transcript), le jeton de session est REVALIDÉ et
// jamais cru sur parole, et la normalisation absorbe les deux accidents réels
// du chemin de collage (fences perdues par le bouton Copy du chat, \r\n).
const path = require('path');
const { normalizeForMatch, resolveMaster, isUuid, MIN_MATCH_CHARS } = require(path.join(__dirname, '..', 'master.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

const UUID_A = '11111111-2222-4333-8444-555555555555';
const UUID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

// Le bloc tel que le modèle l'écrit dans SA réponse (avec les fences).
const BLOCK_IN_TRANSCRIPT = [
  'Voici les suites que je propose :',
  '',
  '```claude-convs',
  'session: ' + UUID_A,
  'group: Refonte paiement',
  'model: sonnet',
  'effort: medium',
  'Implement batch 1 (refunds table schema) from Tools/X/PLAN.md.',
  '---',
  'model: opus',
  'stage: 2',
  'Audit des appels Stripe existants — après le lot 1.',
  '```',
  '',
  'Ordre : lot 1 → audit.',
].join('\n');

// Le même bloc tel qu'il ARRIVE dans le presse-papier : le bouton Copy du chat
// ne donne pas les ```, et Windows sème des \r (constat du lot 6).
const PASTED = [
  'session: ' + UUID_A,
  'group: Refonte paiement',
  'model: sonnet',
  'effort: medium',
  'Implement batch 1 (refunds table schema) from Tools/X/PLAN.md.',
  '---',
  'model: opus',
  'stage: 2',
  'Audit des appels Stripe existants — après le lot 1.',
].join('\r\n');

const OTHER = 'Une conversation sans rapport, qui parle de volets roulants et de Z-Wave, longuement.';

console.log('\n1. Normalisation');
check('les fences disparaissent des deux côtés',
  normalizeForMatch('```claude-convs\nmodel: opus\nfaire X\n```') === 'model: opus\nfaire X');
check('\\r\\n et espaces de fin de ligne sont neutralisés',
  normalizeForMatch('a  \r\nb\t\r\n') === 'a\nb');
check('la casse n\'est PAS normalisée (deux blocs qui diffèrent par la casse ne sont pas le même bloc)',
  normalizeForMatch('Faire X') !== normalizeForMatch('faire x'));
check('le collage normalisé est bien une sous-chaîne du transcript normalisé',
  normalizeForMatch(BLOCK_IN_TRANSCRIPT).indexOf(normalizeForMatch(PASTED)) !== -1);

console.log('\n2. Étage 1 — recherche du bloc');
const one = resolveMaster({
  pasted: PASTED,
  candidates: [{ sessionId: UUID_A, text: BLOCK_IN_TRANSCRIPT }, { sessionId: UUID_B, text: OTHER }],
});
check('exactement un transcript contient le bloc → conv maîtresse', one.sessionId === UUID_A, JSON.stringify(one));
check('… et la voie est bien la recherche', one.via === 'search', one.via);

const none = resolveMaster({ pasted: PASTED, candidates: [{ sessionId: UUID_B, text: OTHER }] });
check('aucun transcript ne contient le bloc → rien (jamais deviné)', none.sessionId === null, JSON.stringify(none));
check('… raison « not-found »', none.reason === 'not-found', none.reason);

const two = resolveMaster({
  pasted: PASTED,
  candidates: [
    { sessionId: UUID_A, text: BLOCK_IN_TRANSCRIPT },
    { sessionId: UUID_B, text: 'Repris tel quel :\n' + BLOCK_IN_TRANSCRIPT },
  ],
});
check('deux transcripts contiennent le bloc → rien (ambiguïté = silence)', two.sessionId === null, JSON.stringify(two));
check('… et le nombre de correspondances est rapporté', two.matches === 2, String(two.matches));

check('aucun candidat du tout → rien, sans exception',
  resolveMaster({ pasted: PASTED, candidates: [] }).sessionId === null);
check('candidats absents (paramètre omis) → rien, sans exception',
  resolveMaster({ pasted: PASTED }).sessionId === null);

console.log('\n3. Garde-fou : un bloc trop court ne cherche rien');
const tiny = resolveMaster({ pasted: 'faire X', candidates: [{ sessionId: UUID_A, text: 'faire X' }] });
check('sous ' + MIN_MATCH_CHARS + ' caractères normalisés, aucune recherche n\'est tentée',
  tiny.sessionId === null && tiny.reason === 'block-too-short', JSON.stringify(tiny));
check('… même avec un jeton de session valide en prime',
  resolveMaster({ pasted: 'faire X', token: UUID_A, candidates: [{ sessionId: UUID_A, text: 'faire X' }] }).sessionId === null);

console.log('\n4. Étage 0 — le jeton est REVALIDÉ, jamais cru sur parole');
const tok = resolveMaster({
  pasted: PASTED,
  token: UUID_A,
  candidates: [{ sessionId: UUID_A, text: BLOCK_IN_TRANSCRIPT }, { sessionId: UUID_B, text: OTHER }],
});
check('jeton dont le transcript contient le bloc → retenu', tok.sessionId === UUID_A && tok.via === 'token', JSON.stringify(tok));

// Le cas qui a motivé la revalidation : un modèle qui recopie l'identifiant
// d'un exemple, ou qui en fabrique un.
const forged = resolveMaster({
  pasted: PASTED,
  token: UUID_B,
  candidates: [{ sessionId: UUID_A, text: BLOCK_IN_TRANSCRIPT }, { sessionId: UUID_B, text: OTHER }],
});
check('jeton pointant une session qui ne contient PAS le bloc → ignoré, étage 1 reprend',
  forged.sessionId === UUID_A && forged.via === 'search', JSON.stringify(forged));

const unknown = resolveMaster({
  pasted: PASTED,
  token: '99999999-9999-4999-8999-999999999999',
  candidates: [{ sessionId: UUID_A, text: BLOCK_IN_TRANSCRIPT }],
});
check('jeton pointant une session inconnue → ignoré sans erreur',
  unknown.sessionId === UUID_A && unknown.via === 'search', JSON.stringify(unknown));

const garbage = resolveMaster({
  pasted: PASTED,
  token: '<uuid fourni par le contexte>',
  candidates: [{ sessionId: UUID_A, text: BLOCK_IN_TRANSCRIPT }],
});
check('jeton qui n\'est même pas un uuid (le modèle a recopié le gabarit) → ignoré',
  garbage.sessionId === UUID_A && garbage.via === 'search', JSON.stringify(garbage));

const tokenAmbiguous = resolveMaster({
  pasted: PASTED,
  token: UUID_A,
  candidates: [
    { sessionId: UUID_A, text: BLOCK_IN_TRANSCRIPT },
    { sessionId: UUID_B, text: BLOCK_IN_TRANSCRIPT },
  ],
});
check('jeton vérifié → tranche même quand deux transcripts portent le bloc (c\'est tout son intérêt)',
  tokenAmbiguous.sessionId === UUID_A && tokenAmbiguous.via === 'token', JSON.stringify(tokenAmbiguous));

check('isUuid rejette ce qui n\'a pas la forme d\'un session_id',
  isUuid(UUID_A) && !isUuid('') && !isUuid('opus') && !isUuid(null));

console.log('\n5. Poste sans nos hooks : pas de jeton du tout');
const noToken = resolveMaster({
  pasted: PASTED,
  candidates: [{ sessionId: UUID_A, text: BLOCK_IN_TRANSCRIPT }],
});
check('bloc écrit à la main, sans ligne session: → l\'étage 1 suffit',
  noToken.sessionId === UUID_A && noToken.via === 'search', JSON.stringify(noToken));

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
