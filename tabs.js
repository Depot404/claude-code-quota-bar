const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isClaudeTab, claudeTabLabels } = require('./labels');
// « ce pid est-il vivant » : une seule vérité pour tout le projet (elle décide
// aussi bien de l'union des onglets ici que de la présence d'une session dans
// state.js) — cf. live-sessions.js.
const { pidAlive } = require('./live-sessions');

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
//
// ── LA COPIE MIROIR NE MENT PLUS (2.110.0, 2026-09-03) ──────────────────────
// Ce fichier a porté trois semaines durant sept parades contre « activeTab
// désigne un onglet d'arrière-plan » : preuve d'activation dans la charge,
// souvenir tenu (`held`), quarantaine et révocation sur transition d'état,
// grâce hors focus, détection de gel du canal RPC, acte primant sur l'API.
// Elles avaient TOUTES la même cause, et elle n'était pas ici : VS Code
// < 1.135 n'effaçait jamais le drapeau `isActive` de l'onglet quitté et
// renvoyait ce DTO en cache tel quel à chaque changement de titre ou d'icône,
// si bien que tout onglet déjà visité se déclarait actif dès qu'il était
// réécrit (mainThreadEditorTabs.ts ; microsoft/vscode#331914, corrigé le
// 2026-08-21, livré en 1.135.0). `engines.vscode` exige désormais ≥ 1.135 :
// la copie miroir dit vrai, une divergence EST une bascule, et il n'y a plus
// rien à retenir, à mettre en quarantaine ni à geler. Historique complet et
// preuves : NOTES_architecture.md, NOTES_audit_simplification_harmonisation_
// 2026-09-02.md §8.
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
  // Instant du dernier CHANGEMENT DE VALEUR de lastActiveLabel : c'est la
  // référence que le juge renderer de state.js compare au flush du memento
  // avant de COMBLER un surlignage vide — un memento antérieur au dernier avis
  // de ce tracker n'apprend rien. Date.now() à la création, pas 0 : la lecture
  // initiale vient d'un canal NEUF (fiable), un memento flushé avant le reload
  // ne doit pas la contredire — le premier flush d'après reload, lui, la jugera.
  let labelChangedAt = Date.now();
  function noteLabelWillChange(next) {
    if (next !== lastActiveLabel) labelChangedAt = Date.now();
  }

  // IDENTITÉ de l'onglet activé par le dernier acte (2026-08-29). Un acte ne
  // porte qu'un LIBELLÉ — inutilisable quand deux conversations en partagent
  // un, c'est-à-dire exactement le cas que le focus par identité résout côté
  // clic. Sans ce canal, un clic exact laisserait le surlignage MUET (state.js
  // refuse de désigner au hasard) : l'onglet serait bon, la ligne surlignée
  // nulle part. Ne vaut que tant que l'onglet actif est bien celui de l'acte —
  // cf. son exposition dans getTabs.
  let actIdentity = null;           // { label, sessionId } | null

  // Focus de LA FENÊTRE (pas de l'onglet) : lu à la création, puis tenu à jour
  // par onDidChangeWindowState ci-dessous. Sert au journal — reconnaître les
  // verdicts « juste après un alt-tab » sans avoir à corréler à la main.
  // `vscode.window.state` peut être absent d'un bouchon de banc : le doute
  // profite à « fenêtre au premier plan », comme le repli déjà en place plus bas.
  let windowFocused = true;
  try { windowFocused = vscode.window.state.focused; } catch {}
  let lastFocusGainedAt = Date.now();

  // La copie miroir dit vrai (VS Code ≥ 1.135, cf. l'en-tête du fichier) :
  // toute divergence entre la lecture fraîche et le souvenir EST une bascule,
  // et s'adopte. Le souvenir garde son unique rôle : le REPLI quand l'onglet
  // actif n'est pas une conversation Claude.
  function refreshActiveLabel() {
    const l = localActiveLabel();
    if (!l || l === lastActiveLabel) return false;
    noteLabelWillChange(l);
    lastActiveLabel = l;
    lastActiveIndex = localActiveIndex();
    return true;
  }

  // Point d'entrée de l'acte : appelé par extension.js juste après avoir fait
  // activer un onglet, ici (focus.js `focusConversation`) ou dans une AUTRE
  // fenêtre qui répond au relais (`createFocusRelay` `onActivated`).
  // `label` = celui réellement activé (jamais deviné : focusTab() a déjà trouvé
  // l'onglet par correspondance, cf. focus.js `findTab`).
  //
  // Ce que l'acte apporte encore, et lui seul : l'IDENTITÉ de la conversation
  // visée (`opts.sessionId`), que la barre d'onglets ne porte pas. La copie
  // miroir, elle, n'a plus besoin d'être devancée — l'événement d'onglet qui
  // suit dira la vérité, et il aura raison.
  function reportActivation(label, opts) {
    if (disposed || !label) return;
    // Posée AVANT toute sortie anticipée : le cas `label === localActiveLabel()`
    // (l'onglet visé était déjà l'actif) est justement celui d'un clic sur la
    // conversation déjà à l'écran, où le surlignage doit pouvoir se poser sur
    // la bonne sœur.
    actIdentity = (opts && opts.sessionId) ? { label, sessionId: opts.sessionId } : null;
    const fresh = localActiveLabel();
    noteLabelWillChange(label);
    lastActiveLabel = label;
    // La position ne se mémorise que si l'API confirme déjà l'activation (elle
    // met son modèle à jour de façon synchrone sur une fenêtre saine). Si elle
    // dit encore autre chose, l'index qu'on lirait serait celui de l'ONGLET
    // PRÉCÉDENT : `null` fait retomber state.js sur le matching par libellé,
    // jamais sur une position fausse.
    lastActiveIndex = (fresh === label) ? localActiveIndex() : null;
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
      if (focused === false) return;
      lastFocusGainedAt = Date.now();
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
    // fenêtre — chaque instance surligne ce que SA fenêtre regarde). LU À
    // CHAQUE APPEL : la copie miroir de VS Code ≥ 1.135 dit vrai, donc la
    // lecture fraîche a toujours le dernier mot — c'est elle qui répare seule
    // une désynchronisation, sans attendre le moindre événement (2026-08-15).
    //
    // Le souvenir garde son unique rôle : REPLI quand l'onglet actif n'est pas
    // une conversation Claude — basculer sur un fichier ne doit pas éteindre le
    // surlignage.
    //
    // `source` : d'où vient `activeLabel` — `fresh` (lecture instantanée de
    // l'API) ou `remembered` (repli sur le souvenir, l'onglet actif n'est pas
    // une conv Claude). Journalisé par le verdict de surlignage (state.js).
    getTabs() {
      if (disposed) {
        return {
          known: false, labels: allLabels(), activeLabel: null, activeIndex: null,
          source: null, windowFocused, sinceFocusMs: Date.now() - lastFocusGainedAt,
          actSessionId: null, labelChangedAt,
        };
      }
      const fresh = localActiveLabel();
      // `activeIndex` suit exactement le même cycle fresh/remembered que
      // `activeLabel` — MÊME lecture instantanée (localActiveIndex), MÊME
      // souvenir de repli. Consommé par state.js (lot 2 du plan d'appariement)
      // pour distinguer, parmi deux onglets au libellé identique, LEQUEL est
      // physiquement actif — chose que le libellé seul ne peut plus dire dès
      // qu'il y a collision.
      const freshIndex = fresh ? localActiveIndex() : null;
      if (fresh) {
        noteLabelWillChange(fresh);
        lastActiveLabel = fresh;
        lastActiveIndex = freshIndex;
      }
      const activeLabel = fresh || lastActiveLabel;
      const activeIndex = fresh ? freshIndex : lastActiveIndex;
      return {
        known: true, labels: allLabels(), activeLabel, activeIndex,
        source: fresh ? 'fresh' : 'remembered',
        windowFocused, sinceFocusMs: Date.now() - lastFocusGainedAt,
        // Identité du dernier acte, servie UNIQUEMENT si l'onglet actif est
        // toujours celui qu'il désignait : dès que l'actif change, l'acte ne
        // dit plus rien de la sœur affichée et se tait (state.js retombe alors
        // sur ses autres preuves d'identité, jamais sur un tirage au sort).
        actSessionId: (actIdentity && actIdentity.label === activeLabel) ? actIdentity.sessionId : null,
        // Instant du dernier changement de valeur du souvenir — la référence
        // que le juge renderer (state.js) compare au flush du memento avant de
        // combler un surlignage vide. Cf. sa déclaration en tête de tracker.
        labelChangedAt,
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
