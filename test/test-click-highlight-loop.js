// ============================================================================
// BANC D'INTÉGRATION FERMÉ — « le focus de l'onglet EST la ligne surlignée ».
//
// Exigence de l'utilisateur (2026-08-29, après onze reprises du même symptôme) :
// simuler le bug dans un environnement clos, cliquer soi-même, observer ce que
// deviennent les onglets (création / suppression / focus) et le comparer au
// surlignage, en boucle, jusqu'à zéro écart.
//
// CE QUE CE BANC A DE DIFFÉRENT des ~60 autres : il ne teste pas une fonction,
// il tient un INVARIANT de bout en bout sur un monde d'onglets qui BOUGE
// vraiment. `openEditorAtIndex` y déplace réellement l'onglet actif, comme dans
// VS Code ; le surlignage est calculé par le VRAI `buildSnapshot`. Après chaque
// geste, une seule question :
//
//     la conversation surlignée est-elle celle dont l'onglet est affiché ?
//
// Deux violations distinctes sont comptées, jamais confondues :
//   - FOCUS RATÉ  : le clic n'a pas amené l'onglet de la conversation visée ;
//   - SURLIGNAGE  : l'onglet affiché et la ligne surlignée désignent deux
//                   conversations différentes (le symptôme historique).
// Un troisième compteur surveille la population d'onglets : le panneau ne doit
// JAMAIS en créer ni en supprimer (contrat user du 2026-08-26).
// ============================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-click-loop-'));
os.homedir = () => SANDBOX;                       // AVANT le require de state.js
fs.mkdirSync(path.join(SANDBOX, '.claude'), { recursive: true });

// ── Le monde : des groupes d'onglets qui bougent pour de vrai ────────────────
// Chaque onglet porte son sessionId — ce que la vraie Tab API n'expose JAMAIS
// (c'est toute l'origine du bug) ; ici il sert d'ORACLE au banc, jamais au code
// testé, qui ne peut y accéder que par le memento.
const WORLD = { groups: [] };
const claudeTab = (label, sessionId) => ({ label, sessionId, input: { viewType: 'mainThreadWebview-claudeVSCodePanel' } });
let CREATED = 0, DESTROYED = 0;

function activeGroup() { return WORLD.groups.find((g) => g.isActive) || WORLD.groups[0]; }
function activeTab() { const g = activeGroup(); return g ? g.tabs[g.activeIndex] : null; }
function activeSessionId() { const t = activeTab(); return t ? t.sessionId : null; }
function allClaudeTabs() { return WORLD.groups.flatMap((g) => g.tabs); }
function labelsOfWorld() { return allClaudeTabs().map((t) => t.label); }
// Index de l'onglet actif dans la liste APLATIE (l'ordre que publie tabs.js).
function flatActiveIndex() {
  let n = 0;
  for (const g of WORLD.groups) {
    for (let i = 0; i < g.tabs.length; i++) { if (g === activeGroup() && i === g.activeIndex) return n; n++; }
  }
  return null;
}
// Le memento du renderer, tel que session-titles.js le rendrait : sessionId →
// { viewColumn, index, claudeCount }. `stale` fige une photo périmée, pour
// jouer le retard réel du flush.
let MEMENTO = { byId: new Map(), activeFlatIndex: null };
function snapshotMemento() {
  const m = new Map();
  let flat = 0;
  let activeFlatIndex = null;
  const act = activeTab();
  for (const g of WORLD.groups) {
    g.tabs.forEach((t, index) => {
      if (t === act) activeFlatIndex = flat;
      m.set(t.sessionId, { viewColumn: g.viewColumn, index, flatIndex: flat++, claudeCount: g.tabs.length });
    });
  }
  return { byId: m, activeFlatIndex };
}
function flushMemento() { MEMENTO = snapshotMemento(); }

// ── Stub `vscode` : les commandes AGISSENT sur le monde ──────────────────────
let focusedGroupColumn = 1;
const stub = {
  window: {
    get tabGroups() {
      return {
        get all() { return WORLD.groups; },
        get activeTabGroup() { return activeGroup(); },
        onDidChangeTabs() { return { dispose() {} }; },
        async close(tab) {
          for (const g of WORLD.groups) {
            const i = g.tabs.indexOf(tab);
            if (i >= 0) { g.tabs.splice(i, 1); DESTROYED++; if (g.activeIndex >= g.tabs.length) g.activeIndex = g.tabs.length - 1; }
          }
        },
      };
    },
    state: { focused: true },
  },
  commands: {
    getCommands: async () => ['claude-vscode.editor.open', 'workbench.action.openEditorAtIndex'],
    executeCommand: async (cmd, arg) => {
      const m = /focus(First|Second|Third)EditorGroup/.exec(cmd);
      if (m) {
        focusedGroupColumn = { First: 1, Second: 2, Third: 3 }[m[1]];
        for (const g of WORLD.groups) g.isActive = g.viewColumn === focusedGroupColumn;
        return;
      }
      if (cmd === 'workbench.action.openEditorAtIndex') {
        const g = activeGroup();
        // Le vrai VS Code ignore un index hors bornes : on fait pareil, sinon
        // le banc masquerait un bug au lieu de le montrer.
        if (g && arg >= 0 && arg < g.tabs.length) g.activeIndex = arg;
        return;
      }
      if (cmd === 'claude-vscode.editor.open') {
        // Le comportement MESURÉ le 2026-08-29 : un webview restauré mais
        // jamais réaffiché n'est pas dans `sessionPanels`, donc la commande
        // OUVRE au lieu de révéler. C'est ce piège que la voie retenue doit
        // s'interdire d'approcher — s'il se déclenche ici, CREATED le dira.
        const g = activeGroup();
        g.tabs.push(claudeTab('Claude Code', `neuve-${++CREATED}`));
        g.activeIndex = g.tabs.length - 1;
        return;
      }
    },
  },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'vscode') return stub;
  return origLoad.call(this, req, ...rest);
};

const focus = require(path.join(__dirname, '..', 'focus.js'));
const state = require(path.join(__dirname, '..', 'state.js'));

focus.setSessionLocationsSource(() => MEMENTO);
focus.setOpenSessionIdsSource(() => new Set(MEMENTO.byId.keys()));

// ── Conversations : transcripts réels dans le bac à sable ────────────────────
const WS = 'C:\\Users\\Test\\Projets VSCODE\\DemoClickLoop';
const projectDir = state.projectDirFor(WS);
fs.mkdirSync(projectDir, { recursive: true });
const assistant = { type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000 } } };
const userMsg = (t) => ({ type: 'user', message: { content: [{ type: 'text', text: t }] } });
function writeTranscript(sessionId, title, ageSec) {
  const p = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(p, [userMsg(`premier message ${sessionId}`), assistant, { type: 'ai-title', aiTitle: title }]
    .map((l) => JSON.stringify(l)).join('\n') + '\n');
  const when = (Date.now() - ageSec * 1000) / 1000;
  fs.utimesSync(p, when, when);
}

// ── Le tracker d'onglets, vu par state.js ───────────────────────────────────
// Forme exacte de tabs.js `getTabs()`. `actSessionId` est l'identité posée par
// le dernier clic panneau (canal ajouté le 2026-08-29) ; elle ne vaut que tant
// que l'onglet actif est bien celui de cet acte, comme dans le vrai tracker.
let lastAct = null;                                // { label, sessionId }
function tabsView() {
  const label = activeTab() ? activeTab().label : null;
  return {
    known: true,
    labels: labelsOfWorld(),
    activeLabel: label,
    activeIndex: flatActiveIndex(),
    frozen: false,
    source: 'fresh',
    windowFocused: true,
    sinceFocusMs: 5000,
    labelChangedAt: Date.now(),
    actSessionId: (lastAct && lastAct.label === label) ? lastAct.sessionId : null,
  };
}

// Le juge renderer : par défaut il CONFIRME le monde (cas nominal — le memento
// vient d'être flushé). Les scénarios de retard le figent volontairement.
let rendererActiveOverride = undefined;
function rendererView() {
  if (rendererActiveOverride !== undefined) return rendererActiveOverride;
  return { sessionId: activeSessionId(), claude: true, flushedAt: Date.now() };
}

function snapshot() {
  return state.buildSnapshot({
    workspacePath: WS, recentMs: 4 * 3600 * 1000, maxItems: 20,
    tabs: tabsView,
    openSessionIds: () => new Set(MEMENTO.byId.keys()),
    sessionTabLocations: () => MEMENTO,
    rendererActive: rendererView,
  }, state.createTranscriptReader());
}

// ── Le geste : un clic sur une ligne du panneau ─────────────────────────────
// Reproduit extension.js `focusConv` : focusConversation, puis l'acte est
// rapporté au tracker avec son identité.
async function clickRow(conv) {
  const before = allClaudeTabs().length;
  const label = await focus.focusConversation({ id: conv.sessionId, title: conv.title, isTrusted: true });
  if (label) lastAct = { label, sessionId: conv.sessionId };
  return { label, tabDelta: allClaudeTabs().length - before };
}

let pass = 0, fail = 0;
const violations = { focus: [], highlight: [], population: [] };
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

// L'INVARIANT, vérifié après chaque geste.
function assertInvariant(where, expectedSessionId, tabDelta) {
  const snap = snapshot();
  const highlighted = snap.conversations.filter((c) => c.isActive).map((c) => c.sessionId);
  const shown = activeSessionId();
  if (tabDelta !== 0) violations.population.push(`${where}: ${tabDelta > 0 ? '+' : ''}${tabDelta} onglet(s)`);
  if (expectedSessionId && shown !== expectedSessionId) {
    violations.focus.push(`${where}: onglet affiché ${shown}, attendu ${expectedSessionId}`);
  }
  if (highlighted.length > 1) {
    violations.highlight.push(`${where}: ${highlighted.length} lignes surlignées (${highlighted})`);
  } else if (highlighted.length === 1 && highlighted[0] !== shown) {
    violations.highlight.push(`${where}: surligné ${highlighted[0]}, onglet affiché ${shown}`);
  }
  return { snap, highlighted, shown };
}

async function run() {
  // ══ SCÉNARIO 1 — deux sœurs au libellé STRICTEMENT identique ══════════════
  // Le cas réel : deux conversations issues du même plan, titres tronqués au
  // même préfixe par VS Code. C'est celui qui a résisté onze fois.
  console.log('\n1. Deux sœurs homonymes — 40 clics alternés');
  const TRUNC = 'Rename scanned invoic…';
  writeTranscript('sis-A', 'Rename scanned invoices from the mailbox', 30);
  writeTranscript('sis-B', 'Rename scanned invoices from the mailbox again', 20);
  WORLD.groups = [{
    viewColumn: 1, isActive: true, activeIndex: 0,
    tabs: [claudeTab(TRUNC, 'sis-A'), claudeTab(TRUNC, 'sis-B')],
  }];
  flushMemento();
  const A = { sessionId: 'sis-A', title: 'Rename scanned invoices from the mailbox' };
  const B = { sessionId: 'sis-B', title: 'Rename scanned invoices from the mailbox again' };

  for (let i = 0; i < 40; i++) {
    const target = i % 2 === 0 ? A : B;
    const r = await clickRow(target);
    assertInvariant(`s1 clic#${i} sur ${target.sessionId}`, target.sessionId, r.tabDelta);
  }
  check('40 clics alternés : aucun focus raté', violations.focus.length === 0,
    violations.focus.slice(0, 3).join(' | '));
  check('40 clics alternés : aucun écart onglet/surlignage', violations.highlight.length === 0,
    violations.highlight.slice(0, 3).join(' | '));
  check('40 clics alternés : population d\'onglets inchangée', violations.population.length === 0,
    violations.population.slice(0, 3).join(' | '));
  check('aucun onglet créé par le panneau (jamais editor.open)', CREATED === 0, `CREATED=${CREATED}`);
  check('aucun onglet supprimé par le panneau', DESTROYED === 0, `DESTROYED=${DESTROYED}`);

  // ══ SCÉNARIO 2 — trois homonymes sur deux groupes ═════════════════════════
  console.log('\n2. Trois homonymes réparties sur deux colonnes — 60 clics aléatoires');
  violations.focus.length = 0; violations.highlight.length = 0; violations.population.length = 0;
  writeTranscript('tri-1', 'Sort the inbox scans by date', 40);
  writeTranscript('tri-2', 'Sort the inbox scans by sender', 35);
  writeTranscript('tri-3', 'Sort the inbox scans by size', 25);
  const T = 'Sort the inbox scan…';
  WORLD.groups = [
    { viewColumn: 1, isActive: true, activeIndex: 0, tabs: [claudeTab(T, 'tri-1'), claudeTab(T, 'tri-2')] },
    { viewColumn: 2, isActive: false, activeIndex: 0, tabs: [claudeTab(T, 'tri-3')] },
  ];
  flushMemento();
  const convs = [
    { sessionId: 'tri-1', title: 'Sort the inbox scans by date' },
    { sessionId: 'tri-2', title: 'Sort the inbox scans by sender' },
    { sessionId: 'tri-3', title: 'Sort the inbox scans by size' },
  ];
  // Séquence déterministe mais non triviale (un générateur congruentiel) :
  // reproductible d'un run à l'autre, contrairement à Math.random.
  let seed = 12345;
  const nextIdx = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let i = 0; i < 60; i++) {
    const target = convs[nextIdx(convs.length)];
    const r = await clickRow(target);
    assertInvariant(`s2 clic#${i} sur ${target.sessionId}`, target.sessionId, r.tabDelta);
  }
  check('60 clics aléatoires sur 2 colonnes : aucun focus raté', violations.focus.length === 0,
    violations.focus.slice(0, 3).join(' | '));
  check('60 clics aléatoires : aucun écart onglet/surlignage', violations.highlight.length === 0,
    violations.highlight.slice(0, 3).join(' | '));
  check('60 clics aléatoires : population inchangée', violations.population.length === 0,
    violations.population.slice(0, 3).join(' | '));

  // ══ SCÉNARIO 3 — l'utilisateur clique dans la BARRE D'ONGLETS ═════════════
  // Aucun acte panneau : c'est le monde qui bouge sous le panneau. Le
  // surlignage doit suivre, sans jamais désigner une sœur au hasard.
  console.log('\n3. Clics dans la barre d\'onglets (aucun acte panneau) — 30 bascules');
  violations.highlight.length = 0;
  lastAct = null;
  for (let i = 0; i < 30; i++) {
    const g = WORLD.groups[nextIdx(WORLD.groups.length)];
    for (const gg of WORLD.groups) gg.isActive = gg === g;
    g.activeIndex = nextIdx(g.tabs.length);
    lastAct = null;                                 // l'utilisateur n'a pas cliqué le panneau
    assertInvariant(`s3 bascule#${i}`, null, 0);
  }
  check('30 bascules d\'onglet : le surlignage ne désigne jamais la mauvaise sœur',
    violations.highlight.length === 0, violations.highlight.slice(0, 3).join(' | '));

  // ══ SCÉNARIO 4 — le memento RETARDE (le piège du monde réel) ══════════════
  // L'utilisateur ferme un onglet ; le flush n'a pas encore eu lieu. La
  // position mémorisée désigne alors le voisin. Exigence : plutôt NE RIEN
  // FAIRE que focuser la mauvaise conversation.
  console.log('\n4. Memento périmé (onglet fermé, pas encore flushé) — le clic ne se trompe jamais');
  violations.focus.length = 0; violations.highlight.length = 0; violations.population.length = 0;
  WORLD.groups = [
    { viewColumn: 1, isActive: true, activeIndex: 0, tabs: [claudeTab(T, 'tri-1'), claudeTab(T, 'tri-2')] },
    { viewColumn: 2, isActive: false, activeIndex: 0, tabs: [claudeTab(T, 'tri-3')] },
  ];
  flushMemento();
  // Fermeture réelle, memento NON rafraîchi : il croit encore à 2 onglets col 1.
  WORLD.groups[0].tabs.splice(0, 1);
  WORLD.groups[0].activeIndex = 0;
  const stale = await clickRow(convs[1]);           // tri-2, désormais en index 0
  const after4 = assertInvariant('s4 clic sur memento périmé', null, stale.tabDelta);
  check('memento périmé : aucun onglet créé ni supprimé', violations.population.length === 0,
    violations.population.join(' | '));
  check('memento périmé : le surlignage ne ment pas', violations.highlight.length === 0,
    violations.highlight.join(' | '));
  check('memento périmé : on ne focuse jamais une sœur au hasard',
    after4.shown !== 'tri-1', `affiché=${after4.shown}`);

  // Après le flush, le clic redevient exact — la dégradation est TRANSITOIRE.
  flushMemento();
  violations.focus.length = 0; violations.highlight.length = 0;
  const healed = await clickRow(convs[1]);
  assertInvariant('s4 après flush', 'tri-2', healed.tabDelta);
  check('après flush : le clic retrouve sa cible exacte', violations.focus.length === 0,
    violations.focus.join(' | '));
  check('après flush : surlignage aligné', violations.highlight.length === 0,
    violations.highlight.join(' | '));

  // ══ SCÉNARIO 5 — onglets RÉORDONNÉS sans flush ════════════════════════════
  console.log('\n5. Onglets réordonnés à la souris, memento pas encore flushé');
  violations.focus.length = 0; violations.highlight.length = 0; violations.population.length = 0;
  WORLD.groups = [{
    viewColumn: 1, isActive: true, activeIndex: 0,
    tabs: [claudeTab(TRUNC, 'sis-A'), claudeTab(TRUNC, 'sis-B')],
  }];
  flushMemento();
  // L'utilisateur les permute à la souris. Dans VS Code, l'onglet ACTIF suit son
  // déplacement — il reste le même onglet ; le banc doit en faire autant, sinon
  // il simule une bascule d'onglet que personne n'a demandée.
  const wasActive = WORLD.groups[0].tabs[WORLD.groups[0].activeIndex];
  WORLD.groups[0].tabs.reverse();
  WORLD.groups[0].activeIndex = WORLD.groups[0].tabs.indexOf(wasActive);
  const swapped = await clickRow(A);
  const after5 = assertInvariant('s5 clic après permutation', null, swapped.tabDelta);
  check('permutation : population inchangée', violations.population.length === 0,
    violations.population.join(' | '));
  check('permutation : le panneau n\'ouvre ni ne ferme rien', CREATED === 0 && DESTROYED === 0,
    `CREATED=${CREATED} DESTROYED=${DESTROYED}`);
  // ⚠️ LIMITE ASSUMÉE, ET C'EST LA SEULE. Deux onglets HOMONYMES permutés à la
  // souris entre deux flushs sont indiscernables : même compte, mêmes libellés,
  // et le memento ne s'est pas encore réécrit. Aucune information disponible ne
  // permet de savoir qu'ils ont bougé — ce n'est pas un défaut d'implémentation
  // mais une absence de donnée. Ce que le banc EXIGE dans ce cas : que rien ne
  // soit créé ni fermé, que la conversation surlignée reste l'une des deux
  // sœurs (jamais une tierce), et que le flush suivant répare tout.
  check('permutation : le surlignage reste sur l\'une des deux sœurs, jamais une tierce',
    after5.highlighted.length <= 1
    && (after5.highlighted.length === 0 || ['sis-A', 'sis-B'].includes(after5.highlighted[0])),
    JSON.stringify(after5.highlighted));

  flushMemento();
  violations.focus.length = 0; violations.highlight.length = 0;
  const after5b = await clickRow(A);
  assertInvariant('s5 après flush', 'sis-A', after5b.tabDelta);
  check('après flush : la permutation est absorbée, clic exact ET surlignage aligné',
    violations.focus.length === 0 && violations.highlight.length === 0,
    [...violations.focus, ...violations.highlight].join(' | '));

  // ══ SCÉNARIO 6 — la boucle longue, tous gestes mêlés ══════════════════════
  // C'est le test que l'utilisateur a demandé : on tourne, on mélange les
  // gestes, et on ne s'arrête qu'à zéro écart.
  // `--slow` (ou CLAUDE_QUOTA_SLOW=1) monte à 2000 gestes et ajoute les
  // permutations d'onglets : ~25 s réelles, au-delà du seuil de 3 s du dossier,
  // donc hors du jeu par défaut. Publish.ps1 les passe à tous les bancs.
  const SLOW = process.argv.includes('--slow') || process.env.CLAUDE_QUOTA_SLOW === '1';
  const ROUNDS = SLOW ? 2000 : 300;
  console.log(`\n6. Boucle longue — ${ROUNDS} gestes mêlés (clics, bascules, flushs${SLOW ? ', permutations' : ''})`);
  if (!SLOW) console.log('   (--slow : 2000 gestes + permutations d\'onglets)');
  violations.focus.length = 0; violations.highlight.length = 0; violations.population.length = 0;
  WORLD.groups = [
    { viewColumn: 1, isActive: true, activeIndex: 0, tabs: [claudeTab(TRUNC, 'sis-A'), claudeTab(TRUNC, 'sis-B')] },
    { viewColumn: 2, isActive: false, activeIndex: 0, tabs: [claudeTab(T, 'tri-1'), claudeTab(T, 'tri-2'), claudeTab(T, 'tri-3')] },
  ];
  flushMemento();
  const all = [A, B, ...convs];
  let clicks = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const dice = nextIdx(SLOW ? 11 : 10);
    if (dice === 10) {
      // Permutation à la souris, PUIS flush — c'est la séquence réelle : VS Code
      // réécrit son memento quand la grille d'éditeurs change. Le cas « permuté
      // mais pas encore flushé » est traité au §5, avec sa limite.
      const g = WORLD.groups[nextIdx(WORLD.groups.length)];
      const keep = g.tabs[g.activeIndex];
      g.tabs.reverse();
      g.activeIndex = g.tabs.indexOf(keep);
      flushMemento();
      assertInvariant(`s6 permutation#${i}`, null, 0);
    } else if (dice < 6) {
      const target = all[nextIdx(all.length)];
      const r = await clickRow(target);
      clicks++;
      // La cible n'est exigée que si le memento est à jour ; sinon on n'exige
      // que l'invariant de cohérence (jamais un surlignage faux).
      assertInvariant(`s6 clic#${i}`, target.sessionId, r.tabDelta);
    } else if (dice < 8) {
      const g = WORLD.groups[nextIdx(WORLD.groups.length)];
      for (const gg of WORLD.groups) gg.isActive = gg === g;
      g.activeIndex = nextIdx(g.tabs.length);
      lastAct = null;
      assertInvariant(`s6 bascule#${i}`, null, 0);
    } else {
      flushMemento();
      assertInvariant(`s6 flush#${i}`, null, 0);
    }
  }
  check(`boucle longue (${ROUNDS} gestes, ${clicks} clics) : aucun focus raté`, violations.focus.length === 0,
    violations.focus.slice(0, 4).join(' | '));
  check('boucle longue : aucun écart onglet/surlignage', violations.highlight.length === 0,
    violations.highlight.slice(0, 4).join(' | '));
  check('boucle longue : population d\'onglets rigoureusement stable',
    violations.population.length === 0, violations.population.slice(0, 4).join(' | '));
  check('sur la totalité du banc, le panneau n\'a JAMAIS ouvert d\'onglet', CREATED === 0, `CREATED=${CREATED}`);
  check('… ni jamais fermé d\'onglet', DESTROYED === 0, `DESTROYED=${DESTROYED}`);

  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
