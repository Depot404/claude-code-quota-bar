// Banc de test de focus.js hors VS Code : module `vscode` bouchonné.
// Aucune fenêtre réelle n'est touchée (les libellés testés ne matchent aucune
// fenêtre → raise-window.ps1 répond « not-found »).
const Module = require('module');
const path = require('path');

const EXT = path.join(__dirname, '..');

let COMMANDS = [];
let GROUPS = [];
const stub = {
  window: { get tabGroups() { return { all: GROUPS }; } },
  commands: { executeCommand: async (cmd, arg) => { COMMANDS.push(arg === undefined ? cmd : `${cmd}(${arg})`); } },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'vscode') return stub;
  return origLoad.call(this, req, ...rest);
};

const focus = require(path.join(EXT, 'focus.js'));

const claude = (label) => ({ label, input: { viewType: 'mainThreadWebview-claudeVSCodePanel' } });
const other = (label) => ({ label, input: { viewType: 'default' } });
const group = (viewColumn, tabs, isActive = false) => ({ viewColumn, tabs, isActive });

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

async function run() {
  console.log('\n1. Correspondance des libellés (onglet tronqué à 24 car. + « … »)');
  GROUPS = [group(1, [claude('Refactor auth middlewar…')], true)];
  let m = focus.findTab('Refactor auth middleware for session rotation');
  check('libellé tronqué ↔ titre complet (cas réel 2026-07-15)', !!m, 'aucun match');

  GROUPS = [group(1, [claude('Sort inbox scans')], true)];
  check('libellé court = titre exact', !!focus.findTab('Sort inbox scans'));

  GROUPS = [group(1, [claude('Rework the mail digest')], true)];
  check('titre différent → aucun match', focus.findTab('Investigate memory leak in worker pool') === null);

  GROUPS = [group(1, [claude('Refactor auth middlewar…')], true)];
  check('préfixe tronqué qui ne préfixe PAS le titre → aucun match',
    focus.findTab('Refactor api middleware for session rotation') === null);

  GROUPS = [group(1, [other('Refactor auth middlewar…')], true)];
  check('onglet non-Claude ignoré', focus.findTab('Refactor auth middleware') === null);

  console.log('\n2. Recherche dans TOUS les groupes (régression lot 1 : groupe actif seulement)');
  GROUPS = [
    group(1, [claude('Autre conv'), claude('Encore une')], true),
    group(2, [other('README.md'), claude('Add invoice PDF expor…')], false),
  ];
  m = focus.findTab('Add invoice PDF export button');
  check('onglet trouvé dans un groupe NON actif', !!m && m.index === 1, m ? `index=${m.index}` : 'aucun match');

  COMMANDS = [];
  await focus.focusConversation({ title: 'Add invoice PDF export button', id: 'x' });
  check('focus du 2e groupe puis openEditorAtIndex(1)',
    COMMANDS.join(' + ') === 'workbench.action.focusSecondEditorGroup + workbench.action.openEditorAtIndex(1)',
    COMMANDS.join(' + '));

  console.log('\n3. Ambiguïté : deux groupes, même préfixe → le groupe actif gagne');
  GROUPS = [
    group(1, [claude('Doublon de titre id…')], false),
    group(2, [claude('Doublon de titre id…')], true),
  ];
  m = focus.findTab('Doublon de titre identique partout');
  check('groupe actif retenu', !!m && m.group.viewColumn === 2, m ? `col=${m.group.viewColumn}` : 'aucun match');

  console.log('\n4. Conv fermée (aucun onglet) → requête de relais écrite, aucun no-op silencieux');
  const fs = require('fs');
  try { fs.unlinkSync(focus.REQUEST_PATH); } catch {}
  GROUPS = [group(1, [claude('Rien à voir')], true)];
  COMMANDS = [];
  await focus.focusConversation({ title: 'Conv ouverte dans une autre fenêtre', id: 'sess-42' });
  check('aucune commande VS Code émise', COMMANDS.length === 0, COMMANDS.join(','));
  const req = JSON.parse(fs.readFileSync(focus.REQUEST_PATH, 'utf8'));
  check('requête déposée avec titre/session/pid/ts',
    req.title === 'Conv ouverte dans une autre fenêtre' && req.session_id === 'sess-42'
    && req.origin_pid === process.pid && Date.now() - req.ts < 5000,
    JSON.stringify(req));

  console.log('\n5. Onglet renommé : le titre du store trouve ce que le transcript ne trouve plus');
  GROUPS = [group(1, [claude('Upload Error TF400898:…')], true)];
  check('titre transcript seul → aucun match (le bug d\'origine)',
    focus.findTab('Afficher ? au lieu du loading') === null);
  m = focus.findTab('Afficher ? au lieu du loading', 'Upload Error TF400898: An Internal Error…');
  check('titre d\'onglet réel en second → onglet retrouvé', !!m, 'aucun match');

  COMMANDS = [];
  await focus.focusConversation({
    title: 'Afficher ? au lieu du loading', tabTitle: 'Upload Error TF400898: An Internal Error…', id: 'y',
  });
  check('le clic focus bien l\'onglet renommé',
    COMMANDS.join(' + ') === 'workbench.action.focusFirstEditorGroup + workbench.action.openEditorAtIndex(0)',
    COMMANDS.join(' + '));

  try { fs.unlinkSync(focus.REQUEST_PATH); } catch {}
  GROUPS = [group(1, [claude('Rien à voir')], true)];
  await focus.focusConversation({ title: 'Conv ailleurs', tabTitle: 'Titre d\'onglet réel', id: 'sess-43' });
  const req2 = JSON.parse(fs.readFileSync(focus.REQUEST_PATH, 'utf8'));
  check('le relais transporte AUSSI le titre d\'onglet (sinon la voisine ne trouve rien)',
    req2.tab_title === 'Titre d\'onglet réel', JSON.stringify(req2));
  try { fs.unlinkSync(focus.REQUEST_PATH); } catch {}

  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

run();
