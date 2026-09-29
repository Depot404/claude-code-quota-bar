// Banc du micro des cases de prompt (2.126.0), en boucle fermée : vrai webview
// headless → vrai routeur d'extension.js → vrai dictation.js → un VRAI process
// auxiliaire (fake-dictation-helper.js, même protocole que whisper_dictate.py,
// texte connu d'avance) → événements repoussés au webview → DOM final.
//
//   §1 réglage vide : aucun bouton (rien ne change pour qui ne l'a pas réglé) ;
//   §2 réglage posé : un micro par case, sans recharger ;
//   §3 clic = écoute ; le texte s'insère AU CURSEUR, le provisoire est
//      remplacé, le figé reste ; un re-rendu du formulaire pendant l'écoute
//      (+ Add task) ne perd rien ; second clic = transcription puis repos ;
//   §4 appui maintenu : relâcher arrête ;
//   §5 brouillon touché pendant l'écoute : la dictée s'arrête, rien n'est écrasé ;
//   §6 Échap : tout ce que la dictée a écrit disparaît ;
//   §7 échec : message dans le bandeau d'échec existant (#batchNotice), bouton en erreur ;
//   §8 réglage vidé : les boutons disparaissent.
//
// Durée : ~15 s (Brave compris). Les attentes sont des SONDES d'état bornées,
// pas des pauses fixes.
'use strict';
const H = require('./harness-loop.js');   // PREMIER require (cf. son en-tête)
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '\n        ' + detail : '')); }
}

const FAKE = path.join(__dirname, 'fake-dictation-helper.js');
const cmd = (extra) => `"${process.execPath}" "${FAKE}"${extra ? ' ' + extra : ''}`;

async function run() {
  const h = await H.start();
  if (!h) { console.log('  SKIP  brave.exe introuvable ou Brave Octopus n\'a pas démarré'); return; }
  h.allowSpawn(true);

  const val = (i) => h.eval(`document.querySelectorAll('.task-top textarea.inp')[${i}].value`);
  const mic = (i) => h.eval(`(() => { const b = document.querySelectorAll('.mic-btn')[${i}];
    return b ? { rec: b.classList.contains('rec'), busy: b.classList.contains('busy'), err: b.classList.contains('err') } : null; })()`);
  const mouse = (i, type) => h.eval(`document.querySelectorAll('.mic-btn')[${i}].dispatchEvent(new MouseEvent('${type}', { bubbles: true, button: 0 }))`);
  const type = (i, text, caret) => h.eval(`(() => { const n = document.querySelectorAll('.task-top textarea.inp')[${i}];
    n.focus(); n.value = ${JSON.stringify(text)}; n.dispatchEvent(new Event('input', { bubbles: true }));
    n.setSelectionRange(${caret}, ${caret}); return true; })()`);
  async function until(expr, ms = 4000) {
    const t0 = Date.now();
    for (;;) {
      await h.settle({ quietMs: 40, maxMs: 1000 });
      if (await h.eval(expr)) return true;
      if (Date.now() - t0 > ms) return false;
    }
  }
  const valIs = (i, s) => `document.querySelectorAll('.task-top textarea.inp')[${i}].value === ${JSON.stringify(s)}`;

  try {
    await h.settle();

    // §1
    check('§1 réglage vide : aucun micro', (await h.eval(`document.querySelectorAll('.mic-btn').length`)) === 0);

    // §2
    h.setConfig('claudeCodeQuotaBar.dictationCommand', cmd());
    await h.settle();
    await h.click('.form-adders .btn');                    // + Add task
    await h.settle();
    const n = await h.eval(`({ ta: document.querySelectorAll('.task-top textarea.inp').length, mic: document.querySelectorAll('.task-top .mic-btn').length })`);
    check('§2 réglage posé : un micro par case', n.ta === 2 && n.mic === 2, JSON.stringify(n));

    // §3
    await type(0, 'avant après', 6);
    await mouse(0, 'mousedown');
    await mouse(0, 'mouseup');                             // tap (< 400 ms)
    check('§3 clic : écoute', (await until(`document.querySelectorAll('.mic-btn')[0].classList.contains('rec')`)));
    check('§3 figé inséré au curseur', await until(valIs(0, 'avant un deux. après')), await val(0));
    await h.click('.form-adders .btn');                    // re-rendu pendant l'écoute
    await h.settle();
    check('§3 re-rendu pendant l\'écoute : toujours en écoute', (await mic(0)).rec, JSON.stringify(await mic(0)));
    check('§3 provisoire écrit derrière le figé', await until(valIs(0, 'avant un deux. trois après')), await val(0));
    await mouse(0, 'mousedown');                           // second clic = arrêt
    await mouse(0, 'mouseup');
    const mid = await mic(0);
    check('§3 arrêt : transcription de la fin', mid && mid.busy && !mid.rec, JSON.stringify(mid));
    check('§3 figé final remplace le provisoire', await until(valIs(0, 'avant un deux. trois quatre. après')), await val(0));
    check('§3 retour au repos', await until(`!document.querySelector('.mic-btn.rec, .mic-btn.busy')`));
    check('§3 l\'autre case n\'a pas bougé', (await val(1)) === '', await val(1));
    check('§3 aucun bandeau d\'échec', !(await h.eval(`document.getElementById('batchNotice').classList.contains('show')`)));

    // §4
    await mouse(1, 'mousedown');
    await until(`document.querySelectorAll('.mic-btn')[1].classList.contains('rec')`);
    await until(valIs(1, 'un deux.'));
    await new Promise((r) => setTimeout(r, 450));
    await mouse(1, 'mouseup');                             // relâché après 400 ms
    check('§4 appui maintenu : relâcher arrête', (await mic(1)).busy, JSON.stringify(await mic(1)));
    check('§4 texte complet, collé proprement', await until(valIs(1, 'un deux. quatre.') + ' || ' + valIs(1, 'un deux. trois quatre.')), await val(1));

    // §5
    await type(2, 'base', 4);
    await mouse(2, 'mousedown'); await mouse(2, 'mouseup');
    await until(valIs(2, 'base un deux.'));
    await type(2, 'XX base un deux.', 0);                  // l'user tape AVANT la dictée
    await new Promise((r) => setTimeout(r, 1100));         // l'interim « trois » est passé
    await h.settle();
    check('§5 brouillon touché : rien d\'écrasé, rien d\'ajouté', (await val(2)) === 'XX base un deux.', await val(2));
    check('§5 … et la dictée s\'est arrêtée', !(await mic(2)).rec && !(await mic(2)).busy, JSON.stringify(await mic(2)));

    // §6
    await type(2, 'garde', 5);
    await mouse(2, 'mousedown'); await mouse(2, 'mouseup');
    await until(valIs(2, 'garde un deux.'));
    await h.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await h.settle();
    check('§6 Échap : la dictée disparaît du brouillon', (await val(2)) === 'garde', await val(2));
    check('§6 … et le bouton revient au repos', !(await mic(2)).rec, JSON.stringify(await mic(2)));

    // §7
    h.setConfig('claudeCodeQuotaBar.dictationCommand', cmd('--fail'));
    await h.settle();
    await mouse(0, 'mousedown'); await mouse(0, 'mouseup');
    check('§7 échec : message dans le bandeau d\'échec',
      await until(`document.getElementById('batchNotice').classList.contains('show') && /microphone/.test(document.getElementById('batchNotice').textContent)`),
      await h.eval(`document.getElementById('batchNotice').textContent`));
    check('§7 … bouton en erreur', await until(`document.querySelectorAll('.mic-btn')[0].classList.contains('err')`));
    check('§7 … brouillon intact', (await val(0)) === 'avant un deux. trois quatre. après', await val(0));
    check('§7 … une seule bannière', (await h.eval(`document.querySelectorAll('#newConvBody .banner, #newConvBody .notice.show').length`)) === 1);

    // §8
    h.setConfig('claudeCodeQuotaBar.dictationCommand', '');
    await h.settle();
    check('§8 réglage vidé : plus de micro', (await h.eval(`document.querySelectorAll('.mic-btn').length`)) === 0);
    check('§8 … et les brouillons sont restés', (await val(0)) === 'avant un deux. trois quatre. après', await val(0));
  } finally {
    await h.dispose();
  }
}

run().then(() => {
  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('banc en erreur :', e && e.stack || e);
  process.exit(1);
});
