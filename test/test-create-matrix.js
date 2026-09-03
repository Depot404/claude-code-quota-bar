// ============================================================================
// MATRICE DU « CREATE » (2026-09-02) — lot suivant de [test/harness-loop.js].
// ÉNUMÈRE la combinatoire annoncée au CLAUDE.md du dossier, ÉLIMINE par
// construction les cases impossibles, et VÉRIFIE chaque case restante sur le
// harnais en boucle fermée (vrai webview → vrai routeur → vrai groups.js →
// vrai buildPanelState → DOM final). NE CORRIGE RIEN : ce fichier mesure.
//
// LES QUATRE AXES (exactement ceux du CLAUDE.md) :
//   T — nombre de tâches      : 1 / 2 dans une vague / 2 en deux vagues
//   M — maîtresse             : absente / résolue (recherche) / résolue puis
//                                détachée au clic / désignée au clic sur une
//                                autre ligne / ambiguë (plusieurs candidates)
//   P — position de la maîtresse : hors lot / membre d'un lot vivant / tête
//                                d'un lot vivant / membre d'un lot dont la
//                                vague suivante est DÉJÀ lancée
//   G — geste final            : Create direct / clic sur une ligne du lot /
//                                clic sur la ligne de la maîtresse
//
// ÉLIMINATIONS PAR CONSTRUCTION (justifiées dans enumerateMatrix, PAS ici) :
//   E1 — P n'a de sens que si une maîtresse est RETENUE (M=search). Pour
//        M=absente/détachée/désignée/ambiguë, aucune conversation n'est
//        retenue comme maîtresse : P retombe sur une case unique.
//   E2 — Le clic de DÉSIGNATION/DÉTACHEMENT (panel.js ~2515 : composingMasterPick()
//        && !root.closest('.grp-body')) ne route QUE sur une ligne HORS
//        .grp-body. Or la ligne d'un membre, ET la ligne de tête d'un lot
//        (grp-master-slot, posée DANS .grp-body par `place(node.body, 0,
//        node.masterHead)`, panel.js ~4374), sont TOUTES DEUX dans .grp-body.
//        Donc désigner/détacher par clic n'est possible QUE sur une ligne
//        plate : M=détachée et M=désignée forcent P=hors-lot.
//   E3 — masterHostGroup() (panel.js) rend null si la maîtresse n'est PAS
//        membre d'un lot vivant (hors lot), ou si elle en est déjà la TÊTE
//        (masterGroupNode() prioritaire). rowInsertTarget refuse alors tout
//        survol de groupe (host absent). Donc G=clic-sur-une-ligne-du-lot et
//        G=clic-sur-la-maîtresse n'existent QUE quand P∈{membre, membre+vague
//        suivante lancée} — et seulement quand M=search (E2 interdit déjà les
//        autres M d'atteindre ces P).
// ============================================================================
'use strict';

// Capturé AVANT harness-loop.js (qui intercepte tout require('child_process')
// ultérieur et n'y expose que spawn/execSync, tous deux désactivés) : cet
// orchestrateur, lui, a besoin du VRAI spawnSync pour lancer un sous-process
// par case (cf. § 3 plus bas).
const { spawnSync } = require('child_process');

const H = require('./harness-loop.js');

const SLOW = process.argv.includes('--slow') || process.env.CLAUDE_QUOTA_SLOW === '1';

// ── 1. LA MATRICE — données pures, aucune dépendance au harnais ────────────

const T_VALUES = ['t1', 't2a', 't2b'];
const M_VALUES = ['absente', 'search', 'detachee', 'designee', 'ambigue'];
const P_VALUES = ['hors-lot', 'membre', 'tete', 'membre-avance'];
const G_VALUES = ['create', 'rowClick', 'masterRowClick'];

const T_LABEL = { t1: '1 tâche', t2a: '2 tâches, 1 vague', t2b: '2 tâches, 2 vagues' };
const M_LABEL = {
  absente: 'maîtresse absente', search: 'résolue (recherche)', detachee: 'résolue puis détachée au clic',
  designee: 'désignée au clic sur une autre ligne', ambigue: 'ambiguë (plusieurs candidates)',
};
const P_LABEL = {
  'hors-lot': 'hors lot', membre: 'membre d’un lot vivant', tete: 'tête d’un lot vivant',
  'membre-avance': 'membre, vague suivante déjà lancée',
};
const G_LABEL = { create: 'Create direct', rowClick: 'clic sur une ligne du lot', masterRowClick: 'clic sur la ligne de la maîtresse' };

const REASON_E1 = 'E1 — aucune maîtresse retenue : la position n’a pas d’objet';
const REASON_E2 = 'E2 — la ligne d’un membre (ou de tête) est dans .grp-body : le clic de désignation/détachement n’y route jamais';
const REASON_E3 = 'E3 — pas de lot-hôte (masterHostGroup() nul) : tout survol de groupe est refusé';

// Verdict PUR d'une cellule (m,p,g) — appelé une fois par cellule du produit
// cartésien P_VALUES×G_VALUES, jamais plus : c'est ce qui garantit que
// valid+éliminées somme exactement à P_VALUES.length×G_VALUES.length par
// (t,m), donc à 180 sur toute la matrice.
//
// M∈{absente, ambigue} : aucune maîtresse retenue → la position n'a
// structurellement aucun objet, pour AUCUNE de ses 4 valeurs (E1). Une seule
// cellule sert de représentante mesurée (p='hors-lot', g='create' — le
// fixture le plus simple, aucun lot à construire) ; les 11 autres du même
// (t,m) sont éliminées, même raison.
// M∈{detachee, designee} : le clic de désignation/détachement ne route que
// sur une ligne HORS .grp-body (panel.js ~2515) → position forcée à
// 'hors-lot' (E2 pour les 3 autres valeurs de P) ; à 'hors-lot', G∈{rowClick,
// masterRowClick} reste sans objet (E3, pas de lot-hôte).
// M=search : P décide tout — host existe (masterHostGroup() non nul) SEULEMENT
// pour P∈{membre, membre-avance} (E3 sinon).
function cellStatus(m, p, g) {
  if (m === 'absente' || m === 'ambigue') {
    if (p === 'hors-lot' && g === 'create') return { valid: true, naPosition: true };
    return { valid: false, reason: REASON_E1 };
  }
  if (m === 'detachee' || m === 'designee') {
    if (p !== 'hors-lot') return { valid: false, reason: REASON_E2 };
    if (g === 'create') return { valid: true, naPosition: false };
    return { valid: false, reason: REASON_E3 };
  }
  // m === 'search'
  if (p === 'membre' || p === 'membre-avance') return { valid: true, naPosition: false };
  if (g === 'create') return { valid: true, naPosition: false };
  return { valid: false, reason: REASON_E3 };
}

function enumerateMatrix() {
  const rows = [];
  for (const t of T_VALUES) {
    for (const m of M_VALUES) {
      for (const p of P_VALUES) {
        for (const g of G_VALUES) {
          const verdict = cellStatus(m, p, g);
          rows.push(Object.assign({ t, m, p, g }, verdict));
        }
      }
    }
  }
  return rows;
}

function printMatrix(rows) {
  const valid = rows.filter((r) => r.valid);
  const eliminated = rows.filter((r) => !r.valid);
  console.log(`Matrice T×M×P×G : ${T_VALUES.length}×${M_VALUES.length}×${P_VALUES.length}×${G_VALUES.length} = ${T_VALUES.length * M_VALUES.length * P_VALUES.length * G_VALUES.length} cases brutes`);
  console.log(`  éliminées par construction : ${eliminated.length}`);
  console.log(`  cases à mesurer            : ${valid.length}`);
  const byReason = new Map();
  eliminated.forEach((r) => byReason.set(r.reason, (byReason.get(r.reason) || 0) + 1));
  byReason.forEach((n, reason) => console.log(`    · ${n.toString().padStart(3)} × ${reason}`));
  console.log('');
  valid.forEach((r) => {
    console.log(`  [${r.t}] ${T_LABEL[r.t]} · ${M_LABEL[r.m]} · ${r.naPosition ? 'position sans objet' : P_LABEL[r.p]} · ${G_LABEL[r.g]}`);
  });
  return { valid, eliminated };
}

// ── 2. LE HARNAIS — fabrique une fixture par case, joue le geste, mesure ───

const PROMPT_FIELD = '.task-top textarea.inp';
const CLICK_CREATE = `(() => {
  const b = Array.from(document.querySelectorAll('.batch .btn')).find((n) => /^Create/.test(n.textContent));
  if (!b) throw new Error('bouton Create introuvable');
  if (b.disabled) throw new Error('bouton Create désactivé (' + (b.title || '') + ')');
  b.click(); return true;
})()`;

function uniqueText(tag, label) {
  return `${label} — case ${tag} — texte de vérification du harnais en boucle fermée, assez long pour dépasser le seuil de recherche de la maîtresse (60 caractères).`;
}

// Bloc claude-convs : 1 à 2 sections, waves selon `sections[i].stage`.
function buildBlock({ session, group, sections }) {
  const lines = ['```claude-convs'];
  if (session) lines.push(`session: ${session}`);
  if (group) lines.push(`group: ${group}`);
  sections.forEach((sec, i) => {
    if (i > 0) lines.push('[---]');
    if (sec.stage) lines.push(`stage: ${sec.stage}`);
    lines.push('model: sonnet');
    lines.push('effort: medium');
    lines.push('');
    lines.push(sec.prompt);
  });
  lines.push('```');
  return lines.join('\n');
}

function sectionsFor(t, tag) {
  const p1 = uniqueText(tag, 'Premiere tache');
  if (t === 't1') return [{ prompt: p1 }];
  const p2 = uniqueText(tag, 'Deuxieme tache');
  if (t === 't2a') return [{ prompt: p1 }, { prompt: p2 }];
  return [{ stage: 1, prompt: p1 }, { stage: 2, prompt: p2 }];
}

// Clique une ligne de MEMBRE (dans .grp-body) contenant `text`. `hoverFirst`
// reproduit le survol réel (wireRowTargets écoute mouseover) avant le clic.
// Survole SANS cliquer — c'est le survol qui décide de la place annoncée par
// l'aperçu (I5 se mesure APRÈS ce survol, jamais sur l'aperçu par défaut
// d'avant tout geste).
async function hoverMemberByText(h, text) {
  await h.eval(`(() => {
    const nodes = Array.from(document.querySelectorAll('#flow .grp .member[data-ins-wave]'));
    const hit = nodes.find((n) => (n.textContent || '').indexOf(${JSON.stringify(text)}) !== -1);
    if (!hit) {
      const seen = nodes.map((n) => (n.textContent || '').slice(0, 80));
      throw new Error('ligne de membre introuvable pour : ' + ${JSON.stringify(text)} + ' — vues : ' + JSON.stringify(seen));
    }
    hit.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    return true;
  })()`);
}
// Re-survole (idempotent) puis clique — utilisée seule quand la valeur
// annoncée n'a pas besoin d'être capturée séparément.
async function clickMemberByText(h, text) {
  await hoverMemberByText(h, text);
  await h.eval(`(() => {
    const nodes = Array.from(document.querySelectorAll('#flow .grp .member[data-ins-wave]'));
    const hit = nodes.find((n) => (n.textContent || '').indexOf(${JSON.stringify(text)}) !== -1);
    hit.click();
    return true;
  })()`);
}

// Clique une ligne PLATE (hors .grp-body) contenant `text` — désignation ou
// détachement de la maîtresse (panel.js ~2515).
async function clickFlatRowByText(h, text) {
  await h.eval(`(() => {
    const nodes = Array.from(document.querySelectorAll('#flow .conv')).filter((n) => !n.closest('.grp-body'));
    const hit = nodes.find((n) => (n.textContent || '').indexOf(${JSON.stringify(text)}) !== -1);
    if (!hit) throw new Error('ligne plate introuvable pour : ' + ${JSON.stringify(text)});
    hit.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    hit.click();
    return true;
  })()`);
}

// Les FEUILLES de contenu — jamais leurs conteneurs : `.member` ENVELOPPE un
// `.conv` (rowFor(conv), quand la tâche est déjà liée) ou un `.m-pending`
// (pendingLine, tant qu'elle ne l'est pas) — les compter en plus de leur
// contenu compterait chaque ligne réelle deux fois (mesuré : la maîtresse,
// membre ET affichée, sortait à « 2 occurrences » sur un texte qui n'existe
// qu'une fois à l'écran).
async function domSnapshot(h) {
  return h.eval(`(() => {
    const nodes = Array.from(document.querySelectorAll('#flow .conv, #flow .m-pending'));
    return nodes.map((n) => ({ cls: n.className, text: (n.textContent || '').slice(0, 220) }));
  })()`);
}
function countMatches(snap, needle) {
  return snap.filter((n) => n.text.indexOf(needle) !== -1).length;
}

// Construit les groupes de la fixture selon P (uniquement M=search). Rend
// { groups, hostGid, siblingText, masterMemberWave } — siblingText = texte du
// membre VOISIN (cible de G=rowClick), masterMemberWave = la vague où la
// maîtresse est membre (cible de G=masterRowClick), ou null si elle n'est pas
// membre (P='tete').
function buildPosition(h, p, masterId, masterTitle, tag, now, sessionsAcc) {
  if (p === 'hors-lot') return { groups: [], hostGid: null, siblingText: null, masterMemberWave: null };

  const siblingText = uniqueText(tag, 'Membre voisin en file');
  const otherId = H.uuid();
  const otherTitle = `Voisine — ${tag}`;
  h.writeTranscript(otherId, { title: otherTitle, firstUser: 'voisine', assistant: 'ok', mtimeMs: now - 90 * 60 * 1000 });
  sessionsAcc[otherId] = { state: 'done', since: now - 90 * 60 * 1000 };
  h.spawnSession(otherId);

  if (p === 'membre') {
    const groups = [{
      id: 'g-' + tag, name: 'lot-' + tag, createdAt: now - 60 * 60 * 1000, collapsed: false,
      masterSessionId: null, masterTitle: '',
      members: [
        { key: 'm1', prompt: 'cadrage', model: null, effort: null, wave: 1, sessionId: masterId, launchedAt: now - 60 * 60 * 1000 },
        { key: 'm2', prompt: siblingText, model: null, effort: null, wave: 2, sessionId: null, launchedAt: null },
      ],
    }];
    return { groups, hostGid: 'g-' + tag, siblingText, masterMemberWave: 1 };
  }
  if (p === 'tete') {
    const groups = [{
      id: 'g-' + tag, name: 'lot-' + tag, createdAt: now - 60 * 60 * 1000, collapsed: false,
      masterSessionId: masterId, masterTitle: masterTitle,
      members: [
        { key: 'm1', prompt: 'cadrage', model: null, effort: null, wave: 1, sessionId: otherId, launchedAt: now - 60 * 60 * 1000 },
        { key: 'm2', prompt: siblingText, model: null, effort: null, wave: 2, sessionId: null, launchedAt: null },
      ],
    }];
    return { groups, hostGid: 'g-' + tag, siblingText, masterMemberWave: null };
  }
  // 'membre-avance' : la maîtresse est membre de la vague 1, et la vague 2 —
  // au-delà de la sienne — est déjà LANCÉE (launchedAt posé) ; une vague 3 en
  // file maintient le lot vivant.
  const groups = [{
    id: 'g-' + tag, name: 'lot-' + tag, createdAt: now - 3 * 60 * 60 * 1000, collapsed: false,
    masterSessionId: null, masterTitle: '',
    members: [
      { key: 'm1', prompt: 'cadrage', model: null, effort: null, wave: 1, sessionId: masterId, launchedAt: now - 3 * 60 * 60 * 1000 },
      { key: 'm2', prompt: 'relance', model: null, effort: null, wave: 2, sessionId: otherId, launchedAt: now - 60 * 60 * 1000 },
      { key: 'm3', prompt: siblingText, model: null, effort: null, wave: 3, sessionId: null, launchedAt: null },
    ],
  }];
  return { groups, hostGid: 'g-' + tag, siblingText, masterMemberWave: 1 };
}

// Fixture de résolution de la maîtresse (M axis) — pose transcripts/tabs
// nécessaires et rend { blockText, masterId, masterTitle, extraClickText }.
// extraClickText = texte de la ligne à cliquer pour M∈{detachee, designee}.
function buildMaster(h, spec, tag, now, sessionsAcc) {
  const sections = sectionsFor(spec.t, tag);

  if (spec.m === 'absente') {
    const blockText = buildBlock({ session: null, group: 'lot-' + tag, sections });
    return { blockText, masterId: null, masterTitle: null, extraClickText: null };
  }

  if (spec.m === 'ambigue') {
    const blockText = buildBlock({ session: null, group: 'lot-' + tag, sections });
    const idA = H.uuid(), idB = H.uuid();
    h.writeTranscript(idA, { title: `Candidate A — ${tag}`, firstUser: 'a', assistant: `Voici la suite.\n\n${blockText}\n`, mtimeMs: now - 40 * 60 * 1000 });
    h.writeTranscript(idB, { title: `Candidate B — ${tag}`, firstUser: 'b', assistant: `Voici la suite.\n\n${blockText}\n`, mtimeMs: now - 30 * 60 * 1000 });
    sessionsAcc[idA] = { state: 'done', since: now - 40 * 60 * 1000 };
    sessionsAcc[idB] = { state: 'done', since: now - 30 * 60 * 1000 };
    h.spawnSession(idA); h.spawnSession(idB);
    return { blockText, masterId: null, masterTitle: null, extraClickText: null };
  }

  if (spec.m === 'designee') {
    // Le bloc ne se retrouve nulle part (comme 'absente') : la désignation
    // écrase une résolution NULLE, pas une résolution existante.
    const blockText = buildBlock({ session: null, group: 'lot-' + tag, sections });
    const desigId = H.uuid();
    const desigTitle = `Designee au clic — ${tag}`;
    h.writeTranscript(desigId, { title: desigTitle, firstUser: 'd', assistant: 'ok', mtimeMs: now - 20 * 60 * 1000 });
    sessionsAcc[desigId] = { state: 'done', since: now - 20 * 60 * 1000 };
    h.spawnSession(desigId);
    return { blockText, masterId: desigId, masterTitle: desigTitle, extraClickText: desigTitle };
  }

  // 'search' et 'detachee' : la maîtresse EST résolue par la recherche —
  // son transcript contient le bloc collé mot pour mot (fences comprises,
  // normalizeForMatch les retire des deux côtés).
  const masterId = H.uuid();
  const masterTitle = `Maitresse — ${tag}`;
  const blockText = buildBlock({ session: null, group: 'lot-' + tag, sections });
  h.writeTranscript(masterId, {
    title: masterTitle, firstUser: 'cadrage',
    assistant: `Voici la suite.\n\n${blockText}\n`,
    mtimeMs: now - 20 * 60 * 1000,
  });
  sessionsAcc[masterId] = { state: 'done', since: now - 20 * 60 * 1000 };
  h.spawnSession(masterId);
  return { blockText, masterId, masterTitle, extraClickText: spec.m === 'detachee' ? masterTitle : null };
}

// ── Invariants génériques (I1..I7) — aucun ne connaît le CAS, seulement le
// DOM/store réels et les textes/ids de la fixture. ──────────────────────────

async function checkInvariants(h, ctx, out) {
  const check = (name, cond, detail) => out.push({ name, ok: !!cond, detail });

  // I1 — chaque tâche lancée a une surface (ligne conv OU ligne de lot).
  const snap = await domSnapshot(h);
  ctx.taskTexts.forEach((txt, i) => {
    check(`I1 — tâche ${i + 1} a une surface à l’écran`, countMatches(snap, txt) >= 1, `occurrences=${countMatches(snap, txt)}`);
  });

  // I3 — aucune conversation rendue deux fois (aucun texte connu > 1 occurrence).
  ctx.knownTexts.forEach((txt) => {
    check(`I3 — « ${txt.slice(0, 30)}… » rendu au plus une fois`, countMatches(snap, txt) <= 1, `occurrences=${countMatches(snap, txt)}`);
  });

  // I4 — le store a ACCEPTÉ le dépôt (jamais un tableau vide).
  const groups = h.groups();
  const st = h.state() || {};
  let storeHits = 0;
  ctx.taskTexts.forEach((txt) => {
    const inGroups = groups.some((g) => (g.members || []).some((m) => (m.prompt || '').indexOf(txt) !== -1));
    const inConvs = (st.conversations || []).some((c) => ctx.openedPrompts.has(c.id) && ctx.openedPrompts.get(c.id) === txt);
    if (inGroups || inConvs) storeHits++;
  });
  check('I4 — le store a accepté toutes les tâches (jamais un tableau vide)', storeHits === ctx.taskTexts.length,
    `${storeHits}/${ctx.taskTexts.length} — groups=${JSON.stringify(groups.map((g) => ({ id: g.id, n: (g.members || []).length })))}`);

  // I5 — la vague ANNONCÉE par l’aperçu (capturée avant le geste, ctx.announcedWave)
  // est la vague RÉELLE assignée à la première tâche dans le store.
  if (ctx.announcedWave != null) {
    let actualWave = null;
    for (const g of groups) {
      const m = (g.members || []).find((mm) => (mm.prompt || '').indexOf(ctx.taskTexts[0]) !== -1);
      if (m) { actualWave = m.wave; break; }
    }
    if (actualWave == null) {
      // Ligne plate (aucun groupe) : la seule vague possible est 1.
      actualWave = (st.conversations || []).some((c) => ctx.openedPrompts.get(c.id) === ctx.taskTexts[0]) ? 1 : null;
    }
    check('I5 — l’aperçu annonçait la vague réellement produite par le store',
      actualWave === ctx.announcedWave, `annoncé=${ctx.announcedWave} réel=${actualWave}`);
  }

  // I6 — aucun chrome sans objet : un lot à 1 membre sans maîtresse cache
  // chevron/interrupteur/compteur (panel.js ~4298).
  const chrome = await h.eval(`(() => {
    return Array.from(document.querySelectorAll('#flow .grp')).map((g) => {
      const dispOf = (sel) => { const n = g.querySelector(sel); return n ? getComputedStyle(n).display : null; };
      return { members: g.querySelectorAll('.member').length, chev: dispOf('.chevron'), tg: dispOf('.tg'), count: dispOf('.grp-count') };
    });
  })()`);
  groups.forEach((g) => {
    const solo = (g.members || []).length === 1 && !g.master;
    if (!solo) return;
    const rendered = chrome.find((c) => c.members === 1);
    check('I6 — lot solo sans maîtresse : chrome (chevron/interrupteur/compteur) masqué',
      !!rendered && rendered.chev === 'none' && rendered.tg === 'none' && rendered.count === 'none',
      JSON.stringify(rendered));
  });

  // I7 — formulaire vide, aucun décor résiduel.
  const residue = await h.eval(`(() => ({
    promptValue: (document.querySelector('${PROMPT_FIELD}') || {}).value || '',
    insTag: document.querySelectorAll('.ins-tag').length,
    insZone: document.querySelectorAll('.ins-zone').length,
    masterChip: document.querySelectorAll('.master-chip').length,
    hotRows: document.querySelectorAll('.ins-hot').length,
    masterTarget: document.querySelectorAll('.master-target').length,
    masterPreview: document.querySelectorAll('.master-preview').length,
  }))()`);
  check('I7 — le formulaire est vide après Create', residue.promptValue === '', JSON.stringify(residue));
  check('I7 — aucun décor d’insertion résiduel (ruban/cadre/agrafe/surlignage)',
    residue.insTag === 0 && residue.insZone === 0 && residue.masterChip === 0
      && residue.hotRows === 0 && residue.masterTarget === 0 && residue.masterPreview === 0,
    JSON.stringify(residue));
}

function caseTag(spec) {
  return `${spec.t}-${spec.m}-${spec.p}-${spec.g}`;
}

async function runCase(spec, report) {
  const tag = caseTag(spec).replace(/[^a-z0-9]+/gi, '');
  const now = Date.now();
  const findings = [];
  let skipped = false;

  // LE DÉCOR AVANT start() — TOUJOURS (règle de harness-loop.js, respectée
  // par test-harness-loop.js) : ext.activate() lit workspaceState UNE FOIS ;
  // un H.setGroups() appelé APRÈS start() écrit dans WORKSPACE_STORE mais
  // n'atteint plus le groupStore déjà chargé en mémoire par l'extension
  // (mesuré : h.groups() rendait [] même avant tout collage). UN SEUL
  // accumulateur pour les deux fixtures : writeSessionsState() REMPLACE tout
  // le fichier sessions-state.json à chaque appel (fiche de hooks, pas un
  // journal) — l'appeler deux fois (une par fixture) efface la première.
  const sessionsAcc = {};
  const fx = buildMaster(H, spec, tag, now, sessionsAcc);
  const pos = spec.m === 'search' ? buildPosition(H, spec.p, fx.masterId, fx.masterTitle, tag, now, sessionsAcc) : { groups: [], hostGid: null, siblingText: null, masterMemberWave: null };
  H.writeSessionsState(sessionsAcc);
  H.setGroups(pos.groups);
  H.setTabs([fx.masterTitle, pos.siblingText, fx.extraClickText].filter(Boolean));

  const h = await H.start();
  if (!h) { skipped = true; report.push({ spec, tag, skipped }); return; }

  try {
    await h.settle();

    await h.paste(PROMPT_FIELD, fx.blockText);
    await h.settle();

    if (spec.m === 'designee' || spec.m === 'detachee') {
      await clickFlatRowByText(h, fx.extraClickText);
      await h.settle();
    }

    // I2 — l’aperçu existe et est connecté au DOM dès qu’un prompt est saisi.
    const apercu = await h.eval(`(() => { const n = document.querySelector('.master-preview'); return !!(n && n.isConnected); })()`);
    findings.push({ name: 'I2 — l’aperçu existe et est connecté au DOM pendant la composition', ok: !!apercu, detail: String(apercu) });

    // G=rowClick/masterRowClick : le SURVOL change ce que l'aperçu annonce
    // (rowInsertTarget) — I5 doit lire l'annonce APRÈS ce survol, jamais
    // l'annonce par défaut d'avant tout geste (elles diffèrent légitimement :
    // survoler la ligne de la maîtresse vise un sous-lot NESTED, numéroté à
    // part).
    if (spec.g === 'rowClick') { await hoverMemberByText(h, pos.siblingText); await h.settle(); }
    else if (spec.g === 'masterRowClick') { await hoverMemberByText(h, fx.masterTitle); await h.settle(); }

    const announcedText = await h.eval(`(() => { const n = document.querySelector('.master-preview .wave-hdr-label'); return n ? n.textContent : null; })()`);
    const announcedMatch = announcedText && announcedText.match(/\d+/);
    const announcedWave = announcedMatch ? Number(announcedMatch[0]) : null;

    const sections = sectionsFor(spec.t, tag);
    const taskTexts = sections.map((s) => s.prompt);

    const openedPrompts = new Map();
    const preOpenedCount = h.opened.length;

    if (spec.g === 'create') {
      await h.eval(CLICK_CREATE);
    } else if (spec.g === 'rowClick') {
      await clickMemberByText(h, pos.siblingText);
    } else if (spec.g === 'masterRowClick') {
      await clickMemberByText(h, fx.masterTitle);
    }
    await h.settle();

    h.opened.slice(preOpenedCount).forEach((o) => openedPrompts.set(o.sessionId, o.prompt));
    // Les tâches déjà ouvertes AVANT ce geste (aucune dans cette matrice —
    // chaque case part d’un formulaire vierge) n’entrent pas en ligne de compte.

    const knownTexts = [fx.masterTitle, pos.siblingText, fx.extraClickText].filter(Boolean).concat(taskTexts);

    await checkInvariants(h, { taskTexts, knownTexts, announcedWave, openedPrompts }, findings);
  } catch (e) {
    findings.push({ name: 'exécution du cas', ok: false, detail: (e && e.stack) || String(e) });
  } finally {
    await h.dispose();
  }

  report.push({ spec, tag, skipped, findings });
}

// ── 3. Exécution ─────────────────────────────────────────────────────────
//
// UN SOUS-PROCESSUS PAR CASE (obligatoire, pas une optimisation) —
// harness-loop.js pose sa SANDBOX une fois, AU REQUIRE (`fs.mkdtempSync` en
// haut du module) ; `dispose()` la RM -rf en fin de session. Un deuxième
// `H.start()` dans le même process node réutilise donc un chemin de
// transcripts déjà supprimé (mesuré : ENOENT sur le 2e cas de chaque run en
// boucle simple) — le harnais est construit pour UNE session par process,
// exactement le patron de test-harness-loop.js (un seul start()/dispose()).
// Chaque case tourne donc dans un `node` neuf : --run-case=<index dans
// enumerateMatrix().filter(valid)> exécute UN SEUL cas et imprime son verdict
// sur une ligne balisée, que le process parent relit.
const RESULT_MARKER = '##RESULT##';

function runCaseIndexArg() {
  const arg = process.argv.find((a) => a.indexOf('--run-case=') === 0);
  return arg ? Number(arg.slice('--run-case='.length)) : null;
}

function runCaseInChildProcess(index, tagForLog) {
  const res = spawnSync(process.execPath, [__filename, '--run-case=' + index], { encoding: 'utf8', timeout: 60000 });
  const out = res.stdout || '';
  const line = out.split('\n').find((l) => l.indexOf(RESULT_MARKER) === 0);
  if (!line) {
    return {
      spec: null, tag: tagForLog, skipped: false,
      findings: [{
        name: 'exécution du cas (sous-processus)', ok: false,
        detail: `aucun résultat reçu (code ${res.status}) — stdout:\n${out.slice(-2000)}\nstderr:\n${(res.stderr || '').slice(-2000)}`,
      }],
    };
  }
  return JSON.parse(line.slice(RESULT_MARKER.length));
}

async function main() {
  const runCaseIdx = runCaseIndexArg();
  if (runCaseIdx != null) {
    const rows = enumerateMatrix();
    const valid = rows.filter((r) => r.valid);
    const results = [];
    await runCase(valid[runCaseIdx], results);
    console.log(RESULT_MARKER + JSON.stringify(results[0]));
    return { childMode: true };
  }

  const rows = enumerateMatrix();
  const { valid } = printMatrix(rows);

  if (!SLOW) {
    console.log('\n(mesure sur le harnais sautée — relancer avec --slow pour jouer les '
      + valid.length + ' cases sur Brave Octopus et produire test/RAPPORT_matrice_create.md)');
    return { rows, results: [] };
  }

  // CLAUDE_QUOTA_CASE_LIMIT : borne de mise au point (une poignée de cases au
  // lieu des 36) — jamais utilisée en exécution normale, seulement pour
  // valider le banc lui-même sans attendre le tour complet.
  const limit = Number(process.env.CLAUDE_QUOTA_CASE_LIMIT) || valid.length;
  const indices = valid.map((_, i) => i).slice(0, limit);
  console.log(`\nLancement du harnais pour ${indices.length} case(s) (--slow, un sous-processus par case)…\n`);
  const results = [];
  let n = 0;
  for (const idx of indices) {
    n++;
    const spec = valid[idx];
    process.stdout.write(`[${n}/${indices.length}] ${caseTag(spec)} … `);
    const r = runCaseInChildProcess(idx, caseTag(spec).replace(/[^a-z0-9]+/gi, ''));
    results.push(r);
    if (r.skipped) { console.log('SKIP (Brave Octopus indisponible)'); break; }
    const fails = (r.findings || []).filter((f) => !f.ok).length;
    console.log(fails ? `${fails} invariant(s) violé(s)` : 'ok');
  }
  return { rows, results };
}

function writeReport(rows, results) {
  const { valid, eliminated } = { valid: rows.filter((r) => r.valid), eliminated: rows.filter((r) => !r.valid) };
  const lines = [];
  lines.push('# Matrice du « Create » — cases rouges');
  lines.push('');
  lines.push('Généré par `node test/test-create-matrix.js --slow` — mesuré sur le harnais en');
  lines.push('boucle fermée ([test/harness-loop.js](harness-loop.js)), jamais déduit. Aucune');
  lines.push('correction appliquée : ce rapport est une photographie, pas un correctif.');
  lines.push('');
  lines.push('## Compte de la matrice');
  lines.push('');
  lines.push(`- ${T_VALUES.length} × ${M_VALUES.length} × ${P_VALUES.length} × ${G_VALUES.length} = ${rows.length} cases brutes`);
  lines.push(`- ${eliminated.length} éliminées par construction (voir en-tête de test-create-matrix.js, E1/E2/E3)`);
  lines.push(`- ${valid.length} cases mesurées`);
  lines.push('');

  if (!results.length) {
    lines.push('## Mesure');
    lines.push('');
    lines.push('SAUTÉE (pas de `--slow`, ou Brave Octopus indisponible) — aucune case rouge à');
    lines.push('rapporter, la matrice ci-dessus est le seul contenu vérifiable de cette exécution.');
    return lines.join('\n') + '\n';
  }

  const skippedRun = results.find((r) => r.skipped);
  if (skippedRun) {
    lines.push('## Mesure interrompue');
    lines.push('');
    lines.push('Brave Octopus (port 9223) introuvable ou n’a pas démarré — aucune case n’a pu être jouée.');
    return lines.join('\n') + '\n';
  }

  const red = results.filter((r) => r.findings.some((f) => !f.ok));
  lines.push('## Cases rouges');
  lines.push('');
  if (!red.length) {
    lines.push(`Aucune — les ${results.length} cases mesurées tiennent les 7 invariants (I1..I7).`);
  } else {
    lines.push(`${red.length} / ${results.length} cases en rouge :`);
    lines.push('');
    red.forEach((r) => {
      lines.push(`### \`${r.tag}\``);
      lines.push('');
      if (r.spec) {
        lines.push(`- T = ${T_LABEL[r.spec.t]}`);
        lines.push(`- M = ${M_LABEL[r.spec.m]}`);
        lines.push(`- P = ${r.spec.naPosition ? 'sans objet' : P_LABEL[r.spec.p]}`);
        lines.push(`- G = ${G_LABEL[r.spec.g]}`);
      } else {
        lines.push('- (spec indisponible — le sous-processus n’a rendu aucun résultat, voir le détail ci-dessous)');
      }
      lines.push('');
      r.findings.filter((f) => !f.ok).forEach((f) => {
        lines.push(`- **${f.name}** — ${f.detail}`);
      });
      lines.push('');
    });
  }
  lines.push('## Toutes les cases mesurées');
  lines.push('');
  lines.push('| case | T | M | P | G | verdict |');
  lines.push('|---|---|---|---|---|---|');
  results.forEach((r) => {
    const fails = r.findings.filter((f) => !f.ok).length;
    if (!r.spec) { lines.push(`| \`${r.tag}\` | — | — | — | — | ${fails ? `🔴 ${fails}` : '🟢'} |`); return; }
    lines.push(`| \`${r.tag}\` | ${T_LABEL[r.spec.t]} | ${M_LABEL[r.spec.m]} | ${r.spec.naPosition ? '—' : P_LABEL[r.spec.p]} | ${G_LABEL[r.spec.g]} | ${fails ? `🔴 ${fails}` : '🟢'} |`);
  });
  lines.push('');
  return lines.join('\n') + '\n';
}

main().then(({ rows, results, childMode }) => {
  if (childMode) { process.exit(0); return; }
  if (SLOW) {
    const fs = require('fs');
    const path = require('path');
    const report = writeReport(rows, results);
    fs.writeFileSync(path.join(__dirname, 'RAPPORT_matrice_create.md'), report, 'utf8');
    console.log('\nRapport écrit : test/RAPPORT_matrice_create.md');
    const anyRed = results.some((r) => r.findings && r.findings.some((f) => !f.ok));
    process.exit(anyRed ? 1 : 0);
  } else {
    process.exit(0);
  }
}).catch((e) => {
  console.error('banc en erreur :', (e && e.stack) || e);
  process.exit(1);
});
