const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isClaudeTab, claudeTabLabels, convMatchesLabel } = require('./labels');
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

// ── Quarantaine de bascule (lot C anti-vol d'onglet, 2026-08-27) ────────────
// Fenêtre pendant laquelle une activation qui désigne l'onglet d'une conv
// VENANT DE CHANGER D'ÉTAT (done/waiting) n'est plus une preuve, cf. la
// doctrine « une bascule ne s'adopte que prouvée » en tête de tracker et la
// démonstration du fantôme plus bas.
//
// D'OÙ VIENT LE CHIFFRE — journal `~/.claude/quotabar-ack-journal.jsonl`, deux
// épisodes mesurés : `done` 11:38:28,77 → adoption 11:38:29,18 (410 ms), puis
// sous instrumentation 2.79.0, `conv-transition` 12:09:24,545 → `tabs-proof`
// 12:09:24,662 (117 ms). 1500 ms couvre les deux avec plus du triple de marge.
//
// POURQUOI PAS PLUS LONG — la fenêtre est aussi le seul endroit où l'on peut
// retenir à tort un VRAI clic (l'utilisateur qui clique, dans la barre
// d'onglets, la conv qu'il vient de voir finir). L'allonger achète une marge
// sur un fantôme déjà couvert et paie en retard d'adoption sur un geste réel :
// on la garde au plus court que la mesure autorise.
//
// SYMÉTRIQUE — la même constante borne les deux sens (activation vue avant la
// transition, ou après) : le tracker reçoit l'événement d'onglet de VS Code,
// la transition vient du moteur d'état, et rien ne garantit leur ordre.
const FLIP_QUARANTINE_MS = Number(process.env.QUOTABAR_FLIP_QUARANTINE_MS) || 1500;

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
  // Instant du dernier CHANGEMENT DE VALEUR de lastActiveLabel (refactor
  // surlignage 2026-08-27, doctrine « le renderer est le juge ») : c'est la
  // référence que l'arbitre de state.js compare au flush du memento renderer —
  // la vérité disque ne corrige le surlignage que si elle est POSTÉRIEURE au
  // dernier avis de ce tracker, sinon un memento en retard rétrograderait un
  // clic tout frais. Date.now() à la création, pas 0 : la lecture initiale
  // vient d'un canal NEUF (fiable), un memento flushé avant le reload ne doit
  // pas la contredire — le premier flush d'après reload, lui, la jugera.
  let labelChangedAt = Date.now();
  function noteLabelWillChange(next) {
    if (next !== lastActiveLabel) labelChangedAt = Date.now();
  }

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

  // ── Activation FANTÔME : une bascule ne s'adopte que PROUVÉE ──────────────
  // (2026-08-23, « Nahimic » : une conversation finit de répondre fenêtre SANS
  // focus, et 0,4 s après l'onglet actif de la copie miroir EST devenu le sien,
  // écran inchangé — capture user : onglet visible « Survie… », surlignage
  // « Nahimic ». Parade d'alors : hors focus, on ne réécrit pas le choix.)
  //
  // (2026-08-26, « Architecture rapatriement » : MÊME fantôme fenêtre FOCUSÉE.
  // À 22:47:27, l'instant exact où cette conversation d'arrière-plan repasse
  // done, la copie miroir bascule sur son onglet et y RESTE 159 s, pendant que
  // l'écran affiche toujours l'onglet réellement sélectionné — capture user :
  // éditeur sur une conv en /compact, surlignage ailleurs ; journal :
  // highlight-verdict source:fresh windowFocused:true. La prémisse « sous
  // focus, l'API dit le geste » était donc fausse — et sa béquille aussi :
  // la confiance (apiTrusted d'alors) se réarmait sur N'IMPORTE QUEL événement
  // d'onglet reçu sous focus, or une conv d'arrière-plan qui finit en produit
  // un (titre/état), et le regain de focus produit des événements de GROUPE
  // mécaniques — le fantôme était blanchi en quelques ms (journal 22:19:29,
  // adoption 2 ms après le regain).)
  //
  // La règle qui neutralise la classe entière, INDÉPENDANTE du focus : une
  // BASCULE (libellé différent du souvenir) n'est adoptée que sur PREUVE —
  //  - un événement d'onglet dont la charge MONTRE une activation : un onglet
  //    Claude listé dans changed/opened avec isActive:true (TabChangeEvent :
  //    « Tabs that have changed, e.g have changed their isActive state ») ;
  //  - une vraie bascule de GROUPE : l'IDENTITÉ du groupe actif a changé —
  //    pas un événement de groupe mécanique à groupe actif constant ;
  //  - un acte (reportActivation : clic panneau, ici ou relayé) ;
  //  - un souvenir INVALIDE : l'onglet mémorisé n'existe plus localement
  //    (fermé, ou renommé — la bascule prompt → ai-title passe par là), la
  //    lecture fraîche est alors la seule information disponible.
  // Une lecture fraîche qui diverge SANS preuve est servie `source: 'held'`
  // et journalisée UNE fois par bascule tenue (tabs-flip-held) : si un fantôme
  // trouve une nouvelle porte, le journal dira laquelle au lieu de la laisser
  // deviner. La concordance (fresh === souvenir) reste adoptée à chaque
  // lecture — l'auto-réparation de 2026-08-15 ne portait que sur elle.
  // ── La preuve « isActive dans la charge » est CIRCULAIRE (2026-08-27) ─────
  // Le lot A avait instrumenté chaque événement porteur d'activation
  // (`tabs-proof`) pour trancher une question précise : l'événement menteur
  // d'une fin de session d'arrière-plan porte-t-il la PAIRE (ancien actif
  // isActive:false + nouveau isActive:true), auquel cas exiger la paire aurait
  // suffi à le reconnaître ? RÉPONSE MESURÉE : NON. Sur les 28 charges
  // relevées — fantômes ET vrais clics panneau confondus — la forme est
  // toujours la même, exactement UN onglet, isActive:true, zéro inactif.
  // Exiger la paire n'aurait pas fermé la porte : ça aurait refusé TOUTES les
  // bascules, y compris les vraies. Piste écartée sur données, pas sur avis.
  //
  // Ce qui reste, c'est que le champ `isActive:true` de la charge est une
  // RECOPIE de la copie miroir menteuse, pas un témoignage indépendant : il
  // affirme ce qu'on lui demande de prouver. Une fois le fantôme entré par
  // cette porte, la doctrine `held` le DÉFEND contre la vérité — plus aucun
  // événement ne vient le contredire (mensonge mesuré ≥ 8 min, fenêtre
  // focusée, l'utilisateur tapant ailleurs). Toute parade « relire plus tard »
  // est donc morte-née : c'est la MÊME source qu'on relirait.
  //
  // LA PORTE SE FERME PAR CORRÉLATION, pas par introspection de la charge. Le
  // fantôme n'est pas n'importe quelle activation : c'est celle qui désigne
  // l'onglet d'une conversation à l'instant où elle change d'état. Cet instant,
  // le moteur d'état le connaît par une source qui n'a rien à voir avec la
  // copie miroir (transcripts, fiches de hooks) — c'est lui qui arme ici une
  // QUARANTAINE sur cet onglet-là, pour FLIP_QUARANTINE_MS. Pendant la
  // quarantaine, `isActive:true` ne prouve plus rien et la bascule est tenue.
  //
  // CE QUI SORT DE QUARANTAINE — jamais la copie miroir, seulement un signal
  // humain qu'elle ne fabrique pas :
  //  - un clic sur la ligne du panneau (`reportActivation`) ;
  //  - un prompt envoyé dans cette conversation, vu par le basculement
  //    d'`active-session.json` (`noteActiveSession`) ;
  //  - le simple passage du temps : au-delà de la fenêtre, une NOUVELLE
  //    activation redevient une preuve ordinaire — c'est le cas de
  //    l'utilisateur qui clique l'onglet quelques secondes après la fin.
  // Le prix assumé est un RETARD d'adoption, jamais un refus définitif : dans
  // le pire cas (clic dans la barre d'onglets pendant la fenêtre, puis lecture
  // silencieuse), le surlignage reste sur l'onglet précédent jusqu'au geste
  // suivant de l'utilisateur, qui le répare quel qu'il soit.
  //
  // La quarantaine ne s'applique QU'À la preuve mesurée coupable — l'activation
  // dans la charge. Une vraie bascule de GROUPE (l'identité du groupe actif
  // change) reste une preuve pleine : elle exige un geste physique qu'aucune
  // fin de session ne produit, et aucun fantôme n'a jamais été relevé par là.
  let lastActiveGroupColumn = null;
  try { lastActiveGroupColumn = vscode.window.tabGroups.activeTabGroup.viewColumn; } catch {}
  let lastHeldLogged = null;

  // Onglets sous quarantaine : sessionId → { at, title, tabTitle } de la conv
  // qui vient de changer d'état. On garde les deux titres parce qu'un libellé
  // d'onglet peut matcher l'un ou l'autre (cf. convMatchesLabel, labels.js).
  const quarantine = new Map();
  // Dernière bascule ADOPTÉE et ce qu'elle a remplacé — la seule chose qui
  // permette de révoquer quand la transition est vue APRÈS coup.
  let lastAdoption = null;          // { label, index, prevLabel, prevIndex, at } | null
  // Dernier `activeSessionId` (session du DERNIER PROMPT utilisateur, cf.
  // state.js readActiveSessionId) déjà vu : c'est son CHANGEMENT qui vaut
  // geste humain, pas sa valeur.
  let lastActiveSessionSeen = null;

  function purgeQuarantine(now) {
    for (const [sid, q] of quarantine) {
      if (now - q.at > FLIP_QUARANTINE_MS) quarantine.delete(sid);
    }
  }

  // La conv sous quarantaine dont l'onglet porte ce libellé, ou null.
  function quarantinedFor(label) {
    if (!label) return null;
    const now = Date.now();
    purgeQuarantine(now);
    for (const [sid, q] of quarantine) {
      if (convMatchesLabel(label, q)) return { sessionId: sid, ageMs: now - q.at };
    }
    return null;
  }

  // Un geste humain vient de désigner cet onglet : sa quarantaine n'a plus
  // lieu d'être, et la révocation en attente non plus.
  function liftQuarantineFor(label, by) {
    const q = quarantinedFor(label);
    if (!q) return false;
    quarantine.delete(q.sessionId);
    logEvent('tabs-quarantine-lifted', { label, sessionId: q.sessionId, by, ageMs: q.ageMs });
    return true;
  }

  // Toute adoption de bascule passe par ici : c'est ce qui rend la révocation
  // possible (on sait ce qu'on a remplacé, et quand).
  function adoptFlip(label, index) {
    lastAdoption = {
      label, index, prevLabel: lastActiveLabel, prevIndex: lastActiveIndex, at: Date.now(),
    };
    noteLabelWillChange(label);
    lastActiveLabel = label;
    lastActiveIndex = index;
  }

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

  // `proof` : l'appelant tient une preuve de bascule (activation dans la charge
  // de l'événement, ou vraie bascule de groupe — cf. la doctrine ci-dessus).
  // Sans preuve, une bascule n'est adoptée que si le souvenir ne désigne plus
  // aucun onglet local (fermé, ou renommé — le rename in-place de l'onglet
  // actif passe par là) : sinon c'est le fantôme, on tient le choix de
  // l'utilisateur, focus ou pas.
  // `quarantinable` : la preuve invoquée est-elle l'activation DANS LA CHARGE,
  // celle que la mesure a montrée recopiée du miroir (donc circulaire) ? Une
  // bascule de groupe, elle, passe avec `false` — cf. la note ci-dessus.
  function refreshActiveLabel(proof, quarantinable) {
    const l = localActiveLabel();
    if (!l || l === lastActiveLabel) return false;
    if (proof && quarantinable) {
      const q = quarantinedFor(l);
      if (q) {
        // Une ligne par bascule retenue, jamais une par recompute : le journal
        // doit rester lisible pendant que le mensonge dure.
        if (lastHeldLogged !== l) {
          lastHeldLogged = l;
          logEvent('tabs-flip-quarantined', {
            fresh: l, kept: lastActiveLabel || null, sessionId: q.sessionId, ageMs: q.ageMs,
          });
        }
        proof = false;
      }
    }
    if (!proof && lastActiveLabel && localLabels().includes(lastActiveLabel)) return false;
    adoptFlip(l, localActiveIndex());
    return true;
  }

  // ── Entrées du moteur d'état (extension.js) ───────────────────────────────
  // `conv` : la conversation qui VIENT de passer done/waiting — { sessionId,
  // title, tabTitle }. Deux effets, un par sens possible de l'ordre :
  //  1. en avant : son onglet passe en quarantaine, une activation qui le
  //     désignerait dans la foulée ne sera plus une preuve ;
  //  2. en arrière : si la bascule a DÉJÀ été adoptée il y a moins de
  //     FLIP_QUARANTINE_MS et qu'elle désignait précisément cet onglet, elle
  //     est RÉVOQUÉE — on remet le choix qu'elle avait écrasé. Sans ce
  //     deuxième sens, il suffirait que l'événement d'onglet arrive avant le
  //     recompute du moteur pour que le fantôme repasse.
  // Révocation refusée si quoi que ce soit a été adopté depuis (lastAdoption
  // n'est plus le dernier fait) : on ne restaure jamais un état périmé.
  function noteConvTransition(conv) {
    if (disposed || !conv || !conv.sessionId) return;
    const now = Date.now();
    purgeQuarantine(now);
    quarantine.set(conv.sessionId, { at: now, title: conv.title, tabTitle: conv.tabTitle });
    if (!lastAdoption || now - lastAdoption.at > FLIP_QUARANTINE_MS) return;
    if (lastActiveLabel !== lastAdoption.label) return;
    if (!convMatchesLabel(lastAdoption.label, conv)) return;
    logEvent('tabs-flip-revoked', {
      fresh: lastAdoption.label, restored: lastAdoption.prevLabel || null,
      sessionId: conv.sessionId, ageMs: now - lastAdoption.at,
    });
    noteLabelWillChange(lastAdoption.prevLabel);
    lastActiveLabel = lastAdoption.prevLabel;
    lastActiveIndex = lastAdoption.prevIndex;
    lastAdoption = null;
    lastHeldLogged = null;
    onChange();
  }

  // `activeSessionId` du snapshot : la session du DERNIER PROMPT utilisateur
  // (state.js readActiveSessionId, `~/.claude/active-session.json`). Son
  // basculement est un geste humain qu'aucune copie miroir ne fabrique — donc
  // une porte de sortie de quarantaine légitime, et la seule qui couvre
  // « l'utilisateur écrit dans la conv qui vient de finir ».
  // On n'adopte que si la copie miroir désigne bien l'onglet de CETTE
  // conversation : le geste prouve l'intention sur elle, pas sur une autre.
  function noteActiveSession(sessionId) {
    if (disposed || !sessionId) return;
    if (sessionId === lastActiveSessionSeen) return;
    const first = lastActiveSessionSeen === null;
    lastActiveSessionSeen = sessionId;
    // Première observation : on ne sait pas si ça vient de changer, donc ce
    // n'est pas un geste (même prudence que `before === undefined` dans
    // maybeFetchOnTransition, extension.js).
    if (first) return;
    const q = quarantine.get(sessionId);
    if (!q) return;
    const fresh = localActiveLabel();
    quarantine.delete(sessionId);
    logEvent('tabs-quarantine-lifted', {
      label: fresh || null, sessionId, by: 'active-session', ageMs: Date.now() - q.at,
    });
    if (fresh && fresh !== lastActiveLabel && convMatchesLabel(fresh, q)) {
      adoptFlip(fresh, localActiveIndex());
      lastHeldLogged = null;
      onChange();
    }
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
  // `opts.origin` ('panel-click' | 'relay', 2026-08-27, lot A surlignage) :
  // d'où vient l'acte — posé ici par extension.js `focusConv`, ou relayé
  // depuis une autre fenêtre via createFocusRelay `onActivated`. `opts.isTrusted`
  // remonte jusqu'à `ev.isTrusted` du clic webview (panel.js) : c'est lui qui
  // arbitre, au lot B ci-dessous, si un acte non confirmé par un événement
  // d'onglet mérite encore le gel indéfini de 2026-08-17, ou doit expirer.
  function reportActivation(label, opts) {
    if (disposed || !label) return;
    const origin = (opts && opts.origin) || null;
    const isTrusted = !!(opts && opts.isTrusted);
    const fresh = localActiveLabel();
    // Journalisé à CHAQUE appel, divergent ou non : c'est la seule vue qui dit
    // si l'acte confirmait déjà ce que l'API voit (fresh === label, rien à
    // armer) ou divergeait dès le départ (canal gelé, ou fenêtre sans focus).
    logEvent('act-posted', { label, origin, isTrusted, fresh });
    // Porte de sortie n°1 de la quarantaine (lot C, 2026-08-27) : le clic sur
    // la ligne du panneau est le geste humain par excellence — il lève la
    // quarantaine de cet onglet AVANT toute écriture du souvenir, sinon
    // l'adoption ci-dessous serait aussitôt révoquée par une transition qui
    // arrive dans la foulée (cliquer une conv qui vient de finir est le cas
    // FRÉQUENT, pas le cas rare).
    liftQuarantineFor(label, origin || 'act');
    lastAdoption = null;
    noteLabelWillChange(label);
    // Un acte est un GESTE de l'utilisateur (clic panneau, ici ou relayé par
    // une autre fenêtre) : il confirme le souvenir, focus ou pas — c'est le
    // seul chemin légitime par lequel l'onglet actif change dans une fenêtre
    // sans focus, et sans cette écriture la parade anti-fantôme le tiendrait
    // en quarantaine comme un fantôme.
    if (label === fresh) {
      lastActiveLabel = label;
      lastActiveIndex = localActiveIndex();
      return;
    }
    lastActiveLabel = label;
    lastActiveIndex = null;
    actReport = { label, at: ++seq, origin, isTrusted };
    clearTimeout(freezeTimer);
    freezeTimer = setTimeout(() => {
      freezeTimer = null;
      if (disposed || frozen) return;
      // ── Lot B (2026-08-27) : un acte non confirmé N'EST PLUS gelé à
      // l'aveugle. Seul un geste dont le message webview portait
      // isTrusted:true (vrai clic humain, cf. panel.js) garde le comportement
      // du 2026-08-17 (frozen indéfini — c'est lui qui protège l'incident
      // SalaireADC, 3 h de gel). Un acte sans certification (message
      // synthétique, relais dont l'origine n'a pas pu être prouvée) est
      // ABANDONNÉ ici : retour à la doctrine souvenir+held, comme si aucun
      // acte n'avait jamais été posé.
      if (!isTrusted) {
        actReport = null;
        logEvent('act-expired', { label, origin });
        onChange();
        return;
      }
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
    // Preuve d'activation DANS la charge : seul un onglet Claude listé changé/
    // ouvert avec isActive:true témoigne d'une vraie bascule — le changement
    // de titre/état d'une conv d'arrière-plan qui finit n'en porte pas.
    let sawActivation = false;
    let changedOrOpened = null;
    try {
      changedOrOpened = [...((e && e.changed) || []), ...((e && e.opened) || [])]
        .map((t) => ({ label: (t && t.label) || null, isActive: !!(t && t.isActive), claude: isClaudeTab(t) }));
      sawActivation = changedOrOpened.some((t) => t.isActive && t.claude);
    } catch { sawActivation = false; changedOrOpened = null; }
    // Charge complète, UNE ligne par événement porteur d'activation (2026-08-27,
    // lot A surlignage) — trancher si l'événement menteur d'une fin de session
    // d'arrière-plan porte la PAIRE (ancien actif isActive:false + nouveau
    // isActive:true) ou seulement la moitié active, cf. la doctrine en tête de
    // fichier. `localActiveLabel()` lu APRÈS republish, donc au même instant
    // que refreshActiveLabel ci-dessous le lira.
    if (sawActivation) logEvent('tabs-proof', { tabs: changedOrOpened, activeLabel: localActiveLabel() });
    // `true` en second : c'est CETTE preuve-là que la mesure a montrée
    // circulaire (recopie du miroir), donc la seule soumise à quarantaine.
    refreshActiveLabel(sawActivation, true);

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
      // Preuve = l'IDENTITÉ du groupe actif a changé (l'utilisateur est passé
      // dans l'autre groupe — seul cas où l'onglet actif de la fenêtre bascule
      // sans onDidChangeTabs). Les événements de groupe mécaniques — regain de
      // focus notamment — gardent le même groupe actif et ne prouvent rien.
      let col = null;
      try { col = vscode.window.tabGroups.activeTabGroup.viewColumn; } catch {}
      const groupSwitched = col != null && lastActiveGroupColumn != null && col !== lastActiveGroupColumn;
      if (col != null) lastActiveGroupColumn = col;
      // Pas de quarantaine ici : changer de groupe actif est un geste physique
      // qu'aucune fin de session ne produit, et le journal n'a jamais relevé
      // de fantôme par ce canal.
      if (refreshActiveLabel(groupSwitched, false)) onChange();
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
      // À la perte de focus il n'y a rien à figer : le souvenir ne contient
      // QUE des choix prouvés (la doctrine vaut focus ou pas depuis le
      // 2026-08-26) — une dernière lecture fraîche pourrait au contraire y
      // glisser un fantôme déjà présent dans la copie miroir.
      if (focused === false) return;
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
    // CHAQUE APPEL — mais depuis le 2026-08-26 la lecture fraîche n'a plus le
    // dernier mot sur une BASCULE : elle répare la concordance et les
    // souvenirs invalides (auto-réparation de 2026-08-15, conservée), jamais
    // elle n'adopte seule un onglet différent — la copie miroir a prouvé
    // qu'elle sait mentir sur activeTab pendant des minutes, fenêtre focusée
    // (cf. la doctrine « une bascule ne s'adopte que prouvée » en tête de
    // tracker). Le geste de réparation universel reste le clic sur une ligne
    // du panneau : reportActivation adopte inconditionnellement.
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
    // `held` (2026-08-23, durci 2026-08-26 : la lecture fraîche diverge du
    // dernier choix PROUVÉ sans preuve de bascule — activation fantôme, cf.
    // la note en tête de tracker ; on sert le souvenir).
    // C'est le champ qui départage la piste du lot 1 (fraîcheur au retour de
    // focus) sans avoir à deviner depuis les symptômes.
    getTabs() {
      if (disposed) {
        return {
          known: false, labels: allLabels(), activeLabel: null, activeIndex: null, frozen: false,
          source: null, windowFocused, sinceFocusMs: Date.now() - lastFocusGainedAt,
          labelChangedAt,
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
      // Parade anti-fantôme (2026-08-23, durcie 2026-08-26 — cf. la note en
      // tête de tracker) : ICI, seule la CONCORDANCE adopte (fresh ===
      // souvenir, rien à confirmer), plus le cas de base — souvenir vide ou
      // qui ne désigne plus aucun onglet local (fermé, renommé) : la lecture
      // fraîche est alors la seule information disponible. Toute BASCULE
      // réelle a déjà été adoptée par sa preuve (événement porteur
      // d'activation, bascule de groupe, acte) avant d'arriver ici ; une
      // divergence restante est le fantôme — servie `source: 'held'`, et
      // journalisée une fois par bascule tenue, pour que la prochaine porte
      // d'entrée d'un fantôme se lise au journal au lieu de se deviner.
      const memoryValid = !!lastActiveLabel && localLabels().includes(lastActiveLabel);
      const freshConfirmed = !!fresh && (fresh === lastActiveLabel || !memoryValid);
      if (freshConfirmed) {
        noteLabelWillChange(fresh);
        lastActiveLabel = fresh;
        lastActiveIndex = freshIndex;
        lastHeldLogged = null;
      } else if (fresh && fresh !== lastHeldLogged) {
        lastHeldLogged = fresh;
        logEvent('tabs-flip-held', { fresh, kept: lastActiveLabel || null, windowFocused });
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
        noteLabelWillChange(actReport.label);
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
        // Instant du dernier changement de valeur du souvenir — la référence
        // que l'arbitre « le renderer est le juge » (state.js) compare au
        // flush du memento renderer. Cf. sa déclaration en tête de tracker.
        labelChangedAt,
      };
    },
    // Câblage : extension.js appelle ceci juste après avoir fait activer un
    // onglet — ici (focus.js `focusConversation`) ou dans une autre fenêtre
    // qui répond au relais (`createFocusRelay` `onActivated`), sur SA propre
    // instance du tracker.
    reportActivation,
    // Lot C (2026-08-27) — les deux signaux que le moteur d'état possède et
    // que la copie miroir ne peut pas fabriquer : quand une conv change
    // d'état, et quand l'utilisateur envoie un prompt.
    noteConvTransition,
    noteActiveSession,
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
