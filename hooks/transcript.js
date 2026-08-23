#!/usr/bin/env node
// Lib partagée : lecture des transcripts ~/.claude/projects/<ws>/<session>.jsonl.
// Require() côté hooks ET côté extension (state.js). Les transcripts font
// couramment plusieurs Mo → on ne lit JAMAIS le fichier entier, seulement une
// queue (dernier état) et, si besoin, une tête (titre de repli).
//
// Source canonique : Tools/ClaudeCodeQuotaBar/hooks/. Ne pas éditer la copie
// déployée dans ~/.claude/scripts/ — éditer ici puis relancer install.ps1.

const fs = require('fs');

const TAIL_BYTES = 65536;
const HEAD_BYTES = 32768;
// Borne du scan ligne-à-ligne (extractTitleInfo / firstUserText, ci-dessous) —
// distincte de HEAD_BYTES, qui reste la fenêtre ai-title/last-prompt côté
// queue. 2 Mo, volontairement large : un contexte de session incorporé dans
// la 1re ligne user peut peser plusieurs centaines de Ko (mesuré 2026-08-18,
// ~233 Ko) — HEAD_BYTES (32 Ko) coupait cette ligne au milieu, JSON.parse
// échouait sur TOUTE la tranche, et le titre retombait au repli last-prompt
// (source divergente du libellé d'onglet, resté sur le 1er prompt → le clic
// sur la ligne ne matchait plus rien, convMatchesLabel/labels.js).
const HEAD_SCAN_MAX_BYTES = 2 * 1024 * 1024;
// Garde de salubrité SEULEMENT (titre de repli = prompt collé entier, parfois
// des Ko) — jamais atteinte par un vrai ai-title. La coupe d'AFFICHAGE est du
// ressort du CSS (ellipsis + tooltip, panel.js) : tronquer ici à 40 rendait le
// titre incomplet même panneau élargi (constat user 2026-07-15).
const TITLE_MAX = 200;

// Lit une tranche du fichier. La 1re ligne d'une queue est presque toujours
// tronquée (on tombe au milieu d'un JSON) → l'appelant la jette.
function readSlice(filePath, bytes, from) {
  const stat = fs.statSync(filePath);
  const size = Math.min(bytes, stat.size);
  if (size <= 0) return null;
  const buf = Buffer.allocUnsafe(size);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buf, 0, size, from === 'tail' ? Math.max(0, stat.size - size) : 0);
  } finally {
    fs.closeSync(fd);
  }
  return { text: buf.toString('utf8'), partialFirstLine: from === 'tail' && size < stat.size };
}

// Scan de tête ligne par ligne, borné en octets mais JAMAIS en plein milieu
// d'une ligne (contrairement à readSlice(…, 'head'), qui coupe à une frontière
// d'octets fixe — une 1re ligne plus grosse que la coupe rend alors un JSON
// illisible dans toute la tranche). `onEntry(entry)` est appelé pour chaque
// ligne parseable, dans l'ordre du fichier ; il rend `true` pour arrêter le
// scan dès qu'il a ce qu'il cherche (évite de lire les 2 Mo en entier sur un
// gros transcript quand la réponse est dans les premières lignes).
function scanHeadLines(filePath, maxBytes, onEntry) {
  let fd;
  try { fd = fs.openSync(filePath, 'r'); } catch { return; }
  const CHUNK = 65536;
  const buf = Buffer.allocUnsafe(CHUNK);
  let leftover = '';
  let pos = 0;
  try {
    while (pos < maxBytes) {
      const toRead = Math.min(CHUNK, maxBytes - pos);
      let bytesRead;
      try { bytesRead = fs.readSync(fd, buf, 0, toRead, pos); } catch { break; }
      if (bytesRead <= 0) break;
      pos += bytesRead;
      leftover += buf.toString('utf8', 0, bytesRead);
      const lines = leftover.split('\n');
      leftover = lines.pop(); // dernière ligne potentiellement incomplète → gardée pour le tour suivant
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        let entry;
        try { entry = JSON.parse(t); } catch { continue; }
        if (onEntry(entry) === true) return;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

function parseSlice(slice) {
  if (!slice) return [];
  const lines = slice.text.split('\n');
  if (slice.partialFirstLine) lines.shift();
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch {}
  }
  return out;
}

// Occupation de la fenêtre = input + cache_read + cache_creation
// (cf. doc statusLine Claude Code).
function usageTokens(u) {
  if (!u) return 0;
  return (u.input_tokens || 0)
       + (u.cache_read_input_tokens || 0)
       + (u.cache_creation_input_tokens || 0);
}

function firstTextBlock(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b && b.type === 'text' && typeof b.text === 'string') return b.text;
    }
  }
  return null;
}

// Blocs injectés par le CLI DANS un message user : contexte de hook, rappels,
// sélection de l'éditeur. Ce ne sont pas des mots de l'utilisateur → retrait
// partout dans le texte, le vrai prompt étant autour.
const INJECTED_BLOCK = /<(system-reminder|ide_selection|local-command-caveat)>[\s\S]*?<\/\1>/gi;

// Enveloppe EN TÊTE, nom de balise quelconque.
//
// Une slash-command n'est pas stockée comme « /model opus » mais comme son
// balisage interne : <command-name>/model</command-name> <command-message>…
// </command-message> <command-args>…</command-args>, et sa sortie comme
// <local-command-stdout>…</local-command-stdout>. Ces entrées ne sont pas
// marquées isMeta : sans ce retrait, une conv ouverte par une slash-command
// s'intitulait « <command-name>/model</command-name> <co… » dans le panneau.
//
// Le nom de balise n'est PAS listé : lister, c'est retomber dans le même bug au
// prochain balisage inventé par le CLI. Une fois l'enveloppe retirée il ne reste
// rien → cleanTitle rend null → extractTitleInfo passe au message suivant et
// tombe sur le premier VRAI texte humain.
//
// Bornée à la TÊTE, volontairement : un prompt humain qui parle de code
// (« pourquoi ce <div> déborde ? ») doit garder ses chevrons.
const LEADING_ENVELOPE = /^\s*<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>\s*/i;
// Filet : balise ouvrante jamais refermée (message tronqué, balisage à une seule
// borne) — le plan l'exige, aucun « <…> » ne doit atteindre l'écran.
const LEADING_TAG = /^\s*<[a-z][^>]*>\s*/i;
const MAX_STRIP = 8;

function stripEnvelopes(s) {
  let t = s.replace(INJECTED_BLOCK, ' ');
  for (let i = 0; i < MAX_STRIP; i++) {
    // Le bloc COMPLET d'abord, le filet seulement s'il n'y en a pas : enchaîner
    // les deux dans la même passe ferait manger par le filet la balise ouvrante
    // du bloc suivant, et le titre repartirait avec la fermeture orpheline
    // (« model</command-message> <command-args>o… » — vu, corrigé, testé).
    let next = t.replace(LEADING_ENVELOPE, '');
    if (next === t) next = t.replace(LEADING_TAG, '');
    if (next === t) break;
    t = next;
  }
  return t;
}

function cleanTitle(s) {
  if (!s) return null;
  const t = stripEnvelopes(s).replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX - 1).trimEnd() + '…' : t;
}

// Dernier message assistant porteur d'un usage → modèle réellement servi à
// CETTE session + occupation courante du contexte. Le transcript est la seule
// source non polluable (current-model.json est global et écrasable).
//
// `effort` (lot 1 du plan de création groupée) vit au niveau de l'ENTRÉE, pas
// dans `message` — vérifié sur transcripts réels 2026-07-22 :
//   {type:'assistant', effort:'high', message:{model:…, usage:…}, …}
// Il est ABSENT sur certaines entrées (transcripts d'avant son introduction,
// modèles sans notion d'effort) : `null` alors, jamais une valeur par défaut —
// c'est ce qui permet au panneau de ne rien afficher plutôt que d'inventer, et
// au badge d'écart de se taire faute de réel connu.
function extractLastAssistant(filePath) {
  const entries = parseSlice(readSlice(filePath, TAIL_BYTES, 'tail'));
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === 'assistant' && e.message && e.message.model) {
      return {
        modelId: e.message.model,
        usage: e.message.usage || null,
        effort: typeof e.effort === 'string' && e.effort ? e.effort : null,
      };
    }
  }
  return null;
}

// Titre de la conversation + PROVENANCE, dans l'ordre de qualité :
//  1) `ai-title` — le titre que Claude Code affiche lui-même sur l'onglet
//     (type vérifié sur transcripts réels 2026-07-15 ; le plan supposait
//     `summary`, qui n'existe pas dans ce format).
//  2) 1er message user PORTEUR DE TEXTE HUMAIN (tête du fichier) = le sujet
//     d'origine de la conv. Les entrées qui ne sont que du balisage de CLI
//     (slash-command, sortie de commande) ne survivent pas à cleanTitle, donc
//     la boucle les traverse d'elle-même.
//  3) `last-prompt` — dernier prompt, moins bon comme titre mais mieux que rien.
//
// La provenance n'est pas cosmétique : le filtre de présence du lot 5 (state.js)
// masque une conv dont aucun onglet ne porte le titre. Seul `ai-title` est le
// libellé RÉEL de l'onglet — un titre de repli ne peut pas matcher, donc son
// absence de correspondance ne prouve rien et ne doit rien masquer.
//
// `precomputedAiTitle` (optionnel) vient du scan incrémental (lot 8,
// scanAiTitleIncremental ci-dessous) : sur un gros transcript, l'entrée
// ai-title peut vivre n'importe où (mesuré : ligne 16/185, octet 33 349 d'un
// fichier de 739 Ko), donc hors des deux fenêtres head/tail ci-dessous.
// Fourni, il court-circuite la recherche ai-title dans la queue (déjà faite
// par l'appelant, à jour) sans changer l'ordre de préférence ni les replis.
function extractTitleInfo(filePath, precomputedAiTitle) {
  const tail = parseSlice(readSlice(filePath, TAIL_BYTES, 'tail'));
  let lastPrompt = null;
  let aiTitle = precomputedAiTitle || null;
  for (let i = tail.length - 1; i >= 0; i--) {
    const e = tail[i];
    if (!aiTitle && e.type === 'ai-title' && e.aiTitle) {
      const t = cleanTitle(e.aiTitle);
      // Un ai-title vide ne doit pas se faire passer pour un titre d'onglet
      // fiable : on retombe sur les replis.
      if (t) aiTitle = t;
    }
    if (!lastPrompt && e.type === 'last-prompt' && e.lastPrompt) lastPrompt = e.lastPrompt;
    if (aiTitle && lastPrompt) break;
  }
  if (aiTitle) return { title: aiTitle, source: 'ai-title' };
  let firstUser = null;
  scanHeadLines(filePath, HEAD_SCAN_MAX_BYTES, (e) => {
    if (e.type !== 'user' || e.isMeta || e.isSidechain || !e.message) return false;
    const txt = firstTextBlock(e.message.content);
    const cleaned = cleanTitle(txt);
    if (!cleaned) return false;
    firstUser = cleaned;
    return true;
  });
  if (firstUser) return { title: firstUser, source: 'first-user' };
  const lp = cleanTitle(lastPrompt);
  return lp ? { title: lp, source: 'last-prompt' } : { title: null, source: null };
}

// PREMIER message user d'un transcript, brut (enveloppes injectées retirées,
// mais NI tronqué NI recondensé comme cleanTitle) — étage 2 du rattachement des
// membres de groupe (attach.js) : le prompt qu'on a inséré à l'ouverture de
// l'onglet doit s'y retrouver tel quel, à la frappe de l'utilisateur près.
//
// Volontairement distinct d'extractTitleInfo, qui cherche un TITRE (ai-title
// d'abord, coupé à 200 caractères, replis multiples) : ici on veut le TEXTE, et
// seulement celui du premier message — un titre, lui, peut venir de la queue du
// fichier. Fichier absent/illisible → null, jamais d'exception (le rattachement
// se contente alors de ne rien conclure).
function firstUserText(filePath, maxChars = 600) {
  // Fichier disparu entre le snapshot et ici (conversation fermée, transcript
  // déplacé) = cas normal, pas une erreur : scanHeadLines rend simplement rien.
  let found = null;
  try {
    scanHeadLines(filePath, HEAD_SCAN_MAX_BYTES, (e) => {
      if (e.type !== 'user' || e.isMeta || e.isSidechain || !e.message) return false;
      const txt = firstTextBlock(e.message.content);
      if (!txt) return false;
      const cleaned = stripEnvelopes(txt).trim();
      if (!cleaned) return false;
      found = cleaned.slice(0, maxChars);
      return true;
    });
  } catch { return null; }
  return found;
}

// Scan incrémental append-only d'un transcript à la recherche d'entrées
// `ai-title` : le dernier trouvé gagne (un re-titrage éventuel est couvert).
// `state` = { scannedBytes, aiTitle } — muté en place, à conserver par
// l'appelant PAR FICHIER (cf. createTranscriptReader, state.js) pour ne
// jamais relire les octets déjà scannés. Premier appel = scan complet ;
// chaque appel suivant ne lit que [scannedBytes, size).
//
// Frontière de reprise : on n'avance `scannedBytes` que jusqu'à la fin de la
// DERNIÈRE LIGNE COMPLÈTE lue (pas jusqu'à `size` brut) — une ligne encore en
// cours d'écriture ne doit ni être perdue, ni faire planter le JSON.parse.
function scanAiTitleIncremental(filePath, state) {
  if (!state || typeof state.scannedBytes !== 'number') state = { scannedBytes: 0, aiTitle: null };
  let stat;
  try { stat = fs.statSync(filePath); } catch { return state; }
  if (stat.size < state.scannedBytes) {
    // Fichier tronqué/remplacé (ne devrait pas arriver, append-only) : reprendre à zéro.
    state.scannedBytes = 0;
    state.aiTitle = null;
  }
  const toRead = stat.size - state.scannedBytes;
  if (toRead <= 0) return state;

  const buf = Buffer.allocUnsafe(toRead);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buf, 0, toRead, state.scannedBytes);
  } finally {
    fs.closeSync(fd);
  }
  const text = buf.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  if (lastNl === -1) return state; // pas encore de ligne complète dans ce delta

  const complete = text.slice(0, lastNl + 1);
  state.scannedBytes += Buffer.byteLength(complete, 'utf8');
  for (const line of complete.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let e;
    try { e = JSON.parse(t); } catch { continue; }
    if (e.type === 'ai-title' && e.aiTitle) {
      const cleaned = cleanTitle(e.aiTitle);
      if (cleaned) state.aiTitle = cleaned;
    }
  }
  return state;
}

// Outils dont un tool_use en fin de transcript signale une attente USER
// immédiate (lot 11) — AskUserQuestion et ExitPlanMode ne déclenchent AUCUN
// hook (anthropics/claude-code#13830, #13024, #13922) : le seul signal
// « attend une réponse » vient soit du hook Notification `idle_prompt` (délai
// fixe de 60 s, non configurable), soit — plus tôt — de la lecture du
// transcript lui-même. Liste courte assumée : rien dans le schéma d'un
// tool_use ne dit qu'il est interactif, donc pas de règle générale possible.
// Extensible en une ligne si un autre outil interactif apparaît.
const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

// Le DERNIER message assistant du transcript se termine-t-il par un tool_use
// d'un outil interactif SANS le tool_result qui répond (l'user n'a pas encore
// répondu) ? Ne pas confondre avec un outil normal en cours (Bash qui tourne) :
// la règle ne s'applique qu'aux outils de INTERACTIVE_TOOLS, tout le reste
// d'un tool_use sans result reste l'état `busy` normal.
// Rend l'INSTANT (ms epoch) du tool_use interactif resté sans réponse, `0` s'il
// est là mais non datable, `null` s'il n'y en a pas. Le timestamp sert à dater
// la preuve : state.js compare cette date à celle du dernier événement hooks
// pour savoir laquelle des deux sources est la plus fraîche (cf. la fonction
// applyTranscriptTruth, qui remplace l'ancien test « l'entrée hooks dit busy »).
function pendingInteractiveAt(filePath) {
  const entries = parseSlice(readSlice(filePath, TAIL_BYTES, 'tail'));
  let lastAssistantIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === 'assistant') { lastAssistantIdx = i; break; }
  }
  if (lastAssistantIdx === -1) return null;
  const content = entries[lastAssistantIdx].message && entries[lastAssistantIdx].message.content;
  if (!Array.isArray(content) || !content.length) return null;
  const lastBlock = content[content.length - 1];
  if (!lastBlock || lastBlock.type !== 'tool_use' || !INTERACTIVE_TOOLS.has(lastBlock.name)) return null;

  // Un tool_result correspondant (même id) plus loin dans le transcript = déjà
  // répondu — tout événement postérieur au tool_use fait foi, pas seulement le
  // tool_result exact (message user envoyé entretemps, etc.).
  for (let i = lastAssistantIdx + 1; i < entries.length; i++) {
    const c = entries[i].message && entries[i].message.content;
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b && b.type === 'tool_result' && b.tool_use_id === lastBlock.id) return null;
      }
    }
  }
  const ts = Date.parse(entries[lastAssistantIdx].timestamp || '');
  return Number.isFinite(ts) ? ts : 0;
}

function hasPendingInteractiveTool(filePath) {
  return pendingInteractiveAt(filePath) !== null;
}

// Interruption manuelle (bouton Stop / Échap) : Claude Code écrit un message
// user « [Request interrupted by user…] » dans le transcript mais ne déclenche
// AUCUN hook — le hook Stop ne tire pas sur interruption, by design
// (anthropics/claude-code#45289 ; hooks reference). Sans ce détour, l'entrée
// d'état posée `busy` par UserPromptSubmit n'est jamais corrigée : le spinner
// tourne jusqu'à STALE_MS (5 min) dans le vide, puis bascule zombie. Même
// principe que hasPendingInteractiveTool : les hooks disent ce qui s'est passé,
// le transcript dit ce qui se passe. Deux formes observées sur transcripts
// réels : « [Request interrupted by user] » et « … by user for tool use] ».
const INTERRUPT_RE = /^\s*\[Request interrupted by user/;

// Le DERNIER message conversationnel du transcript est-il une interruption user
// encore « à vif » (aucun tour assistant repris derrière) ? On saute les lignes
// non conversationnelles que le CLI intercale après coup (queue-operation,
// ai-title, last-prompt, attachment) : seul un vrai message user/assistant
// tranche. Un assistant plus récent = le travail a repris → pas interrompu. Un
// message user isMeta (contexte injecté par un hook) n'est pas une reprise → on
// continue de remonter vers le dernier message user réel.
// Rend l'INSTANT (ms epoch) de cette interruption, `0` si le marqueur est là
// mais non datable (message sans timestamp), `null` s'il n'y a pas
// d'interruption à vif. Même raison que pendingInteractiveAt ci-dessus : sans
// date, impossible de savoir si le transcript en sait plus que les hooks ou le
// contraire — et c'est précisément ce que l'ancienne condition « l'entrée hooks
// dit busy » tentait d'approcher, en se trompant dès qu'un Stop à feedback
// avait posé `done` en cours de tour (incident 2026-08-08 : conv interrompue,
// spinner qui tourne, puis faux ✓ et son de fin 5 min plus tard).
function interruptedAt(filePath) {
  const entries = parseSlice(readSlice(filePath, TAIL_BYTES, 'tail'));
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    if (e.type === 'assistant') return null;
    if (e.isMeta) continue;
    if (!INTERRUPT_RE.test(firstTextBlock(e.message && e.message.content) || '')) return null;
    const ts = Date.parse(e.timestamp || '');
    return Number.isFinite(ts) ? ts : 0;
  }
  return null;
}

function wasInterrupted(filePath) {
  return interruptedAt(filePath) !== null;
}

// Écriture de reprise ≠ travail (incident 2026-08-07) : au reload de la
// fenêtre, l'extension officielle respawne le CLI de chaque onglet restauré,
// et ce respawn APPEND des lignes de comptabilité au transcript (constaté :
// `last-prompt` SANS timestamp, 86 s après le Stop) — le mtime bouge sans le
// moindre travail. Même discrimination que wasInterrupted ci-dessus : seul un
// vrai message user/assistant témoigne d'une activité. Rend le timestamp (ms
// epoch) du DERNIER message conversationnel non-meta, ou null s'il n'est pas
// datable (absent de la fenêtre de queue, ou sans champ timestamp) — le caller
// retombe alors sur le mtime, c.-à-d. le comportement d'avant.
function lastActivityTs(filePath) {
  let entries;
  try { entries = parseSlice(readSlice(filePath, TAIL_BYTES, 'tail')); } catch { return null; }
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    if (e.type === 'user' && e.isMeta) continue;
    if (e.type === 'user' && isStoppedTaskNotif(e.message && e.message.content)) continue;
    const t = Date.parse(e.timestamp || '');
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

// Livraison ≠ reprise (incident 2026-08-22, spinner post-reload n°3) : une
// <task-notification> au statut `stopped` est un message `user` fabriqué par le
// harnais quand il constate qu'une tâche de fond est morte SANS résultat — le
// cas typique : tuée par le reload de fenêtre, notification livrée au respawn
// du CLI. Elle n'est PAS suivie d'une ré-invocation du modèle (constaté en
// réel : aucun assistant pendant 77 s, il ne serait jamais venu) ; la compter
// comme activité conversationnelle faisait conclure isResuming « le travail a
// repris » → spinner sur une conv done, jusqu'à STALE_MS. Ironie mesurée sur le
// transcript témoin : c'est la notification même qui ÉTEINT le pending de
// 2.44.2 qui rallumait le spinner par ce chemin-ci.
// SEUL `stopped` est ignoré : une notification completed/failed annonce une
// vraie ré-invocation imminente — l'ignorer ouvrirait une fenêtre `done` de
// quelques secondes avant le premier token, exactement le faux-done qui a fait
// avancer une vague sur un lot inachevé (incident vagues 2026-08-17). Libellé
// harnais assumé, comme TASK_NOTIF_RE : s'il change, la détection rend faux →
// comportement d'avant (spinner ≤ STALE_MS, auto-éteint), jamais pire.
const TASK_NOTIF_STOPPED_RE = /<status>stopped<\/status>/;
function isStoppedTaskNotif(content) {
  const text = allText(content).trim();
  return TASK_NOTIF_RE.test(text) && TASK_NOTIF_STOPPED_RE.test(text);
}

// ── Signaux de reprise AUTONOME (incident vagues 2026-08-17) ────────────────
//
// « Fin de tour » ≠ « tâche finie » : deux mécanismes du harnais relancent une
// conversation TOUT SEULS après son hook Stop, et le transcript est le seul
// endroit qui le sait :
//  1. Tâche de fond (Agent ou Bash `run_in_background`) : le tool_result du
//     lancement promet une <task-notification> ultérieure — tant qu'elle n'est
//     pas arrivée, la conv va être ré-invoquée. Constaté en réel (lot 1 du
//     batch SNCF, 2026-08-17) : tour fini à 13:37:50, notification-reprise à
//     13:39:23 — entre les deux, le moteur de vagues lisait « done » et
//     ouvrait la vague suivante sur un lot qui n'avait PAS fini.
//  2. ScheduleWakeup (/loop dynamique) : le tool_result porte `scheduledFor` ;
//     un réveil encore à venir = la conv redémarrera d'elle-même.
//
// Détection TEXTUELLE, assumée : les formes ci-dessous sont celles écrites par
// le CLI (relevées sur transcripts réels, versions 2.1.233 → 2.1.234,
// 2026-08-17/18). Si le harnais change son libellé, la détection rend faux →
// comportement d'AVANT ce correctif — MAIS ce « jamais pire » ne vaut que si
// les DEUX moitiés de la paire cassent ENSEMBLE. Incident spinner éternel n°2
// (2026-08-18, le soir même de 2.44.0) : une tâche qui finit EN PLEIN TOUR ne
// passe pas par un message user — le CLI 2.1.234 met sa notification en FILE
// D'ATTENTE (`queue-operation`, puis `attachment` à la livraison). Le
// lancement restait donc vu, la notification plus jamais → moitié de paire
// cassée seule, attente éternelle sur une conv VIVANTE que la borne
// `startedAt` de 2.44.0 ne pouvait pas sauver (lancement plus récent que le
// process, process toujours là). Parade : reconnaître la notification sous
// TOUTES ses formes de livraison (cf. collectNotifTags dans
// pendingResumeSignals) — et pour toute future détection appariée, tester la
// panne asymétrique (une moitié muette). Limite connue, acceptée : une tâche tuée par
// TaskStop n'émet pas de notification → « pending » à tort — le blocage ne
// s'applique qu'aux conversations VIVANTES (cf. effectiveState) et le ▶ manuel
// reste toujours là, même philosophie que `stale` (l'auto se suspend, jamais
// le manuel). Le gel n'est plus PERMANENT depuis la datation ci-dessous
// (incident spinner éternel, 2026-08-18) : un lancement/réveil n'est cru que
// s'il est postérieur au `startedAt` du process VIVANT qui le lit — dès que ce
// process meurt et respawn (reload, crash, resume), la fausse attente expire
// d'elle-même. Elle ne s'efface pas plus tôt : DANS le même process encore
// vivant, un lancement stoppé sans notification reste indiscernable d'un
// lancement toujours en cours — même trou qu'avant, juste borné à la durée de
// vie du process au lieu de l'éternité.
//
// Fenêtre de scan : 4 Mo de queue (un lancement plus vieux que ça dont la
// notification n'est toujours pas arrivée est rarissime ; le rater = repli sur
// le comportement d'avant). Le scan n'est PAS gratuit → l'appelant (state.js)
// le cache par (mtime, size) et ne le déclenche que sur une entrée `done`,
// c'est-à-dire une fois par fin de tour, jamais pendant que ça écrit.
//
// Un signal daté (`pendingTaskAt`, `wakeupSetAt`) n'est une preuve de reprise
// QUE pour le process qui l'a posé — cf. l'amendement ci-dessous.
const PENDING_SCAN_BYTES = 4 * 1024 * 1024;
// ANCRÉS en début de texte, volontairement (faux positif 2026-08-17, trouvé le
// jour même : la conversation qui a CONSTRUIT cette détection citait ces
// libellés dans ses sorties de grep — le scan la voyait « en attente d'une
// tâche de fond » pour toujours, spinner sur une conv terminée). Un VRAI
// résultat de lancement COMMENCE par son libellé ; une citation vit au milieu
// d'un texte (préfixe grep, JSON d'un autre transcript, prose). Même logique
// canal par canal ci-dessous : un signal n'est cru que là où le CLI l'écrit.
const BG_AGENT_LAUNCH_RE = /^Async agent launched successfully/;
const BG_AGENT_ID_RE = /agentId:\s*([A-Za-z0-9_-]+)/;
const BG_BASH_LAUNCH_RE = /^Command running in background with ID:\s*([A-Za-z0-9_.-]+)/;
const TASK_NOTIF_RE = /^<task-notification>/;

// Tout le texte d'un contenu (string brute ou blocs) — contrairement à
// firstTextBlock, une notification peut cohabiter avec d'autres blocs.
function allText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string') out += b.text + '\n';
  }
  return out;
}

function collectTags(text, tag, into) {
  const re = new RegExp('<' + tag + '>([^<]+)</' + tag + '>', 'g');
  let m;
  while ((m = re.exec(text))) into.add(m[1].trim());
}

// Rend { pendingTask, pendingTaskAt, wakeupAt, wakeupSetAt } ou null (fichier
// illisible).
//  - pendingTask   : au moins un lancement de fond (agent/bash) sans
//    <task-notification> correspondante — appariement par task-id (agentId /
//    ID bash) OU par tool-use-id, les deux figurent dans la notification,
//    cherchée sous ses TROIS formes de livraison (cf. collectNotifTags) ;
//  - pendingTaskAt : instant (ms epoch) du plus RÉCENT de ces lancements
//    orphelins, `0` s'il y en a un mais non datable, `null` si `pendingTask`
//    est faux. C'est CETTE date, pas `wakeupAt`, que l'appelant compare au
//    `startedAt` du process vivant (cf. state.js effectiveState) : un
//    lancement plus vieux que la naissance du process courant ne peut PAS
//    recevoir sa notification — ce process n'était pas né pour la recevoir.
//  - wakeupAt      : `scheduledFor` du DERNIER ScheduleWakeup vu (ms epoch), ou
//    null. C'est l'appelant qui compare à « maintenant » : un réveil passé a
//    déjà tiré (la reprise est visible ailleurs), seul un réveil FUTUR annonce
//    une reprise à venir.
//  - wakeupSetAt   : instant (ms epoch) où CE réveil a été armé (timestamp de
//    l'entrée qui porte `scheduledFor`), `0` si présent mais non datable,
//    `null` si `wakeupAt` est null. Même rôle que `pendingTaskAt` : un réveil
//    armé par un process mort ne réveillera jamais le process courant — c'est
//    le harnais qui relance une conversation à l'heure dite, pas le vieux
//    process qui se souvient de son propre minuteur.
function pendingResumeSignals(filePath) {
  let entries;
  try { entries = parseSlice(readSlice(filePath, PENDING_SCAN_BYTES, 'tail')); } catch { return null; }
  const launches = [];
  const notifiedTask = new Set();
  const notifiedToolUse = new Set();
  let wakeupAt = null;
  let wakeupSetAt = null;
  // Une seule définition de « ceci est une notification de fin de tâche »,
  // partagée par ses TROIS formes de livraison (relevées en réel) :
  //   1. message user (string brute ou blocs `text`) — tâche finie pendant que
  //      la conversation était AU REPOS : le harnais ouvre un tour qui porte
  //      la notification (CLI 2.1.233, 2026-08-17) ;
  //   2. `queue-operation` (champ `content`) — tâche finie EN PLEIN TOUR : la
  //      notification passe par la file d'attente (`enqueue` puis `remove`,
  //      les deux portent le texte — Sets, donc idempotent) ;
  //   3. `attachment` avec `commandMode: 'task-notification'` (champ
  //      `attachment.prompt`) — la même, au moment de sa LIVRAISON dans le
  //      contexte (CLI 2.1.234, 2026-08-18, incident spinner éternel n°2).
  // L'ancrage ^<task-notification> reste la garde partout : un prompt USER mis
  // en file (c'est aussi une `queue-operation`) qui ne ferait que CITER ces
  // balises n'éteint rien.
  const collectNotifTags = (raw) => {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!TASK_NOTIF_RE.test(text)) return;
    collectTags(text, 'task-id', notifiedTask);
    collectTags(text, 'tool-use-id', notifiedToolUse);
  };
  for (const e of entries) {
    if (!e) continue;
    if (e.type === 'queue-operation') { collectNotifTags(e.content); continue; }
    if (e.type === 'attachment') {
      if (e.attachment && e.attachment.commandMode === 'task-notification') collectNotifTags(e.attachment.prompt);
      continue;
    }
    if (e.type !== 'user') continue;
    const parsedTs = Date.parse(e.timestamp || '');
    const entryTs = Number.isFinite(parsedTs) ? parsedTs : 0;
    if (e.toolUseResult && typeof e.toolUseResult.scheduledFor === 'number') {
      // Un `stop: true` (fin de /loop) rend `{scheduledFor: 0, stopped: true,
      // cancelledWakeups: N}` (relevé en réel) : il ANNULE les réveils armés —
      // explicite ici, même si l'écrasement par 0 aurait suffi par accident.
      wakeupAt = e.toolUseResult.stopped ? null : e.toolUseResult.scheduledFor;
      wakeupSetAt = e.toolUseResult.stopped ? null : entryTs;
    }
    const content = e.message && e.message.content;
    // Forme 1 : le texte porté par le message user lui-même (string brute ou
    // blocs `text` — allText ignore les tool_results). Une notification
    // « vue » dans un tool_result est une CITATION (grep, cat d'un autre
    // transcript) et ne doit surtout pas ÉTEINDRE une vraie attente.
    collectNotifTags(allText(content));
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || b.type !== 'tool_result') continue;
      // Lancement : UNIQUEMENT un tool_result, et ancré — cf. les regex.
      const txt = allText(b.content).trim();
      if (!txt) continue;
      if (BG_AGENT_LAUNCH_RE.test(txt)) {
        const m = BG_AGENT_ID_RE.exec(txt);
        launches.push({ toolUseId: b.tool_use_id || null, taskId: m ? m[1] : null, ts: entryTs });
        continue;
      }
      const bash = BG_BASH_LAUNCH_RE.exec(txt);
      if (bash) launches.push({ toolUseId: b.tool_use_id || null, taskId: bash[1], ts: entryTs });
    }
  }
  const pendingLaunches = launches.filter((l) =>
    !(l.taskId && notifiedTask.has(l.taskId)) &&
    !(l.toolUseId && notifiedToolUse.has(l.toolUseId)));
  const pendingTask = pendingLaunches.length > 0;
  const pendingTaskAt = pendingTask
    ? pendingLaunches.reduce((latest, l) => Math.max(latest, l.ts || 0), 0)
    : null;
  return { pendingTask, pendingTaskAt, wakeupAt, wakeupSetAt };
}

module.exports = {
  readSlice, parseSlice, usageTokens, extractLastAssistant, extractTitleInfo,
  scanAiTitleIncremental, cleanTitle, firstUserText, TITLE_MAX,
  hasPendingInteractiveTool, wasInterrupted, lastActivityTs, INTERACTIVE_TOOLS,
  pendingResumeSignals,
  pendingInteractiveAt, interruptedAt,
};
