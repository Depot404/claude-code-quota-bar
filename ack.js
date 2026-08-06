const vscode = require('vscode');
const { isClaudeTab } = require('./labels');
const { logEvent } = require('./ack-journal');

// ============================================================================
// ⚠ CE MODULE N'ACQUITTE PLUS RIEN DEPUIS LE 2026-08-06 — il OBSERVE, il ne
// décide plus. Décision de l'utilisateur après un 8e signalement du ✓ vif
// introuvable : un séjour sur un onglet, si long soit-il, ne vaut plus « j'ai
// lu ». Le seul acte qui éteint un ✓ est le CLIC sur la ligne du panneau
// (extension.js `ackConversationById`). Tout ce qui suit décrit la mécanique de
// détection de séjour, conservée pour le journal (ack-journal.js) et pour le
// contexte des lignes d'ack — plus pour poser un accusé.
//
// L'HISTOIRE VAUT D'ÊTRE GARDÉE, c'est elle qui justifie la décision : quatre
// correctifs successifs ont ajouté quatre garde-fous à ce chemin (séjour
// postérieur à `busySince`, seuil postérieur à la fin du tour, identité d'onglet
// insensible au `rename_tab`, marque d'ouverture programmatique), et un
// cinquième cas est arrivé quand même — une fenêtre qui revient au premier plan
// avec la conversation déjà active. Un signal qui exige cinq exceptions ne
// mesurait pas ce qu'on croyait.
//
// ────────────────────────────────────────────────────────────────────────────
// Accusé de lecture d'une conversation terminée (lot 6a) — HISTORIQUE.
//
// POURQUOI — le lot 2 éteignait le ✓ « terminée » au bout de 30 min, par timer.
// Un délai arbitraire ne sait rien de l'utilisateur : il efface le ✓ d'un
// résultat jamais lu, et garde vif celui d'un résultat lu depuis 29 minutes. Le
// seul signal qui veut dire « j'ai vu » est d'être allé sur l'onglet, une fois
// le tour fini.
//
// CE QU'ON OBSERVE — l'onglet Claude actif DU GROUPE ACTIF, la fenêtre ayant le
// focus. Un onglet actif dans un groupe voisin, ou dans une fenêtre en
// arrière-plan, n'est pas consulté : il est simplement affiché.
//
// POURQUOI UN DWELL — deux façons de « visiter » un onglet sans le lire :
// Ctrl+Tab qui le traverse, et l'activation automatique du voisin quand on
// ferme un onglet. Les deux durent moins d'une seconde. Un séjour de 2 s les
// écarte sans jamais gêner une lecture réelle.
//
// POURQUOI DEUX SORTIES — `onDwell` couvre « j'arrive sur l'onglet après coup »,
// `dwellLabel()` couvre le cas symétrique, invisible autrement : l'onglet est
// DÉJÀ actif pendant que Claude finit. Aucune bascule ne viendra jamais, donc
// aucun événement — c'est à l'arrivée du `done` d'aller interroger le séjour en
// cours. Sans cette seconde sortie, lire un résultat en direct laisserait le ✓
// vif indéfiniment.
//
// ACK STRICT (lot 10) — incident 2026-07-15 : un onglet posé là depuis 1 h,
// pendant qu'on travaille ailleurs dans la MÊME fenêtre, satisfaisait déjà ces
// deux critères (actif + focus + 2 s) sans qu'on l'ait jamais regardé au moment
// où Claude finissait. Ce module ne peut PAS trancher seul : il ignore quand le
// run en cours a démarré. `dwellSince()` expose donc le début du séjour brut,
// que l'appelant (extension.js) compare à `busySince` de la conv — le séjour
// ne compte comme un acte observé que s'il a commencé APRÈS ce démarrage.
// Décision user : un faux « non lu » est acceptable, un faux « lu » ne l'est
// pas — donc en cas de doute, ne pas acquitter.
//
// SÉJOUR IDENTIFIÉ PAR L'ONGLET, PAS PAR SON LIBELLÉ (2026-07-22) — incident
// « le ✓ vif passe pâle tout seul ~2,3 s après la fin, sans qu'on ait regardé »,
// signalé plusieurs fois. Cause : l'extension Claude officielle réécrit l'onglet
// à la fin de chaque tour (message `rename_tab` : `panelTab.title` réaffecté ET
// `iconPath` basculé sur `claude-logo-done.svg` — vérifié dans
// anthropic.claude-code-2.1.217/extension.js). Cette réécriture déclenche
// `onDidChangeTabs` ~250 ms après le `done`. Or le séjour était identifié par le
// LIBELLÉ : la moindre variation le faisait naître à nouveau, `since` repartait
// à cet instant, et le dwell de 2 s expirait 2 s plus tard → accusé de lecture
// posé par un événement DE L'OUTIL, jamais par un acte de l'utilisateur (d'où
// l'offset constant `since + 2266 ms` mesuré dans sessions-state.json).
// Un séjour est désormais identifié par l'onglet lui-même (référence de l'objet
// `Tab`, à défaut sa position colonne#index) ; le libellé n'est plus qu'une
// étiquette rafraîchie en place, incapable de créer ou de réarmer un séjour.
//
// ACTIVATION PROGRAMMATIQUE (récidive n°4, 2026-08-05) — le moteur de vagues
// (extension.js `maybeAdvanceWaves`) et le formulaire de batch ouvrent chaque
// tâche via `executeCommand('claude-vscode.editor.open', …)` : l'onglet créé
// devient l'onglet ACTIF de VS Code, exactement comme un clic. Ce module ne
// peut PAS distinguer les deux depuis `onDidChangeTabs` — l'événement est
// identique. Résultat observé (état-témoin
// ~/.claude/quotabar-ack-temoin-2026-08-05.json) : un batch de 4 tâches où
// chaque onglet naît quelques ms APRÈS son `busySince` (le CLI est spawné à
// l'ouverture, cf. launcher.js) — la garde du lot 10 (dwellSince > busySince)
// est donc naturellement satisfaite, alors que personne n'a rien regardé.
// Tant que l'onglet reste seul actif (fenêtre focus, rien d'autre ne bouge —
// plausible sur plusieurs minutes si l'user est simplement absent du clavier),
// le dwell de 2 s finit par passer.
// Fix : l'appelant (extension.js) sait QUAND il vient d'exécuter cette
// commande — il le déclare via `markProgrammaticOpen()` juste avant. La
// PROCHAINE fois que `reevaluate()` voit naître un séjour sur un NOUVEL onglet
// (jamais sur un `sameTab()`, donc jamais sur un simple rename_tab), ce séjour
// est marqué `programmatic` et `isProgrammatic()` le restera tant que l'onglet
// actif ne change pas VRAIMENT — l'appelant doit alors s'abstenir d'acquitter
// automatiquement (le clic explicite sur la ligne panneau reste la porte de
// sortie inconditionnelle, lot 10, inchangée). Un faux « non lu » est
// acceptable, un faux « lu » ne l'est pas (décision déjà actée, lot 10) : la
// marque expire (PROGRAMMATIC_MARK_TTL_MS) pour ne jamais coller à un onglet
// SANS RAPPORT ouvert bien plus tard (commande échouée, repli presse-papier…).
//
// INSTRUMENTATION (étape 18 phase 1, 2026-08-06) — 5e récidive : ce module
// journalise désormais la VIE DU SÉJOUR (naissance, re-titrage, mort, dwell
// atteint) et le cycle de la marque programmatique (posée, consommée fraîche ou
// périmée) dans ~/.claude/quotabar-ack-journal.jsonl, cf. ack-journal.js. Rien
// n'est décidé d'après ce journal : c'est une trace, la logique ci-dessous est
// inchangée. Ce qu'on cherche à voir en conditions réelles : QUEL séjour a
// couvert l'ack (né comment, quand, programmatique ou pas), et si la marque de
// 15 s expire avant le done d'un lot long — piste n°1 du plan, non prouvée.
// ============================================================================

const DWELL_MS = 2000;
// Marge large au-dessus de SESSION_WAIT_MS (launcher.js, 10 s) : le temps entre
// l'exécution de la commande d'ouverture et l'apparition réelle de l'onglet
// dans `onDidChangeTabs` ne doit jamais dépasser ça en pratique.
const PROGRAMMATIC_MARK_TTL_MS = 15000;

// Un abonnement qui n'existe pas (API absente d'une version de VS Code) ne doit
// pas emporter l'activation de l'extension : au pire l'ack rate un signal.
function subscribe(register, cb) {
  try { return register(cb) || { dispose() {} }; } catch { return { dispose() {} }; }
}

// Onglet Claude actif du groupe actif, avec son groupe — on a besoin des deux
// pour situer l'onglet (cf. tabIdentity).
function activeClaudeTab() {
  try {
    const group = vscode.window.tabGroups.activeTabGroup;
    const tab = group && group.activeTab;
    return tab && isClaudeTab(tab) && tab.label ? { group, tab } : null;
  } catch { return null; }
}

// Identité de l'onglet actif INDÉPENDANTE de son libellé et de son icône : sa
// position (colonne du groupe + rang dans le groupe). Un `rename_tab` n'y touche
// pas ; un changement d'onglet actif, si. `null` quand l'API ne permet pas de la
// calculer — l'appelant retombe alors sur la comparaison de libellés.
function tabIdentity(group, tab) {
  try {
    if (!group || !Array.isArray(group.tabs)) return null;
    const idx = group.tabs.indexOf(tab);
    if (idx < 0) return null;
    return `${group.viewColumn != null ? group.viewColumn : '?'}#${idx}`;
  } catch { return null; }
}

// Le séjour en cours porte-t-il sur le MÊME onglet que ce qu'on observe ?
// Trois preuves, de la plus forte à la plus faible : l'objet `Tab` est le même
// (VS Code mute ses instances en place lors d'un rename), à défaut sa position,
// à défaut son libellé (dernier repli, celui d'avant ce correctif).
function sameTab(stay, tab, identity, label) {
  if (stay.tab && tab && stay.tab === tab) return true;
  if (stay.identity && identity) return stay.identity === identity;
  return stay.label === label;
}

function windowFocused() {
  try { return !!(vscode.window.state && vscode.window.state.focused); } catch { return false; }
}

// handlers : { onDwell(label), dwellMs? }
function createAckTracker(handlers = {}) {
  const onDwell = typeof handlers.onDwell === 'function' ? handlers.onDwell : () => {};
  const dwellMs = handlers.dwellMs != null ? handlers.dwellMs : DWELL_MS;
  let current = null;   // { tab, identity, label, since, programmatic } — séjour en cours
  let timer = null;
  let disposed = false;
  let pendingProgrammaticAt = null;   // marque posée par markProgrammaticOpen(), consommée une fois

  // Consomme la marque si elle est encore fraîche — TTL pour ne jamais coller
  // à un séjour sans rapport si l'ouverture attendue n'a jamais abouti.
  function consumeProgrammaticMark() {
    if (pendingProgrammaticAt == null) return false;
    const ageMs = Date.now() - pendingProgrammaticAt;
    const fresh = ageMs < PROGRAMMATIC_MARK_TTL_MS;
    pendingProgrammaticAt = null;
    // `fresh: false` = la marque a expiré avant que l'onglet n'apparaisse : le
    // séjour qui naît n'est PAS protégé alors que l'ouverture était bien la
    // nôtre. C'est la piste n°1 du plan (étape 18) — cette ligne la prouve ou
    // l'écarte, en conditions réelles.
    logEvent('mark-consume', { ageMs, fresh, ttlMs: PROGRAMMATIC_MARK_TTL_MS });
    return fresh;
  }

  function reevaluate() {
    if (disposed) return;
    const found = windowFocused() ? activeClaudeTab() : null;
    const tab = found ? found.tab : null;
    const label = tab ? tab.label : null;
    const identity = found ? tabIdentity(found.group, tab) : null;

    // Plus d'onglet Claude consulté (focus perdu, bascule vers un fichier…) :
    // le séjour s'arrête net.
    if (!label) {
      clearTimeout(timer);
      timer = null;
      if (current) {
        logEvent('stay-end', {
          label: current.label,
          identity: current.identity,
          stayMs: Date.now() - current.since,
          programmatic: current.programmatic === true,
          focused: windowFocused(),
        });
      }
      current = null;
      return;
    }

    // Même onglet : on ne réarme surtout pas le compteur, sinon un événement
    // périodique (une frappe, un changement d'onglet ailleurs) le remettrait à
    // zéro et le dwell ne serait jamais atteint. On rafraîchit en revanche
    // l'étiquette et l'identité en place — c'est ici que passe le `rename_tab`
    // de fin de tour, qui ne doit RIEN redémarrer.
    if (current && sameTab(current, tab, identity, label)) {
      // Seul le RE-TITRAGE mérite une ligne : c'est le `rename_tab` de fin de
      // tour, l'événement qui a fabriqué l'ack de l'incident 2026-07-22. Les
      // rappels sans changement (frappe, événement voisin) ne sont pas
      // journalisés — ils n'apprennent rien et noieraient le journal.
      if (current.label !== label) {
        logEvent('stay-rename', {
          from: current.label, to: label, identity,
          stayMs: Date.now() - current.since,
          programmatic: current.programmatic === true,
        });
      }
      current.tab = tab;
      current.identity = identity;
      current.label = label;
      return;
    }

    clearTimeout(timer);
    const prev = current;
    current = { tab, identity, label, since: Date.now(), programmatic: consumeProgrammaticMark() };
    // Naissance d'un séjour : c'est LUI qui, 2 s plus tard, autorisera (ou non)
    // un ack. `programmatic` dit si la marque du lanceur l'a couvert ;
    // `previousLabel` dit d'où l'on vient (un séjour né d'un vrai changement
    // d'onglet ne se lit pas comme un séjour né d'une ouverture automatique).
    logEvent('stay-start', {
      label, identity,
      programmatic: current.programmatic === true,
      previousLabel: prev ? prev.label : null,
      previousStayMs: prev ? current.since - prev.since : null,
      focused: true,   // reevaluate() ne crée un séjour que fenêtre focus (cf. found)
    });
    timer = setTimeout(() => {
      timer = null;
      if (disposed || !current) return;
      logEvent('dwell-fired', {
        label: current.label,
        identity: current.identity,
        stayMs: Date.now() - current.since,
        dwellMs,
        programmatic: current.programmatic === true,
      });
      try { onDwell(current.label); } catch {}
    }, dwellMs);
  }

  const subs = [
    subscribe((cb) => vscode.window.tabGroups.onDidChangeTabs(cb), reevaluate),
    subscribe((cb) => vscode.window.tabGroups.onDidChangeTabGroups(cb), reevaluate),
    subscribe((cb) => vscode.window.onDidChangeWindowState(cb), reevaluate),
  ];
  reevaluate();

  return {
    // Libellé de l'onglet consulté depuis assez longtemps pour compter comme lu,
    // ou null. À interroger quand une conv vient de passer `done`.
    dwellLabel() {
      if (disposed || !current) return null;
      return Date.now() - current.since >= dwellMs ? current.label : null;
    },
    // Libellé de l'onglet où l'on séjourne EN CE MOMENT, sans condition de
    // durée. L'appelant compare lui-même `dwellSince()` à la fin du tour :
    // le seuil doit courir à partir de l'affichage du résultat, pas à partir de
    // l'arrivée sur l'onglet (un séjour antérieur au `done` ne prouve rien sur
    // ce qui s'affiche après).
    stayLabel() {
      return disposed || !current ? null : current.label;
    },
    // Début du séjour en cours (indépendant du seuil du dwell) — lot 10 : l'ack
    // strict compare CE timestamp au démarrage du run (`busySince`), pas la fin
    // du dwell. Sans lui, l'appelant ne peut pas distinguer « arrivé pendant que
    // ça tournait » de « déjà là depuis avant le lancement ».
    dwellSince() {
      return disposed || !current ? null : current.since;
    },
    // Le séjour en cours porte-t-il sur un onglet né d'une activation
    // PROGRAMMATIQUE (launcher, moteur de vagues) ? Tant que c'est le cas,
    // l'appelant doit s'abstenir d'acquitter automatiquement — cf. bandeau du
    // haut. Redevient `false` dès qu'un VRAI changement d'onglet survient
    // (sameTab() ne repasse jamais ici, donc un simple rename_tab ne l'efface
    // pas non plus, exactement comme `since`).
    isProgrammatic() {
      return !disposed && !!current && current.programmatic === true;
    },
    // À appeler par l'appelant JUSTE AVANT de déclencher une ouverture
    // d'onglet qu'il sait programmatique (executeCommand d'ouverture). Une
    // seule marque en vol à la fois — cohérent avec le lanceur, sérialisé.
    markProgrammaticOpen() {
      // Une marque déjà en vol qu'on remplace = une ouverture précédente dont
      // l'onglet n'est jamais apparu (commande échouée, onglet réutilisé…) :
      // le séjour correspondant ne sera donc jamais marqué. Cas à voir passer.
      logEvent('mark-set', {
        replacedPendingAgeMs: pendingProgrammaticAt == null ? null : Date.now() - pendingProgrammaticAt,
      });
      pendingProgrammaticAt = Date.now();
    },
    // Photo du séjour en cours, pour le journal de l'appelant (extension.js) —
    // lecture SEULE, aucun effet de bord : une ligne de journal ne doit jamais
    // pouvoir changer un verdict d'ack.
    journalContext() {
      const now = Date.now();
      return {
        stayLabel: disposed || !current ? null : current.label,
        stayIdentity: disposed || !current ? null : current.identity,
        staySince: disposed || !current ? null : current.since,
        stayMs: disposed || !current ? null : now - current.since,
        programmatic: !disposed && !!current && current.programmatic === true,
        pendingMarkAgeMs: pendingProgrammaticAt == null ? null : now - pendingProgrammaticAt,
        pendingMarkTtlLeftMs: pendingProgrammaticAt == null
          ? null : PROGRAMMATIC_MARK_TTL_MS - (now - pendingProgrammaticAt),
        focused: windowFocused(),
      };
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      current = null;
      pendingProgrammaticAt = null;
      for (const s of subs) { try { s.dispose(); } catch {} }
    },
  };
}

module.exports = { createAckTracker, DWELL_MS, PROGRAMMATIC_MARK_TTL_MS };
