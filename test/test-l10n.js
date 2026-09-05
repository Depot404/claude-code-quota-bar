// Banc : localisation en+fr (lot 15 du plan
// PLAN_creation_groupes_2026-07-22.md).
//
// Deux choses à couvrir, sans navigateur :
//  1) côté hôte d'extension (Node) — renderHtml() (panel.js) injecte bien le
//     bundle actif (vscode.l10n.bundle) tel quel dans le webview, jamais mis
//     en cache : c'est ce que window.l10nBundle lit côté webview ;
//  2) côté webview — t(message, ...args) : lookup dans le bundle injecté,
//     repli sur le texte source (anglais) si la clé est absente ou si aucun
//     bundle n'est chargé, substitution des placeholders {0}/{1}… Le code
//     RÉEL est extrait du HTML compilé (même geste que
//     test-batch-create.js §11 pour la syntaxe) et exécuté avec `new
//     Function`, pas une réimplémentation miroir : ce qui tourne ici est
//     l'algorithme réellement livré.
//
// Complète : les bundles bundle.l10n.json (source) / bundle.l10n.fr.json
// (traductions) ont les mêmes clés et les mêmes placeholders {n} — sinon un
// texte partirait sans ses arguments en français.
const Module = require('module');
const fs = require('fs');
const path = require('path');

const EXT = path.join(__dirname, '..');

function loadPanel(bundle) {
  const origLoad = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'vscode') {
      return {
        window: {}, commands: {}, Uri: { parse: (s) => s },
        l10n: { bundle, t: (message, ...args) => (args.length ? message.replace(/\{(\d+)\}/g, (_, i) => (args[i] !== undefined ? args[i] : '')) : message) },
      };
    }
    return origLoad.call(this, req, ...rest);
  };
  try {
    delete require.cache[require.resolve(path.join(EXT, 'panel.js'))];
    return require(path.join(EXT, 'panel.js'));
  } finally {
    Module._load = origLoad;
  }
}

function renderedHtml(bundle) {
  const { ClaudePanelProvider } = loadPanel(bundle);
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
  return html;
}

// Extrait le corps réel de t() (et son bundle) du script compilé — pas une
// réimplémentation : c'est le code qui part dans le .vsix.
function extractT(html) {
  const m = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
  if (!m) return null;
  const src = m[1];
  const bm = src.match(/const L10N_BUNDLE = (\{[\s\S]*?\});/);
  const fm = src.match(/function t\(message\) \{[\s\S]*?\n  \}/);
  if (!bm || !fm) return null;
  return { bundleLiteral: bm[1], fnSrc: fm[0] };
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

console.log('\n1. renderHtml() injecte le bundle actif tel quel (jamais mis en cache)');
const testBundle = { 'Cancel': 'Annuler', 'Create {0}': 'Créer {0}' };
const html1 = renderedHtml(testBundle);
const extracted1 = extractT(html1);
check('bundle extrait', !!extracted1, 'script/bundle introuvables dans le HTML compilé');
check('contenu du bundle fidèle à vscode.l10n.bundle',
  extracted1 && JSON.parse(extracted1.bundleLiteral).Cancel === 'Annuler'
    && JSON.parse(extracted1.bundleLiteral)['Create {0}'] === 'Créer {0}');

console.log('\n2. Anglais (aucun bundle chargé, vscode.l10n.bundle undefined) → repli sur la source');
const html2 = renderedHtml(undefined);
const extracted2 = extractT(html2);
check('bundle vide en anglais', extracted2 && extracted2.bundleLiteral === '{}', extracted2 && extracted2.bundleLiteral);

console.log('\n3. t() réel, exécuté via new Function — lookup + placeholders + repli');
function runT(fnSrc, bundleLiteral, message, ...args) {
  const factory = new Function('L10N_BUNDLE', `${fnSrc}\nreturn t.apply(null, arguments[1]);`);
  return factory(JSON.parse(bundleLiteral), [message, ...args]);
}
check('clé présente, sans placeholder → traduction',
  runT(extracted1.fnSrc, extracted1.bundleLiteral, 'Cancel') === 'Annuler');
check('clé présente, avec placeholder → traduction + substitution',
  runT(extracted1.fnSrc, extracted1.bundleLiteral, 'Create {0}', 3) === 'Créer 3');
check('clé absente du bundle → repli sur le texte source (anglais), placeholders quand même substitués',
  runT(extracted1.fnSrc, extracted1.bundleLiteral, 'Untitled') === 'Untitled'
  && runT(extracted1.fnSrc, extracted1.bundleLiteral, 'Opening {0} conversation(s)…', 2)
     === 'Opening 2 conversation(s)…'
  // Deux placeholders tous fournis (la chaîne du bandeau n'en a plus qu'un
  // depuis 2026-08-15) — la ligne suivante, elle, couvre l'argument manquant.
  && runT(extracted1.fnSrc, extracted1.bundleLiteral, 'Wave {0}: could not open — {1}.', 2, 'boom')
     === 'Wave 2: could not open — boom.');
check('bundle vide (anglais) → toujours la source, placeholders inchangés',
  runT(extracted2.fnSrc, extracted2.bundleLiteral, 'Create {0}', 5) === 'Create 5');
check('argument manquant pour un placeholder → substitué par une chaîne vide, jamais "undefined" littéral',
  runT(extracted1.fnSrc, extracted1.bundleLiteral, 'Wave {0}: could not open — {1}.', 2) === 'Wave 2: could not open — .');

console.log('\n4. Les deux bundles livrés (source + fr) sont complets et cohérents');
const en = require(path.join(EXT, 'l10n', 'bundle.l10n.json'));
const fr = require(path.join(EXT, 'l10n', 'bundle.l10n.fr.json'));
const enKeys = Object.keys(en);
const frKeys = Object.keys(fr);
check('même jeu de clés dans les deux bundles',
  enKeys.length === frKeys.length && enKeys.every((k) => Object.prototype.hasOwnProperty.call(fr, k)),
  `en=${enKeys.length} fr=${frKeys.length}`);
let placeholderMismatch = 0;
for (const k of enKeys) {
  const a = (k.match(/\{\d+\}/g) || []).sort().join(',');
  const b = ((fr[k] || '').match(/\{\d+\}/g) || []).sort().join(',');
  if (a !== b) placeholderMismatch++;
}
check('mêmes placeholders {n} entre la clé source et sa traduction, pour toutes les entrées', placeholderMismatch === 0, `${placeholderMismatch} désaccord(s)`);
check('bundle source = clé identique à la valeur (c\'est le texte tel qu\'écrit dans le code)',
  enKeys.every((k) => en[k] === k));
check('aucune entrée fr vide (traduction oubliée)', frKeys.every((k) => fr[k] && fr[k].trim()));

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
