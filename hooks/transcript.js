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
function extractLastAssistant(filePath) {
  const entries = parseSlice(readSlice(filePath, TAIL_BYTES, 'tail'));
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === 'assistant' && e.message && e.message.model) {
      return { modelId: e.message.model, usage: e.message.usage || null };
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
  for (const e of parseSlice(readSlice(filePath, HEAD_BYTES, 'head'))) {
    if (e.type !== 'user' || e.isMeta || e.isSidechain || !e.message) continue;
    const txt = firstTextBlock(e.message.content);
    const cleaned = cleanTitle(txt);
    if (cleaned) return { title: cleaned, source: 'first-user' };
  }
  const lp = cleanTitle(lastPrompt);
  return lp ? { title: lp, source: 'last-prompt' } : { title: null, source: null };
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
function hasPendingInteractiveTool(filePath) {
  const entries = parseSlice(readSlice(filePath, TAIL_BYTES, 'tail'));
  let lastAssistantIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === 'assistant') { lastAssistantIdx = i; break; }
  }
  if (lastAssistantIdx === -1) return false;
  const content = entries[lastAssistantIdx].message && entries[lastAssistantIdx].message.content;
  if (!Array.isArray(content) || !content.length) return false;
  const lastBlock = content[content.length - 1];
  if (!lastBlock || lastBlock.type !== 'tool_use' || !INTERACTIVE_TOOLS.has(lastBlock.name)) return false;

  // Un tool_result correspondant (même id) plus loin dans le transcript = déjà
  // répondu — tout événement postérieur au tool_use fait foi, pas seulement le
  // tool_result exact (message user envoyé entretemps, etc.).
  for (let i = lastAssistantIdx + 1; i < entries.length; i++) {
    const c = entries[i].message && entries[i].message.content;
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b && b.type === 'tool_result' && b.tool_use_id === lastBlock.id) return false;
      }
    }
  }
  return true;
}

module.exports = {
  readSlice, parseSlice, usageTokens, extractLastAssistant, extractTitleInfo,
  scanAiTitleIncremental, cleanTitle, TITLE_MAX,
  hasPendingInteractiveTool, INTERACTIVE_TOOLS,
};
