// Banc de tabs.js : détection de fermeture d'onglet + union inter-fenêtres.
// Le module `vscode` est bouchonné et HOME est un bac à sable → aucune fenêtre
// ni aucun fichier réel n'est touché. La seconde « fenêtre » est un VRAI second
// process (test/tabs-instance.js), seule façon de prouver l'union et le
// nettoyage d'une instance morte.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-tabs-'));
os.homedir = () => SANDBOX;                       // AVANT le require de tabs.js
fs.mkdirSync(path.join(SANDBOX, '.claude'), { recursive: true });

let GROUPS = [];
let onDidChangeTabs = null;
const stub = {
  window: {
    tabGroups: {
      get all() { return GROUPS; },
      onDidChangeTabs: (cb) => { onDidChangeTabs = cb; return { dispose() { onDidChangeTabs = null; } }; },
    },
  },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'vscode') return stub;
  return origLoad.call(this, req, ...rest);
};

const tabsMod = require(path.join(__dirname, '..', 'tabs.js'));

const claude = (label) => ({ label, input: { viewType: 'mainThreadWebview-claudeVSCodePanel' } });
const other = (label) => ({ label, input: { viewType: 'default' } });
const group = (tabs) => ({ viewColumn: 1, isActive: true, tabs });

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  console.log('\n1. Publication des onglets locaux');
  GROUPS = [group([other('README.md'), claude('Implémenter lot 5 ong…')])];
  let closedSeen = [];
  let closedTs = 0;
  let changes = 0;
  const tracker = tabsMod.createTabTracker({
    onTabsClosed: (labels) => { closedTs = Date.now(); closedSeen.push(...labels); },
    onChange: () => { changes++; },
  });

  check('fichier <pid>.json écrit', fs.existsSync(tabsMod.OWN_FILE));
  let published = JSON.parse(fs.readFileSync(tabsMod.OWN_FILE, 'utf8'));
  check('seuls les onglets Claude sont publiés',
    JSON.stringify(published.labels) === JSON.stringify(['Implémenter lot 5 ong…']),
    JSON.stringify(published.labels));
  check('getTabs : known + libellé local',
    tracker.getTabs().known === true && tracker.getTabs().labels.includes('Implémenter lot 5 ong…'));

  console.log('\n2. Fermeture d\'onglet');
  GROUPS = [group([other('README.md')])];                       // l'onglet a disparu
  const t0 = Date.now();
  onDidChangeTabs({ closed: [claude('Implémenter lot 5 ong…')], opened: [], changed: [] });
  published = JSON.parse(fs.readFileSync(tabsMod.OWN_FILE, 'utf8'));
  check('republication immédiate pour les autres fenêtres (synchrone)',
    published.labels.length === 0, JSON.stringify(published.labels));
  check('onChange notifié', changes >= 1);
  await sleep(300);
  check('onTabsClosed reçoit le libellé fermé',
    closedSeen.length === 1 && closedSeen[0] === 'Implémenter lot 5 ong…', JSON.stringify(closedSeen));
  // Mesure de l'événement lui-même, pas du sleep du test.
  const delay = closedTs - t0;
  check(`fermeture signalée en ${delay} ms (exigence : < 1 s)`, delay > 0 && delay < 1000, `${delay} ms`);

  console.log('\n3. Faux positifs à ne pas déclencher');
  closedSeen = [];
  // Onglet glissé d'un groupe à l'autre, fermeture et réouverture livrées dans
  // le MÊME événement.
  GROUPS = [group([claude('Conv déplacée entre g…')])];
  onDidChangeTabs({ closed: [claude('Conv déplacée entre g…')], opened: [claude('Conv déplacée entre g…')], changed: [] });
  await sleep(300);
  check('onglet déplacé (toujours présent) → AUCUNE fermeture signalée',
    closedSeen.length === 0, JSON.stringify(closedSeen));

  closedSeen = [];
  // Le cas retors : VS Code livre la fermeture AVANT la réouverture (le split
  // fait déjà tirer l'événement plusieurs fois, cf. microsoft/vscode#146786).
  // Au moment du 1er événement l'onglet n'existe nulle part → sans confirmation
  // différée, un simple drag ferait disparaître la conv du panneau.
  GROUPS = [group([])];
  onDidChangeTabs({ closed: [claude('Conv déplacée en 2 ét…')], opened: [], changed: [] });
  await sleep(40);
  GROUPS = [group([claude('Conv déplacée en 2 ét…')])];          // réouverte dans l'autre groupe
  onDidChangeTabs({ closed: [], opened: [claude('Conv déplacée en 2 ét…')], changed: [] });
  await sleep(300);
  check('fermeture puis réouverture en DEUX événements → aucune fermeture signalée',
    closedSeen.length === 0, JSON.stringify(closedSeen));

  closedSeen = [];
  GROUPS = [group([])];
  onDidChangeTabs({ closed: [other('README.md')], opened: [], changed: [] });
  await sleep(300);
  check('onglet non-Claude fermé → ignoré', closedSeen.length === 0, JSON.stringify(closedSeen));

  console.log('\n4. Union avec une VRAIE seconde fenêtre (autre process)');
  GROUPS = [group([claude('Onglet de la fenêtre A')])];
  const child = spawn(process.execPath, [
    path.join(__dirname, 'tabs-instance.js'), SANDBOX, 'Onglet de la fenêtre B',
  ], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve) => child.stdout.once('data', resolve));

  let labels = tracker.getTabs().labels;
  check('les onglets des DEUX fenêtres sont dans l\'union',
    labels.includes('Onglet de la fenêtre A') && labels.includes('Onglet de la fenêtre B'),
    JSON.stringify(labels));

  const childFile = path.join(tabsMod.TABS_DIR, `${child.pid}.json`);
  check('la fenêtre B a bien publié son fichier', fs.existsSync(childFile));

  // Onglet glissé de NOTRE fenêtre vers la fenêtre B : il est bel et bien fermé
  // ici, mais la conv n'a pas disparu — elle vit chez la voisine.
  closedSeen = [];
  GROUPS = [group([])];
  onDidChangeTabs({ closed: [claude('Onglet de la fenêtre B')], opened: [], changed: [] });
  await sleep(300);
  check('onglet fermé ici mais ouvert dans une AUTRE fenêtre → aucune fermeture signalée',
    closedSeen.length === 0, JSON.stringify(closedSeen));

  console.log('\n5. Instance morte : nettoyage sur pid absent');
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
  await sleep(200);
  labels = tracker.getTabs().labels;
  check('les onglets d\'une fenêtre morte sortent de l\'union',
    !labels.includes('Onglet de la fenêtre B'), JSON.stringify(labels));
  check('son fichier résiduel est supprimé', !fs.existsSync(childFile));

  console.log('\n6. dispose');
  tracker.dispose();
  check('notre fichier est retiré (nos onglets ne comptent plus ailleurs)',
    !fs.existsSync(tabsMod.OWN_FILE));
  check('après dispose, known:false → plus aucun masquage', tracker.getTabs().known === false);

  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

run();
