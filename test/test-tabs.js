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
let onDidChangeTabGroups = null;
let onDidChangeWindowState = null;
const stub = {
  window: {
    onDidChangeWindowState: (cb) => {
      onDidChangeWindowState = cb;
      return { dispose() { onDidChangeWindowState = null; } };
    },
    tabGroups: {
      get all() { return GROUPS; },
      get activeTabGroup() { return GROUPS.find((g) => g.isActive) || null; },
      onDidChangeTabs: (cb) => { onDidChangeTabs = cb; return { dispose() { onDidChangeTabs = null; } }; },
      onDidChangeTabGroups: (cb) => { onDidChangeTabGroups = cb; return { dispose() { onDidChangeTabGroups = null; } }; },
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
  GROUPS = [group([other('README.md'), claude('Implement part 5 clos…')])];
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
    JSON.stringify(published.labels) === JSON.stringify(['Implement part 5 clos…']),
    JSON.stringify(published.labels));
  check('getTabs : known + libellé local',
    tracker.getTabs().known === true && tracker.getTabs().labels.includes('Implement part 5 clos…'));

  console.log('\n2. Fermeture d\'onglet');
  GROUPS = [group([other('README.md')])];                       // l'onglet a disparu
  const t0 = Date.now();
  onDidChangeTabs({ closed: [claude('Implement part 5 clos…')], opened: [], changed: [] });
  published = JSON.parse(fs.readFileSync(tabsMod.OWN_FILE, 'utf8'));
  check('republication immédiate pour les autres fenêtres (synchrone)',
    published.labels.length === 0, JSON.stringify(published.labels));
  check('onChange notifié', changes >= 1);
  await sleep(300);
  check('onTabsClosed reçoit le libellé fermé',
    closedSeen.length === 1 && closedSeen[0] === 'Implement part 5 clos…', JSON.stringify(closedSeen));
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

  console.log('\n5bis. Fichiers .json.tmp orphelins (2026-08-07 : 17 constatés sur le poste)');
  // publish() écrit <pid>.json.tmp puis renomme. Quand le rename échoue (le
  // fichier cible est ouvert en lecture par une voisine — courant sous
  // Windows), le .tmp restait pour toujours : otherLabels() ne connaissait que
  // les <pid>.json. Deux verrous : le producteur nettoie son propre résidu, et
  // le balayage ramasse ceux des instances mortes.
  const deadPid = 999999;                       // hors plage de pid Windows
  const deadTmp = path.join(tabsMod.TABS_DIR, `${deadPid}.json.tmp`);
  const deadJson = path.join(tabsMod.TABS_DIR, `${deadPid}.json`);
  fs.writeFileSync(deadTmp, JSON.stringify({ pid: deadPid, ts: Date.now(), labels: ['Fantôme'] }));
  fs.writeFileSync(deadJson, JSON.stringify({ pid: deadPid, ts: Date.now(), labels: ['Fantôme'] }));
  let sweep = tracker.getTabs().labels;
  check('le .tmp d\'une instance MORTE est supprimé au balayage', !fs.existsSync(deadTmp));
  check('… son .json l\'est aussi (comportement historique inchangé)', !fs.existsSync(deadJson));
  check('… et rien de ce fichier n\'entre dans l\'union',
    !sweep.includes('Fantôme'), JSON.stringify(sweep));

  // Instance VIVANTE : son .tmp peut être en cours d'écriture — on n'y touche
  // pas, et on ne le lit pas non plus (un .tmp n'est pas une publication).
  const livePid = process.ppid || process.pid;   // un pid réellement vivant, autre que le nôtre si possible
  const liveTmp = path.join(tabsMod.TABS_DIR, `${livePid}.json.tmp`);
  if (livePid !== process.pid) {
    fs.writeFileSync(liveTmp, JSON.stringify({ pid: livePid, ts: Date.now(), labels: ['Moitié écrit'] }));
    sweep = tracker.getTabs().labels;
    check('le .tmp d\'une instance VIVANTE est laissé en place', fs.existsSync(liveTmp));
    check('… mais jamais lu (un .tmp n\'est pas une publication)',
      !sweep.includes('Moitié écrit'), JSON.stringify(sweep));
    try { fs.unlinkSync(liveTmp); } catch {}
  }

  // Rename impossible → publish() ne doit RIEN laisser derrière lui.
  const realRename = fs.renameSync;
  fs.renameSync = () => { throw new Error('EBUSY simulé'); };
  try {
    GROUPS = [group([claude('Publication qui échoue')])];
    onDidChangeTabs({ closed: [], opened: [], changed: [] });
  } finally {
    fs.renameSync = realRename;
  }
  check('rename raté → le .tmp est nettoyé sur-le-champ (plus d\'orphelin par construction)',
    !fs.existsSync(`${tabsMod.OWN_FILE}.tmp`));

  console.log('\n6. Onglet actif → activeLabel (surlignage du panneau)');
  check('aucun onglet Claude jamais sélectionné → activeLabel null',
    tracker.getTabs().activeLabel === null, String(tracker.getTabs().activeLabel));

  // Sélection d'un onglet Claude (bascule de groupe : seul onDidChangeTabGroups tire).
  let changesBefore = changes;
  const tabA = claude('Conv A sélectionnée');
  GROUPS = [{ viewColumn: 1, isActive: true, activeTab: tabA, tabs: [tabA] }];
  onDidChangeTabGroups({ opened: [], closed: [], changed: GROUPS });
  check('activeLabel suit l\'onglet Claude sélectionné',
    tracker.getTabs().activeLabel === 'Conv A sélectionnée', String(tracker.getTabs().activeLabel));
  check('changement d\'onglet actif → onChange (le panneau se rafraîchit)', changes > changesBefore);

  // Bascule d'onglet DANS le groupe : onDidChangeTabs `changed`, qui porte les
  // deux onglets dont isActive a changé — c'est cette PREUVE d'activation qui
  // autorise l'adoption (doctrine 2026-08-26, cf. tabs.js).
  const tabB = claude('Conv B sélectionnée');
  tabA.isActive = false; tabB.isActive = true;
  GROUPS = [{ viewColumn: 1, isActive: true, activeTab: tabB, tabs: [tabA, tabB] }];
  onDidChangeTabs({ opened: [], closed: [], changed: [tabA, tabB] });
  check('bascule dans le groupe (onDidChangeTabs avec activation) → activeLabel mis à jour',
    tracker.getTabs().activeLabel === 'Conv B sélectionnée', String(tracker.getTabs().activeLabel));

  // Sélection d'un onglet NON-Claude : le dernier onglet Claude reste mémorisé
  // (basculer sur un fichier ne doit pas éteindre le surlignage).
  const tabFile = other('README.md');
  GROUPS = [{ viewColumn: 1, isActive: true, activeTab: tabFile, tabs: [tabA, tabB, tabFile] }];
  onDidChangeTabs({ opened: [], closed: [], changed: [tabFile] });
  check('onglet fichier sélectionné → le dernier onglet Claude reste mémorisé',
    tracker.getTabs().activeLabel === 'Conv B sélectionnée', String(tracker.getTabs().activeLabel));

  // CONTRAT DE 2.110.0 : la copie miroir de VS Code ≥ 1.135 ne ment plus
  // (microsoft/vscode#331914, `engines.vscode` exige cette version) — une
  // divergence de la lecture fraîche EST une bascule et s'adopte, sans preuve à
  // exiger ni souvenir à défendre. Les sept parades qui tenaient le contraire
  // (held, quarantaine, révocation, grâce hors focus, gel, acte primant, tabs-
  // proof) sont parties avec la cause qu'elles couvraient.
  tabA.isActive = true; tabB.isActive = false;
  GROUPS = [{ viewColumn: 1, isActive: true, activeTab: tabA, tabs: [tabA, tabB, tabFile] }];
  check('onglet actif changé sans événement → adopté (le miroir dit vrai)',
    tracker.getTabs().activeLabel === 'Conv A sélectionnée', String(tracker.getTabs().activeLabel));
  check('… et se déclare source: fresh, jamais held',
    tracker.getTabs().source === 'fresh', String(tracker.getTabs().source));
  // L'auto-réparation de 2026-08-15 : le souvenir ne désigne plus aucun onglet
  // local (fermé/renommé), la lecture fraîche est la seule information.
  GROUPS = [{ viewColumn: 1, isActive: true, activeTab: tabB, tabs: [tabB, tabFile] }];
  check('onglet mémorisé disparu → la lecture fraîche reprend (seule info disponible)',
    tracker.getTabs().activeLabel === 'Conv B sélectionnée', String(tracker.getTabs().activeLabel));
  GROUPS = [{ viewColumn: 1, isActive: true, activeTab: tabA, tabs: [tabA, tabB, tabFile] }];

  // Lire frais ne suffit pas : encore faut-il que QUELQU'UN redemande. Au retour
  // d'un alt-tab, aucun onglet n'a bougé, donc aucun événement d'onglet ne tire
  // — sans ce signal, le panneau attend le tick d'horloge du moteur (30 s) alors
  // que c'est l'instant précis où l'utilisateur le regarde.
  changesBefore = changes;
  onDidChangeWindowState({ focused: true });
  check('retour de focus sur la fenêtre → recompute (sans attendre le tick de 30 s)',
    changes > changesBefore, `changes=${changes} avant=${changesBefore}`);
  changesBefore = changes;
  onDidChangeWindowState({ focused: false });
  check('perte de focus → aucun recompute inutile', changes === changesBefore);

  console.log('\n7. L\'acte (clic panneau) : il ne porte plus que l\'IDENTITÉ visée');
  // Ce qui reste de `reportActivation` en 2.110.0 : poser le souvenir et, seul
  // apport que la barre d'onglets ne sait pas donner, le sessionId de la
  // conversation visée (state.js s'en sert pour désigner la bonne sœur quand
  // deux onglets portent le même libellé tronqué). Plus d'acte primant sur
  // l'API, plus de gel : l'événement d'onglet qui suit dit la vérité.
  onDidChangeWindowState({ focused: true });
  const tabActed = claude('Conv actée par le panneau');
  GROUPS = [{ viewColumn: 1, isActive: true, activeTab: tabActed, tabs: [tabActed] }];
  onDidChangeTabGroups({ opened: [], closed: [], changed: GROUPS });
  tracker.reportActivation('Conv actée par le panneau', { sessionId: 'sACT' });
  check('acte concordant → souvenir posé, lecture fraîche inchangée',
    tracker.getTabs().activeLabel === 'Conv actée par le panneau'
      && tracker.getTabs().source === 'fresh',
    tracker.getTabs().activeLabel + '/' + tracker.getTabs().source);
  check('… et l\'identité du clic est publiée (actSessionId)',
    tracker.getTabs().actSessionId === 'sACT', String(tracker.getTabs().actSessionId));
  // L'onglet actif change : l'acte ne dit plus rien de la sœur affichée, il se
  // tait (state.js retombe sur ses autres preuves, jamais sur un tirage au sort).
  const tabAfterAct = claude('Conv suivante');
  GROUPS = [{ viewColumn: 1, isActive: true, activeTab: tabAfterAct, tabs: [tabActed, tabAfterAct] }];
  onDidChangeTabGroups({ opened: [], closed: [], changed: GROUPS });
  check('l\'actif a changé → actSessionId retombe à null',
    tracker.getTabs().actSessionId === null && tracker.getTabs().activeLabel === 'Conv suivante',
    tracker.getTabs().actSessionId + '/' + tracker.getTabs().activeLabel);

  console.log('\n8. activeIndex — position de l\'onglet actif (lot 2 du plan d\'appariement, 2026-08-21)');
  // Contrairement au libellé, l'index se lit par IDENTITÉ de l'onglet, pas par
  // texte — c'est ce qui permet à state.js de départager deux onglets au
  // libellé identique. Deux groupes, plusieurs onglets Claude : l'index doit
  // être la position dans la liste APLATIE (groupes puis onglets, dans
  // l'ordre), pas dans le seul groupe actif.
  const twinLabel = 'Deux onglets au même nom';
  const tabX = claude(twinLabel);
  const tabZ = claude(twinLabel);
  const otherFile = other('notes.md');
  GROUPS = [
    { viewColumn: 1, isActive: false, activeTab: null, tabs: [otherFile, tabX] },
    { viewColumn: 2, isActive: true, activeTab: tabZ, tabs: [tabZ] },
  ];
  onDidChangeTabGroups({ opened: [], closed: [], changed: GROUPS });
  check('deux onglets au même libellé, le second (groupe 2) est actif → activeIndex = 1 (aplati : otherFile ignoré, tabX=0, tabZ=1)',
    tracker.getTabs().activeIndex === 1, String(tracker.getTabs().activeIndex));
  check('… le libellé seul, lui, ne peut pas les distinguer',
    tracker.getTabs().activeLabel === twinLabel);

  // Bascule vers le PREMIER des deux (même libellé) : l'index change bien,
  // contrairement à ce qu'un matching par texte donnerait (indiscernable).
  GROUPS = [
    { viewColumn: 1, isActive: true, activeTab: tabX, tabs: [otherFile, tabX] },
    { viewColumn: 2, isActive: false, activeTab: null, tabs: [tabZ] },
  ];
  onDidChangeTabGroups({ opened: [], closed: [], changed: GROUPS });
  check('bascule sur le PREMIER onglet du même libellé → activeIndex = 0',
    tracker.getTabs().activeIndex === 0, String(tracker.getTabs().activeIndex));

  // Repli (onglet fichier actif) : l'index mémorisé suit le même souvenir que
  // le libellé — basculer sur un fichier ne doit éteindre ni l'un ni l'autre.
  GROUPS = [
    { viewColumn: 1, isActive: true, activeTab: otherFile, tabs: [otherFile, tabX] },
    { viewColumn: 2, isActive: false, activeTab: null, tabs: [tabZ] },
  ];
  onDidChangeTabs({ opened: [], closed: [], changed: [otherFile] });
  check('onglet fichier sélectionné → activeIndex reste celui du dernier onglet Claude (repli, comme activeLabel)',
    tracker.getTabs().activeIndex === 0, String(tracker.getTabs().activeIndex));
  check('source déclarée "remembered" (cohérent avec le repli)',
    tracker.getTabs().source === 'remembered', String(tracker.getTabs().source));

  // Acte dont l'API ne confirme pas encore l'activation (ici l'onglet actif est
  // un fichier) : PAS d'index — la position qu'on lirait serait celle de
  // l'onglet PRÉCÉDENT. `null` fait retomber state.js sur le matching par
  // libellé, jamais sur une position fausse.
  tracker.reportActivation('Acte sans position connue');
  check('acte non confirmé par l\'API → activeIndex null (jamais la position d\'un autre onglet)',
    tracker.getTabs().activeIndex === null, String(tracker.getTabs().activeIndex));
  check('… mais le libellé, lui, est bien porté (comportement du lot 1 intact)',
    tracker.getTabs().activeLabel === 'Acte sans position connue');

  console.log('\n9. dispose');
  tracker.dispose();
  check('notre fichier est retiré (nos onglets ne comptent plus ailleurs)',
    !fs.existsSync(tabsMod.OWN_FILE));
  check('après dispose, known:false → plus aucun masquage', tracker.getTabs().known === false);
  check('après dispose, activeLabel null', tracker.getTabs().activeLabel === null);

  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

run();
