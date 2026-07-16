// Process fils pour le banc de dédoublonnage multi-fenêtres (test-sounds.js) :
// une seule instance qui pose le claim `key`, comme deux fenêtres VS Code
// recomputant le même snapshot en même temps. HOME/USERPROFILE viennent de
// l'env passé par le parent (spawn), déjà pointés vers le bac à sable.
const path = require('path');
const { claimSound } = require(path.join(__dirname, '..', 'sounds.js'));

const key = process.argv[2];
process.stdout.write(JSON.stringify({ pid: process.pid, claimed: claimSound(key) }) + '\n');
