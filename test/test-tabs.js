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
process.env.QUOTABAR_FREEZE_DETECT_MS = '150';     // AVANT le require de tabs.js

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

  // Bascule d'onglet DANS le groupe : onDidChangeTabs `changed`.
  const tabB = claude('Conv B sélectionnée');
  GROUPS = [{ viewColumn: 1, isActive: true, activeTab: tabB, tabs: [tabA, tabB] }];
  onDidChangeTabs({ opened: [], closed: [], changed: [tabB] });
  check('bascule dans le groupe (onDidChangeTabs) → activeLabel mis à jour',
    tracker.getTabs().activeLabel === 'Conv B sélectionnée', String(tracker.getTabs().activeLabel));

  // Sélection d'un onglet NON-Claude : le dernier onglet Claude reste mémorisé
  // (basculer sur un fichier ne doit pas éteindre le surlignage).
  const tabFile = other('README.md');
  GROUPS = [{ viewColumn: 1, isActive: true, activeTab: tabFile, tabs: [tabA, tabB, tabFile] }];
  onDidChangeTabs({ opened: [], closed: [], changed: [tabFile] });
  check('onglet fichier sélectionné → le dernier onglet Claude reste mémorisé',
    tracker.getTabs().activeLabel === 'Conv B sélectionnée', String(tracker.getTabs().activeLabel));

  // Cœur du correctif 2026-08-15. L'onglet actif change sans qu'AUCUN événement
  // ne tire : getTabs() doit dire la vérité quand même. Un souvenir alimenté par
  // les seuls événements suppose que ceux-ci couvrent tous les chemins
  // d'activation ; dès qu'un chemin échappe, le surlignage se fige sur une conv
  // quittée — et le clic sur la bonne ligne ne le répare PAS, puisque son onglet
  // est déjà actif, donc il n'y a rien à rattraper.
  GROUPS = [{ viewColumn: 1, isActive: true, activeTab: tabA, tabs: [tabA, tabB, tabFile] }];
  check('onglet actif changé SANS aucun événement → getTabs() le voit (auto-réparation)',
    tracker.getTabs().activeLabel === 'Conv A sélectionnée', String(tracker.getTabs().activeLabel));

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

  console.log('\n7. Acte vs API — la preuve la plus fraîche gagne (2026-08-17)');
  // Retour de focus d'abord : ce paragraphe teste l'ORDRE acte/événement, pas
  // la parade anti-fantôme (§8quater) — ses événements doivent donc arriver
  // fenêtre focusée, comme dans l'incident d'origine (clic panneau, fenêtre
  // au premier plan). Hors focus, un événement divergent serait retenu en
  // quarantaine, et c'est le §8quater qui prouve CE comportement-là.
  onDidChangeWindowState({ focused: true });
  // L'API dit encore « Conv A » (rien n'a bougé côté vscode.window.tabGroups) :
  // c'est exactement la signature d'une activation qu'on vient de commander
  // (focusTab() a réussi) mais dont l'événement n'est pas encore arrivé — ou
  // n'arrivera jamais, fenêtre gelée.
  tracker.reportActivation('Conv X activée par acte');
  check('acte rapporté, divergent de l\'API, AUCUN événement encore reçu → il prime tout de suite',
    tracker.getTabs().activeLabel === 'Conv X activée par acte', String(tracker.getTabs().activeLabel));

  // Un événement d'onglet POSTÉRIEUR arrive — et dit autre chose que l'acte
  // (cas volontairement retors : prouve que ce n'est pas l'acte qui reste
  // collé, c'est bien la DATE qui arbitre).
  const tabY = claude('Conv Y — après l\'événement');
  GROUPS = [{ viewColumn: 1, isActive: true, activeTab: tabY, tabs: [tabY] }];
  onDidChangeTabGroups({ opened: [], closed: [], changed: GROUPS });
  check('événement postérieur à l\'acte, même divergent de lui → l\'API reprend la main',
    tracker.getTabs().activeLabel === 'Conv Y — après l\'événement', String(tracker.getTabs().activeLabel));

  console.log('\n8. Détecteur de gel (2026-08-17, QUOTABAR_FREEZE_DETECT_MS=150 pour ce banc)');
  check('état initial : pas gelé', tracker.getTabs().frozen === false);
  let changesBeforeGel = changes;
  // L'API reste sur « Conv Y » (posée au §7) : cette activation-ci diverge et
  // ne sera JAMAIS confirmée par un événement dans ce test.
  tracker.reportActivation('Conv gelée — jamais confirmée');
  check('juste après l\'acte divergent : pas encore gelé (le délai n\'est pas écoulé)',
    tracker.getTabs().frozen === false);
  await sleep(250);   // > QUOTABAR_FREEZE_DETECT_MS (150 ms)
  check('silence total après le délai → frozen:true', tracker.getTabs().frozen === true);
  check('le gel se publie via onChange (le panneau doit pousser le bandeau)', changes > changesBeforeGel);

  changesBefore = changes;
  const tabA2 = claude('Conv A — canal réveillé');
  GROUPS = [{ viewColumn: 1, isActive: true, activeTab: tabA2, tabs: [tabA2] }];
  onDidChangeTabGroups({ opened: [], closed: [], changed: GROUPS });
  check('un événement d\'onglet reçu → frozen:false (le canal a reparlé)',
    tracker.getTabs().frozen === false);
  check('la levée du gel pousse aussi (bandeau retiré)', changes > changesBefore);

  console.log('\n8bis. Fraîcheur au retour d\'alt-tab (lot 1 du plan appariement, 2026-08-21)');
  // Le symptôme : « ces bugs arrivent très fréquemment après une bascule alt+tab ».
  // Le recompute au retour de focus existe depuis le 2026-08-15 (§6 ci-dessus) —
  // ce qui restait faux, c'est ce que getTabs() RÉPONDAIT à cet instant, parce
  // qu'un `actReport` que rien ne pouvait supplanter écrasait la lecture fraîche.

  // (a) Activation d'un onglet DÉJÀ actif : c'est le chemin qui fabriquait
  // l'acte éternel — aucun événement d'onglet ne peut jamais suivre (cf. le
  // commentaire de `focusConv`, extension.js). Aucun acte ne doit être posé.
  const tabP = claude('Conv P déjà active');
  GROUPS = [{ viewColumn: 1, isActive: true, activeTab: tabP, tabs: [tabP] }];
  onDidChangeTabGroups({ opened: [], closed: [], changed: GROUPS });
  tracker.reportActivation('Conv P déjà active');          // == localActiveLabel()
  check('acte sur un onglet DÉJÀ actif → aucun gel armé (rien à confirmer)',
    tracker.getTabs().frozen === false);
  check('acte sur un onglet DÉJÀ actif → la lecture fraîche reste la source',
    tracker.getTabs().source === 'fresh', String(tracker.getTabs().source));

  // L'onglet actif change ensuite SANS qu'aucun événement ne tire (le chemin du
  // §6, celui qu'aucune API ne garantit exhaustif). Avant le lot 1, l'acte posé
  // ci-dessus gagnait ici et pour toujours.
  const tabQ = claude('Conv Q — sans événement');
  GROUPS = [{ viewColumn: 1, isActive: true, activeTab: tabQ, tabs: [tabP, tabQ] }];
  changesBefore = changes;
  onDidChangeWindowState({ focused: false });
  onDidChangeWindowState({ focused: true });               // alt-tab : retour dans la fenêtre
  check('retour d\'alt-tab après un acte non divergent → lecture fraîche, pas l\'acte',
    tracker.getTabs().activeLabel === 'Conv Q — sans événement', String(tracker.getTabs().activeLabel));
  check('… et le panneau est bien redemandé au retour de focus', changes > changesBefore);
  check('windowFocused/sinceFocusMs publiés pour le journal du lot 0',
    tracker.getTabs().windowFocused === true && tracker.getTabs().sinceFocusMs >= 0,
    JSON.stringify([tracker.getTabs().windowFocused, tracker.getTabs().sinceFocusMs]));

  // (b) La contrainte à NE PAS casser (incident 2026-08-17) : sur une fenêtre
  // dont le canal est mort, l'acte reste roi — la lecture fraîche relit le gel.
  tracker.reportActivation('Conv R — fenêtre gelée');       // diverge de tabQ
  await sleep(250);                                        // > FREEZE_DETECT_MS
  check('fenêtre gelée : le gel est bien détecté', tracker.getTabs().frozen === true);
  const tabS = claude('Conv S — copie miroir gelée');
  GROUPS = [{ viewColumn: 1, isActive: true, activeTab: tabS, tabs: [tabQ, tabS] }];  // l'API ment
  onDidChangeWindowState({ focused: false });
  onDidChangeWindowState({ focused: true });               // même alt-tab qu'en (a)
  check('retour d\'alt-tab sur fenêtre GELÉE → l\'acte reste la seule vérité',
    tracker.getTabs().activeLabel === 'Conv R — fenêtre gelée', String(tracker.getTabs().activeLabel));
  check('… et il se déclare comme tel au journal (source: act-report)',
    tracker.getTabs().source === 'act-report', String(tracker.getTabs().source));

  // Le canal reparle : l'acte cède, comme au §8.
  onDidChangeTabGroups({ opened: [], closed: [], changed: GROUPS });
  check('canal réveillé après le gel → la lecture fraîche reprend la main',
    tracker.getTabs().activeLabel === 'Conv S — copie miroir gelée' && tracker.getTabs().source === 'fresh',
    String(tracker.getTabs().activeLabel) + '/' + String(tracker.getTabs().source));

  console.log('\n8ter. activeIndex — position de l\'onglet actif (lot 2 du plan d\'appariement, 2026-08-21)');
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

  // Acte mémorisé (fenêtre gelée, §8 plus haut) : PAS d'index — reportActivation
  // ne connaît que le libellé, et le calculer ici relirait la même copie
  // miroir gelée sans valeur ajoutée. state.js retombe alors sur le matching
  // par libellé d'avant ce lot (comportement inchangé sur ce chemin rare).
  tracker.reportActivation('Acte sans position connue');
  check('acte mémorisé → activeIndex null (pas de position fiable sur canal gelé)',
    tracker.getTabs().activeIndex === null, String(tracker.getTabs().activeIndex));
  check('… mais le libellé, lui, est bien porté (comportement du lot 1 intact)',
    tracker.getTabs().activeLabel === 'Acte sans position connue');

  console.log('\n8quater. Activation fantôme — une bascule hors focus n\'est jamais un choix (2026-08-23)');
  // L'incident prouvé au journal : une conversation FINIT de répondre pendant
  // que la fenêtre n'a pas le focus, et l'onglet actif de la copie miroir
  // devient LE SIEN (0,4 s après la fin, « Nahimic Companion », 00:05:21) —
  // l'écran, lui, affiche toujours l'onglet que l'utilisateur avait quitté.
  // Sans parade, le panneau surligne la conv terminée et l'utilisateur
  // revient d'alt-tab sur un surlignage faux — 3e signalement du symptôme.

  // Point de départ propre : un onglet M choisi SOUS focus, par événement.
  const tabM = claude('Conv M — choisie avant de partir');
  const tabF = claude('Conv F — finit en arrière-plan');
  GROUPS = [{ viewColumn: 1, isActive: true, activeTab: tabM, tabs: [tabM, tabF] }];
  onDidChangeTabGroups({ opened: [], closed: [], changed: GROUPS });
  check('départ : M choisie sous focus, lecture fraîche',
    tracker.getTabs().activeLabel === 'Conv M — choisie avant de partir'
      && tracker.getTabs().source === 'fresh',
    tracker.getTabs().activeLabel + '/' + tracker.getTabs().source);

  // L'utilisateur part (alt-tab). La conv F finit : la copie miroir bascule
  // sur son onglet, un événement d'onglet arrive — HORS focus.
  onDidChangeWindowState({ focused: false });
  GROUPS = [{ viewColumn: 1, isActive: true, activeTab: tabF, tabs: [tabM, tabF] }];
  onDidChangeTabs({ opened: [], closed: [], changed: [tabF] });
  check('bascule hors focus → le choix de l\'utilisateur est tenu (M, pas le fantôme)',
    tracker.getTabs().activeLabel === 'Conv M — choisie avant de partir',
    String(tracker.getTabs().activeLabel));
  check('… et se déclare en quarantaine au journal (source: held)',
    tracker.getTabs().source === 'held', String(tracker.getTabs().source));

  // Retour d'alt-tab SANS aucun clic : l'écran montre toujours M — le
  // surlignage doit rester sur M. C'est l'instant exact du signalement.
  onDidChangeWindowState({ focused: true });
  check('retour d\'alt-tab, aucun geste → toujours M, jamais le fantôme',
    tracker.getTabs().activeLabel === 'Conv M — choisie avant de partir',
    String(tracker.getTabs().activeLabel));

  // Premier geste réel : un clic d'onglet produit un événement SOUS focus —
  // la confiance revient, l'API reprend la main.
  onDidChangeTabs({ opened: [], closed: [], changed: [tabF] });
  check('événement sous focus → l\'API reprend la main',
    tracker.getTabs().activeLabel === 'Conv F — finit en arrière-plan'
      && tracker.getTabs().source === 'fresh',
    tracker.getTabs().activeLabel + '/' + tracker.getTabs().source);

  // Renommage HORS focus de l'onglet déjà actif (prompt → ai-title) : même
  // position, libellé neuf — pas une bascule, le souvenir doit suivre, sinon
  // il ne matcherait plus aucun titre au retour.
  onDidChangeWindowState({ focused: false });
  tabF.label = 'Conv F — renommée en absence';
  onDidChangeTabs({ opened: [], closed: [], changed: [tabF] });
  check('rename in-place hors focus → suivi (le souvenir ne meurt pas sur un titre neuf)',
    tracker.getTabs().activeLabel === 'Conv F — renommée en absence',
    String(tracker.getTabs().activeLabel));

  // Fantôme APRÈS le rename, dans la MÊME absence : la concordance du rename
  // n'a pas rendu la confiance — la bascule reste retenue.
  GROUPS = [{ viewColumn: 1, isActive: true, activeTab: tabM, tabs: [tabM, tabF] }];
  onDidChangeTabs({ opened: [], closed: [], changed: [tabM] });
  check('fantôme après un rename dans la même absence → encore retenu',
    tracker.getTabs().activeLabel === 'Conv F — renommée en absence'
      && tracker.getTabs().source === 'held',
    tracker.getTabs().activeLabel + '/' + tracker.getTabs().source);

  // Alt-tab ordinaire : au retour, l'utilisateur clique un onglet — tout
  // rentre dans l'ordre, aucun held parasite en usage normal.
  onDidChangeWindowState({ focused: true });
  onDidChangeTabGroups({ opened: [], closed: [], changed: GROUPS });
  check('geste au retour → concordance retrouvée, source fresh',
    tracker.getTabs().activeLabel === 'Conv M — choisie avant de partir'
      && tracker.getTabs().source === 'fresh',
    tracker.getTabs().activeLabel + '/' + tracker.getTabs().source);

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
