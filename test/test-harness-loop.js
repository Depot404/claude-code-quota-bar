// Deux DÉMONSTRATIONS du harnais en boucle fermée ([harness-loop.js]) — pas
// l'énumération des cas, qui est le lot suivant. Chacune joue un geste RÉEL
// dans le vrai webview et n'assertionne QUE sur ce qui se réaffiche après que
// le vrai store et le vrai buildPanelState ont eu la main :
//
//   §1 — un « Create » sans conversation maîtresse. Invariant du CLAUDE.md du
//        dossier : après un Create, la tâche lancée a TOUJOURS une surface à
//        l'écran (ligne de conv, ligne « en attente », ou membre de lot),
//        jamais rien. C'est la régression 2.104.0 (rétablie en 2.105.0), que
//        les bancs d'avant n'avaient pas vue parce qu'ils s'arrêtaient au
//        message posté — celui-ci le voit parce qu'il regarde l'écran d'après.
//
//   §2 — un dépôt SŒUR dans un lot vivant : un bloc collé dont la maîtresse est
//        membre d'un lot en cours rejoint CE lot (2.101.0), et le dépôt doit
//        être ACCEPTÉ par groups.js puis VISIBLE — le refus silencieux du store
//        sur une vague déjà lancée est la régression 2.102.0.
//
// Durée : ~10 s (lancement de Brave compris). Aucune attente passive, donc pas
// de `--slow` : ce banc regarde des pixels, il ne dort pas.
//
// §3 — LE TROU MESURÉ ICI LE 2026-09-02, tranché par l'user le 2026-09-06 et
// livré en 2.117.0 : un prompt solo tapé à la main, sans bloc ni maîtresse, ne
// fonde toujours aucun lot (2.104.0) — mais il suit désormais le MÊME chemin
// qu'un bloc collé (aperçu, cibles au survol, dépôt d'un clic dans un lot) et,
// une fois lancé, garde une ligne « en attente » dans la liste plate jusqu'à
// ce que la conversation soit listée (transcript né au premier Entrée). Seule
// différence avec un bloc : la place PAR DÉFAUT de l'aperçu, hors de tout lot.
// L'assertion de l'invariant est écrite pour ce cas aussi, sur l'écran.
const H = require('./harness-loop.js');   // ← doit rester le PREMIER require
const path = require('path');
const fs = require('fs');

// Captures du §3 (aperçu du prompt solo, puis sa ligne « en attente ») : le
// rendu se REGARDE, un banc de mesure ne suffit pas (règle du dossier). Hors
// publication : test/out/ est ignoré par git.
const OUT_DIR = path.join(__dirname, 'out');
try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch {}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

const PROMPT_FIELD = '.task-top textarea.inp';
// Le bouton « Create » se désigne par son libellé : le DOM du panneau ne porte
// aucun identifiant de test, et lui en ajouter un pour le banc serait du code
// de production écrit pour le banc.
const CLICK_CREATE = `(() => {
  const b = Array.from(document.querySelectorAll('.batch .btn')).find((n) => /^Create/.test(n.textContent));
  if (!b) throw new Error('bouton Create introuvable');
  if (b.disabled) throw new Error('bouton Create désactivé');
  b.click(); return true;
})()`;

const now = Date.now();
const MASTER_ID = H.uuid();       // la conv de cadrage, MEMBRE du lot vivant
const MASTER_TITLE = 'Chantier — lot 1';

// Le bloc SŒUR : celui que la maîtresse a écrit (il est donc dans SON
// transcript, c'est ce qui la prouve source du collage) et qu'on colle.
const SIBLING_BLOCK = [
  '```claude-convs',
  `session: ${MASTER_ID}`,
  'model: sonnet',
  'effort: medium',
  '',
  'Lot 2 — reprendre la table des cas de la boucle fermee et la remplir case par case.',
  '```',
].join('\n');

// Le bloc du §1 : une seule tâche, aucune ligne session:, et un texte qu'aucun
// transcript ne contient — donc aucune maîtresse, ni par jeton ni par
// recherche. C'est le bloc /handoffs à une tâche de la régression 2.104.0.
const SOLO_PROMPT = 'Tache solo sans maitresse : verifier que le lancement laisse une surface a l ecran.';
const SOLO_BLOCK = [
  '```claude-convs',
  'group: chantier-solo',
  'model: sonnet',
  'effort: medium',
  '',
  SOLO_PROMPT,
  '```',
].join('\n');

async function run() {
  // ── Décor : une conv de cadrage, membre d'un lot vivant à deux vagues ──────
  H.writeTranscript(MASTER_ID, {
    title: MASTER_TITLE,
    firstUser: 'Cadrage du chantier de la boucle fermee',
    assistant: `Voici les lots suivants.\n\n${SIBLING_BLOCK}\n`,
    mtimeMs: now - 20 * 60 * 1000,
  });
  H.writeSessionsState({ [MASTER_ID]: { state: 'done', since: now - 20 * 60 * 1000 } });
  H.spawnSession(MASTER_ID);
  H.setTabs([MASTER_TITLE]);
  H.setGroups([{
    id: 'gA', name: 'chantier', createdAt: now - 60 * 60 * 1000, collapsed: false,
    masterSessionId: null, masterTitle: '',
    members: [
      // Vague 1 : LANCÉE, et c'est la conv de cadrage qui la tient.
      { key: 'm1', prompt: 'Lot 1 — cadrage', model: null, effort: null, wave: 1, sessionId: MASTER_ID, launchedAt: now - 60 * 60 * 1000 },
      // Vague 2 : encore en file.
      { key: 'm2', prompt: 'Lot 1bis — releve', model: null, effort: null, wave: 2, sessionId: null, launchedAt: null },
    ],
  }]);

  const h = await H.start();
  if (!h) { console.log('  SKIP  brave.exe introuvable ou Brave Octopus n\'a pas démarré'); return; }

  try {
    await h.settle();
    const boot = h.state();
    check('le panneau a bien reçu un état', !!boot, JSON.stringify((h.pushed || []).map((m) => m && m.type)));
    check('la conv de cadrage est rendue comme membre du lot vivant',
      !!boot && (boot.groups || []).some((g) => g.id === 'gA' && !g.done
        && (g.members || []).some((m) => m.convId === MASTER_ID)),
      JSON.stringify(boot && boot.groups));

    // ── §1 — Create sans maîtresse ──────────────────────────────────────────
    console.log('\n1. Un « Create » sans conversation maîtresse');
    await h.paste(PROMPT_FIELD, SOLO_BLOCK);
    await h.settle();
    const resolved = h.sentOfType('resolveMasterPaste').length;
    check('le collage a bien été reconnu comme bloc (une recherche de maîtresse est partie)',
      resolved === 1, String(resolved));
    check('… et aucune maîtresse n\'a été trouvée (le texte n\'est dans aucun transcript)',
      (h.pushed.filter((m) => m && m.type === 'masterResolved').pop() || {}).sessionId == null,
      JSON.stringify(h.pushed.filter((m) => m && m.type === 'masterResolved').pop()));

    await h.eval(CLICK_CREATE);
    await h.settle();

    check('le clic a bien emprunté le chemin « créer un lot », pas un dépôt',
      h.sentOfType('createBatch').length === 1 && h.sentOfType('addTasksToGroup').length === 0,
      JSON.stringify(h.sent.map((m) => m.type)));
    check('une conversation a réellement été ouverte pour la tâche',
      h.opened.length === 1 && h.opened[0].prompt === SOLO_PROMPT,
      JSON.stringify(h.opened));

    // L'INVARIANT, mesuré sur l'écran d'après — pas sur le message envoyé.
    const launchedId = h.opened.length ? h.opened[0].sessionId : null;
    const surface = await h.eval(`(() => {
      const txt = ${JSON.stringify(SOLO_PROMPT.slice(0, 40))};
      const hit = (n) => (n.textContent || '').indexOf(txt) !== -1;
      return {
        // Les trois gabarits de surface : ligne de conversation (transcript
        // déjà né), ligne de tâche d'un lot, et ligne « en attente » de la
        // liste plate (2026-09-06) — c'est celle-ci qui doit la porter ici.
        forTask: Array.from(document.querySelectorAll('#flow .member, #flow .conv, #flow > .flat-pending')).filter(hit).length,
        flat: Array.from(document.querySelectorAll('#flow > .flat-pending')).filter(hit).length,
        rows: document.querySelectorAll('#flow .conv').length,
        groups: document.querySelectorAll('#flow .grp').length,
      };
    })()`);
    const st = h.state() || {};
    const listed = (st.conversations || []).some((c) => c.id === launchedId);
    check('INVARIANT — la tâche lancée a une surface à l\'écran (ligne, ligne « en attente » ou membre de lot)',
      surface.forTask === 1,
      `DOM ${JSON.stringify(surface)} · listée dans l'état : ${listed} · id ${launchedId}`);
    // 2026-09-09 (signalé par l'user) : un `group:` sur une tâche UNIQUE ne
    // fonde plus de lot — « BATCH hh:mm », rail et bloc autour d'une seule
    // ligne, pour un nom affiché nulle part. La surface est la ligne « en
    // attente », comme pour un prompt tapé (§3).
    check('… et ce `group:` n\'a fondé AUCUN lot : la surface est la ligne « en attente » de la liste plate',
      surface.flat === 1 && (st.groups || []).length === 1 && (st.groups || [])[0].id === 'gA'
        && !(st.groups || []).some((g) => (g.members || []).some((m) => m.convId === launchedId)),
      `DOM ${JSON.stringify(surface)} · lots ${JSON.stringify((st.groups || []).map((g) => g.id))}`);

    // ── §2 — dépôt sœur dans un lot vivant ──────────────────────────────────
    console.log('\n2. Un dépôt SŒUR dans un lot vivant');
    const sentBefore = h.sent.length;
    await h.paste(PROMPT_FIELD, SIBLING_BLOCK);
    await h.settle();
    const master = (h.pushed.filter((m) => m && m.type === 'masterResolved').pop() || {});
    check('la maîtresse du bloc est retrouvée (jeton session: vérifié contre son transcript)',
      master.sessionId === MASTER_ID, JSON.stringify(master));

    await h.eval(CLICK_CREATE);
    await h.settle();

    const fresh = h.sent.slice(sentBefore).map((m) => m.type);
    check('le Create est parti en DÉPÔT dans le lot de la maîtresse, pas en nouveau lot',
      fresh.includes('addTasksToGroup') && !fresh.includes('createBatch'), JSON.stringify(fresh));

    const drop = h.sentOfType('addTasksToGroup').pop() || {};
    check('… visant le lot de la maîtresse, sur une vague que le store peut encore accepter',
      drop.id === 'gA' && Number(drop.wave) > 1, JSON.stringify(drop));

    // Le store a-t-il ACCEPTÉ ? La question que les bancs d'avant ne posaient
    // pas : un refus de groups.js ne dit rien, ni au webview ni à l'écran.
    const gA = h.groups().find((g) => g.id === 'gA') || { members: [] };
    const added = (gA.members || []).filter((m) => (m.prompt || '').indexOf('Lot 2 —') === 0);
    check('le store a accepté le dépôt (la tâche est membre du lot dans l\'état poussé)',
      added.length === 1, JSON.stringify((gA.members || []).map((m) => ({ k: m.key, w: m.wave, p: m.prompt }))));
    check('… et elle est placée APRÈS la vague de la maîtresse',
      added.length === 1 && added[0].wave > 1, JSON.stringify(added));

    // Une tâche en FILE n'a pas encore de conversation : elle se rend en
    // `.member` (le gabarit des lignes de lot sans conv liée), pas en `.conv`.
    const shown = await h.eval(`(() => {
      const txt = 'Lot 2 —';
      const hit = (n) => (n.textContent || '').indexOf(txt) !== -1;
      const inGroup = Array.from(document.querySelectorAll('#flow .grp .member')).filter(hit);
      return {
        inGroup: inGroup.length,
        anywhere: Array.from(document.querySelectorAll('#flow .member, #flow .conv')).filter(hit).length,
        wave: inGroup.length ? (inGroup[0].closest('.wave') || {}).className || null : null,
      };
    })()`);
    check('… et l\'écran la montre DANS le lot',
      shown.inGroup === 1 && shown.anywhere === 1, JSON.stringify(shown));

    // ── §3 — prompt SOLO tapé à la main : sans bloc, sans lot, sans maîtresse ──
    console.log('\n3. Un prompt SOLO tapé à la main (décision user 2026-09-06)');
    // Texte inventé, comme toute fixture publiable (test-no-private-residue.js).
    const TYPED = 'Billing export: one row per invoice and per day, with a foldable detail listing every line.';
    const sentBefore3 = h.sent.length;
    const openedBefore3 = h.opened.length;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const HIT = JSON.stringify(TYPED.slice(0, 30));
    // input + paste, comme un collage réel : ce n'est pas un bloc, donc un
    // prompt simple (applyBlockPaste), sans recherche de maîtresse.
    await h.paste(PROMPT_FIELD, TYPED);
    await h.settle();
    check('un texte qui n\'est pas un bloc ne déclenche aucune recherche de maîtresse',
      h.sent.slice(sentBefore3).every((m) => m.type !== 'resolveMasterPaste'),
      JSON.stringify(h.sent.slice(sentBefore3).map((m) => m.type)));
    const previewDefault = await h.eval(`(() => {
      const p = document.querySelector('.master-preview');
      return {
        present: !!p,
        underNewConv: !!p && !!p.closest('#newConvBody'),
        inGroup: !!p && !!p.closest('.grp-body'),
        lines: p ? p.querySelectorAll('.m-pending').length : 0,
        waveHeaders: p ? p.querySelectorAll('.wave-hdr').length : 0,
        text: p ? (p.textContent || '').indexOf(${HIT}) !== -1 : false,
      };
    })()`);
    check('APERÇU — le prompt tapé est prévisualisé, par défaut HORS de tout lot, sous « New conversation »',
      previewDefault.present && previewDefault.underNewConv && !previewDefault.inGroup
        && previewDefault.lines === 1 && previewDefault.text,
      JSON.stringify(previewDefault));
    check('… sans séparateur de vague : aucun lot ne naîtra, la ligne annoncée est la ligne plate',
      previewDefault.waveHeaders === 0, JSON.stringify(previewDefault));

    // Survol d'une ligne du lot vivant (vague 2, encore ouverte au dépôt) :
    // l'aperçu se déplace DANS le lot — mêmes cibles qu'un bloc collé.
    await h.eval(`(() => {
      const r = Array.from(document.querySelectorAll('#flow .grp-body [data-ins-wave]'))
        .find((x) => Number(x.dataset.insWave) === 2);
      if (!r) throw new Error('ligne de la vague 2 introuvable');
      (r.querySelector('.conv, .m-pending') || r).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      return true;
    })()`);
    await wait(250);
    const previewHover = await h.eval(`(() => {
      const p = document.querySelector('.master-preview');
      const tag = document.querySelector('.ins-tag');
      return { present: !!p, inGroup: !!p && !!p.closest('.grp-body'), tag: tag ? tag.textContent : null, refused: !!document.querySelector('.ins-tag.no') };
    })()`);
    check('… au survol d\'une ligne du lot, l\'aperçu se pose DANS le lot, cible acceptée (même geste qu\'un bloc)',
      previewHover.present && previewHover.inGroup && !previewHover.refused, JSON.stringify(previewHover));
    await h.eval(`(() => { document.querySelector('#flow .grp-body').dispatchEvent(new MouseEvent('mouseleave')); return true; })()`);
    await wait(250);
    const previewBack = await h.eval(`(() => {
      const p = document.querySelector('.master-preview');
      return { present: !!p, underNewConv: !!p && !!p.closest('#newConvBody') };
    })()`);
    check('… et revient sous « New conversation » quand la souris quitte le lot',
      previewBack.present && previewBack.underNewConv, JSON.stringify(previewBack));

    // Create : conversation SEULE, aucun lot fondé, et une ligne « en attente »
    // dans la liste plate — l'invariant, mesuré sur l'écran.
    const groupsBefore3 = ((h.state() || {}).groups || []).length;
    await h.shot(path.join(OUT_DIR, 'solo-1-apercu.png'));
    await h.eval(CLICK_CREATE);
    await h.settle();
    const fresh3 = h.sent.slice(sentBefore3).map((m) => m.type);
    check('Create ouvre la conversation seule (createBatch), sans dépôt dans un lot',
      fresh3.includes('createBatch') && !fresh3.includes('addTasksToGroup'), JSON.stringify(fresh3));
    check('une conversation a été ouverte avec ce prompt',
      h.opened.length === openedBefore3 + 1 && h.opened[h.opened.length - 1].prompt === TYPED,
      JSON.stringify(h.opened.slice(openedBefore3)));
    const soloId = h.opened.length > openedBefore3 ? h.opened[h.opened.length - 1].sessionId : null;
    const st3 = h.state() || {};
    // Le §1 n'a fondé aucun lot non plus (depuis 2026-09-09) : le compte de
    // lots ne doit simplement pas BOUGER au Create d'un prompt solo.
    check('aucun lot n\'a été fondé pour elle (le compte de lots est inchangé, aucun membre ne la porte)',
      (st3.groups || []).length === groupsBefore3
        && !(st3.groups || []).some((g) => (g.members || []).some((m) => m.convId === soloId)),
      JSON.stringify((st3.groups || []).map((g) => g.id)));
    await h.shot(path.join(OUT_DIR, 'solo-2-en-attente.png'));
    // Sur SA ligne, pas sur le compte : depuis le 2026-09-09 la tâche du §1
    // (bloc à une section avec `group:`, sans maîtresse) attend là elle aussi.
    const pending3 = (st3.pending || []).find((p) => p.id === soloId);
    check('l\'état poussé porte sa ligne « en attente » : prompt, modèle demandé, statut inserted',
      !!pending3 && pending3.prompt === TYPED && pending3.status === 'inserted' && !!pending3.asked,
      JSON.stringify(st3.pending));
    const surface3 = await h.eval(`(() => {
      const hit = (n) => (n.textContent || '').indexOf(${HIT}) !== -1;
      const flat = Array.from(document.querySelectorAll('#flow > .flat-pending')).filter(hit);
      const kids = Array.from(document.querySelectorAll('#flow > *')).filter((k) => !k.classList.contains('empty'));
      return {
        flat: flat.length,
        pulse: flat.length ? !!flat[0].querySelector('.ico-pending-wait') : false,
        note: flat.length ? (flat[0].querySelector('.m-note') || {}).textContent || null : null,
        inGroup: Array.from(document.querySelectorAll('#flow .grp-body .m-pending')).filter(hit).length,
        preview: !!document.querySelector('.master-preview'),
        last: kids.length ? kids[kids.length - 1].classList.contains('flat-pending') : false,
      };
    })()`);
    check('INVARIANT — la tâche solo a sa surface : UNE ligne « en attente » dans la liste plate, hors lot, en fin de liste, qui pulse',
      surface3.flat === 1 && surface3.pulse && surface3.inGroup === 0 && surface3.last, JSON.stringify(surface3));
    check('… avec la même note courte qu\'un membre de lot : « press Enter in the tab »',
      surface3.note === 'press Enter in the tab', JSON.stringify(surface3));
    check('… et l\'aperçu du formulaire a disparu avec le Create',
      surface3.preview === false, JSON.stringify(surface3));

    // L'user appuie sur Entrée : le transcript naît, la conversation est
    // listée comme n'importe quelle autre, la ligne d'attente s'efface.
    if (soloId) {
      H.writeTranscript(soloId, { title: 'Billing export refactor', firstUser: TYPED, mtimeMs: Date.now() });
      H.writeSessionsState({
        [MASTER_ID]: { state: 'done', since: now - 20 * 60 * 1000 },
        [soloId]: { state: 'busy', since: Date.now() },
      });
    }
    let listed3 = false;
    for (let i = 0; i < 24 && !listed3; i++) {
      await h.settle();
      listed3 = ((h.state() || {}).conversations || []).some((c) => c.id === soloId);
      if (!listed3) await wait(250);
    }
    const afterEnter = h.state() || {};
    check('après Entrée (transcript né) : la conversation est listée comme une ligne ordinaire',
      listed3, JSON.stringify((afterEnter.conversations || []).map((c) => c.id)));
    check('… et sa ligne « en attente » a quitté l\'état poussé',
      !(afterEnter.pending || []).some((p) => p.id === soloId), JSON.stringify(afterEnter.pending));
    const domAfter = await h.eval(`(() => {
      const hit = (n) => (n.textContent || '').indexOf(${HIT}) !== -1;
      return { pending: Array.from(document.querySelectorAll('#flow .flat-pending')).filter(hit).length,
               rows: document.querySelectorAll('#flow .conv').length };
    })()`);
    check('… et l\'écran : plus aucune ligne d\'attente pour elle',
      domAfter.pending === 0, JSON.stringify(domAfter));
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
