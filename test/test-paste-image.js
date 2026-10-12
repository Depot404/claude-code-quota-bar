// Image collée dans une case de prompt (2.127.0) — de bout en bout : un VRAI
// évènement paste portant un fichier image dans le vrai webview → message au
// vrai routeur d'extension.js → fichier écrit par paste-image.js → chemin
// renvoyé et inséré dans le texte, là où était le curseur.
//
//   §1 — module seul : extension, .gitignore, ménage des images anciennes.
//   §2 — collage d'une image : fichier écrit, chemin inséré au curseur.
//   §3 — presse-papier image + texte : reste un collage de TEXTE.
const H = require('./harness-loop.js');   // ← doit rester le PREMIER require
const fs = require('fs');
const os = require('os');
const path = require('path');
const pasteMod = require('../paste-image');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

// Le dossier de travail du harnais est fictif (C:\Users\Test\…) : on redirige
// l'écriture vers un dossier jetable, sans toucher au reste du module. Posé
// avant H.start(), donc avant qu'extension.js ne déstructure l'export.
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-paste-'));
const realSave = pasteMod.savePastedImage;
pasteMod.savePastedImage = (o) => realSave(Object.assign({}, o, { workspaceRoot: WS }));

// PNG 1×1 transparent.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const FIELD = '.task-top textarea.inp';

function pasteJs(withText) {
  return `(() => {
    const ta = document.querySelector(${JSON.stringify(FIELD)});
    ta.focus();
    ta.value = 'avant après';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.setSelectionRange(5, 5);
    const bin = atob(${JSON.stringify(PNG_B64)});
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
    ${withText ? "dt.setData('text/plain', 'du texte');" : ''}
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    ta.dispatchEvent(ev);
    return ev.defaultPrevented;
  })()`;
}

async function main() {
  console.log('1. Module seul');
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-paste-unit-'));
    const dir = pasteMod.imageDir(ws);
    fs.mkdirSync(dir, { recursive: true });
    const old = path.join(dir, 'paste-old.png');
    fs.writeFileSync(old, 'x');
    const t = (Date.now() - pasteMod.RETAIN_MS - 60000) / 1000;
    fs.utimesSync(old, t, t);
    const f = realSave({ workspaceRoot: ws, mime: 'image/jpeg', base64: PNG_B64 });
    check('extension tirée du type', f.endsWith('.jpg'), f);
    check('.gitignore à « * » posé', fs.readFileSync(path.join(dir, '.gitignore'), 'utf8') === '*\n');
    check('image de plus de 7 jours retirée', !fs.existsSync(old));
    let threw = false;
    try { realSave({ workspaceRoot: ws, mime: 'text/plain', base64: PNG_B64 }); } catch { threw = true; }
    check('type non image refusé', threw);
    fs.rmSync(ws, { recursive: true, force: true });
  }

  const h = await H.start();
  if (!h) { console.log('  SKIP  brave.exe introuvable ou Brave Octopus n\'a pas démarré'); return; }
  try {
    await h.settle();

    console.log('\n2. Collage d\'une image');
    const prevented = await h.eval(pasteJs(false));
    // FileReader est asynchrone : on laisse au webview le temps de poster.
    await new Promise((r) => setTimeout(r, 300));
    await h.settle();
    check('le collage par défaut est empêché', prevented === true);
    check('un seul message pasteImage', h.sentOfType('pasteImage').length === 1, JSON.stringify(h.sentOfType('pasteImage').map((m) => m.mime)));
    const reply = h.pushed.filter((m) => m && m.type === 'imageSaved').pop() || {};
    check('l\'extension renvoie un chemin', !!reply.path, JSON.stringify(reply));
    check('fichier écrit sous .claude/pasted-images', !!reply.path && reply.path.startsWith(path.join(WS, '.claude', 'pasted-images')) && fs.existsSync(reply.path));
    check('octets identiques à l\'image collée', !!reply.path && fs.readFileSync(reply.path).equals(Buffer.from(PNG_B64, 'base64')));
    const value = await h.eval(`document.querySelector(${JSON.stringify(FIELD)}).value`);
    check('chemin inséré au curseur, espacé', value === 'avant [image: ' + reply.path + '] après', JSON.stringify(value));

    console.log('\n3. Presse-papier image + texte');
    const before = h.sentOfType('pasteImage').length;
    const prevented2 = await h.eval(pasteJs(true));
    await new Promise((r) => setTimeout(r, 300));
    await h.settle();
    check('collage de texte laissé au navigateur', prevented2 === false);
    check('aucun pasteImage envoyé', h.sentOfType('pasteImage').length === before);
  } finally {
    await h.dispose();
    fs.rmSync(WS, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
