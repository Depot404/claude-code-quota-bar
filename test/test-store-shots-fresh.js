// Banc : les captures de la fiche publique sont-elles à jour ?
//
// POURQUOI CE BANC EXISTE — la fiche du Marketplace a montré un panneau de la
// 2.32 jusqu'à la 2.40 : huit versions, dont deux changements bien visibles
// (l'en-tête de lot refaite en 2.36.0, les lots imbriqués en 2.37.0). La règle
// « on régénère dans le même lot » était pourtant écrite. Elle demandait de s'en
// SOUVENIR, et de juger « est-ce visible ? » — deux choses qu'un banc ne
// demande pas. Même correctif que pour le paranoia grep devenu
// test-no-private-residue.js : ce qui n'est pas exécuté n'est pas un contrôle.
//
// CE QU'IL FAIT — compare l'empreinte des sources de rendu enregistrée au
// moment de la génération (images/shots-source.json) à leur état actuel.
// Rouge = les captures ont été prises avec un autre panel.js.
//
// POUR LE REMETTRE AU VERT, deux gestes, jamais un troisième :
//   node test/make-store-shots.js            → régénère, puis REGARDER les PNG
//   node test/make-store-shots.js --fingerprint-only
//                                            → seulement si, après les avoir
//                                              regardées, aucun pixel ne change
//
// Le banc s'auto-contrôle (une empreinte fabriquée fausse doit le faire
// tomber) : vert le jour où on l'écrit, il le resterait avec une comparaison
// cassée — « rien trouvé » et « ne sait pas chercher » se ressemblent trop.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkFingerprint, writeFingerprint, fingerprintPath, SOURCES } = require('./shots-fingerprint.js');

const IMAGES = path.join(__dirname, '..', 'images');
let ok = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { ok++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  — ' + detail : '')); }
}

console.log('1. Fraîcheur des captures de la fiche (images/)');
const res = checkFingerprint(IMAGES);
check(
  'une empreinte de génération existe',
  !res.missing,
  'aucun ' + fingerprintPath(IMAGES) + " — lancer `node test/make-store-shots.js` (et REGARDER les PNG)"
);
if (!res.missing) {
  check(
    'les captures ont été générées avec le rendu ACTUEL',
    res.fresh,
    'sources modifiées depuis : ' + res.stale.join(', ')
      + ' — régénérer (`node test/make-store-shots.js`, puis regarder les PNG),'
      + ' ou `--fingerprint-only` si rien ne change à l\'écran'
  );
}
check('les 4 PNG de la fiche sont là', ['screenshot.png', 'screenshot-group.png',
  'screenshot-new-conversation.png', 'screenshot-quota.png']
  .every((f) => fs.existsSync(path.join(IMAGES, f))));

console.log('\n2. Auto-contrôle du détecteur');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-shots-'));
try {
  check('dossier sans empreinte → « manquante », jamais « fraîche »',
    (() => { const r = checkFingerprint(sandbox); return r.missing === true && r.fresh === false; })());

  writeFingerprint(sandbox);
  check('empreinte fraîchement écrite → fraîche', checkFingerprint(sandbox).fresh === true);

  const p = fingerprintPath(sandbox);
  const saved = JSON.parse(fs.readFileSync(p, 'utf8'));
  const firstKey = SOURCES[0].key;
  saved.sources[firstKey] = 'deadbeefdeadbeef';
  fs.writeFileSync(p, JSON.stringify(saved, null, 2));
  const tampered = checkFingerprint(sandbox);
  check('empreinte falsifiée → détectée, et le fichier fautif est nommé',
    tampered.fresh === false && tampered.stale.includes(firstKey),
    JSON.stringify(tampered));

  fs.writeFileSync(p, 'ceci n\'est pas du JSON');
  check('empreinte illisible → traitée comme absente, jamais comme fraîche',
    (() => { const r = checkFingerprint(sandbox); return r.fresh === false; })());
} finally {
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {}
}

console.log(`\n${ok} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
