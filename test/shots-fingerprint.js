// Empreinte des sources qui DESSINENT les captures de la fiche.
//
// POURQUOI — les 4 PNG de `images/` SONT la fiche publique. La règle « un
// changement visible dans le panneau se régénère dans le même lot » existait
// depuis le 2026-08-09, écrite noir sur blanc… et la fiche a quand même dérivé
// de la 2.32 à la 2.40 : en-tête de lot refaite (2.36.0), lots imbriqués
// (2.37.0), rien de tout ça sur les images. Une règle qu'il faut se RAPPELER
// d'appliquer finit toujours par sauter ; c'est déjà ce qui avait justifié de
// remplacer le « paranoia grep » par test-no-private-residue.js. Même remède :
// un banc qui devient ROUGE.
//
// CE QU'ON MESURE — le hash des fichiers qui décident du rendu (panel.js, seul
// producteur du HTML/CSS du webview, et le jeu de données fictif de
// make-store-shots.js). S'ils bougent, les captures peuvent mentir : on
// régénère et on REGARDE. Volontairement grossier — un hash de fichier entier
// attrape aussi une modification invisible (un commentaire), et c'est le prix
// à payer pour ne jamais rater l'inverse : une modification visible traitée
// comme invisible. C'est exactement le jugement d'« ampleur » qui a échoué.
//
// LA SORTIE DE SECOURS est explicite et tracée : `node test/make-store-shots.js
// --fingerprint-only` réenregistre l'empreinte SANS régénérer les images. À
// n'utiliser qu'après avoir REGARDÉ et constaté qu'aucun pixel de la fiche ne
// change — un commit qui fait ça se voit dans l'historique, contrairement à un
// oubli.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FINGERPRINT_FILE = 'shots-source.json';

// Fichiers dont le contenu détermine ce qu'on voit sur les captures. Ajouter
// ici tout nouveau module qui produirait du rendu (le webview n'en a qu'un
// aujourd'hui : panel.js fabrique le HTML, le CSS et le JS embarqués).
const SOURCES = [
  { key: 'panel.js', file: path.join(__dirname, '..', 'panel.js') },
  { key: 'test/make-store-shots.js', file: path.join(__dirname, 'make-store-shots.js') },
];

function hashOf(file) {
  // Les fins de ligne ne changent aucun pixel : un clone Windows/Unix ne doit
  // pas faire tomber le banc (le repo public est resynchronisé depuis Windows,
  // cf. le piège CRLF de PUBLISH.md).
  const buf = fs.readFileSync(file);
  const norm = Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

function currentFingerprint() {
  const out = {};
  for (const s of SOURCES) out[s.key] = hashOf(s.file);
  return out;
}

function fingerprintPath(dir) {
  return path.join(dir, FINGERPRINT_FILE);
}

function writeFingerprint(dir) {
  const payload = {
    _comment: 'Written by test/make-store-shots.js. Do not edit by hand — see test/shots-fingerprint.js.',
    sources: currentFingerprint(),
  };
  fs.writeFileSync(fingerprintPath(dir), JSON.stringify(payload, null, 2) + '\n');
  return payload;
}

// { fresh, missing, stale: [clés] } — `missing` distingue « jamais enregistré »
// de « périmé » : les deux sont rouges, mais la consigne n'est pas la même.
function checkFingerprint(dir) {
  const file = fingerprintPath(dir);
  if (!fs.existsSync(file)) return { fresh: false, missing: true, stale: [] };
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { fresh: false, missing: true, stale: [] }; }
  const now = currentFingerprint();
  const ref = (saved && saved.sources) || {};
  const stale = Object.keys(now).filter((k) => now[k] !== ref[k]);
  return { fresh: stale.length === 0, missing: false, stale };
}

module.exports = { FINGERPRINT_FILE, SOURCES, currentFingerprint, writeFingerprint, checkFingerprint, fingerprintPath };
