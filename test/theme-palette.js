// Palette RÉELLE des thèmes par défaut de VS Code (Light Modern / Dark
// Modern), telle que l'hôte l'injecte dans un webview.
//
// Pourquoi ce module existe : une planche ou un banc qui saisit ses couleurs
// de thème à la main est un banc qui fabrique ses données — il ne peut rien
// révéler. Un lot de 2026-08-26 a supposé list.activeSelectionBackground
// « bleu » en thème clair ; Light Modern le met à #E8E8E8, un gris. Le
// surlignage « refait » est donc sorti identique à l'ancien sur l'écran de
// l'utilisateur, deux versions de suite.
//
// Deux sources, dans cet ordre : le JSON du thème, puis les valeurs par défaut
// du cœur (registerColor, lues dans le bundle du workbench) pour tout ce que le
// thème ne surcharge pas.
const fs = require('fs');
const path = require('path');

// Emplacements d'installation possibles ; on retient le premier qui porte les
// thèmes par défaut. Une build portable ou un dossier inhabituel se déclare
// avec la variable d'environnement VSCODE_APP_ROOT.
function findAppRoots() {
  const roots = [];
  const push = (p) => { if (p) roots.push(p); };
  push(process.env.VSCODE_APP_ROOT);
  const bases = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft VS Code'),
    '/usr/share/code', '/Applications/Visual Studio Code.app/Contents',
  ].filter(Boolean);
  for (const base of bases) {
    push(path.join(base, 'resources', 'app'));
    // Les installs Windows récentes rangent `resources/` sous un dossier de
    // version (deux peuvent coexister pendant une mise à jour) : on prend le
    // plus récent, c'est celui qui tourne.
    let subs = [];
    try {
      subs = fs.readdirSync(base, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => ({ p: path.join(base, e.name, 'resources', 'app'), t: (() => { try { return fs.statSync(path.join(base, e.name)).mtimeMs; } catch { return 0; } })() }))
        .sort((a, b) => b.t - a.t).map((x) => x.p);
    } catch {}
    for (const s of subs) push(s);
  }
  return roots.filter((r) => { try { return fs.existsSync(path.join(r, 'extensions', 'theme-defaults', 'themes', 'dark_modern.json')); } catch { return false; } });
}

// « list-activeSelectionBackground » → « list.activeSelectionBackground ».
function toColorId(cssName) {
  const i = cssName.indexOf('-');
  return i < 0 ? cssName : cssName.slice(0, i) + '.' + cssName.slice(i + 1).replace(/-/g, '');
}

const NON_COLOR = new Set(['font-family', 'font-size', 'editor-font-family', 'font-weight']);

/**
 * @param {string} panelSource contenu de panel.js — sert à ne collecter que les
 *   couleurs dont la feuille de style se sert réellement.
 * @returns {{light: Object, dark: Object}} variables --vscode-* → valeur
 */
function palettes(panelSource) {
  const root = findAppRoots()[0];
  if (!root) throw new Error("installation VS Code introuvable (poser VSCODE_APP_ROOT)");
  const themesDir = path.join(root, 'extensions', 'theme-defaults', 'themes');
  const coreFile = path.join(root, 'out', 'vs', 'workbench', 'workbench.desktop.main.js');
  const core = fs.existsSync(coreFile) ? fs.readFileSync(coreFile, 'utf8') : '';

  const ids = new Set();
  for (const m of panelSource.matchAll(/var\(--vscode-([A-Za-z0-9-]+)/g)) ids.add(m[1]);

  const coreDefault = (id, variant) => {
    const m = core.match(new RegExp('"' + id.replace(/\./g, '\\.') + '",\\{([^}]{0,400})'));
    if (!m) return null;
    const v = m[1].match(new RegExp(variant + ':"(#[0-9a-fA-F]{3,8})"'));
    return v ? v[1] : null;
  };

  const out = {};
  for (const variant of ['light', 'dark']) {
    const colors = JSON.parse(fs.readFileSync(path.join(themesDir, variant + '_modern.json'), 'utf8')).colors || {};
    const pal = {};
    for (const css of ids) {
      if (NON_COLOR.has(css)) continue;
      const v = colors[toColorId(css)] || coreDefault(toColorId(css), variant);
      if (v) pal['--vscode-' + css] = v;
    }
    // charts.* sont des ALIAS dans le cœur (registerColor pointe sur une autre
    // couleur, jamais sur un littéral) : le motif ci-dessus ne les voit pas.
    // charts.red ← errorForeground est confirmé par mesure de pixel sur un
    // panneau réel (#F85149 en Light Modern) ; blue ← textLink, yellow ←
    // editorWarning viennent du source.
    const alias = {
      '--vscode-charts-red': pal['--vscode-errorForeground'],
      '--vscode-charts-blue': pal['--vscode-textLink-foreground'],
      '--vscode-charts-yellow': coreDefault('editorWarning.foreground', variant),
    };
    for (const [k, v] of Object.entries(alias)) if (v && !pal[k]) pal[k] = v;
    out[variant] = pal;
  }
  return out;
}

module.exports = { palettes, findAppRoots };
