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
// ⚠️ TROU RESTANT, MESURÉ ICI LE 2026-09-02 (constat, pas une assertion) : la
// parade de 2.105.0 tient au `group:` du bloc ou à une maîtresse. Un prompt
// solo SANS l'un ni l'autre ne fonde toujours aucun lot et sa conversation
// n'a, elle non plus, pas encore de transcript : mesuré par ce même harnais,
// l'écran ne montre RIEN pour la tâche lancée (0 nœud, la conv n'est pas dans
// l'état poussé). C'est le comportement d'avant les lots — reste à trancher
// s'il tombe sous l'invariant ; l'assertion n'est pas écrite tant que la
// décision (lot solo, ou ligne « en attente » dans la liste plate) n'est pas
// prise, pour ne pas figer un choix de produit dans un banc.
const H = require('./harness-loop.js');   // ← doit rester le PREMIER require

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
        // Les deux gabarits de surface : ligne de conversation (transcript
        // déjà né) et ligne de tâche d'un lot (rien n'a encore été envoyé).
        forTask: Array.from(document.querySelectorAll('#flow .member, #flow .conv')).filter(hit).length,
        rows: document.querySelectorAll('#flow .conv').length,
        groups: document.querySelectorAll('#flow .grp').length,
      };
    })()`);
    const st = h.state() || {};
    const listed = (st.conversations || []).some((c) => c.id === launchedId);
    // Témoin (mesuré le 2026-09-02) : le MÊME bloc privé de sa ligne `group:`
    // sort cette assertion à 0 nœud — elle n'est donc pas verte d'office, elle
    // sait dire « rien à l'écran ».
    check('INVARIANT — la tâche lancée a une surface à l\'écran (ligne, ligne « en attente » ou membre de lot)',
      surface.forTask === 1,
      `DOM ${JSON.stringify(surface)} · listée dans l'état : ${listed} · id ${launchedId}`);

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
