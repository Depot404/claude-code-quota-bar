// Banc : rattachement d'un membre de groupe à sa conversation (lot 2 du plan
// PLAN_creation_groupes_2026-07-22.md) — les trois étages, y compris leurs
// échecs, qui doivent être PROPRES (membre « non lié », jamais un mauvais lien).
//
//   étage 1 — diff du registre ~/.claude/sessions : déjà couvert par
//             test-batch-create.js §5/§7/§8 (c'est launcher.js). Repris ici sous
//             l'angle du store : ce que l'étage 1 rend se pose bien sur le bon
//             membre, et deux lancements ne se volent pas leur identité.
//   étage 2 — préfixe de prompt retrouvé en premier message user d'un
//             transcript : le gros de ce fichier, avec un VRAI .jsonl écrit sur
//             disque pour éprouver firstUserText (enveloppes injectées, entrées
//             meta, format réel du CLI).
//   étage 3 — manuel : c'est un QuickPick, rien à tester ici sinon que le store
//             accepte le lien et refuse un sessionId déjà pris (test-group-store).
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT = path.join(__dirname, '..');
const { matchPending, pendingForRelink, looksLikeSamePrompt, identifiesConversation, MIN_PREFIX } = require(path.join(EXT, 'attach.js'));
const { memberTruth } = require(path.join(EXT, 'member-truth.js'));
const { firstUserText } = require(path.join(EXT, 'hooks', 'transcript.js'));
const { createGroupStore } = require(path.join(EXT, 'groups.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-attach-'));
function writeTranscript(name, lines) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}
const userLine = (text, extra) => Object.assign({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }, extra || {});

const PROMPT = 'Implement the token-refresh flow in auth/session.ts; keep the public API stable.';

function run() {
  console.log('\n1. Premier message user d\'un transcript (firstUserText)');
  const plain = writeTranscript('plain.jsonl', [
    { type: 'summary', summary: 'whatever' },
    userLine(PROMPT),
    { type: 'assistant', message: { model: 'claude-opus-4-8', usage: {} } },
  ]);
  check('texte du premier message user', firstUserText(plain) === PROMPT, JSON.stringify(firstUserText(plain)));

  const wrapped = writeTranscript('wrapped.jsonl', [
    userLine('<system-reminder>bla bla</system-reminder>\n' + PROMPT + '\n<ide_selection>x</ide_selection>'),
  ]);
  check('enveloppes injectées par le CLI retirées', firstUserText(wrapped) === PROMPT, JSON.stringify(firstUserText(wrapped)));

  const meta = writeTranscript('meta.jsonl', [
    userLine('caveat interne', { isMeta: true }),
    userLine('branche parallèle', { isSidechain: true }),
    userLine(PROMPT),
  ]);
  check('entrées meta/sidechain ignorées', firstUserText(meta) === PROMPT, JSON.stringify(firstUserText(meta)));

  const empty = writeTranscript('empty.jsonl', [{ type: 'assistant', message: { model: 'x', usage: {} } }]);
  check('transcript sans message user → null', firstUserText(empty) === null);
  check('fichier absent → null, jamais d\'exception', firstUserText(path.join(TMP, 'nope.jsonl')) === null);

  console.log('\n2. Comparaison de prompts (tolérante aux blancs, à rien d\'autre)');
  check('identique', looksLikeSamePrompt(PROMPT, PROMPT));
  check('indentation/retours à la ligne recopiés différemment',
    looksLikeSamePrompt('Implement the token-refresh flow\n  in auth/session.ts', 'Implement the token-refresh flow in auth/session.ts'));
  check('casse ignorée', looksLikeSamePrompt('IMPLEMENT THE TOKEN REFRESH FLOW', 'implement the token refresh flow'));
  check('le transcript contient PLUS que le prompt (contexte ajouté)',
    looksLikeSamePrompt(PROMPT, PROMPT + '\n\nHere is the file you asked for: …'));
  check('prompt réellement différent → non',
    looksLikeSamePrompt(PROMPT, 'Write the integration tests for the refund endpoint') === false);
  check('prompt court : égalité STRICTE exigée',
    looksLikeSamePrompt('go', 'go') === true && looksLikeSamePrompt('go', 'go ahead') === false);
  check(`… seuil documenté (${MIN_PREFIX} caractères)`, MIN_PREFIX >= 8);
  check('vide des deux côtés → jamais un match', looksLikeSamePrompt('', '') === false);

  // `identifiesConversation` (2026-08-10) : le MÊME seuil, mais posé comme
  // question distincte — « ce message suffit-il à IDENTIFIER une conversation ? »
  // C'est ce que supersede.js doit exiger avant de conclure qu'un transcript est
  // le resume d'un autre. L'égalité stricte ci-dessus reste vraie et légitime
  // ICI (on compare le prompt qu'on vient d'insérer, borné par launchedAt) ;
  // là-bas, elle fondait deux conversations distinctes ouvertes par « ok ».
  check('message court → n\'identifie AUCUNE conversation',
    identifiesConversation('go') === false && identifiesConversation('ok') === false
    && identifiesConversation('prompt') === false);
  check('message assez long → identifie',
    identifiesConversation(PROMPT) === true);
  check('longueur mesurée APRÈS normalisation des blancs',
    identifiesConversation('   ok   \n\n ') === false
    && identifiesConversation('a'.repeat(MIN_PREFIX)) === true);
  check('null / vide → n\'identifie rien, jamais d\'exception',
    identifiesConversation(null) === false && identifiesConversation('') === false);

  console.log('\n3. Étage 2 : appariement en masse');
  const members = [
    { groupId: 'g1', key: 'm1', prompt: PROMPT, launchedAt: 1000 },
    { groupId: 'g1', key: 'm2', prompt: 'Write the integration tests for the refund endpoint', launchedAt: 1000 },
  ];
  const pairs = matchPending(members, [
    { sessionId: 's-refund', firstUser: 'Write the integration tests for the refund endpoint', mtime: 2000 },
    { sessionId: 's-token', firstUser: PROMPT, mtime: 2000 },
    { sessionId: 's-autre', firstUser: 'Something else entirely, unrelated to this batch', mtime: 2000 },
  ]);
  check('chaque membre trouve SA conversation', pairs.length === 2, JSON.stringify(pairs));
  check('… la bonne', pairs.find((p) => p.key === 'm1').sessionId === 's-token' && pairs.find((p) => p.key === 'm2').sessionId === 's-refund', JSON.stringify(pairs));

  console.log('\n4. Échecs PROPRES : on préfère « non lié » à un mauvais lien');
  check('prompt édité avant envoi → aucun rattachement',
    matchPending([members[0]], [{ sessionId: 's', firstUser: 'En fait, fais plutôt le contraire de ce qui est écrit', mtime: 2000 }]).length === 0);
  const twins = [
    { groupId: 'g1', key: 'm1', prompt: PROMPT, launchedAt: 1000 },
    { groupId: 'g1', key: 'm2', prompt: PROMPT, launchedAt: 1000 },
  ];
  check('deux membres au prompt IDENTIQUE → rien (ambiguïté)',
    matchPending(twins, [{ sessionId: 's1', firstUser: PROMPT, mtime: 2000 }]).length === 0);
  check('un membre qui matche DEUX transcripts → rien',
    matchPending([members[0]], [
      { sessionId: 's1', firstUser: PROMPT, mtime: 2000 },
      { sessionId: 's2', firstUser: PROMPT, mtime: 2100 },
    ]).length === 0);
  check('transcript ÉCRIT AVANT le lancement → jamais le nôtre',
    matchPending([members[0]], [{ sessionId: 'vieux', firstUser: PROMPT, mtime: 500 }]).length === 0);
  check('aucun candidat → rien, jamais d\'exception', matchPending(members, []).length === 0);
  check('entrées malformées ignorées',
    matchPending([null, { groupId: 'g', key: 'k' }], [null, { sessionId: 's' }]).length === 0);

  console.log('\n5. Étages 1 et 2 posés sur le store, dans l\'ordre');
  let saved = [];
  const store = createGroupStore({ load: () => saved, save: (g) => { saved = g; }, now: () => 1000, newId: () => 'g1' });
  store.create('Lot', [
    { prompt: PROMPT, model: 'opus', effort: 'high', wave: 1 },
    { prompt: 'Write the integration tests for the refund endpoint', model: 'sonnet', effort: 'medium', wave: 1 },
  ]);
  // Étage 1 : le registre n'a rendu qu'UN sessionId (l'autre onglet n'a pas
  // publié son fichier de session à temps) — cas réel du timeout de launcher.js.
  store.attachByIndex('g1', 0, 's-token');
  check('après l\'étage 1, un seul membre reste en attente',
    store.pending().map((p) => p.key).join() === 'm2', JSON.stringify(store.pending()));

  // Étage 2 : la conv déjà rattachée ne doit PAS être proposée comme candidate
  // (c'est le filtre que fait extension.js avec attachedIds).
  const taken = store.attachedIds();
  const candidates = [
    { sessionId: 's-token', firstUser: PROMPT, mtime: 2000 },
    { sessionId: 's-refund', firstUser: 'Write the integration tests for the refund endpoint', mtime: 2000 },
  ].filter((c) => !taken.has(c.sessionId));
  const late = matchPending(store.pending(), candidates);
  check('l\'étage 2 rattrape le membre laissé de côté', late.length === 1 && late[0].sessionId === 's-refund', JSON.stringify(late));
  store.attach(late[0].groupId, late[0].key, late[0].sessionId);
  check('plus rien en attente', store.pending().length === 0);
  check('les deux intentions sont récupérables pour le badge d\'écart', store.intents().length === 2);

  console.log('\n6. Étage 3 : lien manuel, et refus de voler une conv déjà membre');
  store.detach('g1', 'm2');
  check('membre délié → il revient dans la file d\'attente', store.pending().length === 1);
  check('lien manuel vers une conv DÉJÀ membre : refusé', store.attach('g1', 'm2', 's-token') === false);
  check('lien manuel vers une conv libre : accepté', store.attach('g1', 'm2', 's-manuelle') === true);

  console.log('\n7. Liens MORT-NÉS : le re-lien de l\'étage 2 (incident 2026-08-04)');
  // Le film exact de l'incident : l'étage 1 lie m1 au premier sessionId apparu
  // (~ac67), ce CLI meurt dans les secondes qui suivent, l'extension officielle
  // en respawne un autre SOUS LE MÊME ONGLET (~21b3). Le membre garde le mort ;
  // le panneau annonçait « fermée avant envoi » alors que l'onglet était ouvert,
  // prompt dedans. Ici on vérifie que le membre redevient candidat à l'étage 2.
  let saved2 = [];
  const inc = createGroupStore({ load: () => saved2, save: (g) => { saved2 = g; }, now: () => 1000, newId: () => 'gi' });
  inc.create('Incident', [
    { prompt: PROMPT, model: 'sonnet', effort: 'high', wave: 1 },
    { prompt: 'Write the integration tests for the refund endpoint', model: 'opus', effort: 'high', wave: 1 },
  ]);
  inc.attachByIndex('gi', 0, 'ac67');    // le mort-né
  inc.attachByIndex('gi', 1, 'e60b');    // vivant, celui-là

  // Sources de la table de vérité : ac67 mort et sans transcript (rien n'a
  // jamais tourné dessous), e60b vivant.
  const truth = (m) => memberTruth(m, {
    isLive: (id) => id === 'e60b',
    hasTranscript: () => false,
    hookState: () => null,
    getConv: () => null,
  });
  let relink = pendingForRelink(inc.all(), truth);
  check('le membre au lien mort-né redevient candidat à l\'étage 2',
    relink.length === 1 && relink[0].key === 'm1' && relink[0].prompt === PROMPT, JSON.stringify(relink));
  check('… avec la MÊME forme que store.pending() (concaténable tel quel)',
    relink[0].groupId === 'gi' && relink[0].launchedAt === 1000, JSON.stringify(relink[0]));
  check('… et le membre vivant, lui, n\'est jamais candidat', !relink.some((p) => p.key === 'm2'));

  // L'utilisateur appuie sur Entrée dans l'onglet orphelin : le transcript naît
  // sous le NOUVEL id (21b3), après launchedAt → l'étage 2 matche et répare.
  const repaired = matchPending(
    inc.pending().concat(relink),
    [{ sessionId: '21b3', firstUser: PROMPT, mtime: 5000 }]
  );
  check('Entrée dans l\'onglet orphelin → l\'étage 2 re-lie le membre au CLI réel',
    repaired.length === 1 && repaired[0].key === 'm1' && repaired[0].sessionId === '21b3', JSON.stringify(repaired));
  check('… le store accepte d\'écraser un sessionId mort par le vivant',
    inc.attach('gi', 'm1', '21b3') === true);
  check('… et le ticket est réparé : plus rien à re-lier',
    pendingForRelink(inc.all(), (m) => memberTruth(m, {
      isLive: (id) => id === 'e60b' || id === '21b3', hasTranscript: (id) => id === '21b3',
      hookState: () => null, getConv: () => null,
    })).length === 0);

  console.log('\n8. Contre-cas : le « lié = définitif » du lot 8 reste ENTIER');
  // Session morte AVEC transcript = vrai `stale` : un travail a commencé sous
  // cet identifiant, le lien le protège — jamais un candidat au re-lien.
  check('mort AVEC transcript (vrai stale) → jamais candidat',
    pendingForRelink(inc.all(), (m) => memberTruth(m, {
      isLive: () => false, hasTranscript: () => true, hookState: () => 'busy', getConv: () => null,
    })).length === 0);
  check('session vivante → jamais candidate',
    pendingForRelink(inc.all(), (m) => memberTruth(m, {
      isLive: () => true, hasTranscript: () => true, hookState: () => 'busy', getConv: () => null,
    })).length === 0);
  check('terminée puis onglet fermé (done·closed) → jamais candidate',
    pendingForRelink(inc.all(), (m) => memberTruth(m, {
      isLive: () => false, hasTranscript: () => true, hookState: () => 'done', getConv: () => null,
    })).length === 0);
  check('entrées malformées / truthOf absent → tableau vide, jamais d\'exception',
    pendingForRelink(null, truth).length === 0 && pendingForRelink(inc.all(), null).length === 0
    && pendingForRelink([null, { id: 'x', members: [null, { key: 'k' }] }], truth).length === 0);
  check('truthOf qui lève → membre ignoré, jamais d\'exception',
    pendingForRelink(inc.all(), () => { throw new Error('boom'); }).length === 0);

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

run();
