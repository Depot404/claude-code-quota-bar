'use strict';
// Faux auxiliaire de dictée pour test-dictation-button.js : même protocole que
// dictation/whisper_dictate.py (JSON par ligne), texte connu d'avance, horloge
// fixe — le banc teste le BOUTON et l'insertion, pas Whisper (celui-là a son
// banc : test-dictation-helper.js).
//
// Après « start » : listening + level, puis interim « un » (+50 ms), final
// « un deux. » (+150 ms), interim « trois » (+900 ms). Après « stop » : final
// « trois quatre. » (+400 ms) puis done. `--fail` : toute dictée échoue
// (micro refusé par Windows).
const fail = process.argv.includes('--fail');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let timers = [];
const later = (ms, fn) => timers.push(setTimeout(fn, ms));
const clear = () => { timers.forEach(clearTimeout); timers = []; };

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    const id = m.id;
    if (m.cmd === 'start') {
      clear();
      if (fail) {
        out({ ev: 'error', id, code: 'mic-denied', message: 'denied' });
        out({ ev: 'done', id });
        continue;
      }
      out({ ev: 'listening', id });
      out({ ev: 'level', id, v: 0.8 });
      later(50, () => out({ ev: 'interim', id, text: 'un' }));
      later(150, () => out({ ev: 'final', id, text: 'un deux.' }));
      later(900, () => out({ ev: 'interim', id, text: 'trois' }));
    } else if (m.cmd === 'stop') {
      clear();
      later(400, () => { out({ ev: 'final', id, text: 'trois quatre.' }); out({ ev: 'done', id }); });
    } else if (m.cmd === 'cancel') {
      clear();
      out({ ev: 'done', id });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
