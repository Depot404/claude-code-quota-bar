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

// Position de l'onglet Claude actif dans localLabels() — MÊME ordre que
// claudeTabLabels (groupes puis onglets, dans l'ordre de vscode.window.tabGroups.all).
// Par IDENTITÉ de l'onglet (===), jamais par libellé : c'est précisément
// l'ambiguïté d'un libellé partagé par deux onglets que cet index sert à
// lever en aval (state.js, appariement bijectif, lot 2 du plan d'appariement
// des onglets, 2026-08-21). null si l'onglet actif n'est pas une conv Claude.
function localActiveIndex() {
  try {
    const group = vscode.window.tabGroups.activeTabGroup;
    const activeTab = group && group.activeTab;
    if (!activeTab || !isClaudeTab(activeTab) || !activeTab.label) return null;
    let idx = -1;
    let i = 0;
    for (const g of vscode.window.tabGroups.all) {
      for (const t of (g && g.tabs) || []) {
        if (!isClaudeTab(t)) continue;
        if (t === activeTab) idx = i;
        i++;
      }
    }
    return idx >= 0 ? idx : null;
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
  // Compagnon de lastActiveLabel, même cycle de vie : la position REMEMBERED
  // pour le repli (bascule sur un fichier — cf. lastActiveLabel plus haut).
  let lastActiveIndex = localActiveIndex();

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

  // Focus de LA FENÊTRE (pas de l'onglet) : lu à la création, puis tenu à jour
  // par onDidChangeWindowState ci-dessous. Sert au journal du lot 0 — reconnaître
  // les verdicts « juste après un alt-tab » sans avoir à corréler à la main.
  // `vscode.window.state` peut être absent d'un bouchon de banc : le doute
  // profite à « fenêtre au premier plan », comme le repli déjà en place plus bas.
  let windowFocused = true;
  try { windowFocused = vscode.window.state.focused; } catch {}
  let lastFocusGainedAt = Date.now();

  // ── Activation FANTÔME : une bascule hors focus n'est jamais un choix ─────
  // (2026-08-23, prouvé au journal : la conversation « Nahimic Companion »
  // finit de répondre à 00:05:20.655, fenêtre SANS focus, aucun geste — et
  // 0,4 s après, l'onglet actif de la copie miroir EST devenu son onglet,
  // alors que l'écran, lui, affichait toujours l'onglet que l'utilisateur
  // avait quitté. La capture de l'utilisateur montre les deux à la fois :
  // onglet visible « Survie… », surlignage « Nahimic ». L'API ment donc par
  // rapport au VISIBLE quand une conversation se termine en arrière-plan.)
  //
  // La règle qui neutralise la classe entière : un humain ne peut pas changer
  // d'onglet dans une fenêtre qui n'a pas le focus. Même le clic direct sur
  // l'onglet d'une fenêtre en arrière-plan donne D'ABORD le focus à la
  // fenêtre, et l'activation arrive ~110 ms APRÈS le regain (mesuré, deux
  // occurrences au journal du 2026-08-23) — donc toute activation légitime
  // est observée fenêtre focusée. D'où :
  //  - à la PERTE de focus, on fige le dernier choix de l'utilisateur (une
  //    dernière lecture fraîche : une bascule légitime sans événement juste
  //    avant la perte — le chemin de 2026-08-15 — est encore capturée) ;
  //  - hors focus, ni les événements ni la lecture fraîche ne réécrivent ce
  //    choix (seul le RENOMMAGE de l'onglet déjà actif — même position,
  //    libellé neuf, prompt → ai-title — reste suivi, et l'acte du relais,
  //    qui est un geste de l'utilisateur dans une autre fenêtre) ;
  //  - au regain, la lecture fraîche ne reprend la main que CONFIRMÉE : un
  //    événement d'onglet reçu sous focus (tout clic en produit), ou la
  //    simple concordance fresh === souvenir (rien à confirmer). Tant que la
  //    copie miroir diverge sans confirmation, on sert le souvenir,
  //    `source: 'held'` au journal.
  // L'auto-réparation de 2026-08-15 reste entière sous focus : fenêtre au
  // premier plan, fresh est adopté à chaque lecture, événement ou pas.
  let apiTrusted = true;

  // Un événement d'onglet RÉEL (onDidChangeTabs ou onDidChangeTabGroups) est
  // la seule preuve que le canal RPC est vivant — l'un ou l'autre suffit, les
  // deux meurent ensemble dans l'incident constaté. Toute réception éteint le
  // détecteur de gel en cours ET lève le gel s'il était posé : le canal vient
  // de prouver qu'il répond, même si aucun autre champ n'a changé.
  function noteTabsEventReceived() {
    lastTabsEventAt = ++seq;
    // Un événement d'onglet reçu FENÊTRE FOCUSÉE ne peut venir que d'un geste
    // (tout clic d'onglet en produit un) : il rend sa confiance à la copie
    // miroir. Hors focus, il peut porter l'activation fantôme — il compte
    // pour l'ordre acte/API, jamais comme confirmation.
    if (windowFocused) apiTrusted = true;
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
    const idx = localActiveIndex();
    // Hors focus, une BASCULE (position différente) est le fantôme possible :
    // on ne réécrit pas le choix de l'utilisateur. Le renommage de l'onglet
    // déjà actif (même position, libellé neuf), lui, reste suivi — sans lui,
    // le souvenir garderait un libellé qui n'existe plus et ne matcherait
    // plus rien après la bascule prompt → ai-title.
    if (!windowFocused && idx !== lastActiveIndex) return false;
    lastActiveLabel = l;
    lastActiveIndex = idx;
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
  //
  // ET C'EST LA MÊME CONDITION QUI DÉCIDE DE POSER L'ACTE (lot 1 du plan
  // d'appariement, 2026-08-21). Auparavant `actReport` était posé dans TOUS les
  // cas, divergence ou non — or l'activation d'un onglet DÉJÀ actif ne produit
  // jamais d'événement d'onglet (extension.js le dit noir sur blanc : « clic =
  // acte observé explicite, même si l'onglet est déjà actif — le seul cas où
  // aucune bascule ne peut jamais se produire »). `lastTabsEventAt` ne bougeait
  // donc plus JAMAIS au-dessus de cet acte, qui écrasait la lecture fraîche
  // recompute après recompute, indéfiniment.
  //
  // Ce que ça cassait : l'auto-réparation du 2026-08-15 (cf. getTabs ci-dessous
  // — « même si AUCUN événement ne tire, le prochain recompute remet le
  // surlignage d'aplomb tout seul »). Un acte éternel la neutralisait, et le
  // symptôme ressortait à l'instant où l'on REGARDE le panneau : au retour
  // d'alt-tab, le recompute a bien lieu, mais l'acte périmé répond à sa place.
  // Aggravant, identique à 2026-08-15 : cliquer sur la bonne ligne ne réparait
  // rien, puisque ce clic reposait un acte de plus.
  //
  // Un acte non divergent n'apporte STRICTEMENT rien : `localActiveLabel()`
  // renvoie déjà la même chose, la lecture fraîche est juste et reste
  // auto-réparable. On ne le pose donc plus. L'acte redevient ce pour quoi il a
  // été créé le 2026-08-17 : la seule vérité disponible quand la copie miroir
  // est GELÉE — cas où, par construction, il diverge.
  function reportActivation(label) {
    if (disposed || !label) return;
    // Un acte est un GESTE de l'utilisateur (clic panneau, ici ou relayé par
    // une autre fenêtre) : il confirme le souvenir, focus ou pas — c'est le
    // seul chemin légitime par lequel l'onglet actif change dans une fenêtre
    // sans focus, et sans cette écriture la parade anti-fantôme le tiendrait
    // en quarantaine comme un fantôme.
    if (label === localActiveLabel()) {
      lastActiveLabel = label;
      lastActiveIndex = localActiveIndex();
      return;
    }
    lastActiveLabel = label;
    lastActiveIndex = null;
    actReport = { label, at: ++seq };
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
      if (disposed) return;
      const focused = e ? e.focused : true;
      windowFocused = focused;
      if (focused) lastFocusGainedAt = Date.now();
      if (focused === false) {
        // FIGER le choix de l'utilisateur au moment où il part : une dernière
        // lecture fraîche (tout ce qui a précédé la perte s'est fait sous
        // focus, donc est de lui — y compris une bascule sans événement, le
        // chemin de 2026-08-15). Le fantôme, lui, arrive APRÈS cet instant.
        const l = localActiveLabel();
        if (l) { lastActiveLabel = l; lastActiveIndex = localActiveIndex(); }
        apiTrusted = false;
        return;
      }
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
    // `source` (lot 0 du plan d'appariement) — d'où vient `activeLabel` :
    // `fresh` (lecture instantanée de l'API), `remembered` (repli sur le
    // souvenir, l'onglet actif n'est pas une conv Claude), `act-report` (l'acte
    // mémorisé l'emporte sur l'API, cf. la note « Acte vs API » ci-dessus),
    // `held` (2026-08-23 : la lecture fraîche diverge du dernier choix de
    // l'utilisateur sans avoir été confirmée sous focus — activation fantôme
    // possible, cf. la note en tête de tracker ; on sert le souvenir).
    // C'est le champ qui départage la piste du lot 1 (fraîcheur au retour de
    // focus) sans avoir à deviner depuis les symptômes.
    getTabs() {
      if (disposed) {
        return {
          known: false, labels: allLabels(), activeLabel: null, activeIndex: null, frozen: false,
          source: null, windowFocused, sinceFocusMs: Date.now() - lastFocusGainedAt,
        };
      }
      const fresh = localActiveLabel();
      // `activeIndex` suit exactement le même cycle fresh/remembered que
      // `activeLabel` ci-dessous — MÊME lecture instantanée (localActiveIndex),
      // MÊME souvenir de repli. Consommé par state.js (lot 2 du plan
      // d'appariement) pour distinguer, parmi deux onglets au libellé
      // identique, LEQUEL est physiquement actif — chose que le libellé seul
      // ne peut plus dire dès qu'il y a collision.
      const freshIndex = fresh ? localActiveIndex() : null;
      // Parade anti-fantôme (2026-08-23, cf. la note en tête de tracker) :
      // fresh n'est adopté que CONFIRMÉ — confiance intacte (`apiTrusted`,
      // rendue par tout événement d'onglet reçu sous focus), ou concordance
      // avec le souvenir (rien à confirmer). Une divergence non confirmée —
      // l'activation fantôme d'une conversation qui finit en arrière-plan —
      // est tenue en quarantaine : on sert le dernier choix de l'utilisateur,
      // `source: 'held'`, jusqu'à ce qu'un geste sous focus tranche.
      const freshConfirmed = fresh && (apiTrusted || fresh === lastActiveLabel);
      if (freshConfirmed) {
        // La concordance n'efface le doute que fenêtre au premier plan : hors
        // focus, elle autorise l'adoption (identique de toute façon) mais un
        // fantôme ULTÉRIEUR dans la même absence doit encore être retenu.
        if (windowFocused) apiTrusted = true;
        lastActiveLabel = fresh;
        lastActiveIndex = freshIndex;
      }
      let activeLabel = freshConfirmed ? fresh : lastActiveLabel;
      let activeIndex = freshConfirmed ? freshIndex : lastActiveIndex;
      let source = freshConfirmed ? 'fresh' : (fresh ? 'held' : 'remembered');
      // L'acte ne l'emporte que TANT QU'IL A ENCORE UNE RAISON D'EXISTER (lot 1
      // du plan d'appariement, 2026-08-21) — deux états, et deux seulement :
      //  - `freezeTimer !== null` : l'acte vient d'être posé et attend sa
      //    confirmation. C'est la latence qu'il sert à combler (quelques ms sur
      //    une fenêtre saine) ; pendant cette fenêtre-là il prime, inchangé.
      //  - `frozen` : le délai est passé sans qu'aucun événement n'arrive, le
      //    canal RPC est mort. L'acte est alors la SEULE vérité disponible et le
      //    reste indéfiniment — c'est l'incident du 2026-08-17 (fenêtre
      //    SalaireADC, 3 h), que la ligne ci-dessous préserve mot pour mot.
      // Hors de ces deux états, la lecture fraîche reprend la main. Sans cette
      // borne, un acte que rien ne supplante (aucun événement d'onglet ne suit
      // l'activation d'un onglet déjà actif) écrasait `fresh` pour toujours sur
      // une fenêtre PARFAITEMENT SAINE, et le surlignage restait faux jusqu'au
      // prochain événement sans rapport. Cf. `reportActivation` ci-dessus, qui
      // ferme l'autre moitié du trou (ne plus poser d'acte inutile) : les deux
      // ensemble rendent à la lecture fraîche son auto-réparation de 2026-08-15,
      // celle qui se voit au retour d'alt-tab.
      // La distinction saine/gelée est celle que le plan exige, et elle existait
      // déjà : `frozen` / `noteTabsEventReceived`. On ne périme jamais l'acte au
      // jugé (pas de timer arbitraire, pas d'horloge) — on lui demande seulement
      // s'il est encore le mieux informé.
      // Honnêteté sur cette ligne : avec `reportActivation` corrigé, tout acte
      // posé arme le détecteur, et le seul chemin qui le désarme monte aussi
      // `lastTabsEventAt` — `actUsable` est donc AUJOURD'HUI impliqué par la
      // condition d'ordre qui la précède. Elle est gardée parce qu'elle ÉCRIT la
      // règle au lieu de la laisser dépendre de cet enchaînement : le jour où un
      // acte serait posé sans armer le détecteur, ou `frozen` levé par un autre
      // chemin, le trou se rouvrirait ici en silence.
      const actUsable = frozen || freezeTimer !== null;
      if (actReport && actReport.at > lastTabsEventAt && actUsable) {
        activeLabel = actReport.label;
        lastActiveLabel = actReport.label;
        source = 'act-report';
        // Pas d'index pour l'acte : `reportActivation` ne connaît que le
        // LIBELLÉ activé (focus.js n'a pas cherché sa position dans la liste
        // aplatie), et le calculer ici relirait la même copie miroir gelée
        // que `fresh` — sans valeur ajoutée sur canal mort. `null` fait
        // retomber le consommateur (state.js) sur le matching par libellé
        // d'avant ce lot, exactement le comportement déjà en place sur ce
        // chemin rare (fenêtre gelée) avant l'appariement bijectif.
        activeIndex = null;
        lastActiveIndex = null;
      }
      return {
        known: true, labels: allLabels(), activeLabel, activeIndex, frozen,
        source, windowFocused, sinceFocusMs: Date.now() - lastFocusGainedAt,
      };
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
