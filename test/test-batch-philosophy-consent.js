// Bancs du CONSENTEMENT de la philosophie de lot (lot onboarding 4,
// 2026-08-19) — côté hôte d'extension, mêmes bouchons que
// test-onboarding-banner.js/test-canary.js.
//
// Ce que philosophy-install.js ne peut pas prouver seul (c'est un module Node
// pur, appelé uniquement APRÈS consentement) :
//   1. un refus dans la modale N'ÉCRIT RIEN DU TOUT — ni le fichier de
//      philosophie, ni CLAUDE.md ;
//   2. un accord écrit bien les deux (même chemin que promptBatchPhilosophy
//      utilisé par la commande Palette, le lien du walkthrough et le
//      chaînage optionnel depuis installHooks()) ;
//   3. la modale de consentement est DISTINCTE de celle des hooks — jamais
//      fondue en une seule question (deux showWarningMessage séparés, deux
//      libellés de bouton différents) ;
//   4. le chaînage automatique après installHooks() ne (re)propose JAMAIS
//      plus d'une fois par machine, qu'on ait accepté ou refusé — la
//      commande Palette, elle, reste disponible à la demande, refus ou pas ;
//   5. si le fichier de philosophie est déjà déposé (ex: poste où un ancien
//      refus a été suivi d'un ajout manuel), le chaînage automatique ne
//      propose même pas la modale.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeMemento() {
  const map = new Map();
  return {
    get: (k, d) => (map.has(k) ? map.get(k) : d),
    update: (k, v) => { map.set(k, v); return Promise.resolve(); },
  };
}

// answerScript: tableau de libellés à retourner, un par appel de
// showWarningMessage (dans l'ordre) — pop() du début à chaque appel. Permet
// de distinguer précisément QUELLE modale répond quoi, contrairement au
// bouchon générique "accepte toujours" de test-onboarding-banner.js.
function makeVscodeStub(answerScript) {
  const warnCalls = [];
  const infoCalls = [];
  const setContextCalls = [];
  const commandHandlers = {};
  const state = { provider: null };

  const stub = {
    window: {
      state: { focused: true },
      onDidChangeWindowState: () => ({ dispose() {} }),
      tabGroups: {
        get all() { return []; },
        get activeTabGroup() { return { activeTab: null }; },
        onDidChangeTabs: () => ({ dispose() {} }),
        onDidChangeTabGroups: () => ({ dispose() {} }),
      },
      registerWebviewViewProvider: (_type, p) => { state.provider = p; return { dispose() {} }; },
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      showWarningMessage: async (msg, opts, ...items) => {
        warnCalls.push({ msg, opts, items });
        const answer = answerScript.shift();
        // answer peut être l'INDEX du bouton à "cliquer", ou undefined (Échap).
        return typeof answer === 'number' ? items[answer] : undefined;
      },
      showInformationMessage: async (msg, ...items) => { infoCalls.push({ msg, items }); return undefined; },
      showErrorMessage: async (msg) => { infoCalls.push({ msg, error: true }); return undefined; },
      withProgress: async (_opts, task) => task(),
    },
    ProgressLocation: { Notification: 1 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: 'C:\\Users\\Test\\Projets VSCODE\\DemoBatchPhilosophy' } }],
      getConfiguration: () => ({ get: (_k, d) => d }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    commands: {
      registerCommand: (id, fn) => { commandHandlers[id] = fn; return { dispose() {} }; },
      executeCommand: async (cmd, ...args) => { if (cmd === 'setContext') setContextCalls.push(args); },
    },
    env: { openExternal: async () => {} },
    Uri: { parse: (s) => s },
    l10n: { t: (message, ...args) => (args.length ? message.replace(/\{(\d+)\}/g, (_, i) => (args[i] !== undefined ? args[i] : '')) : message) },
  };
  return { stub, warnCalls, infoCalls, setContextCalls, commandHandlers, state };
}

function installFixture(answerScript) {
  const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-batch-philosophy-'));
  os.homedir = () => SANDBOX;
  fs.mkdirSync(path.join(SANDBOX, '.claude'), { recursive: true });

  const netStub = { get: () => { throw new Error('network disabled in test'); } };
  const procStub = { spawn: () => { throw new Error('spawn disabled in test'); }, execSync: () => { throw new Error('execSync disabled in test'); } };
  const { stub, warnCalls, infoCalls, setContextCalls, commandHandlers, state } = makeVscodeStub(answerScript);

  const origLoad = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'vscode') return stub;
    if (req === 'http' || req === 'https') return netStub;
    if (req === 'child_process') return procStub;
    return origLoad.call(this, req, ...rest);
  };

  // Plusieurs "activations" tournent dans CE MÊME process Node (une par
  // scénario, chacune sa propre SANDBOX) — extension.js require une poignée
  // d'autres modules du repo qui calculent des chemins ~/.claude/... au
  // top-level (state.js CLAUDE_DIR, tabs.js TABS_DIR, batch.js SETTINGS_PATH,
  // etc.), figés au moment du PREMIER require. Sans purger LEUR cache aussi,
  // la 2e sandbox hériterait des chemins de la 1re. On vide donc tout le
  // cache require des modules du repo (jamais node_modules/), pas seulement
  // extension.js — équivalent d'un nouveau process pour ces constantes.
  const extResolved = path.resolve(EXT) + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(extResolved) && !key.includes(`${path.sep}node_modules${path.sep}`)) {
      delete require.cache[key];
    }
  }
  const ext = require(path.join(EXT, 'extension.js'));
  Module._load = origLoad;

  const context = {
    subscriptions: [],
    extensionPath: EXT,
    workspaceState: makeMemento(),
    globalState: makeMemento(),
  };
  ext.activate(context);

  return { SANDBOX, ext, context, commandHandlers, warnCalls, infoCalls, setContextCalls };
}

function teardown(fx) {
  for (const s of fx.context.subscriptions) { try { s.dispose(); } catch {} }
  fx.ext.deactivate();
  try { fs.rmSync(fx.SANDBOX, { recursive: true, force: true }); } catch {}
}

function philosophyFileOf(sandbox) { return path.join(sandbox, '.claude', 'claude-convs-batching.md'); }
function claudeMdOf(sandbox) { return path.join(sandbox, '.claude', 'CLAUDE.md'); }

async function run() {
  console.log('\n1. Commande Palette, REFUS dans la modale — rien n\'est écrit du tout');
  {
    const fx = installFixture([undefined]); // showWarningMessage → Échap/Cancel
    await sleep(80);
    await fx.commandHandlers['claude-code-quota-bar.installBatchPhilosophy']();
    check('la modale de consentement a bien été montrée', fx.warnCalls.length === 1);
    check('le fichier de philosophie n\'a PAS été déposé', !fs.existsSync(philosophyFileOf(fx.SANDBOX)));
    check('CLAUDE.md n\'a PAS été créé', !fs.existsSync(claudeMdOf(fx.SANDBOX)));
    check('aucun message de confirmation/erreur affiché (rien ne s\'est passé)', fx.infoCalls.length === 0, JSON.stringify(fx.infoCalls));
    teardown(fx);
  }

  console.log('\n2. Commande Palette, ACCORD dans la modale — les deux sont écrits');
  {
    const fx = installFixture([0]); // showWarningMessage → premier item ("Add it")
    await sleep(80);
    await fx.commandHandlers['claude-code-quota-bar.installBatchPhilosophy']();
    check('le fichier de philosophie a été déposé, identique à la source',
      fs.existsSync(philosophyFileOf(fx.SANDBOX))
      && fs.readFileSync(philosophyFileOf(fx.SANDBOX), 'utf8') === fs.readFileSync(path.join(EXT, 'philosophy', 'claude-convs-batching.md'), 'utf8'));
    check('CLAUDE.md contient la ligne d\'import', fs.existsSync(claudeMdOf(fx.SANDBOX))
      && fs.readFileSync(claudeMdOf(fx.SANDBOX), 'utf8').includes('@claude-convs-batching.md'));
    check('un message de confirmation a été affiché', fx.infoCalls.some((c) => !c.error));
    teardown(fx);
  }

  console.log('\n3. Le texte montré AVANT accord porte le contenu réel du fichier (jamais une signature à l\'aveugle)');
  {
    const fx = installFixture([undefined]);
    await sleep(80);
    await fx.commandHandlers['claude-code-quota-bar.installBatchPhilosophy']();
    const call = fx.warnCalls[0];
    const philosophySource = fs.readFileSync(path.join(EXT, 'philosophy', 'claude-convs-batching.md'), 'utf8').trim();
    check('la modale est bien MODALE (options.modal===true)', call.opts && call.opts.modal === true);
    check('le detail de la modale est EXACTEMENT le contenu du fichier déposé', call.opts && call.opts.detail === philosophySource);
    check('le message nomme le caractère optionnel', /optional/i.test(call.msg));
    check('le message nomme le caractère conseillé', /recommend/i.test(call.msg));
    check('le message montre la ligne d\'import qui sera ajoutée', call.msg.includes('@claude-convs-batching.md'));
    teardown(fx);
  }

  console.log('\n4. Modale des hooks vs modale de la philosophie — DEUX questions séparées, jamais fondues');
  {
    // Répond "Install hooks" à la 1re modale (hooks), refuse la 2e (philosophie).
    const fx = installFixture([0, undefined]);
    await sleep(80);
    await fx.commandHandlers['claude-code-quota-bar.installHooks']();
    check('exactement DEUX modales distinctes ont été montrées (hooks, puis philosophie)', fx.warnCalls.length === 2, String(fx.warnCalls.length));
    check('la 1re modale parle des hooks (statusLine/settings.json)', /settings\.json|statusLine/i.test(fx.warnCalls[0].msg));
    check('la 2e modale parle de la philosophie de lot (CLAUDE.md personnel), texte DIFFÉRENT de la 1re',
      /CLAUDE\.md/.test(fx.warnCalls[1].msg) && fx.warnCalls[1].msg !== fx.warnCalls[0].msg);
    check('les hooks ont bien été installés malgré le refus de la philosophie',
      fs.existsSync(path.join(fx.SANDBOX, '.claude', 'scripts', 'hook-session-state.js')));
    check('la philosophie, elle, n\'a rien écrit (refusée)', !fs.existsSync(philosophyFileOf(fx.SANDBOX)));
    teardown(fx);
  }

  console.log('\n5. Chaînage auto depuis installHooks() — ne propose plus après une première réponse (accepté ou refusé)');
  {
    const fx = installFixture([0, undefined]); // hooks: accepté ; philosophie: refusée
    await sleep(80);
    await fx.commandHandlers['claude-code-quota-bar.installHooks']();
    check('2 modales à la 1re installation (hooks + offre philosophie)', fx.warnCalls.length === 2);

    // Ré-installer les hooks (repair) — le globalState a mémorisé le refus,
    // la commande Palette n'a jamais été invoquée séparément : PAS de 3e
    // modale, même si le fichier de philosophie est toujours absent.
    fx.warnCalls.length = 0;
    fx.commandHandlers['claude-code-quota-bar.installHooks']; // no-op, juste pour lisibilité
    await fx.commandHandlers['claude-code-quota-bar.installHooks']();
    check('une SEULE modale (hooks) au second installHooks() — pas de re-proposition auto', fx.warnCalls.length === 1, String(fx.warnCalls.length));
    check('toujours rien écrit pour la philosophie (refus respecté)', !fs.existsSync(philosophyFileOf(fx.SANDBOX)));

    // La commande Palette dédiée, elle, reste disponible malgré le refus mémorisé.
    fx.warnCalls.length = 0;
    await fx.commandHandlers['claude-code-quota-bar.installBatchPhilosophy']();
    check('la commande Palette dédiée montre quand même sa modale malgré un refus antérieur', fx.warnCalls.length === 1);
    teardown(fx);
  }

  console.log('\n6. Fichier déjà déposé (install manuelle antérieure) — le chaînage auto ne propose même pas la modale');
  {
    const fx = installFixture([0]); // 1 seule réponse dispo : ne doit servir qu'aux hooks
    fs.mkdirSync(path.join(fx.SANDBOX, '.claude'), { recursive: true });
    fs.writeFileSync(philosophyFileOf(fx.SANDBOX), '# already there\n', 'utf8');
    await sleep(80);
    await fx.commandHandlers['claude-code-quota-bar.installHooks']();
    check('une SEULE modale (hooks) — aucune offre, le marqueur existe déjà', fx.warnCalls.length === 1, String(fx.warnCalls.length));
    teardown(fx);
  }

  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

run();
