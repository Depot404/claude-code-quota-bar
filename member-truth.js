// ============================================================================
// TABLE DE VÉRITÉ UNIQUE du statut d'un membre de groupe (lot 10 du plan
// PLAN_creation_groupes_2026-07-22.md).
//
// POURQUOI — cinq bugs de la MÊME classe se sont succédé, chacun corrigé à la
// pièce dans son coin de code :
//   1. « Link… » qui réapparaît sur une tâche finie (lot 8, panel.js) ;
//   2. « closed before sending » sur des conversations terminées (lot 9,
//      extension.js) ;
//   3. « ✓ done · closed » affiché sur les membres d'une vague qu'on VIENT
//      d'ouvrir (rien n'a encore été envoyé) ;
//   4. les mêmes membres vus `stale` par le moteur de vagues, qui suspend
//      l'auto et affiche un bandeau rouge, au Create ;
//   5. (2026-08-04) « fermée avant envoi » annoncé sur un onglet GRAND OUVERT,
//      prompt inséré : le premier CLI meurt dans les secondes suivant
//      l'ouverture, l'extension officielle en respawne un autre SOUS LE MÊME
//      ONGLET, et le membre reste collé au mort. Même faute, une source de
//      plus : la vivacité d'un PROCESS ne dit rien d'un ONGLET. D'où
//      `unsent-lost`, qui n'affirme plus que ce qui est prouvé, et le
//      re-lien des liens mort-nés (attach.js `pendingForRelink`).
//   6. (2026-08-05, étape 17) « ouverte » affiché juste après la fermeture
//      d'un onglet : à la fermeture, `isLive(id)` (registre ~/.claude/sessions)
//      et l'état des hooks (sessions-state.json) se purgent chacun à son
//      rythme, de façon asynchrone (SessionEnd tire quand le process a fini
//      de mourir) — pendant la fenêtre où l'un des deux a déjà purgé et pas
//      l'autre, `live` restait vrai et `state` retombait sur `idle`, un
//      libellé qui PRÉSUME un onglet ouvert. Le panneau, lui, sait DÉJÀ que
//      l'onglet est fermé (l'événement d'onglet l'a fait sortir de la vue) —
//      c'est ce fait-là, jamais la course hooks/registre, qui doit trancher.
//      D'où `tabClosed(id)`, une source de plus qui dégrade `live` de force
//      dès que l'onglet est PROUVÉ fermé : `idle`/`inserted` (qui présument
//      un onglet) deviennent structurellement inatteignables, et un membre
//      TERMINÉ tombe direct en `done-closed` (masqué) sans attendre que la
//      course se résolve d'elle-même.
// Cause commune : un FAIT DURABLE (lié ? envoyé ? terminé ?) déduit d'une VUE
// PARTIELLE — la liste affichée par le panneau, qui ne contient que les
// conversations ayant un transcript ET un onglet, bornée à `maxItems`. Une
// conversation tout juste ouverte n'y est pas (son transcript naît au premier
// envoi) ; une conversation finie dont on ferme l'onglet en sort. Les deux
// étaient lues « disparue » — donc `done·closed` ici et `stale` là.
//
// PRINCIPE — un seul endroit résout le statut, à partir de sources qui, elles,
// disent chacune un fait :
//   - `isLive(id)`        registre ~/.claude/sessions (live-sessions.js) : le
//                         process CLI de cette session tourne-t-il ? C'est la
//                         VIVACITÉ, l'information qui manquait au lot 8/9 ;
//                         elle existe dès l'ouverture de l'onglet ;
//   - `hasTranscript(id)` le fichier ~/.claude/projects/<ws>/<id>.jsonl existe :
//                         il naît au PREMIER ENVOI et ne disparaît plus — donc
//                         « a envoyé » est un fait irréversible (lot 9) ;
//   - `hookState(id)`     état posé par les hooks (sessions-state.json), pour
//                         les sessions qui ne sont plus dans la vue ;
//   - `getConv(id)`       la vue : consultée pour l'état affiné (interrupted,
//                         waiting…) et pour l'ONGLET (`tabOpen`) — jamais pour
//                         décider si un membre est lié, envoyé ou terminé.
//
// Toutes sont optionnelles : absente = prédicat faux (dégradation silencieuse,
// règle du projet). Node PUR — aucun `require('vscode')`, aucun accès disque :
// les sources sont injectées, la fonction est donc testable cas par cas
// (test/test-member-truth.js reproduit la table du plan ligne à ligne).
// ============================================================================

// Statuts canoniques. `waveStatus` est la projection sur le vocabulaire du
// moteur de vagues (waves.js), qui n'en connaît que quatre.
//
// Le point qui répare le bug n°4 : `done-closed` projette sur `done` — une
// tâche finie dont l'onglet est fermé NE BLOQUE PAS la vague suivante. Et
// `stale` ne peut plus naître d'une absence de la vue : il exige une session
// MORTE dont le transcript existe (donc qui a travaillé) sans jamais atteindre
// `done` — une vraie interruption.
const WAVE_STATUS = {
  queued: 'queued',
  'not-linked': 'launched',
  inserted: 'launched',
  busy: 'launched',
  waiting: 'launched',
  idle: 'launched',
  interrupted: 'launched',
  done: 'done',
  'done-closed': 'done',
  stale: 'stale',
  // Le process suivi est mort sans qu'un seul message soit parti. Ce qu'on SAIT :
  // plus rien ne tourne sous cet identifiant, la tâche ne finira pas toute seule.
  // Ce qu'on ne sait PAS, et qu'on n'affirme donc plus : que l'ONGLET, lui, ait
  // été fermé (incident 2026-08-04 — le premier CLI meurt dans les secondes qui
  // suivent l'ouverture, l'extension officielle en respawne un autre sous le même
  // onglet, et le membre garde le mort). Comme `stale` pour le moteur (l'auto se
  // suspend, ▶ reste) ; le libellé, lui, dit exactement ce qui est prouvé.
  'unsent-lost': 'stale',
};

// Note courte affichée dans le pied du membre — SEULEMENT quand la
// conversation n'est pas rendue dans la vue (sinon c'est sa ligne qui parle,
// et répéter serait un doublon).
const NOTES = {
  queued: '',
  'not-linked': 'not linked yet',
  inserted: 'press Enter in the tab',
  busy: 'running',
  waiting: 'waiting for you',
  idle: 'open',
  interrupted: 'interrupted',
  done: '✓ done',
  'done-closed': '✓ done · closed',
  stale: 'interrupted — never finished',
  'unsent-lost': 'link lost before sending',
};

// Infobulle de la ligne « en attente » (le prompt, quand aucune conversation
// n'est rendue). Même table, même endroit : deux textes qui se contredisent,
// c'est déjà le bug qu'on répare.
const HINTS = {
  queued: 'Queued — opens when this wave starts.',
  'not-linked': 'Not linked to a conversation yet.',
  inserted: 'Tab open with the prompt inserted — press Enter to start it.',
  busy: 'Running, but not in the panel list right now.',
  waiting: 'Waiting for you, but not in the panel list right now.',
  idle: 'Open, but not in the panel list right now.',
  interrupted: 'Interrupted — not in the panel list right now.',
  done: 'Finished.',
  'done-closed': 'Finished — its tab has been closed.',
  stale: 'Its process is gone and it never reached the end of a turn.',
  'unsent-lost': 'Its background process died before anything was sent. If the tab is still open, press Enter — it will link itself back. Otherwise use “Relaunch”.',
};

// États que state.js/les hooks peuvent produire et qu'on relaie tels quels.
const KNOWN_STATES = new Set(['busy', 'waiting', 'done', 'stale', 'idle', 'interrupted']);

const NEVER = () => false;
const NOTHING = () => null;
const fnOr = (f, dflt) => (typeof f === 'function' ? f : dflt);

// `member` : un membre du store de groupe — { sessionId, launchedAt } suffit.
// (`convId` est accepté comme alias : c'est le nom du champ une fois le membre
// sérialisé vers le webview.)
function memberTruth(member, sources) {
  const m = member || {};
  const s = sources || {};
  const isLive = fnOr(s.isLive, NEVER);
  const hasTranscript = fnOr(s.hasTranscript, NEVER);
  const hookState = fnOr(s.hookState, NOTHING);
  const getConv = fnOr(s.getConv, NOTHING);
  // Onglet PROUVÉ fermé (bug n°6 ci-dessus) : source optionnelle, absente par
  // défaut (dégradation silencieuse, comme les trois autres) — sans elle,
  // comportement identique à avant l'étape 17.
  const tabClosed = fnOr(s.tabClosed, NEVER);

  const convId = m.sessionId || m.convId || null;

  // Pas de sessionId : les deux seules lignes de la table qui ne dépendent
  // d'aucune source — le store du groupe suffit à trancher.
  if (!convId) {
    return build(m.launchedAt != null ? 'not-linked' : 'queued', {
      convId: null, conv: null, live: false, sent: false,
    });
  }

  const conv = getConv(convId) || null;
  // `live` dégradé de force dès que l'onglet est PROUVÉ fermé : `isLive` et
  // `hookState` peuvent chacun retarder leur purge de quelques secondes après
  // la fermeture (course asynchrone, cf. bug n°6) — le panneau, lui, sait déjà
  // que l'onglet est parti, et rien de ce qui suppose un onglet ouvert
  // (`inserted`, `idle`) ne doit plus pouvoir en sortir.
  const live = !!isLive(convId) && !tabClosed(convId);
  // « A envoyé » : le transcript existe. Sa PRÉSENCE DANS LA VUE en est une
  // preuve suffisante (state.js ne liste que des conversations qui en ont un),
  // mais jamais une condition — c'est tout le correctif du lot 9.
  const sent = !!conv || !!hasTranscript(convId);
  // État des hooks : celui de la vue quand elle l'a (il est affiné —
  // `interrupted`, `waiting` sur outil interactif), sinon celui du fichier
  // d'état, qui survit à la sortie de la vue.
  const raw = (conv && conv.state) || hookState(convId) || null;
  const state = KNOWN_STATES.has(raw) ? raw : null;

  let status;
  if (live && !sent) {
    // Onglet ouvert par nous, prompt inséré, rien envoyé : l'état du Create.
    status = 'inserted';
  } else if (live) {
    status = state || 'idle';
  } else if (!sent) {
    // Le process lié est mort sans avoir jamais envoyé. On ne prétend RIEN sur
    // l'onglet (cf. WAVE_STATUS) : le lien est perdu, un point c'est tout — et
    // parce que rien n'a jamais commencé sous cet identifiant, il n'y a rien à
    // protéger : le membre redevient rattachable (canLink/canRelaunch).
    status = 'unsent-lost';
  } else {
    // Session morte avec transcript. `state === null` = les hooks ne savent
    // plus rien (entrée purgée après 24 h, ou hooks jamais installés) : on
    // conclut TERMINÉE, pas `stale`. Un doute sur une conversation morte
    // depuis longtemps ne doit pas geler une vague pour l'éternité — c'est
    // précisément le travers que ce module supprime.
    //
    // `idle` reçoit le MÊME verdict : aucun hook n'écrit `idle` (ils ne posent
    // que busy/waiting/done) — c'est le REPLI de state.js quand l'entrée
    // n'existe pas, donc exactement « les hooks ne savent rien », pas un état.
    // Cas réel : recharger la fenêtre VS Code tue les CLI assez proprement pour
    // que SessionEnd tire et PURGE les entrées ; les convs terminées, encore
    // listées (leur ligne affiche ✓), revenaient `stale` — compteur « 0/N
    // done » contredisant les ✓, auto-avancement suspendu (2026-07-24).
    const doneish = state === 'done' || state == null || state === 'idle';
    if (!doneish) {
      status = 'stale';
    } else {
      // Terminée. `done` (onglet encore ouvert, on propose de le fermer) vs
      // `done-closed` (onglet parti, rien à fermer) — la VIVACITÉ du PROCESS ne
      // tranche PAS : une conversation finie dont le CLI a rendu la main (ou
      // qu'un RELOAD vient de tuer) garde très souvent son onglet ouvert.
      // Confondre « CLI mort » et « onglet fermé » supprimait le chip vert de
      // fermeture sur toute conv terminée après un reload (bug 2, 2026-07-24) :
      // c'est `conv.tabOpen` (la VUE — la seule chose que la vue a le droit de
      // décider ici) qui fait foi. Les deux projettent sur `done` pour le
      // moteur de vagues : le compteur reste d'accord avec les ✓, correctif du
      // reload conservé.
      status = (conv && conv.tabOpen) ? 'done' : 'done-closed';
    }
  }

  return build(status, { convId, conv, live, sent });
}

function build(status, ctx) {
  const listed = !!ctx.conv;
  return {
    status,
    waveStatus: WAVE_STATUS[status] || 'launched',
    convId: ctx.convId,
    linked: !!ctx.convId,
    listed,
    live: ctx.live,
    sent: ctx.sent,
    // Un membre lié l'est DÉFINITIVEMENT (lot 8) : proposer « Link… » sur un
    // membre qui a déjà un sessionId invite à rebrancher une tâche finie.
    // UNE exception, et une seule : le lien MORT-NÉ (`unsent-lost`) — process
    // mort ET rien jamais envoyé sous cet id, donc rien qui ait commencé, donc
    // rien à protéger. L'interdit reste entier partout ailleurs (session
    // vivante, ou morte AVEC transcript = vrai `stale`).
    canLink: status === 'not-linked' || status === 'unsent-lost',
    // Rouvrir une conversation pour cette tâche (prompt/modèle/effort du
    // membre) : le remède quand l'onglet, lui, est vraiment parti.
    canRelaunch: status === 'unsent-lost',
    // Fermer l'onglet : seulement une conversation terminée dont un onglet est
    // encore ouvert — donc forcément visible dans la vue (c'est la seule chose
    // que la vue a le droit de décider ici).
    canClose: status === 'done' && listed && !!ctx.conv.tabOpen,
    note: listed ? '' : (NOTES[status] || ''),
    hint: HINTS[status] || '',
  };
}

module.exports = { memberTruth, WAVE_STATUS, NOTES, HINTS, KNOWN_STATES };
