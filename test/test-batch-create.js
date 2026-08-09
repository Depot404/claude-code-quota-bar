// Banc : création groupée de conversations (lot 1 du plan
// PLAN_creation_groupes_2026-07-22.md).
//
// Couvre les quatre choses qui peuvent silencieusement mal tourner :
//   1. les variables d'environnement sont posées AVANT l'appel de commande et
//      RESTAURÉES après — y compris quand la clé n'existait pas (supprimée, pas
//      mise à vide) et y compris quand la commande jette ;
//   2. les lancements sont SÉRIALISÉS (process.env est partagé par tout l'hôte
//      d'extension : deux lancements simultanés se voleraient leurs variables) ;
//   3. `claude-vscode.editor.open` absent/en échec ⇒ repli presse-papier +
//      conversation vide + message, jamais d'exception (décision 7 du plan) ;
//   4. le sessionId de la conversation ouverte est retrouvé par DIFF du registre
//      ~/.claude/sessions — et son absence n'est pas une erreur.
// Plus le noyau métier (batch.js) et la syntaxe du JS embarqué dans le webview,
// que `node --check panel.js` ne voit PAS (c'est une chaîne de caractères).
const path = require('path');
const vm = require('vm');

const EXT = path.join(__dirname, '..');
const {
  normalizeTasks, envForTask, applyEnv, conflictingEnvVars,
  createIntentStore, mismatchOf, ENV_MODEL, ENV_EFFORT,
  resolveDefaultModel, resolveDefaultEffort, appendTasksAfterWave,
} = require(path.join(EXT, 'batch.js'));
const { createBatchLauncher } = require(path.join(EXT, 'launcher.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

// Faux registre de sessions : `spawn()` simule l'apparition d'un fichier
// ~/.claude/sessions/<pid>.json, ce que fait le CLI à l'OUVERTURE de l'onglet
// (vérifié empiriquement 2026-07-22).
function fakeRegistry(initial = []) {
  let entries = initial.slice();
  return {
    list: () => entries.slice(),
    spawn: (sessionId, cwd) => entries.push({ sessionId, cwd, pid: 1000 + entries.length }),
  };
}

async function run() {
  console.log('\n1. Normalisation (batch.js) — plus de découpage bête (dumbSplit retiré, plan zone unique 2026-07-23)');
  const norm = normalizeTasks([
    { prompt: '  a  ', model: 'opus', effort: 'high', wave: 3 },
    { prompt: '', model: 'opus', effort: 'high', wave: 1 },
    { prompt: 'b', model: 'gpt-4', effort: 'insane', wave: 7 },
  ]);
  check('prompt vide jeté', norm.length === 2, JSON.stringify(norm));
  check('valeurs inconnues ramenées au défaut résolu injecté (null par défaut, lot 14)',
    norm[1].model === null && norm[1].effort === null, JSON.stringify(norm[1]));
  check('vagues renumérotées en suite contiguë depuis 1', norm[0].wave === 1 && norm[1].wave === 2, JSON.stringify(norm.map((t) => t.wave)));

  const normResolved = normalizeTasks(
    [{ prompt: 'c', model: 'nope', effort: 'nope', wave: 1 }],
    { model: 'sonnet', effort: 'medium' },
  );
  check('résolu injecté sert bien de repli pour une valeur invalide',
    normResolved[0].model === 'sonnet' && normResolved[0].effort === 'medium', JSON.stringify(normResolved[0]));
  const normResolvedHaiku = normalizeTasks(
    [{ prompt: 'd', model: 'haiku', effort: 'nope', wave: 1 }],
    { model: 'sonnet', effort: 'medium' },
  );
  check('modèle haiku explicite → effort JAMAIS résolu, même avec un défaut résolu par ailleurs',
    normResolvedHaiku[0].effort === null, JSON.stringify(normResolvedHaiku[0]));

  console.log('\n1bis. resolveDefaultModel / resolveDefaultEffort (lot 14)');
  check('modèle hors MODELS ⇒ null, jamais une valeur inventée',
    resolveDefaultModel({ model: 'gpt-4', effort: 'high' }) === null);
  check('resolved absent ⇒ null', resolveDefaultModel(null) === null && resolveDefaultEffort('opus', null) === null);
  check('haiku ⇒ jamais d\'effort résolu, même valide',
    resolveDefaultEffort('haiku', { model: 'haiku', effort: 'high' }) === null);

  console.log('\n1ter. resolveDefaultModel — mapping ID complet → famille (plan sélecteurs 2026-07-24 §1)');
  // Le défaut persisté dans ~/.claude/settings.json est un ID COMPLET
  // (« claude-fable-5[1m] »), pas la famille nue des boutons segmentés
  // (« fable ») : avant le fix, seul le strip du suffixe [1m] était tenté,
  // ce qui ne matchait jamais un ID complet ⇒ aucun bouton allumé.
  const idBench = [
    ['claude-fable-5[1m]', 'fable'],
    ['claude-sonnet-5', 'sonnet'],
    ['claude-opus-4-8', 'opus'],
    ['claude-haiku-4-5-20251001', 'haiku'],
    ['sonnet', 'sonnet'],
    ['opus[1m]', 'opus'],
    ['inconnu-x', null],
  ];
  idBench.forEach(([raw, expected]) => {
    const got = resolveDefaultModel({ model: raw, effort: null });
    check(`"${raw}" → ${expected === null ? 'null' : '"' + expected + '"'}`, got === expected, JSON.stringify(got));
  });

  console.log('\n2. Variables d\'environnement (batch.js)');
  check('modèle inconnu/absent ne pose rien', Object.keys(envForTask({ model: null, effort: null })).length === 0);
  const vars = envForTask({ model: 'opus', effort: 'medium' });
  check('modèle et effort posés sous leurs noms documentés',
    vars[ENV_MODEL] === 'opus' && vars[ENV_EFFORT] === 'medium', JSON.stringify(vars));
  const env = { PATH: 'x', [ENV_MODEL]: 'preexisting' };
  const restore = applyEnv(env, { [ENV_MODEL]: 'haiku', [ENV_EFFORT]: 'low' });
  check('posées pendant', env[ENV_MODEL] === 'haiku' && env[ENV_EFFORT] === 'low', JSON.stringify(env));
  restore();
  check('valeur préexistante restaurée à l\'identique', env[ENV_MODEL] === 'preexisting', JSON.stringify(env));
  check('clé absente avant → SUPPRIMÉE, pas mise à vide', !(ENV_EFFORT in env), JSON.stringify(env));

  console.log('\n2bis. Sélecteurs du lot 7 : effort max, haiku sans effort');
  const maxVars = envForTask({ model: 'opus', effort: 'max' });
  check('effort max accepté et posé', maxVars[ENV_EFFORT] === 'max', JSON.stringify(maxVars));
  const haikuVars = envForTask({ model: 'haiku', effort: 'high' });
  check('haiku ne pose JAMAIS CLAUDE_CODE_EFFORT_LEVEL, même avec un effort demandé',
    !(ENV_EFFORT in haikuVars), JSON.stringify(haikuVars));
  check('haiku pose bien le modèle', haikuVars[ENV_MODEL] === 'haiku', JSON.stringify(haikuVars));
  const haikuNoEffort = envForTask({ model: 'haiku', effort: null });
  check('haiku sans effort du tout → toujours aucune var effort', !(ENV_EFFORT in haikuNoEffort), JSON.stringify(haikuNoEffort));

  console.log('\n3. Conflit avec claudeCode.environmentVariables (garde-fou du plan)');
  check('aucun conflit sur un réglage vide', conflictingEnvVars([]).length === 0);
  check('conflit détecté', conflictingEnvVars([{ name: ENV_MODEL, value: 'sonnet' }, { name: 'FOO', value: '1' }]).join() === ENV_MODEL);
  check('réglage absent/malformé → aucun conflit, jamais d\'exception', conflictingEnvVars(undefined).length === 0);

  console.log('\n4. Écart intention ↔ réel (batch.js)');
  const intents = createIntentStore();
  intents.record('s1', { model: 'opus', effort: 'high' });
  check('pas d\'intention → pas d\'écart', mismatchOf(null, { modelId: 'claude-sonnet-5', effort: 'low' }) === null);
  check('intention respectée → pas d\'écart',
    mismatchOf(intents.get('s1'), { modelId: 'claude-opus-4-8[1m]', effort: 'high' }) === null);
  const mm = mismatchOf(intents.get('s1'), { modelId: 'claude-sonnet-5', effort: 'medium' });
  check('modèle divergent signalé par FAMILLE', mm && mm.model && mm.model.real === 'sonnet', JSON.stringify(mm));
  check('effort divergent signalé', mm && mm.effort && mm.effort.asked === 'high', JSON.stringify(mm));
  check('réel inconnu (transcript pas encore écrit) → pas d\'écart',
    mismatchOf(intents.get('s1'), { modelId: null, effort: null }) === null);
  check('intention null (rien demandé, lot 14) → jamais d\'écart',
    mismatchOf({ model: null, effort: null }, { modelId: 'claude-haiku-4-5', effort: 'low' }) === null);
  const intents2 = createIntentStore();
  intents2.record('s2', { model: 'not-a-model', effort: 'not-an-effort' });
  check('valeur invalide enregistrée ⇒ ramenée à null (jamais un écart inventé)',
    intents2.get('s2').model === null && intents2.get('s2').effort === null, JSON.stringify(intents2.get('s2')));

  console.log('\n5. Lancement : env posé PENDANT l\'appel, restauré APRÈS');
  const reg = fakeRegistry([{ sessionId: 'old', cwd: 'C:\\ws' }]);
  const seen = [];
  const procEnv = {};
  let launcher = createBatchLauncher({
    executeCommand: async (cmd, sessionId, prompt) => {
      // L'environnement doit être posé À CET INSTANT : c'est le spawn du CLI
      // (déclenché par cette commande) qui en recopie une image.
      seen.push({ cmd, prompt, model: procEnv[ENV_MODEL], effort: procEnv[ENV_EFFORT] });
      reg.spawn('new-' + seen.length, 'C:\\ws');
    },
    listCommands: async () => ['claude-vscode.editor.open'],
    env: procEnv,
    listSessions: reg.list,
    workspacePath: 'C:\\ws',
    sleep: () => Promise.resolve(),
  });
  let res = await launcher.launch(normalizeTasks([
    { prompt: 'un', model: 'opus', effort: 'high', wave: 1 },
    { prompt: 'deux', model: null, effort: null, wave: 1 },
  ]));
  check('la commande d\'ouverture est bien celle des NOTES',
    seen[0].cmd === 'claude-vscode.editor.open', seen[0].cmd);
  check('env posé pendant l\'appel de la tâche 1', seen[0].model === 'opus' && seen[0].effort === 'high', JSON.stringify(seen[0]));
  check('tâche sans modèle résolu : AUCUNE variable posée (pas de fuite de la tâche 1)',
    seen[1].model === undefined && seen[1].effort === undefined, JSON.stringify(seen[1]));
  check('environnement rendu propre après le lot',
    !(ENV_MODEL in procEnv) && !(ENV_EFFORT in procEnv), JSON.stringify(procEnv));
  check('sessionId retrouvé par diff du registre', res.launched.map((r) => r.sessionId).join() === 'new-1,new-2', JSON.stringify(res.launched.map((r) => r.sessionId)));
  check('prompts transmis dans l\'ordre', seen.map((s) => s.prompt).join() === 'un,deux');

  console.log('\n6. Sérialisation : jamais deux poses d\'environnement en même temps');
  const overlaps = [];
  let inFlight = 0;
  const reg2 = fakeRegistry();
  launcher = createBatchLauncher({
    executeCommand: async () => {
      inFlight++;
      overlaps.push(inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      reg2.spawn('s' + overlaps.length, 'C:\\ws');
    },
    listCommands: async () => ['claude-vscode.editor.open'],
    env: {},
    listSessions: reg2.list,
    workspacePath: 'C:\\ws',
    sleep: () => Promise.resolve(),
  });
  await Promise.all([
    launcher.launch(normalizeTasks([{ prompt: 'a' }, { prompt: 'b' }])),
    launcher.launch(normalizeTasks([{ prompt: 'c' }])),
  ]);
  check('aucun chevauchement, même entre deux Create concurrents',
    overlaps.every((n) => n === 1) && overlaps.length === 3, JSON.stringify(overlaps));

  console.log('\n7. Session jamais vue (timeout) : pas une erreur, juste pas de sessionId');
  const regMute = fakeRegistry();
  launcher = createBatchLauncher({
    executeCommand: async () => {},           // rien ne se passe : aucun fichier de session
    listCommands: async () => ['claude-vscode.editor.open'],
    env: {},
    listSessions: regMute.list,
    workspacePath: 'C:\\ws',
    waitMs: 30,
    pollMs: 5,
  });
  res = await launcher.launch(normalizeTasks([{ prompt: 'z' }]));
  check('lancement réussi malgré l\'absence de session', res.launched.length === 1 && res.fallbackAt === null);
  check('sessionId null (aucun rattachement deviné)', res.launched[0].sessionId === null);

  console.log('\n8. Session ouverte dans une AUTRE fenêtre pendant notre lancement');
  const reg3 = fakeRegistry();
  launcher = createBatchLauncher({
    executeCommand: async () => { reg3.spawn('other-window', 'C:\\autre-workspace'); },
    listCommands: async () => ['claude-vscode.editor.open'],
    env: {},
    listSessions: reg3.list,
    workspacePath: 'C:\\ws',
    waitMs: 30,
    pollMs: 5,
  });
  res = await launcher.launch(normalizeTasks([{ prompt: 'z' }]));
  check('une session d\'un autre workspace n\'est jamais attribuée à notre lancement',
    res.launched[0].sessionId === null, JSON.stringify(res.launched[0].sessionId));

  console.log('\n9. Repli presse-papier (editor.open absent ou en échec)');
  let clip = null, messages = [], commands = [];
  const procEnv2 = {};
  launcher = createBatchLauncher({
    executeCommand: async (cmd) => { commands.push(cmd); },
    listCommands: async () => [],                    // commande ABSENTE
    env: procEnv2,
    listSessions: () => [],
    writeClipboard: async (t) => { clip = t; },
    showMessage: (t) => messages.push(t),
    waitMs: 10, pollMs: 5,
  });
  res = await launcher.launch(normalizeTasks([{ prompt: 'à coller', model: 'opus' }, { prompt: 'suivante' }]));
  check('aucune exception ne remonte', !!res);
  check('repli signalé sur la 1re tâche', res.fallbackAt === 0, JSON.stringify(res.fallbackAt));
  check('prompt dans le presse-papier', clip === 'à coller', JSON.stringify(clip));
  check('conversation vide ouverte', commands.includes('claude-vscode.newConversation'), JSON.stringify(commands));
  check('message explicite, avec le compte des tâches non lancées',
    messages.length === 1 && /1 more task/.test(messages[0]), JSON.stringify(messages));
  check('environnement restauré malgré l\'échec', !(ENV_MODEL in procEnv2), JSON.stringify(procEnv2));

  console.log('\n10. Commande présente mais qui JETTE (montée de version cassante)');
  const procEnv3 = {};
  clip = null; messages = [];
  launcher = createBatchLauncher({
    executeCommand: async (cmd) => { if (cmd === 'claude-vscode.editor.open') throw new Error('command failed'); },
    listCommands: async () => ['claude-vscode.editor.open'],
    env: procEnv3,
    listSessions: () => [],
    writeClipboard: async (t) => { clip = t; },
    showMessage: (t) => messages.push(t),
    waitMs: 10, pollMs: 5,
  });
  res = await launcher.launch(normalizeTasks([{ prompt: 'boum', effort: 'low' }]));
  check('repli aussi quand la commande jette', res.fallbackAt === 0 && clip === 'boum', JSON.stringify({ fallbackAt: res.fallbackAt, clip }));
  check('environnement restauré même sur exception', !(ENV_EFFORT in procEnv3), JSON.stringify(procEnv3));

  console.log('\n11. Syntaxe du JS EMBARQUÉ dans le webview (invisible à node --check)');
  const { ClaudePanelProvider } = (function () {
    const Module = require('module');
    const orig = Module._load;
    Module._load = function (req, ...rest) {
      if (req === 'vscode') {
        return {
          window: {}, commands: {},
          l10n: { bundle: {}, t: (message, ...args) => (args.length ? message.replace(/\{(\d+)\}/g, (_, i) => (args[i] !== undefined ? args[i] : '')) : message) },
        };
      }
      return orig.call(this, req, ...rest);
    };
    try { return require(path.join(EXT, 'panel.js')); } finally { Module._load = orig; }
  }());
  let html = null;
  const view = {
    webview: {
      cspSource: 'vscode-resource:',
      options: null,
      set html(v) { html = v; },
      get html() { return html; },
      onDidReceiveMessage() {},
      postMessage() {},
    },
    onDidDispose() {},
  };
  new ClaudePanelProvider({}, {}).resolveWebviewView(view);
  const m = html && html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
  check('script du webview extrait', !!m);
  let syntaxErr = null;
  try { new vm.Script(m[1]); } catch (e) { syntaxErr = e; }
  check('le script du webview compile (échappements du template literal)', !syntaxErr, syntaxErr && syntaxErr.message);
  check('le formulaire de lot est bien câblé dans le HTML',
    /id="batchForm"/.test(html) && /createBatch/.test(html));

  console.log('\n12. computeLastChoiceFromTasks (extension.js) — lot 2, avenant 2026-07-24 : Create mémorise la dernière tâche du batch');
  const { computeLastChoiceFromTasks } = (function () {
    const Module = require('module');
    const orig = Module._load;
    Module._load = function (req, ...rest) {
      if (req === 'vscode') {
        return {
          window: {}, commands: {}, workspace: {}, env: {}, Uri: {},
          l10n: { t: (message, ...args) => (args.length ? message.replace(/\{(\d+)\}/g, (_, i) => (args[i] !== undefined ? args[i] : '')) : message) },
        };
      }
      return orig.call(this, req, ...rest);
    };
    try { return require(path.join(EXT, 'extension.js')); } finally { Module._load = orig; }
  }());
  const c12a = computeLastChoiceFromTasks([
    { model: 'sonnet', effort: 'medium', wave: 1 },
    { model: 'opus', effort: 'high', wave: 1 },
  ]);
  check('bloc collé multi-tâches → dernière tâche du batch (opus·high), pas la première',
    c12a.model === 'opus' && c12a.effort === 'high', JSON.stringify(c12a));

  const c12b = computeLastChoiceFromTasks([
    { model: 'sonnet', effort: 'medium', wave: 1 },
    { model: 'haiku', effort: 'xhigh', wave: 2 },
  ]);
  check('dernière tâche haiku → modèle mémorisé (haiku), effort NON mémorisé (invariant haiku)',
    c12b.model === 'haiku' && c12b.effort === null, JSON.stringify(c12b));

  const c12c = computeLastChoiceFromTasks([{ model: 'fable', effort: 'max', wave: 1 }]);
  check('tâche unique → son propre modèle/effort',
    c12c.model === 'fable' && c12c.effort === 'max', JSON.stringify(c12c));

  console.log('\n13. appendTasksAfterWave (batch.js) — étape 10 : transfert d\'un bloc multi-vagues DANS un groupe existant');
  const block4 = normalizeTasks([
    { prompt: 'un', model: 'sonnet', effort: 'medium', wave: 1 },
    { prompt: 'deux', model: 'sonnet', effort: 'medium', wave: 1 },
    { prompt: 'trois', model: 'opus', effort: 'high', wave: 2 },
    { prompt: 'quatre', model: 'opus', effort: 'high', wave: 3 },
  ]);
  const appended = appendTasksAfterWave(block4, 2);
  check('vagues relatives (1,1,2,3) décalées après la dernière vague du groupe (max=2) → (3,3,4,5)',
    appended.map((t) => t.wave).join() === '3,3,4,5', JSON.stringify(appended.map((t) => t.wave)));
  check('prompts et modèle/effort de section préservés, ordre inchangé',
    appended.map((t) => t.prompt).join() === 'un,deux,trois,quatre'
    && appended[2].model === 'opus' && appended[2].effort === 'high', JSON.stringify(appended));

  check('groupe SANS membre (appendAfter=0) → les vagues du bloc valent telles quelles',
    appendTasksAfterWave(normalizeTasks([{ prompt: 'x', wave: 1 }]), 0)[0].wave === 1);
  check('appendAfter négatif/non-fini → traité comme 0, jamais un décalage négatif',
    appendTasksAfterWave(normalizeTasks([{ prompt: 'x', wave: 1 }]), -3)[0].wave === 1
    && appendTasksAfterWave(normalizeTasks([{ prompt: 'x', wave: 1 }]), NaN)[0].wave === 1);
  check('tasks non-array → tableau vide, jamais une exception', Array.isArray(appendTasksAfterWave(null, 2)) && appendTasksAfterWave(null, 2).length === 0);
  check('vague RELATIVE unique (bloc sans stage:, un seul wave) → une seule vague après le groupe',
    new Set(appendTasksAfterWave(normalizeTasks([{ prompt: 'a' }, { prompt: 'b' }]), 5).map((t) => t.wave)).size === 1
    && appendTasksAfterWave(normalizeTasks([{ prompt: 'a' }, { prompt: 'b' }]), 5)[0].wave === 6);

  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
