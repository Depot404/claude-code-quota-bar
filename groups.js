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
// Seule interdiction : elle ne peut pas être en même temps membre du MÊME
// groupe (ce serait la même conversation à deux places dans la même section).
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
  };
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
    }));
  return {
    id,
    name: typeof g.name === 'string' && g.name.trim() ? g.name.trim() : 'Batch',
    createdAt: Number.isFinite(g.createdAt) ? g.createdAt : 0,
    collapsed: !!g.collapsed,
    // Passage de vague (lot 4). Défaut `true` (mockup validé : `advance:"auto"`
    // par défaut) — un stockage écrit par le lot 2 (avant ce champ) tombe donc
    // sur le même comportement que s'il l'avait explicitement choisi.
    autoAdvance: g.autoAdvance !== false,
    // Conv maîtresse (lot 11) — absente de tout stockage écrit avant ce lot :
    // `null`, comportement d'avant, aucune migration.
    masterSessionId: typeof g.masterSessionId === 'string' && g.masterSessionId ? g.masterSessionId : null,
    masterTitle: typeof g.masterTitle === 'string' ? g.masterTitle : '',
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
    m.sessionId = sessionId;
    persist();
    return true;
  }

  return {
    all() { return groups; },
    get: find,

    // `tasks` = sortie de normalizeTasks (batch.js), éventuellement enrichie
    // d'un `sessionId` quand le lancement l'a déjà retrouvé. Le groupe est créé
    // AVANT le lancement dans le cas nominal : il apparaît tout de suite dans le
    // panneau avec ses membres non liés, et les sessionId arrivent ensuite.
    // `advance` : toggle de passage de vague voulu à la création ('auto'
    // par défaut, cf. sanitizeGroup) — modifiable ensuite via setAutoAdvance.
    create(name, tasks, advance) {
      const at = now();
      const list = Array.isArray(tasks) ? tasks : [];
      const g = {
        id: mkId(),
        name: (typeof name === 'string' && name.trim()) || `Batch ${new Date(at).toISOString().slice(11, 16)}`,
        createdAt: at,
        collapsed: false,
        autoAdvance: advance !== 'manual',
        masterSessionId: null,
        masterTitle: '',
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

    setAutoAdvance(id, auto) {
      const g = find(id);
      if (!g) return false;
      g.autoAdvance = !!auto;
      persist();
      return true;
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

    // Déplacer un membre PAS ENCORE LANCÉ vers la vague voisine (édition en
    // cours de route, décision 5 du plan : « une tâche lancée ne bouge plus »).
    // `delta` = +1/-1 ; refuse de descendre sous la vague déjà lancée + 1 (on ne
    // fait pas rentrer une tâche dans une vague qui est déjà partie).
    moveQueuedMember(id, key, delta) {
      const g = find(id);
      if (!g) return false;
      const m = g.members.find((x) => x.key === key);
      if (!m || m.launchedAt != null) return false;
      const lw = g.members.reduce((max, x) => (x.launchedAt != null && x.wave > max ? x.wave : max), 0);
      const target = m.wave + (delta > 0 ? 1 : -1);
      if (target <= lw) return false;
      if (!g.members.some((x) => x.wave === target)) return false; // pas de vague créée par un déplacement
      m.wave = target;
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
      });
      persist();
      return true;
    },

    // Ajout d'une tâche EN FILE dans un groupe déjà créé (plan ajout-tache
    // 2026-07-24) — le « + » par vague du panneau, ou sa ligne fantôme
    // « nouvelle vague ». Fabrique IDENTIQUE à celle du Create (memberOfTask)
    // pour la cohérence des champs ; AUCUN lancement (launchedAt forcé à
    // null, y compris pour une vague 1 encore vide : memberOfTask ne le sait
    // pas faire tout seul, lui qui sert aussi create()). `wave` explicite
    // (vague déjà en file) ou `null` = nouvelle vague, calculée ICI (max des
    // vagues existantes + 1 — le store est seul à jour, pas le webview).
    // Refuse une vague déjà lancée ou en cours (même seuil que
    // moveQueuedMember : `target <= lw`) — y ajouter reviendrait à la lancer
    // aussitôt, la surprise que le design interdit.
    addTask(id, task, wave) {
      const g = find(id);
      if (!g) return false;
      const prompt = typeof (task && task.prompt) === 'string' ? task.prompt.trim() : '';
      if (!prompt) return false;
      const lw = g.members.reduce((max, m) => (m.launchedAt != null && m.wave > max ? m.wave : max), 0);
      let targetWave;
      if (wave == null) {
        targetWave = g.members.reduce((max, m) => Math.max(max, m.wave), 0) + 1;
      } else {
        const n = Number(wave);
        if (!Number.isInteger(n) || n < 1 || n <= lw) return false;
        targetWave = n;
      }
      const used = new Set(g.members.map((m) => m.key));
      let i = g.members.length + 1;
      while (used.has(`m${i}`)) i++;
      const key = `m${i}`;
      const member = memberOfTask({ prompt, model: task && task.model, effort: task && task.effort, wave: targetWave }, key, now());
      member.launchedAt = null;
      g.members.push(member);
      persist();
      return true;
    },

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
      m.sessionId = null;
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
}

module.exports = { createGroupStore, hueOf, sanitizeGroup };
