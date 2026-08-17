const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isClaudeTab, claudeTabLabels } = require('./labels');
// « ce pid est-il vivant » : une seule vérité pour tout le projet (elle décide
// aussi bien de l'union des onglets ici que de la présence d'une session dans
// state.js) — cf. live-sessions.js.
const { pidAlive } = require('./live-sessions');
// Le gel de la copie miroir (cf. section « acte vs API » plus bas) laisse une
// trace dans le même journal que l'ack : c'est déjà le canal qui a servi à
// PROUVER l'incident du 2026-08-17 (fenêtre SalaireADC, 3 h de gel).
const { logEvent } = require('./ack-journal');

// ============================================================================
// Suivi des onglets de conversation (lot 5).
//
// POURQUOI — fermer l'onglet d'une conv doit la faire disparaître du panneau
// tout de suite. On ne peut PAS s'appuyer sur le hook SessionEnd : il ne tire
// ni sur /exit ni sur /clear (anthropics/claude-code#17885, #6428) et reste
// erratique à la fermeture d'un onglet (#14760, #45424). Quand il ne tire pas,
// la conv ne sort qu'à l'expiration de recentMs (4 h) ou du fade `done`
// (30 min) — la « grosse latence » signalée. La seule source fiable est ici,
// côté VS Code : onDidChangeTabs.
//
// POURQUOI UN FICHIER PAR INSTANCE — le panneau liste les convs du WORKSPACE,
// pas celles de la fenêtre : une conv du même workspace peut très bien avoir son
// onglet dans une AUTRE fenêtre VS Code, dont les tabGroups nous sont
// invisibles (chaque fenêtre a son propre hôte d'extension). La présence se
// juge donc sur l'UNION des onglets de toutes les instances — sinon chaque
// fenêtre masquerait les convs ouvertes chez les autres.
//
// Un fichier PAR PID (~/.claude/panel-tabs/<pid>.json) plutôt qu'un fichier
// partagé : chaque fichier n'a qu'un seul écrivain, donc aucun read-modify-write
// concurrent à arbitrer — pas de lock du tout, contrairement à
// sessions-state.json où N hooks fusionnent dans le même objet. Le nettoyage
// d'une instance morte se réduit à un unlink. Le rename atomique reste, lui,
// indispensable : un lecteur ne doit jamais voir un JSON tronqué.
//
// SENS DE L'ÉCHEC — un fichier résiduel (pid réattribué par Windows) fait
// croire à des onglets qui n'existent plus : la conv reste affichée, soit
// exactement le comportement d'avant le lot 5. L'inverse (masquer une conv
// vivante) serait une perte d'information. Le doute profite donc à l'affichage.
// ============================================================================

const TABS_DIR = path.join(os.homedir(), '.claude', 'panel-tabs');
const OWN_FILE = path.join(TABS_DIR, `${process.pid}.json`);

// Délai avant de CONFIRMER qu'un onglet signalé fermé l'est vraiment.
//
// Un onglet déplacé (d'un groupe à l'autre, voire vers une autre fenêtre) est
// signalé fermé puis rouvert, et rien ne garantit que VS Code livre les deux
// dans le même événement : la doc de TabChangeEvent ne dit pas ce que valent
// `closed`/`opened` sur un déplacement, et microsoft/vscode#146786 (classé
// « as-designed ») montre que split/drop émettent PLUSIEURS événements. Plutôt
// que de parier sur cet ordre, on relit l'union un instant plus tard : si le
// libellé est revenu (ici ou chez une voisine), il n'a jamais été fermé.
// 150 ms est invisible à l'œil et laisse ~850 ms de marge sur l'exigence « la
// conv disparaît en moins d'une seconde ».
const CLOSE_CONFIRM_MS = 150;

// Délai avant de déclarer la copie miroir des onglets GELÉE (2026-08-17,
// diagnostic prouvé sur une fenêtre restée figée 3 h : voir
// PLAN_gel_tabs_api_2026-08-17.md). Une activation que NOUS venons de commander
// (clic panneau → focusTab()) DOIT produire un onDidChangeTabs — VS Code met à
// jour son modèle de rendu de façon synchrone, l'événement suit en quelques ms
// sur une fenêtre saine. Si rien n'arrive dans ce délai, le canal RPC de cette
// fenêtre est mort : ni un tick de plus ni une nouvelle lecture ne le
// réveilleront, seul un reload de fenêtre ressuscite le canal.
// Override de banc (même motif que CLAUDE_QUOTA_CANARY_MS, extension.js) :
// attendre 2 s pour de vrai à chaque run serait un coût de banc, pas une
// preuve de plus.
const FREEZE_DETECT_MS = Number(process.env.QUOTABAR_FREEZE_DETECT_MS) || 2000;

function log(fmt, ...args) { console.log('[QuotaBar] ' + fmt, ...args); }

function localLabels() {
  try { return claudeTabLabels(vscode.window.tabGroups.all); } catch { return []; }
}

// Libellé de l'onglet Claude ACTIF (onglet actif du groupe actif de CETTE
// fenêtre), ou null si l'onglet actif n'est pas une conversation Claude.
// Même définition que l'ack (ack.js) : ailleurs = simplement affiché, pas
// sélectionné.
//
// EXPORTÉE (plan repli-auto étape 9) pour le ⌂-focus (lier l'onglet actif
// comme master) : contrairement à `lastActiveLabel`/`getTabs().activeLabel`
// ci-dessous — qui RESTE sur le dernier onglet Claude vu tant qu'on n'en
// revisite pas un autre, exprès pour ne pas éteindre le surlignage quand on
// bascule sur un fichier — le ⌂-focus a besoin de la vérité INSTANTANÉE :
// « l'onglet actif EST-IL une conv Claude, là, maintenant ? ». Un onglet
// non-Claude actif doit faire échouer le lien, jamais retomber sur le
// souvenir d'une conv visitée plus tôt.
function localActiveLabel() {
  try {
    const group = vscode.window.tabGroups.activeTabGroup;
    const tab = group && group.activeTab;
    return tab && isClaudeTab(tab) && tab.label ? tab.label : null;
  } catch { return null; }
}

function publish(labels) {
  const tmp = `${OWN_FILE}.tmp`;
  try {
    fs.mkdirSync(TABS_DIR, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, ts: Date.now(), labels }));
    fs.renameSync(tmp, OWN_FILE);
  } catch (e) {
    // Le rename ÉCHOUE parfois sous Windows (le fichier cible est ouvert en
    // lecture par une voisine à l'instant même) — et le .tmp restait alors sur
    // le disque pour toujours : personne ne le relisait, personne ne le
    // nettoyait (otherLabels ne connaissait que les <pid>.json). 17 orphelins
    // constatés le 2026-08-07. On repart donc propre, quitte à republier au
    // prochain événement d'onglet : le sens de l'échec ne change pas, une
    // publication manquée ne masque jamais une conversation (l'union se lit
    // sur les fichiers présents, et l'ancien <pid>.json reste valable).
    try { fs.unlinkSync(tmp); } catch {}
    log('tabs publish failed: %s', e && e.message);
  }
}

// Libellés publiés par les AUTRES fenêtres, en nettoyant au passage les fichiers
// d'instances mortes (VS Code fermé brutalement : dispose() n'a pas tourné) —
// y compris leurs .tmp restés d'un rename raté (cf. publish ci-dessus). Un .tmp
// d'instance VIVANTE, lui, ne se touche pas : elle est peut-être en train de
// l'écrire.
function otherLabels() {
  let files;
  try { files = fs.readdirSync(TABS_DIR); } catch { return []; }
  const out = [];
  for (const f of files) {
    const m = /^(\d+)\.json(\.tmp)?$/.exec(f);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid) continue;
    const file = path.join(TABS_DIR, f);
    if (!pidAlive(pid)) {
      try { fs.unlinkSync(file); } catch {}
      continue;
    }
    // Un .tmp d'instance vivante n'est pas une publication : c'est un fichier
    // à moitié écrit ou le résidu d'un rename raté. On ne le lit jamais — son
    // <pid>.json, lui, porte la dernière union valable.
    if (m[2]) continue;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(data.labels)) out.push(...data.labels.filter((l) => typeof l === 'string'));
    } catch {}
  }
  return out;
}

// onTabsClosed(labels) : onglets Claude réellement disparus de CETTE fenêtre.
// onChange() : quelque chose a bougé (ici ou ailleurs) → recompute du snapshot.
function createTabTracker(handlers = {}) {
  const onTabsClosed = typeof handlers.onTabsClosed === 'function' ? handlers.onTabsClosed : () => {};
  const onChange = typeof handlers.onChange === 'function' ? handlers.onChange : () => {};
  let watcher = null;
  let disposed = false;
  const pendingClosed = new Set();
  let confirmTimer = null;

  // Dernier onglet Claude SÉLECTIONNÉ dans cette fenêtre — c'est lui que le
  // panneau surligne (state.js). On MÉMORISE plutôt que de lire à la volée :
  // basculer sur un onglet fichier ne doit pas éteindre le surlignage — la
  // « conversation courante » reste la dernière visitée. Le libellé se rafraîchit
  // aussi sur `changed` (bascule prompt → ai-title pendant que l'onglet est
  // actif), sinon il ne matcherait plus aucun titre après renommage.
  let lastActiveLabel = localActiveLabel();

  // ── Acte vs API : la preuve la plus fraîche gagne (2026-08-17) ────────────
  // Quand NOUS activons un onglet (clic panneau → focusTab()), on SAIT qui
  // devient actif sans avoir besoin de relire l'API — utile en soi (moins un
  // aller-retour) et vital quand la copie miroir de l'hôte d'extension est
  // GELÉE : lire frais relit alors le gel, recomputer relit le gel, un seul
  // signal reste vrai : ce qu'on vient de commander. `actReport` porte cette
  // preuve ; `lastTabsEventAt` porte la preuve concurrente (l'API a bien
  // parlé DEPUIS). Celle des deux qui est la plus récente gagne (cf. getTabs).
  //
  // Compteur monotone, PAS `Date.now()`, pour arbitrer l'ordre : deux appels
  // synchrones (un événement suivi dans la même passe par un `reportActivation`)
  // peuvent tomber dans la même milliseconde — l'horloge ne distinguerait plus
  // « avant » de « après » et l'acte perdrait la main à tort. Même motif que
  // `createVerdictFilter` (ack-journal.js).
  let seq = 0;
  let actReport = null;             // { label, at } | null
  let lastTabsEventAt = 0;
  let frozen = false;
  let freezeTimer = null;

  // Un événement d'onglet RÉEL (onDidChangeTabs ou onDidChangeTabGroups) est
  // la seule preuve que le canal RPC est vivant — l'un ou l'autre suffit, les
  // deux meurent ensemble dans l'incident constaté. Toute réception éteint le
  // détecteur de gel en cours ET lève le gel s'il était posé : le canal vient
  // de prouver qu'il répond, même si aucun autre champ n'a changé.
  function noteTabsEventReceived() {
    lastTabsEventAt = ++seq;
    if (freezeTimer) { clearTimeout(freezeTimer); freezeTimer = null; }
    if (frozen) {
      frozen = false;
      logEvent('tabs-freeze-cleared', {});
      onChange();
    }
  }

  function refreshActiveLabel() {
    const l = localActiveLabel();
    if (!l || l === lastActiveLabel) return false;
    lastActiveLabel = l;
    return true;
  }

  // Point d'entrée de la moitié « acte » : appelé par extension.js juste après
  // avoir fait activer un onglet, ici (focus.js `focusConversation`) ou dans
  // une AUTRE fenêtre qui répond au relais (`createFocusRelay` `onActivated`).
  // `label` = celui réellement activé (jamais deviné : focusTab() a déjà
  // trouvé l'onglet par correspondance, cf. focus.js `findTab`).
  //
  // Armement du détecteur de gel UNIQUEMENT si l'activation vient de diverger
  // de ce que l'API dit là, maintenant : sur une fenêtre saine, VS Code met à
  // jour son modèle de façon SYNCHRONE lors de l'activation — `localActiveLabel()`
  // renvoie donc déjà `label`, aucune divergence, rien à armer (l'événement,
  // lui, suivra de toute façon dans la foulée). Une divergence ne peut venir
  // que d'un canal mort : c'est exactement le signal qu'on cherche.
  function reportActivation(label) {
    if (disposed || !label) return;
    actReport = { label, at: ++seq };
    if (label === localActiveLabel()) return;
    clearTimeout(freezeTimer);
    freezeTimer = setTimeout(() => {
      freezeTimer = null;
      if (disposed || frozen) return;
      frozen = true;
      logEvent('tabs-freeze-detected', { label });
      onChange();
    }, FREEZE_DETECT_MS);
  }

  publish(localLabels());

  function allLabels() {
    return [...localLabels(), ...otherLabels()];
  }

  // Un libellé n'est déclaré fermé que s'il a disparu de PARTOUT : le comparer à
  // l'union et non aux seuls onglets locaux couvre du même coup l'onglet glissé
  // vers une autre fenêtre, et la conv ouverte en double dans deux fenêtres
  // (fermer l'une ne la fait pas disparaître tant que l'autre l'a encore).
  // Comparaison exacte, sans labelMatches : on compare ici deux libellés
  // d'onglets, pas un libellé à un titre — même source, même troncature.
  function confirmClosed() {
    confirmTimer = null;
    if (disposed || !pendingClosed.size) return;
    const candidates = [...pendingClosed];
    pendingClosed.clear();
    const present = new Set(allLabels());
    const gone = candidates.filter((l) => !present.has(l));
    if (!gone.length) return;
    log('claude tab(s) closed: %j', gone);
    try { onTabsClosed(gone); } catch (err) { log('onTabsClosed failed: %s', err && err.message); }
  }

  const sub = vscode.window.tabGroups.onDidChangeTabs((e) => {
    if (disposed) return;
    // Preuve de vie du canal AVANT tout le reste : cet événement, quel que
    // soit son contenu, désarme le détecteur de gel et lève un gel en cours.
    noteTabsEventReceived();
    // Republier AVANT tout le reste : les autres fenêtres doivent voir la
    // nouvelle réalité tout de suite. `changed` compte aussi — c'est par lui que
    // passe « le libellé vient de basculer du prompt au vrai ai-title » ; sans
    // republication, l'union resterait sur l'ancien libellé et la conv
    // paraîtrait sans onglet.
    publish(localLabels());
    refreshActiveLabel();

    for (const t of (e && e.closed) || []) {
      if (isClaudeTab(t) && t.label) pendingClosed.add(t.label);
    }
    if (pendingClosed.size && !confirmTimer) {
      confirmTimer = setTimeout(confirmClosed, CLOSE_CONFIRM_MS);
    }
    onChange();
  });

  // Basculer d'un GROUPE d'éditeurs à l'autre change l'onglet actif de la
  // fenêtre sans émettre onDidChangeTabs (seul onDidChangeTabGroups tire,
  // cf. TabGroupChangeEvent.changed « e.g. have changed their active state »).
  // API absente d'une version → subscription vide, le surlignage rate juste
  // les bascules de groupe.
  let groupSub = { dispose() {} };
  try {
    groupSub = vscode.window.tabGroups.onDidChangeTabGroups(() => {
      if (disposed) return;
      // Même preuve de vie que onDidChangeTabs ci-dessus : les deux canaux
      // meurent ensemble dans l'incident constaté, l'un ou l'autre suffit à
      // prouver que celui-ci répond encore.
      noteTabsEventReceived();
      if (refreshActiveLabel()) onChange();
    }) || groupSub;
  } catch {}

  // Retour de focus sur la fenêtre — alt-tab depuis un autre programme, ou
  // bascule entre deux fenêtres VS Code.
  //
  // AUCUN événement d'onglet ne tire dans ce cas, et c'est logique : rien n'a
  // bougé dans la barre d'onglets. Mais c'est précisément l'instant où
  // l'utilisateur REGARDE le panneau — s'il a quitté VS Code depuis une
  // conversation et y revient sur une autre, ou si l'onglet actif a changé
  // pendant l'absence, le surlignage doit être juste TOUT DE SUITE. Sans ce
  // signal, la lecture fraîche de getTabs() est bien correcte mais personne ne
  // la demande : le panneau attend le tick d'horloge du moteur (30 s,
  // state.js) pour se remettre d'aplomb, et 30 s après un alt-tab c'est
  // exactement la fenêtre de temps pendant laquelle on regarde.
  //
  // `focused` absent (API plus ancienne) → on recompute quand même : un
  // recompute de trop est invisible (il ne pousse au webview que si le rendu
  // change vraiment), un surlignage faux ne l'est pas.
  // Why : 2026-08-15, 2e signalement — après le passage à la lecture fraîche,
  // le surlignage restait faux au retour d'alt-tab jusqu'au tick suivant.
  let focusSub = { dispose() {} };
  try {
    focusSub = vscode.window.onDidChangeWindowState((e) => {
      if (disposed || (e && e.focused === false)) return;
      onChange();
    }) || focusSub;
  } catch {}

  // Les autres fenêtres republient sur leurs propres changements d'onglets :
  // il faut recomputer ici aussi, sinon une conv rouverte ailleurs resterait
  // masquée chez nous jusqu'au prochain tick.
  try {
    watcher = fs.watch(TABS_DIR, () => { if (!disposed) onChange(); });
  } catch (e) {
    log('tabs watch failed: %s', e && e.message);
  }

  return {
    // Contrat consommé par state.js (buildSnapshot) : `known` dit si l'on sait
    // quelque chose des onglets. À false, AUCUNE conv n'est masquée.
    //
    // `activeLabel` : onglet Claude sélectionné ICI (le surlignage est par
    // fenêtre — chaque instance surligne ce que SA fenêtre regarde). LU À CHAQUE
    // APPEL, jamais servi depuis le seul souvenir. Le moteur d'état appelle
    // getTabs() à chaque recompute (extension.js, `tabs:`) : lire la vérité ici
    // rend le surlignage AUTO-RÉPARABLE. Un souvenir mis à jour uniquement par
    // événements suppose que ces événements couvrent TOUS les chemins par
    // lesquels un onglet devient actif — hypothèse déjà démentie une fois (la
    // bascule de groupe, rattrapée plus haut par onDidChangeTabGroups), et
    // impossible à prouver exhaustive sur une API qu'on ne maîtrise pas. La
    // lecture fraîche rend la question sans objet : même si AUCUN événement ne
    // tire, le prochain recompute (tick de 30 s, ou n'importe quel hook) remet
    // le surlignage d'aplomb tout seul.
    //
    // Le souvenir garde son unique rôle, inchangé : REPLI quand l'onglet actif
    // n'est pas une conversation Claude — basculer sur un fichier ne doit pas
    // éteindre le surlignage.
    //
    // Why : 2026-08-15, signalé sur capture — le panneau surlignait une
    // conversation quittée depuis un moment alors qu'un autre onglet était
    // sélectionné. Aggravant : cliquer sur la BONNE ligne ne réparait rien,
    // puisque son onglet était déjà actif — donc aucun événement à rattraper,
    // et le souvenir faux survivait au geste censé le corriger.
    //
    // Amendement 2026-08-17 — la lecture fraîche elle-même peut mentir : sur
    // une fenêtre dont le canal RPC est mort, `localActiveLabel()` relit la
    // MÊME copie miroir gelée, encore et encore. `actReport` (posé par
    // `reportActivation`) est alors la preuve la plus fraîche tant qu'AUCUN
    // événement d'onglet postérieur ne l'a supplanté — comparaison d'ORDRE
    // (compteur monotone, jamais l'horloge), jamais un timer arbitraire : si
    // un événement arrive, il reprend la main
    // (fenêtre saine, ou fenêtre qui se dégèle) ; s'il n'arrive jamais, l'acte
    // reste vrai indéfiniment (fenêtre gelée). `frozen` : cf. reportActivation
    // et noteTabsEventReceived — indicateur de gel, publié tel quel.
    getTabs() {
      if (disposed) return { known: false, labels: allLabels(), activeLabel: null, frozen: false };
      const fresh = localActiveLabel();
      if (fresh) lastActiveLabel = fresh;
      let activeLabel = fresh || lastActiveLabel;
      if (actReport && actReport.at > lastTabsEventAt) {
        activeLabel = actReport.label;
        lastActiveLabel = actReport.label;
      }
      return { known: true, labels: allLabels(), activeLabel, frozen };
    },
    // Câblage : extension.js appelle ceci juste après avoir fait activer un
    // onglet — ici (focus.js `focusConversation`) ou dans une autre fenêtre
    // qui répond au relais (`createFocusRelay` `onActivated`), sur SA propre
    // instance du tracker.
    reportActivation,
    dispose() {
      disposed = true;
      clearTimeout(confirmTimer);
      clearTimeout(freezeTimer);
      try { sub.dispose(); } catch {}
      try { groupSub.dispose(); } catch {}
      try { focusSub.dispose(); } catch {}
      try { if (watcher) watcher.close(); } catch {}
      // Notre fenêtre s'en va : ses onglets ne doivent plus compter dans l'union
      // des autres. En cas de crash, otherLabels() nettoie via pidAlive().
      try { fs.unlinkSync(OWN_FILE); } catch {}
    },
  };
}

module.exports = { createTabTracker, localActiveLabel, TABS_DIR, OWN_FILE };
