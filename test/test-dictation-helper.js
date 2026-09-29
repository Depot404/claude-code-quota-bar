// Banc de l'auxiliaire de dictée (dictation/whisper_dictate.py), sans micro :
// le VRAI pipeline (détecteur de voix, découpage au silence, provisoire,
// Whisper) joué sur test/fixtures/dictation-fr.wav — deux phrases en voix
// française de Windows, séparées d'un silence de 1,8 s.
//
// Ce qu'il tient : la transcription attendue, en DEUX phrases figées (le
// silence découpe), chacune précédée d'au moins un texte provisoire (« ça
// s'écrit en parlant »), puis « done ».
//
// SKIP propre si l'interpréteur ou faster-whisper manque (repo public, CI) :
// commande prise dans QUOTABAR_DICTATION_PYTHON, sinon `python`.
// Durée : ~15 s, dont le chargement du modèle (calcul, pas une attente).
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : '')); }
}
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

const PY = process.env.QUOTABAR_DICTATION_PYTHON || 'python';
const HELPER = path.join(__dirname, '..', 'dictation', 'whisper_dictate.py');
const WAV = path.join(__dirname, 'fixtures', 'dictation-fr.wav');
const EXPECTED = ['Bonjour, ceci est un essai de dictée vocale.', 'Le texte doit apparaître dans la case du formulaire.'];

const probe = spawnSync(PY, ['-c', 'import faster_whisper'], { encoding: 'utf8' });
if (probe.error || probe.status !== 0) {
  console.log(`  SKIP  ${PY} sans faster-whisper — ${(probe.error && probe.error.message) || (probe.stderr || '').trim().split('\n').pop()}`);
  console.log('\n0 ok, 0 fail');
  process.exit(0);
}

const r = spawnSync(PY, [HELPER, '--file', WAV, '--language', 'fr'], { encoding: 'utf8', timeout: 180000 });
const events = (r.stdout || '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { bad: l }; } });
const finals = events.filter((e) => e.ev === 'final').map((e) => e.text);
const errors = events.filter((e) => e.ev === 'error' || e.bad);

check('aucune erreur', r.status === 0 && !errors.length, JSON.stringify(errors) + ' ' + (r.stderr || '').slice(-400));
check('deux phrases figées (le silence découpe)', finals.length === 2, JSON.stringify(finals));
check('transcription attendue', norm(finals.join(' ')) === norm(EXPECTED.join(' ')), JSON.stringify(finals));
check('accents conservés', /dictée/.test(finals.join(' ')) && /apparaître/.test(finals.join(' ')), JSON.stringify(finals));
const firstFinal = events.findIndex((e) => e.ev === 'final');
check('un texte provisoire avant la première phrase figée',
  events.slice(0, firstFinal).some((e) => e.ev === 'interim' && e.text), JSON.stringify(events.slice(0, firstFinal)));
check('« done » en dernier', events.length && events[events.length - 1].ev === 'done', JSON.stringify(events[events.length - 1]));

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
