// ============================================================================
// MAÎTRESSE EN TÊTE D'UN LOT VIVANT — ses lignes sont des cibles, sa tête se
// détache (2026-09-13, signalé par l'user sur son vrai panneau).
//
// Scénario réel : un bloc collé dont la maîtresse est la TÊTE d'un lot vivant ;
// l'user veut poser le prompt dans la vague 2 de CE lot. Constaté :
//   1. clic sur un membre de la vague 2 → refusé, ruban « la place est fixée
//      par la conversation maîtresse », le clic ouvre l'onglet ;
//   2. clic sur la maîtresse (tête) → rien : ni nouvelle vague, ni détachement ;
//   3. après détachement d'un clic sur une ligne plate, TOUT lot reste refusé.
// Cause : rowInsertTarget ne connaissait comme « lot de la maîtresse » que
// celui dont elle est MEMBRE (masterHostGroup) — jamais celui dont elle est la
// TÊTE (masterChainGroup) ; et le verrou tenait au COLLAGE (form.masterPaste),
// pas à l'existence d'une maîtresse, donc survivait à son détachement.
//
// Harnais en boucle fermée (vrai webview → vrai routeur → vrai groups.js →
// DOM final), même fixture « tête » que test-create-matrix.js. Lance Brave :
// derrière --slow, comme tout banc qui attend.
// ============================================================================
'use strict';

const H = require('./harness-loop.js');

const SLOW = process.argv.includes('--slow') || process.env.CLAUDE_QUOTA_SLOW === '1';
const PROMPT_FIELD = '.task-top textarea.inp';

let ok = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { ok++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
}

function block(prompt) {
  return ['```claude-convs', 'model: sonnet', 'effort: medium', '', prompt, '```'].join('\n');
}

const ribbon = `(() => ({
  tag: (function () { const t = document.querySelector('.ins-tag'); return t ? t.textContent : null; })(),
  refused: !!document.querySelector('.ins-tag.no'),
  zones: document.querySelectorAll('.ins-zone').length,
  btn: (function () { const b = document.querySelector('#newConvBody button.pri'); return b ? b.textContent : null; })(),
  masterTargets: document.querySelectorAll('.master-target').length,
  masterIsHead: !!document.querySelector('.grp-master-head .master-target'),
}))()`;

function memberSel(text) {
  return `Array.from(document.querySelectorAll('#flow .grp .member[data-ins-wave]')).find((n) => (n.textContent || '').indexOf(${JSON.stringify(text)}) !== -1)`;
}
const HEAD_ROW = `document.querySelector('#flow .grp-master-head .conv')`;
function hover(sel) { return `(() => { const n = ${sel}; if (!n) throw new Error('introuvable'); n.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return true; })()`; }
function click(sel) { return `(() => { const n = ${sel}; if (!n) throw new Error('introuvable'); n.click(); return true; })()`; }
const CLICK_CREATE = click(`document.querySelector('#newConvBody button.pri')`);

async function main() {
  if (!SLOW) {
    console.log('(banc sauté — il lance un vrai webview ; relancer avec --slow)');
    return;
  }
  const now = Date.now();
  const sessions = {};
  const masterId = H.uuid();
  const masterTitle = 'Lead conversation — head of the batch';
  const otherId = H.uuid();
  const siblingText = 'Second member queued in wave two — long enough for the master search threshold';
  const task1 = 'First drop into wave two, before the queued member — closed-loop harness text number one';
  const task2 = 'Second drop after detaching the master — closed-loop harness text number two';
  const block1 = block(task1);
  const block2 = block(task2);

  // La maîtresse a ÉCRIT les deux blocs (résolution par recherche, via:'search').
  H.writeTranscript(masterId, { title: masterTitle, firstUser: 'cadrage', assistant: `Voici la suite.\n\n${block1}\n\nEt ensuite.\n\n${block2}\n`, mtimeMs: now - 20 * 60 * 1000 });
  H.writeTranscript(otherId, { title: 'Neighbour in wave one', firstUser: 'neighbour', assistant: 'ok', mtimeMs: now - 90 * 60 * 1000 });
  sessions[masterId] = { state: 'done', since: now - 20 * 60 * 1000 };
  sessions[otherId] = { state: 'done', since: now - 90 * 60 * 1000 };
  H.spawnSession(masterId); H.spawnSession(otherId);
  H.writeSessionsState(sessions);
  // Lot VIVANT dont la maîtresse est la TÊTE : vague 1 lancée (voisine), vague 2 en file (le « lot 2 »).
  H.setGroups([{
    id: 'g-head', name: 'lot-head', createdAt: now - 60 * 60 * 1000, collapsed: false,
    masterSessionId: masterId, masterTitle: masterTitle,
    members: [
      { key: 'm1', prompt: 'cadrage', model: null, effort: null, wave: 1, sessionId: otherId, launchedAt: now - 60 * 60 * 1000 },
      { key: 'm2', prompt: siblingText, model: null, effort: null, wave: 2, sessionId: null, launchedAt: null },
    ],
  }]);
  H.setTabs([masterTitle, 'Neighbour in wave one']);

  const h = await H.start();
  if (!h) { console.log('(Brave Octopus indisponible — banc sauté)'); return; }
  try {
    await h.settle();

    // ── 1. Collage : la maîtresse est résolue, et c'est la TÊTE du lot ──────
    await h.paste(PROMPT_FIELD, block1);
    await h.settle();
    const r0 = await h.eval(ribbon);
    check('collage : la maîtresse est désignée, et c\'est la tête du lot', r0.masterTargets === 1 && r0.masterIsHead, JSON.stringify(r0));

    // ── 2. Survol + clic sur « Lot 2 » (membre du lot de la maîtresse) ──────
    await h.eval(hover(memberSel(siblingText)));
    await h.settle();
    const r1 = await h.eval(ribbon);
    check('survol du lot 2 : cible ACCEPTÉE « + into wave 2 » (jamais « sets the place »)',
      r1.refused === false && r1.zones === 1 && !!r1.tag && /into wave 2/.test(r1.tag), JSON.stringify(r1));
    await h.eval(click(memberSel(siblingText)));
    await h.settle();
    const r2 = await h.eval(ribbon);
    check('clic sur le lot 2 : la cible est FIXÉE, le bouton nomme la vague 2', /wave 2/.test(r2.btn || ''), JSON.stringify(r2));
    check('… et le clic n\'a PAS ouvert l\'onglet (aucun focusConv)', h.sentOfType('focusConv').length === 0, JSON.stringify(h.sentOfType('focusConv')));
    await h.eval(CLICK_CREATE);
    await h.settle();
    const g1 = h.groups().find((g) => g.id === 'g-head');
    const m1 = g1 && (g1.members || []).find((m) => (m.prompt || '').indexOf(task1) !== -1);
    check('« Créer » : la tâche est dans CE lot, vague 2 (addTasksToGroup, jamais createBatch)',
      !!m1 && m1.wave === 2 && h.sentOfType('addTasksToGroup').length === 1 && h.sentOfType('createBatch').length === 0,
      JSON.stringify({ member: m1, sent: h.sent.map((m) => m.type) }));

    // ── 3. Second collage : clic sur la maîtresse (tête) = la DÉTACHER ──────
    await h.paste(PROMPT_FIELD, block2);
    await h.settle();
    const r3 = await h.eval(ribbon);
    check('second collage : maîtresse de nouveau en tête', r3.masterTargets === 1 && r3.masterIsHead, JSON.stringify(r3));
    await h.eval(hover(HEAD_ROW));
    await h.settle();
    const r4 = await h.eval(ribbon);
    check('survol de la maîtresse en tête : ruban « detach from this conversation »',
      !!r4.tag && /detach from this conversation/.test(r4.tag) && r4.refused === false, JSON.stringify(r4));
    await h.eval(click(HEAD_ROW));
    await h.settle();
    const r5 = await h.eval(ribbon);
    check('clic sur la maîtresse en tête : plus aucune maîtresse (cadre orange retiré)', r5.masterTargets === 0, JSON.stringify(r5));
    check('… sans ouvrir l\'onglet', h.sentOfType('focusConv').length === 0);

    // ── 4. Détachée : le lot n'est plus verrouillé ──────────────────────────
    await h.eval(hover(memberSel(siblingText)));
    await h.settle();
    const r6 = await h.eval(ribbon);
    check('après détachement, survol du lot 2 : cible ACCEPTÉE (le verrou est parti avec la maîtresse)',
      r6.refused === false && r6.zones === 1 && !!r6.tag && /into wave 2/.test(r6.tag), JSON.stringify(r6));
    await h.eval(click(memberSel(siblingText)));
    await h.settle();
    await h.eval(CLICK_CREATE);
    await h.settle();
    const g2 = h.groups().find((g) => g.id === 'g-head');
    const m2 = g2 && (g2.members || []).find((m) => (m.prompt || '').indexOf(task2) !== -1);
    check('« Créer » : seconde tâche dans le lot, vague 2', !!m2 && m2.wave === 2, JSON.stringify(m2));
  } catch (e) {
    check('exécution', false, (e && e.stack) || String(e));
  } finally {
    await h.dispose();
  }
}

main().then(() => {
  console.log(`\n${ok} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}, (e) => { console.error(e); process.exit(1); });
