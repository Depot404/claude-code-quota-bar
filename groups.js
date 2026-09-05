// ============================================================================
// Groupes de conversations — persistance et cycle de vie (lot 2 du plan
// PLAN_creation_groupes_2026-07-22.md).
//
// Node PUR : la persistance est INJECTÉE (`load`/`save`), donc ce module se
// teste sans VS Code. En production, l'adaptateur est le `workspaceState` de
// l'extension — un groupe appartient à un workspace, exactement comme les
// conversations qu'il contient (elles sont listées depuis le dossier projet du
// workspace, cf. state.js).
//
// CE QU'EST UN GROUPE — des MÉTADONNÉES posées sur des conversations qui, elles,
// existent indépendamment. Rien d'autre. Conséquences, qui sont les invariants
// de ce fichier :
//   • dissoudre un groupe ne ferme, n'interrompt et ne supprime AUCUNE
//     conversation : seules les métadonnées disparaissent (décision du plan,
//     tableau des cas dégradés) ;
//   • retirer un membre ne fait pas plus : la conversation redevient une ligne
//     plate du panneau ;
//   • un membre peut exister SANS conversation (`sessionId: null`) — c'est le
//     cas normal entre l'ouverture d'un onglet et l'apparition de son fichier
//     de session, et le cas définitif quand aucun des trois étages de
//     rattachement (cf. attach.js) n'a su nommer la conversation. Un membre non
//     lié s'affiche tel quel ; on n'invente jamais de lien.
//
// UN sessionId N'APPARTIENT QU'À UN MEMBRE : `attach` refuse un identifiant
// déjà pris (par ce groupe ou un autre). Sans cette garde, l'étage 2 du
// rattachement (préfixe de prompt) pourrait accrocher la même conversation à
// deux membres au prompt identique — deux lignes pour une seule conv.
//
// CONVERSATION MAÎTRESSE (lot 11) — `masterSessionId` + `masterTitle` : la conv
// d'où vient le bloc collé. C'est un POINTEUR, pas un membre :
//   • elle ne compte ni dans les vagues ni dans « N/M done » ;
//   • elle n'est pas retirée de la liste plate du panneau — le groupe affiche
//     une ligne de tête qui la DÉSIGNE, la conversation, elle, continue sa vie
//     là où elle est (elle peut très bien être membre d'un groupe antérieur :
//     c'est même le cas nominal d'un chantier en lots, où le lot N propose les
//     handoffs du lot N+1) ;
//   • `masterTitle` est le titre AU MOMENT DU LIEN : quand la conv sort de la
//     fenêtre du panneau, la ligne de tête reste lisible plutôt que de devenir
//     un identifiant nu.
//   • `masterLinkedAt` est l'INSTANT du lien (plan « la maîtresse n'engage que
//     son dernier lot », 2026-08-15). Une même conversation de cadrage lance
//     plusieurs lots à des heures différentes : elle est alors revendiquée par
//     plusieurs groupes, ce qui est légitime — mais UN seul peut la rendre en
//     tête (il n'y a qu'un nœud de conversation dans le DOM). C'est le plus
//     RÉCEMMENT lié qui la garde, et la résolution se fait au rendu
//     (nesting.js), jamais en réécrivant le store : rien n'est délié tout seul.
//     Pourquoi un champ propre plutôt que `createdAt` du groupe : relier à la
//     main une maîtresse vers un groupe plus ancien doit avoir un effet visible
//     (la tête bascule vers lui) — jugé sur `createdAt`, le geste serait muet.
// Seule interdiction : elle ne peut pas être en même temps membre du MÊME
// groupe (ce serait la même conversation à deux places dans la même section).
//
// PREUVE DE FIN D'UN MEMBRE (lot D, 2026-09-05) — `doneProven` : posé à `true`
// par `markDoneProven` quand member-truth.js a OBSERVÉ un `done` écrit par une
// source (extension.js l'appelle à cet instant). Il survit à la fermeture de
// l'onglet, au reload, à la purge des hooks — c'est tout son objet : « 0/3
// done » sous trois ✓ venait de ce que la preuve partait avec l'onglet. Il ne
// retombe à `false` que quand le LIEN change (`relink` : attach, detach, rearm,
// dropMisattachedIntents) — une preuve appartient à une conversation, pas à
// une clé de membre.
// ============================================================================

// Teintes stables dérivées du nom : la même liste de convs regroupée sous le
// même nom garde la même pastille d'une fenêtre à l'autre, sans stocker de
// couleur (donc sans jamais avoir à la migrer). Saturation/luminosité fixes,
// choisies lisibles sur thème clair ET sombre — le reste du panneau n'utilise
// que des variables de thème, c'est la seule couleur libre.
function hueOf(name) {
  const s = String(name || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

// Vague la plus avancee deja ouverte (0 = aucune) — TOUJOURS derivee des
// membres, jamais stockee : c'est le seuil sous lequel plus rien ne se deplace
// ni ne s'ajoute. Le meme calcul trainait en double (moveQueuedMember, addTask),
// deux occasions de diverger.
function launchedWaveOf(g) {
  return g.members.reduce((max, m) => (m.launchedAt != null && m.wave > max ? m.wave : max), 0);
}

// Vagues renumerotees en une suite contigue — meme invariant que le
// compactWaves du formulaire de creation (panel.js, lot 1), pour que les memes
// glyphes ◂ ▸ veuillent dire la meme chose avant et apres le lancement d'un
// lot. Une vague videe par un deplacement ne laisse donc pas de trou : ce
// numero sert aussi de libelle au bouton d'ouverture (« ▶ vague 3 »), et un
// trou s'y lirait comme une vague perdue. L'ORDRE relatif est preserve, donc
// les vagues deja lancees restent devant, avec les memes numeros tant que la
// numerotation part de 1.
function compactWaves(g) {
  const waves = [...new Set(g.members.map((m) => m.wave))].sort((a, b) => a - b);
  const renum = new Map(waves.map((w, i) => [w, i + 1]));
  g.members.forEach((m) => { m.wave = renum.get(m.wave); });
}

// `launchedAt` n'est posé QUE pour la vague 1 (lot 4) : à la création, seule
// la vague 1 part ; les suivantes restent `queued` (launchedAt: null) jusqu'à
// markLaunched(), appelé par extension.js quand leur tour vient (▶ manuel ou
// avance auto).
function memberOfTask(task, key, at) {
  const wave = Number.isFinite(task && task.wave) && task.wave >= 1 ? Math.floor(task.wave) : 1;
  return {
    key,
    prompt: String((task && task.prompt) || ''),
    // Lot 14 : plus de valeur `inherit` — `null` = rien de demandé pour ce
    // membre (aucun écart intention/réel possible, cf. intents() ci-dessous).
    model: (task && task.model) || null,
    effort: (task && task.effort) || null,
    wave,
    sessionId: (task && task.sessionId) || null,
    launchedAt: wave === 1 ? at : null,
    doneProven: false,
  };
}

// Tout changement de LIEN passe ici : la preuve de fin (cf. en-tête) décrit la
// conversation qu'on quitte, jamais celle qu'on rejoint.
function relink(m, sessionId) {
  m.sessionId = sessionId;
  m.doneProven = false;
}

// Nettoyage défensif de ce qui sort du stockage : workspaceState garde du JSON
// écrit par une VERSION ANTÉRIEURE de l'extension (l'utilisateur met à jour, le
// stockage reste). Une entrée illisible est jetée, jamais interprétée à moitié.
function sanitizeGroup(g) {
  if (!g || typeof g !== 'object') return null;
  const id = typeof g.id === 'string' && g.id ? g.id : null;
  if (!id) return null;
  const members = (Array.isArray(g.members) ? g.members : [])
    .filter((m) => m && typeof m === 'object' && typeof m.key === 'string' && m.key)
    .map((m) => ({
      key: m.key,
      prompt: typeof m.prompt === 'string' ? m.prompt : '',
      // Lot 14 : un stockage antérieur peut porter l'ancienne valeur littérale
      // `'inherit'` — elle traverse ici telle quelle (c'est une chaîne comme
      // une autre pour ce garde-fou de type) ; les consommateurs (batch.js
      // isModel/isEffort) ne la reconnaissent plus et la traitent comme une
      // valeur inconnue, donc comme `null` au moment de poser les env vars.
      model: typeof m.model === 'string' ? m.model : null,
      effort: typeof m.effort === 'string' ? m.effort : null,
      wave: Number.isFinite(m.wave) && m.wave >= 1 ? Math.floor(m.wave) : 1,
      sessionId: typeof m.sessionId === 'string' && m.sessionId ? m.sessionId : null,
      launchedAt: Number.isFinite(m.launchedAt) ? m.launchedAt : null,
      // Absent d'un stockage antérieur au lot D : `false`, la preuve se
      // réobserve au prochain rendu si la source parle encore. Zéro migration.
      doneProven: m.doneProven === true,
    }));
  // Numérotation contiguë dès la LECTURE, pas seulement au prochain clic
  // (2026-08-22) : un stockage écrit avant ce lot peut porter un trou — une
  // vague vidée par l'ancien déplacement « +1 sur le numéro », ou par le
  // retrait de son dernier membre. Le panneau afficherait « vague 1 » puis
  // « vague 3 », et la flèche ◂ serait morte. L'invariant appartient au store :
  // il tient à l'entrée, pas au bon vouloir des appelants. Rien n'est réécrit
  // de force — la valeur assainie est celle que persist() gardera au prochain
  // changement, comme pour les autres replis de cette fonction.
  compactWaves({ members });
  const createdAt = Number.isFinite(g.createdAt) ? g.createdAt : 0;
  return {
    id,
    name: typeof g.name === 'string' && g.name.trim() ? g.name.trim() : 'Batch',
    createdAt,
    collapsed: !!g.collapsed,
    // Mode d'enchaînement des vagues, PAR LOT (2026-08-26, décision user) :
    //   'auto'   — la vague suivante s'ouvre d'elle-même quand la courante est
    //              terminée (avec la garde « explicitement terminée », cf.
    //              extension.js maybeAdvanceWaves) ;
    //   'manual' — RIEN ne s'ouvre jamais tout seul ; le bouton ▶ de la vague
    //              suivante apparaît quand la courante est finie, et le clic
    //              EST l'acte délibéré (aucune confirmation).
    // Défaut AUTO pour un lot neuf comme pour tout stockage antérieur à ce
    // lot : le comportement historique, aucune migration. Seule la valeur
    // exacte 'manual' bascule — n'importe quoi d'autre retombe sur 'auto'
    // (une valeur illisible ne doit pas figer un lot en attente d'un clic).
    waveMode: g.waveMode === 'manual' ? 'manual' : 'auto',
    // Conv maîtresse (lot 11) — absente de tout stockage écrit avant ce lot :
    // `null`, comportement d'avant, aucune migration.
    masterSessionId: typeof g.masterSessionId === 'string' && g.masterSessionId ? g.masterSessionId : null,
    masterTitle: typeof g.masterTitle === 'string' ? g.masterTitle : '',
    // Stockage antérieur au plan « dernier lot » : l'instant du lien n'a jamais
    // été écrit. Repli sur la création du groupe — c'est la seule date connue
    // qui ordonne les lots entre eux, et elle donne l'ordre attendu dans le cas
    // qui a motivé le plan (un lot par heure de lancement). ZÉRO migration :
    // rien n'est réécrit, le défaut se pose à la lecture.
    masterLinkedAt: Number.isFinite(g.masterLinkedAt) && g.masterLinkedAt > 0 ? g.masterLinkedAt : createdAt,
    members,
  };
}

// deps :
//   load()        → tableau brut lu du stockage (workspaceState.get)
//   save(groups)  → écriture (workspaceState.update) ; peut rendre une Promise,
//                   qu'on n'attend jamais : l'état en mémoire fait foi pour le
//                   rendu, l'écriture ne fait que le survivre au reload.
//   now()         → horloge (injectable pour les bancs)
//   newId()       → identifiant de groupe (injectable pour les bancs)
function createGroupStore(deps = {}) {
  const {
    load = () => [],
    save = () => {},
    now = () => Date.now(),
    newId = null,
  } = deps;

  let seq = 0;
  const mkId = newId || (() => `g${now().toString(36)}${(seq++).toString(36)}`);

  let groups = [];
  try { groups = (load() || []).map(sanitizeGroup).filter(Boolean); } catch { groups = []; }

  function persist() {
    try { save(groups.map((g) => JSON.parse(JSON.stringify(g)))); } catch {}
  }

  function find(id) { return groups.find((g) => g.id === id) || null; }

  // Fonctions nommées plutôt que des méthodes appelées par `this` : le store
  // est destructuré ici et là côté extension, et une méthode qui s'appelle
  // elle-même par `this` casserait silencieusement à la première déstructuration.
  function dissolve(id) {
    const i = groups.findIndex((g) => g.id === id);
    if (i === -1) return false;
    groups.splice(i, 1);
    persist();
    return true;
  }

  // Tous les sessionId déjà rattachés, tous groupes confondus — la garde
  // d'unicité de `attach` et le filtre des candidats de l'étage 2.
  function attachedIds() {
    const out = new Set();
    for (const g of groups) for (const m of g.members) if (m.sessionId) out.add(m.sessionId);
    return out;
  }

  // Identifiants qu'un groupe REVENDIQUE : ses membres, plus sa conv maîtresse.
  // Sert partout où l'on cherche « une conversation encore disponible » (liste
  // du lien manuel, candidats de l'étage 2) — une maîtresse n'est pas
  // disponible pour être rattachée comme membre.
  function claimedIds() {
    const out = attachedIds();
    for (const g of groups) if (g.masterSessionId) out.add(g.masterSessionId);
    return out;
  }

  // Rattachement d'un membre à une conversation. Refuse un sessionId déjà
  // pris : deux membres pour une même conv, c'est une ligne fantôme. Refuse
  // aussi la maîtresse de CE groupe : elle y est déjà, en tête (lot 11).
  function attach(id, key, sessionId) {
    const g = find(id);
    if (!g || !sessionId) return false;
    const m = g.members.find((x) => x.key === key);
    if (!m || m.sessionId === sessionId) return false;
    if (g.masterSessionId === sessionId) return false;
    if (attachedIds().has(sessionId)) return false;
    relink(m, sessionId);
    persist();
    return true;
  }

  // Nommé (au lieu d'un littéral rendu directement) parce qu'une méthode en
  // appelle une autre : `addTask` délègue à `addTasks` pour que le seuil de
  // vague n'existe qu'à un seul endroit, et `this` ne survivrait pas à un
  // appel déstructuré.
  const store = {
    all() { return groups; },
    get: find,

    // `tasks` = sortie de normalizeTasks (batch.js), éventuellement enrichie
    // d'un `sessionId` quand le lancement l'a déjà retrouvé. Le groupe est créé
    // AVANT le lancement dans le cas nominal : il apparaît tout de suite dans le
    // panneau avec ses membres non liés, et les sessionId arrivent ensuite.
    create(name, tasks) {
      const at = now();
      const list = Array.isArray(tasks) ? tasks : [];
      const g = {
        id: mkId(),
        // Repli quand le bloc collé ne porte pas de ligne `group:`. Heure
        // LOCALE, jamais toISOString() : celui-ci rend l'heure UTC — un lot
        // créé à 14:11 à Paris s'appelait « Batch 12:11 ». Le défaut était
        // quasi invisible tant que ce nom ne vivait qu'en infobulle, et
        // seulement sur un lot sans maîtresse ; il devient une horloge fausse
        // en évidence dès que la grip l'affiche. Même idiome que le libellé de
        // reset du quota (hhmm(), extension.js) : le fuseau et le format
        // viennent de la machine, pas d'un découpage de chaîne.
        name: (typeof name === 'string' && name.trim())
          || `Batch ${new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`,
        createdAt: at,
        collapsed: false,
        waveMode: 'auto',
        masterSessionId: null,
        masterTitle: '',
        masterLinkedAt: 0,        // aucun lien encore : setMaster le stampe
        members: list.map((t, i) => memberOfTask(t, `m${i + 1}`, at)),
      };
      groups.push(g);
      persist();
      return g;
    },

    // ── Conversation maîtresse (lot 11) ──────────────────────────────────
    // Pointeur, pas membre. Refuse une conversation qui est déjà membre de CE
    // groupe (même conv à deux places dans la même section) ; l'accepte en
    // revanche si elle est membre d'un AUTRE groupe — un lot précédent qui
    // propose les handoffs du suivant est le cas nominal, pas une anomalie.
    setMaster(id, sessionId, title) {
      const g = find(id);
      if (!g || !sessionId) return false;
      if (g.members.some((m) => m.sessionId === sessionId)) return false;
      if (g.masterSessionId === sessionId && !title) return false;
      g.masterSessionId = sessionId;
      // Instant du lien : c'est LUI qui départage deux groupes revendiquant la
      // même conversation (le plus récent la rend en tête, cf. en-tête). Posé à
      // CHAQUE lien accepté, y compris une re-désignation de la même conv sur
      // le même groupe : le geste doit avoir un effet, sinon relier une vieille
      // maîtresse resterait muet — la famille de bugs que ce champ répare.
      g.masterLinkedAt = now();
      // Titre AU MOMENT DU LIEN : ce qui restera lisible quand la conv sortira
      // de la fenêtre du panneau. Un titre vide n'écrase pas un titre connu.
      if (typeof title === 'string' && title.trim()) g.masterTitle = title.trim();
      persist();
      return true;
    },

    unsetMaster(id) {
      const g = find(id);
      if (!g || !g.masterSessionId) return false;
      g.masterSessionId = null;
      g.masterTitle = '';
      persist();
      return true;
    },

    masterGroupIdOf(sessionId) {
      if (!sessionId) return null;
      for (const g of groups) if (g.masterSessionId === sessionId) return g.id;
      return null;
    },

    // Membres d'une vague donnée, dans leur ordre de création — c'est l'ordre
    // dans lequel launcher.js rend ses résultats, donc l'ordre qui permet de
    // réattribuer chaque sessionId au bon membre après un launch() partiel.
    membersOfWave(id, wave) {
      const g = find(id);
      if (!g) return [];
      return g.members.filter((m) => m.wave === wave);
    },

    // Fait passer un membre `queued` à `launched` (lot 4 : ouverture d'une
    // vague au-delà de la 1) — le sessionId, lui, arrive séparément via
    // `attach` (étages 1/2/3 du rattachement, inchangés).
    markLaunched(id, key, at) {
      const g = find(id);
      if (!g) return false;
      const m = g.members.find((x) => x.key === key);
      if (!m || m.launchedAt != null) return false;
      m.launchedAt = Number.isFinite(at) ? at : now();
      persist();
      return true;
    },

    // Réarmer un membre dont le lien est MORT-NÉ (chip « Relancer », plan
    // lien-mort-né 2026-08-04) : le ticket redevient « en attente », les trois
    // étages du rattachement rejouent normalement sur la conversation qu'on
    // s'apprête à rouvrir. Le nouveau `launchedAt` est indispensable : c'est le
    // repère temporel qui empêche l'étage 2 d'accrocher un vieux transcript.
    // Garde : un membre `queued` (jamais lancé) n'a rien à réarmer — c'est déjà
    // son état. La décision « ce membre est-il vraiment mort-né ? » n'est PAS
    // ici : elle appartient à la table de vérité (member-truth.js), que
    // l'appelant interroge à l'instant.
    rearm(id, key, at) {
      const g = find(id);
      if (!g) return false;
      const m = g.members.find((x) => x.key === key);
      if (!m || m.launchedAt == null) return false;
      relink(m, null);
      m.launchedAt = Number.isFinite(at) ? at : now();
      persist();
      return true;
    },

    // Preuve de fin OBSERVÉE (cf. en-tête) : écrite une fois, relue par
    // member-truth.js avant toute source vivante. Rend false quand rien ne
    // change (déjà prouvé, membre non lié) — l'appelant n'a alors rien à
    // re-pousser.
    markDoneProven(id, key) {
      const g = find(id);
      if (!g) return false;
      const m = g.members.find((x) => x.key === key);
      if (!m || !m.sessionId || m.doneProven) return false;
      m.doneProven = true;
      persist();
      return true;
    },

    // Déplacer un membre PAS ENCORE LANCÉ d'une vague à l'autre (édition en
    // cours de route, décision 5 du plan : « une tâche lancée ne bouge plus »).
    //
    // Une vague est une POSITION, pas un numéro figé (décision 2026-08-22,
    // arbitrée sur MOCKUP_vagues_fleches_2026-08-22.html) : la numérotation
    // reste 1, 2, 3… sans trou, et `delta` vaut UN CRAN, pas « +1 sur le
    // numéro ». D'où deux gestes, selon que le membre a des voisines ou non :
    //   · SEUL dans sa vague → il rejoint la vague voisine, la sienne se vide
    //     et disparaît (c'est la renumérotation qui la supprime).
    //   · ACCOMPAGNÉ → il se DÉTACHE dans une vague neuve, juste avant ou
    //     juste après ses voisines. C'est ce geste-là qui fabrique une vague
    //     au bout de la file — auparavant AUCUN chemin ne savait en créer une,
    //     d'où le ▸ masqué sur la dernière vague et le ◂ mort dès qu'une vague
    //     s'était vidée (bug 2026-08-22).
    // Les deux gestes sont exactement inverses l'un de l'autre : la flèche
    // opposée annule toujours le clic précédent, ce que « +1 / -1 » ne savait
    // pas faire (une fusion était sans retour).
    //
    // Deux refus, et deux seulement : descendre dans une vague déjà lancée
    // (elle est partie), et déplacer un membre SEUL vers le vide — ce dernier
    // ne changerait rien à l'ordre d'exécution, il ne ferait que renuméroter.
    moveQueuedMember(id, key, delta) {
      const g = find(id);
      if (!g) return false;
      const m = g.members.find((x) => x.key === key);
      if (!m || m.launchedAt != null) return false;
      const d = delta > 0 ? 1 : -1;
      const pivot = m.wave;
      if (g.members.filter((x) => x.wave === pivot).length === 1) {
        const target = pivot + d;
        // Seuil INCHANGÉ ici, volontairement (2026-08-28) : un cran est un
        // geste implicite — le même clic ne fait pas la même chose selon la
        // vague de départ, et rien ne demande confirmation. Les deux portes
        // qui, elles, acceptent désormais la vague EN COURS (addTasks, le menu
        // setMemberWave) sont des DÉSIGNATIONS explicites, confirmées côté
        // panneau avant de lancer quoi que ce soit. Ce geste-ci n'est d'ailleurs
        // plus câblé à l'UI depuis 2026-08-27 (remplacé par le menu).
        if (target <= launchedWaveOf(g)) return false;
        if (!g.members.some((x) => x.wave === target)) return false;
        m.wave = target;
      } else {
        // Scission. Tout ce qui bouge ici est FORCÉMENT en file : le membre est
        // `queued`, donc sa vague l'est aussi, et on ne décale que sa vague
        // (vers l'arrière) ou celles qui la suivent (vers l'avant) — jamais une
        // vague déjà ouverte, qui est toujours devant.
        const from = d > 0 ? pivot + 1 : pivot;
        g.members.forEach((x) => { if (x !== m && x.wave >= from) x.wave += 1; });
        m.wave = from;
      }
      compactWaves(g);
      persist();
      return true;
    },

    // DESTINATION ABSOLUE — l'opération du menu « vague n ▾ » (2026-08-26),
    // volontairement DISTINCTE de moveQueuedMember juste au-dessus : celui-ci
    // raisonne en CRANS (un membre seul FUSIONNE, un membre accompagné SE
    // DÉTACHE), si bien qu'il n'existe aucun nombre de clics ◂/▸ qui signifie
    // « va en vague 4 » — le même clic ne fait pas la même chose selon qui
    // partage la vague de départ. Le menu, lui, DÉSIGNE une vague : c'est un
    // autre geste, il lui faut sa propre porte.
    //
    // `wave` = numéro d'une vague EXISTANTE encore en file, ou `null` =
    // « nouvelle vague à la fin » (max + 1, calculé ICI : le store est seul à
    // jour, le webview a pu recevoir un état périmé entre son rendu et le clic).
    // Le numéro reçu est celui d'AVANT compactage — on le pose tel quel, puis
    // compactWaves rétablit la contiguïté. Une vague d'origine vidée disparaît
    // donc et tout se resserre : la destination reste le même GROUPE DE
    // MEMBRES, même si son numéro affiché descend d'un cran ensuite (invariant
    // « une vague est une position, jamais un numéro figé »).
    //
    // Quatre refus, chacun le miroir d'une règle déjà tenue ailleurs :
    //   · membre déjà lancé (comme moveQueuedMember) — il est parti ;
    //   · vague STRICTEMENT sous launchedWave (même seuil qu'addTasks) — une
    //     vague passée est terminée, y arriver ne veut rien dire ; la vague EN
    //     COURS, elle, EST une destination depuis 2026-08-28 (le membre y part
    //     aussitôt, extension.js s'en charge) ;
    //   · vague inexistante (> max) — ce serait fabriquer un trou depuis un
    //     état périmé ; « nouvelle vague » a sa propre valeur, `null` ;
    //   · tout ce qui ne changerait RIEN : la vague courante, et « nouvelle
    //     vague » demandée par un membre déjà seul en dernière position (même
    //     refus que le ▸ de moveQueuedMember, qui ne ferait que renuméroter).
    setMemberWave(id, key, wave) {
      const g = find(id);
      if (!g) return false;
      const m = g.members.find((x) => x.key === key);
      if (!m || m.launchedAt != null) return false;
      const maxWave = g.members.reduce((max, x) => Math.max(max, x.wave), 0);
      let target;
      if (wave == null) {
        const alone = g.members.filter((x) => x.wave === m.wave).length === 1;
        if (alone && m.wave === maxWave) return false;
        target = maxWave + 1;
      } else {
        const n = Number(wave);
        // Même seuil qu'addTasks/moveQueuedMember : la vague EN COURS est une
        // destination (le membre y part aussitôt), une vague PASSÉE non.
        if (!Number.isInteger(n) || n < 1 || n < launchedWaveOf(g) || n > maxWave) return false;
        if (n === m.wave) return false;
        target = n;
      }
      m.wave = target;
      compactWaves(g);
      persist();
      return true;
    },

    rename(id, name) {
      const g = find(id);
      const clean = typeof name === 'string' ? name.trim() : '';
      if (!g || !clean) return false;
      g.name = clean;
      persist();
      return true;
    },

    setCollapsed(id, collapsed) {
      const g = find(id);
      if (!g) return false;
      g.collapsed = !!collapsed;
      persist();
      return true;
    },

    // Interrupteur manuel/auto de l'en-tête du lot (2026-08-26). Écrit la même
    // valeur assainie que sanitizeGroup : tout ce qui n'est pas exactement
    // 'manual' vaut 'auto'. Rend false quand rien ne change, pour que
    // l'appelant n'ait pas à re-pousser l'état du panneau pour rien.
    setWaveMode(id, mode) {
      const g = find(id);
      if (!g) return false;
      const clean = mode === 'manual' ? 'manual' : 'auto';
      if (g.waveMode === clean) return false;
      g.waveMode = clean;
      persist();
      return true;
    },

    // Dissolution : les métadonnées, RIEN d'autre. Aucun onglet fermé, aucune
    // conversation interrompue — elles redeviennent des lignes plates.
    dissolve,

    removeMember(id, key) {
      const g = find(id);
      if (!g) return false;
      const i = g.members.findIndex((m) => m.key === key);
      if (i === -1) return false;
      g.members.splice(i, 1);
      // Un groupe vidé de tous ses membres n'a plus rien à montrer ni à
      // représenter : le laisser serait une ligne d'en-tête orpheline.
      if (!g.members.length) return dissolve(id);
      persist();
      return true;
    },

    // Ajout manuel d'une conversation EXISTANTE (action « ajouter un membre »).
    // Le prompt n'est pas connu — c'est le titre de la conv qui parlera dans le
    // panneau. `model`/`effort` restent `null` (lot 14) : on n'a rien demandé
    // pour elle, donc aucun écart intention/réel ne doit être affiché.
    addExisting(id, sessionId, prompt) {
      const g = find(id);
      if (!g || !sessionId) return false;
      // `claimedIds` et non `attachedIds` : la conv maîtresse d'un groupe n'est
      // pas disponible pour devenir membre (lot 11).
      if (claimedIds().has(sessionId)) return false;
      const used = new Set(g.members.map((m) => m.key));
      let n = g.members.length + 1;
      while (used.has(`m${n}`)) n++;
      g.members.push({
        key: `m${n}`,
        prompt: typeof prompt === 'string' ? prompt : '',
        model: null,
        effort: null,
        wave: g.members.length ? Math.max(...g.members.map((m) => m.wave)) : 1,
        sessionId,
        // Déjà une conversation EXISTANTE (donc déjà « lancée », au sens du
        // moteur de vagues) — `null` la ferait compter comme `queued` et
        // fausserait launchedWave/moveQueuedMember (lot 4).
        launchedAt: now(),
        doneProven: false,
      });
      persist();
      return true;
    },

    // Ajout de tâches dans un groupe déjà créé (plan ajout-tache 2026-07-24,
    // étendu 2026-08-28) — le « + » par vague du panneau, ou sa ligne fantôme
    // « nouvelle vague ». Fabrique IDENTIQUE à celle du Create (memberOfTask)
    // pour la cohérence des champs ; AUCUN lancement ici (launchedAt forcé à
    // null, y compris pour une vague 1 encore vide : memberOfTask ne le sait
    // pas faire tout seul, lui qui sert aussi create()) — c'est extension.js
    // qui ouvre ce qui atterrit dans une vague DÉJÀ OUVERTE, voir plus bas.
    //
    // `wave` explicite ou `null` = nouvelle vague à la fin, calculée ICI (max
    // des vagues existantes + 1 — le store est seul à jour, pas le webview).
    // Seuil (2026-08-28) : `n < lw` refusé, `n === lw` ACCEPTÉ. Une vague
    // PASSÉE n'accepte plus rien (elle est finie, y poser une tâche ne veut
    // rien dire) ; la vague EN COURS, si — demande explicite de l'user, qui
    // veut glisser un lot dans la vague qui tourne. Ce n'est plus une
    // « surprise » : le clic qui l'amène ici est confirmé côté webview.
    //
    // Les tâches portent des vagues RELATIVES (1..K, contiguës — garanties
    // par batch.js normalizeTasks).
    //
    // DEUX GESTES, JAMAIS UN SEUL QUI DEVINE (2026-08-29). Jusqu'ici, poser un
    // bloc « à partir de » la vague visée fondait sa première vague DANS elle
    // et insérait les suivantes derrière : sur un bloc à 4 vagues déposé en
    // vague 2, la tâche existante de la vague 2 se retrouvait à côté d'une
    // nouvelle et le reste du lot était repoussé de 3 — mesuré, et signalé par
    // l'user (« ça me fait un rendu archaïque… un gros bazar »). Le mélange
    // n'était pas un bug de calcul : c'était l'ambiguïté d'un geste unique
    // pour deux intentions. Elles sont désormais nommées par l'appelant :
    //   · mode 'into'   — les tâches rejoignent la vague `wave` (elle existe
    //     déjà). Réservé à un bloc qui tient en UNE vague : une vague ne peut
    //     pas absorber une topologie, et l'aplatir en silence perdrait
    //     l'ordonnancement voulu. K > 1 est donc refusé ici.
    //   · mode 'before' — les K vagues du bloc s'insèrent AVANT la vague
    //     `wave`, qui est repoussée avec toutes ses suivantes. Rien ne
    //     fusionne, la topologie du bloc arrive intacte.
    // `wave == null` (« + nouvelle vague ») reste le troisième cas : à la fin,
    // le mode n'a alors rien à trancher.
    // Rend la liste des clés créées (vide = rien fait).
    addTasks(id, tasks, wave, mode) {
      const g = find(id);
      if (!g) return [];
      const list = (Array.isArray(tasks) ? tasks : [])
        .map((t) => ({
          prompt: typeof (t && t.prompt) === 'string' ? t.prompt.trim() : '',
          model: t && t.model,
          effort: t && t.effort,
          wave: Number.isInteger(t && t.wave) && t.wave > 0 ? t.wave : 1,
        }))
        .filter((t) => t.prompt);
      if (!list.length) return [];
      const lw = launchedWaveOf(g);
      const rel = [...new Set(list.map((t) => t.wave))].sort((a, b) => a - b);
      const insert = wave != null && mode === 'before';
      let target;
      if (wave == null) {
        target = g.members.reduce((max, m) => Math.max(max, m.wave), 0) + 1;
      } else {
        const n = Number(wave);
        if (!Number.isInteger(n) || n < 1 || n < lw) return [];
        // Une vague DÉJÀ OUVERTE accueille encore ce qu'on lui donne (demande
        // du 2026-08-28), mais on ne peut pas se glisser DEVANT elle : ce qui
        // atterrit sous `launchedWave` part aussitôt (extension.js
        // openMembersInLaunchedWaves), donc insérer K vagues en amont les
        // ouvrirait toutes d'un coup — exactement l'ordonnancement que le bloc
        // demandait d'éviter. Le refus vaut mieux qu'un lancement en rafale.
        if (insert && n <= lw) return [];
        // Un bloc à plusieurs vagues ne rentre pas DANS une vague.
        if (!insert && rel.length > 1) return [];
        target = n;
      }
      const offsetOf = new Map(rel.map((w, i) => [w, i]));
      // Insertion : la vague visée est repoussée elle aussi (>=), sans quoi sa
      // tâche existante se retrouverait mêlée à la première vague du bloc.
      if (insert) g.members.forEach((m) => { if (m.wave >= target) m.wave += rel.length; });
      const used = new Set(g.members.map((m) => m.key));
      const added = [];
      let i = g.members.length + 1;
      for (const t of list) {
        while (used.has(`m${i}`)) i++;
        const key = `m${i}`;
        used.add(key);
        const member = memberOfTask({ prompt: t.prompt, model: t.model, effort: t.effort, wave: target + offsetOf.get(t.wave) }, key, now());
        member.launchedAt = null;
        g.members.push(member);
        added.push(key);
      }
      persist();
      return added;
    },

    // Compat d'appel (une tâche, verdict booléen) — même chemin, jamais une
    // seconde implémentation : le seuil de vague ne doit exister qu'à un seul
    // endroit.
    addTask(id, task, wave, mode) { return store.addTasks(id, [task], wave, mode).length > 0; },

    attach,

    // Rattachement par INDEX de la liste de tâches passée à create() — c'est
    // l'étage 1 (diff du registre ~/.claude/sessions), dont launcher.js rend
    // les résultats dans l'ordre des tâches.
    attachByIndex(id, index, sessionId) {
      const g = find(id);
      if (!g || !sessionId) return false;
      const m = g.members[index];
      if (!m) return false;
      return attach(id, m.key, sessionId);
    },

    detach(id, key) {
      const g = find(id);
      if (!g) return false;
      const m = g.members.find((x) => x.key === key);
      if (!m || !m.sessionId) return false;
      relink(m, null);
      persist();
      return true;
    },

    attachedIds,
    claimedIds,

    // Membres en attente d'identité, pour l'étage 2 (cf. attach.js). Un membre
    // `queued` (lot 4 : vague pas encore ouverte, `launchedAt` null) n'a AUCUNE
    // conversation à retrouver — l'exclure, sinon l'étage 2 chercherait son
    // prompt en tête d'un transcript qui n'existe pas encore.
    pending() {
      const out = [];
      for (const g of groups) {
        for (const m of g.members) {
          if (!m.sessionId && m.prompt && m.launchedAt != null) {
            out.push({ groupId: g.id, key: m.key, prompt: m.prompt, launchedAt: m.launchedAt });
          }
        }
      }
      return out;
    },

    groupIdOf(sessionId) {
      if (!sessionId) return null;
      for (const g of groups) {
        if (g.members.some((m) => m.sessionId === sessionId)) return g.id;
      }
      return null;
    },

    // Ce qui a été DEMANDÉ pour chaque conversation rattachée — sert à réamorcer
    // le magasin d'intentions (batch.js) après un reload de la fenêtre, qui
    // vide sa mémoire mais pas le workspaceState. Sans ça, le badge d'écart
    // disparaissait au premier reload (écart assumé du lot 1).
    intents() {
      const out = [];
      for (const g of groups) {
        for (const m of g.members) {
          if (!m.sessionId) continue;
          // Rien à comparer : `null` (lot 14) ou l'ancienne valeur littérale
          // `'inherit'` d'un stockage écrit avant ce lot (jamais migrée,
          // simplement plus reconnue comme une intention).
          if ((!m.model || m.model === 'inherit') && (!m.effort || m.effort === 'inherit')) continue;
          out.push({ sessionId: m.sessionId, model: m.model, effort: m.effort, at: m.launchedAt || g.createdAt });
        }
      }
      return out;
    },

    // Auto-réparation des liens PROUVÉS FAUX (2026-09-01). La garde d'identité
    // du launcher empêche les mésattributions à venir ; celles déjà écrites
    // dans workspaceState, elles, survivent aux reloads et gardent leur badge
    // d'écart sur une conversation qui n'a jamais rien demandé. La preuve est la
    // même que celle du launcher, relue à l'envers : une session dont le process
    // a démarré AVANT `launchedAt − waitMs` ne peut pas être celle que ce
    // lancement a ouverte.
    //
    // Portée volontairement étroite — seuls les membres PORTEURS D'UNE INTENTION
    // (ceux dont le badge peut mentir) : une conversation ajoutée à la main
    // (`addExisting`, model/effort à `null`) est légitimement plus vieille que
    // son membre, et rien ne doit la défaire.
    // Le doute profite TOUJOURS à l'existant : `startedAtOf` qui rend `null`
    // (process mort, registre illisible) ou un `startedAt` postérieur (un reload
    // a respawné le CLI de cette conversation) ⇒ on garde.
    // On défait le LIEN, pas la tâche : prompt, modèle, effort et vague restent,
    // donc « Relancer » et le rattachement par l'étage 2 fonctionnent encore.
    //
    // startedAtOf : (sessionId) => epoch ms | null
    // → nombre de liens défaits.
    dropMisattachedIntents(startedAtOf, waitMs) {
      if (typeof startedAtOf !== 'function' || !Number.isFinite(waitMs)) return 0;
      let n = 0;
      for (const g of groups) {
        for (const m of g.members) {
          if (!m.sessionId) continue;
          if ((!m.model || m.model === 'inherit') && (!m.effort || m.effort === 'inherit')) continue;
          const at = Number.isFinite(m.launchedAt) ? m.launchedAt : g.createdAt;
          if (!Number.isFinite(at) || at <= 0) continue;
          let started = null;
          try { started = startedAtOf(m.sessionId); } catch { started = null; }
          if (!Number.isFinite(started) || started <= 0) continue;
          if (started >= at - waitMs) continue;
          relink(m, null);
          n++;
        }
      }
      if (n) persist();
      return n;
    },

    // Purge des groupes DEVENUS SANS OBJET : plus vieux que `maxAgeMs` et dont
    // aucun membre ne correspond à une conversation encore connue du panneau.
    // Appelée une fois à l'activation, jamais en continu — c'est un ménage de
    // stockage, pas une règle d'affichage (un groupe dont les convs ont
    // simplement vieilli hors de la liste reste intact tant qu'il est récent).
    prune(maxAgeMs, knownIds) {
      const known = knownIds instanceof Set ? knownIds : new Set(knownIds || []);
      const at = now();
      const before = groups.length;
      groups = groups.filter((g) => {
        if (at - (g.createdAt || 0) <= maxAgeMs) return true;
        // Un groupe encore représenté à l'écran n'est jamais purgé — y compris
        // quand ce qui reste à l'écran est sa seule conv maîtresse (lot 11).
        if (g.masterSessionId && known.has(g.masterSessionId)) return true;
        return g.members.some((m) => m.sessionId && known.has(m.sessionId));
      });
      if (groups.length !== before) persist();
      return before - groups.length;
    },
  };

  return store;
}

module.exports = { createGroupStore, hueOf, sanitizeGroup };
