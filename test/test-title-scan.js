// Banc du scan incrémental d'ai-title (lot 8).
// Incident réel 2026-07-15 : ai-title en ligne 16/185, à l'octet 33 349 d'un
// transcript de 739 Ko → invisible des fenêtres head (32 Ko) / tail (64 Ko) de
// extractTitleInfo. Conséquence : titre = repli 1er message user, et le filtre
// de présence du lot 5 (titleSource !== 'ai-title') refusait de masquer la
// conv fermée → restait affichée pour toujours.
const fs = require('fs');
const os = require('os');
const path = require('path');

const { scanAiTitleIncremental, extractTitleInfo } = require(path.join(__dirname, '..', 'hooks', 'transcript.js'));
const { createTranscriptReader } = require(path.join(__dirname, '..', 'state.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-title-scan-'));
const user = (txt) => JSON.stringify({ type: 'user', message: { content: txt } });
const aiTitle = (t) => JSON.stringify({ type: 'ai-title', aiTitle: t });

console.log('\n1. Incident rejoué : ai-title noyé loin des deux fenêtres head/tail');
{
  const p = path.join(SANDBOX, 'buried.jsonl');
  const lines = [];
  // Padding devant : largement > HEAD_BYTES (32 Ko) pour que la tête ne le voie pas.
  for (let i = 0; i < 400; i++) lines.push(user('padding avant ' + 'x'.repeat(120)));
  lines.push(aiTitle('Lot 7 — flèche burn-rate'));
  // Padding derrière : largement > TAIL_BYTES (64 Ko) pour que la queue ne le voie pas.
  for (let i = 0; i < 800; i++) lines.push(user('padding après ' + 'x'.repeat(120)));
  fs.writeFileSync(p, lines.map((l) => l).join('\n') + '\n');
  const sizeKB = fs.statSync(p).size / 1024;
  check('fichier fabriqué bien > 96 Ko (hors des deux fenêtres combinées)', sizeKB > 96, `${sizeKB.toFixed(1)} Ko`);

  // Sans scan incrémental (précédent comportement) : ai-title invisible.
  const naive = extractTitleInfo(p);
  check('sans le scan incrémental, ai-title est bien invisible (reproduit le bug)',
    naive.source !== 'ai-title', JSON.stringify(naive));

  // Avec le scan incrémental (premier passage = scan complet) : trouvé.
  const state = scanAiTitleIncremental(p, { scannedBytes: 0, aiTitle: null });
  const info = extractTitleInfo(p, state.aiTitle);
  check('avec le scan incrémental, titre = ai-title réel', info.title === 'Lot 7 — flèche burn-rate' && info.source === 'ai-title',
    JSON.stringify(info));
}

console.log('\n2. ai-title ré-émis en fin de fichier → le dernier gagne');
{
  const p = path.join(SANDBOX, 'retitled.jsonl');
  fs.writeFileSync(p, [aiTitle('Premier titre'), user('bla')].map((l) => l).join('\n') + '\n');
  const state = { scannedBytes: 0, aiTitle: null };
  scanAiTitleIncremental(p, state);
  check('1er ai-title capté', state.aiTitle === 'Premier titre', state.aiTitle);

  fs.appendFileSync(p, aiTitle('Titre corrigé') + '\n');
  scanAiTitleIncremental(p, state);
  check('re-titrage : le dernier gagne', state.aiTitle === 'Titre corrigé', state.aiTitle);
}

console.log('\n3. Scan incrémental vérifié : compteur d\'octets sur écritures successives');
{
  const p = path.join(SANDBOX, 'incremental.jsonl');
  fs.writeFileSync(p, user('a') + '\n');
  const state = { scannedBytes: 0, aiTitle: null };
  scanAiTitleIncremental(p, state);
  const afterFirst = state.scannedBytes;
  check('1er scan avance scannedBytes jusqu\'à la fin du fichier', afterFirst === fs.statSync(p).size, afterFirst);

  // Rescanner sans nouvelle écriture : ne doit RIEN relire (0 octet de delta).
  const before = state.scannedBytes;
  scanAiTitleIncremental(p, state);
  check('rescan sans écriture nouvelle : scannedBytes inchangé', state.scannedBytes === before, state.scannedBytes);

  fs.appendFileSync(p, user('b') + '\n');
  scanAiTitleIncremental(p, state);
  check('après écriture : scannedBytes avance jusqu\'à la nouvelle taille', state.scannedBytes === fs.statSync(p).size,
    `${state.scannedBytes} vs ${fs.statSync(p).size}`);
  check('le delta lu est bien < la taille totale (pas un re-scan complet)',
    (fs.statSync(p).size - afterFirst) < fs.statSync(p).size);

  // Ligne en cours d'écriture (pas de \n final) : ne doit pas avancer, ni planter.
  const partialLen = fs.statSync(p).size;
  fs.appendFileSync(p, '{"type":"ai-title","aiT'); // JSON tronqué, pas de \n
  scanAiTitleIncremental(p, state);
  check('ligne incomplète (pas de \\n) : scannedBytes ne bouge pas', state.scannedBytes === partialLen, state.scannedBytes);
  fs.appendFileSync(p, 'itle":"Titre complet"}\n');
  scanAiTitleIncremental(p, state);
  check('ligne complétée ensuite : bien captée', state.aiTitle === 'Titre complet', state.aiTitle);
}

console.log('\n4. Intégration createTranscriptReader (state.js) : incrémental à travers plusieurs read()');
{
  const p = path.join(SANDBOX, 'reader.jsonl');
  fs.writeFileSync(p, [
    user('padding ' + 'x'.repeat(70000)), // > TAIL_BYTES pour forcer le besoin du cache incrémental
    aiTitle('Titre du reader'),
    user('reste'),
  ].join('\n') + '\n');
  const read = createTranscriptReader();
  const v1 = read(p);
  check('1er read() trouve le titre malgré le padding', v1.title === 'Titre du reader' && v1.titleSource === 'ai-title',
    JSON.stringify(v1));

  fs.appendFileSync(p, user('nouveau message') + '\n');
  const v2 = read(p);
  check('2e read() après écriture : titre toujours correct (cache incrémental conservé)',
    v2.title === 'Titre du reader' && v2.titleSource === 'ai-title', JSON.stringify(v2));
}

console.log('\n5. Fermeture d\'onglet sur une conv à vieux/gros transcript → provenance ai-title (masquable par le lot 5)');
{
  const p = path.join(SANDBOX, 'presence.jsonl');
  fs.writeFileSync(p, [
    user('padding ' + 'x'.repeat(70000)),
    aiTitle('Conv à retirer'),
  ].join('\n') + '\n');
  const read = createTranscriptReader();
  const v = read(p);
  check('titleSource === "ai-title" (condition du filtre de présence isGone, state.js)', v.titleSource === 'ai-title', v.titleSource);
}

fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
