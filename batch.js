// ============================================================================
// Création groupée de conversations — noyau métier (lot 1 du plan
// PLAN_creation_groupes_2026-07-22.md).
//
// Node PUR : aucune dépendance à `vscode` (le pilotage de l'éditeur vit dans
// launcher.js). Tout ce qui décide — reconnaissance du bloc ```claude-convs```,
// validation des choix modèle/effort, variables d'environnement à poser, écart
// entre ce qui a été DEMANDÉ et ce qui tourne RÉELLEMENT — est ici, donc
// testable en `node`.
//
//  1. `parseClaudeConvsBlock` — SEUL point d'entrée pour transformer un texte
//     collé en tâches (le champ prompt EST la zone de collage, décision du
//     plan 2026-07-23 : plus de découpage bête sur ligne vide — un texte sans
//     bloc reconnu redevient UN SEUL prompt, tel quel, lignes vides comprises).
//  2. `envForTask` — modèle et effort passent par l'ENVIRONNEMENT du process
//     hôte (ANTHROPIC_MODEL / CLAUDE_CODE_EFFORT_LEVEL), jamais par une
//     écriture de ~/.claude/settings.json : écrire un état global pour
//     paramétrer un appel, c'est une course entre conversations plus un effet
//     de bord permanent (cf. NOTES_api_claude_code_extension.md).
//  3. `mismatchOf` — le panneau affiche le modèle/effort RÉELS lus du
//     transcript ; l'intention enregistrée au lancement ne sert qu'à signaler
//     un ÉCART. Aucun mécanisme aveugle : si le réel est inconnu, il n'y a pas
//     d'écart, pas de badge.
// ============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseModelId } = require('./hooks/model-id.js');

// Valeurs proposées par les boutons segmentés (aucun dropdown, décision 4 du
// plan). Lot 14 : « inherit » a disparu — une conversation tout-défaut
// s'obtient déjà avec le bouton natif de Claude Code ; l'extension ne sert
// QUE quand on choisit. `null` = valeur pas (encore) résolue — le formulaire
// pré-sélectionne le défaut RÉSOLU des settings (readInheritSettings) au lieu
// d'afficher un état abstrait ; résolution impossible ⇒ aucun bouton allumé
// et Create désactivé (jamais une valeur inventée, cf. plan lot 14).
const MODELS = ['haiku', 'sonnet', 'opus', 'fable'];
// `max` ajouté au lot 7 : honoré par le CLI (vérifié 2026-07-23 par exécution
// réelle, cf. NOTES). Ultracode n'a PAS sa place ici — non pilotable par
// variable d'environnement (grep du binaire, même vérification), donc absent
// du formulaire plutôt qu'un bouton qui mentirait (cf. plan lot 7).
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Les deux seules variables concernées (doc env-vars de Claude Code, vérifiées
// par exécution réelle le 2026-07-22 : elles priment sur les settings persistés).
const ENV_MODEL = 'ANTHROPIC_MODEL';
const ENV_EFFORT = 'CLAUDE_CODE_EFFORT_LEVEL';
const OUR_ENV_VARS = [ENV_MODEL, ENV_EFFORT];

function isModel(v) { return MODELS.includes(v); }
function isEffort(v) { return EFFORTS.includes(v); }

// `resolved` (lot 14) = { model, effort } RÉSOLUS des settings
// (readInheritSettings), tels que poussés dans batchState.inherit côté
// webview. Un champ non résolu (ou hors de MODELS/EFFORTS — settings
// exotiques) reste `null` : jamais une valeur inventée. haiku n'a pas de
// notion d'effort (lot 7) : un effort résolu n'est jamais appliqué dessus.
function resolveDefaultModel(resolved) {
  const raw = resolved && typeof resolved.model === 'string' ? resolved.model : null;
  if (!raw) return null;
  // `~/.claude/settings.json` peut porter un alias avec tag (`opus[1m]`) — les
  // boutons segmentés n'ont que les FAMILLES nues (lot 7/12) ; on pré-sélectionne
  // sur la famille, comme le faisait déjà le libellé « inherit (opus) » du lot 12
  // (écart assumé du lot 14 : le tag `[1m]` lui-même n'est pas reproductible par
  // un bouton qui n'existe pas — voir Avancement du plan).
  const stripped = raw.replace(/\[[^\]]*\]$/, '');
  if (isModel(stripped)) return stripped;
  // Forme courte déjà gérée ci-dessus ; un ID complet (`claude-fable-5`,
  // `claude-opus-4-8`, `claude-haiku-4-5-20251001`) échappe au strip nu — on
  // le fait passer par le même parseur de schéma que l'affichage du modèle
  // réel (hooks/model-id.js), plutôt que de dupliquer une table ID→famille
  // qui dériverait à chaque nouveau modèle. Bug corrigé 2026-07-24 : le
  // défaut persisté (ID complet) n'allumait plus aucun bouton du formulaire.
  const parsed = parseModelId(raw) || parseModelId(stripped);
  return parsed && isModel(parsed.family) ? parsed.family : null;
}
function resolveDefaultEffort(model, resolved) {
  if (model === 'haiku') return null;
  return resolved && isEffort(resolved.effort) ? resolved.effort : null;
}

function blankTask(wave = 1, resolved = null) {
  const model = resolveDefaultModel(resolved);
  return { prompt: '', model, effort: resolveDefaultEffort(model, resolved), wave };
}

// ── Parseur strict du bloc ```claude-convs``` (lot 3) ──────────────────────
// Bonus de collage, rien de plus (décision révisée 3 fois le 2026-07-22,
// cf. plan) : le SEUL point d'entrée reste le collage dans le champ prompt
// (la zone unique, décision du plan 2026-07-23). Ce parseur ne lit JAMAIS un
// transcript ni n'attend un comportement du modèle — il se contente de
// reconnaître un format dans le texte collé, comme un raccourci de saisie.
// Tout-ou-rien : un bloc mal formé n'est PAS corrigé à la volée (contrairement
// à normalizeTasks), il est rejeté avec une raison — le texte redevient alors
// un prompt simple tel quel, jamais une demi-lecture.
//
// Format (documenté dans /handoffs, cf. install.ps1) :
//   ```claude-convs
//   session: <uuid>           (optionnel, UNE fois, en tête — lot 11 : jeton
//                              RECOPIÉ du contexte injecté par notre hook, jamais
//                              inventé par le modèle ; revalidé à l'arrivée par
//                              master.js, donc sans danger s'il est faux)
//   group: <nom>              (optionnel, UNE fois, avant tout le reste)
//   model: <haiku|sonnet|opus|fable>   (optionnel, par section)
//   effort: <low|medium|high|xhigh|max> (optionnel, par section — ignoré si model: haiku)
//   stage: <n>                         (optionnel, par section — vague)
//   <prompt tel quel, peut faire plusieurs lignes>
//   [---]
//   <section suivante…>
//   ```
// Plusieurs blocs dans le texte collé → le DERNIER gagne (décision du plan).
//
// Séparateur `[---]` (décision du plan 2026-07-23, 3 tirets ou plus entre
// crochets) : remplace l'ancien `---` nu, trop anodin — une ligne `---` seule
// est à la fois une règle horizontale markdown et un délimiteur de frontmatter
// YAML, un prompt collé contenant du markdown pouvait se faire découper en
// douce. `[---]` n'a de sens dans aucun de ces formats. Legacy : une ligne
// `---` nue compte encore comme séparateur, mais SEULEMENT si la ligne
// immédiatement suivante est un champ reconnu — motif : les blocs des plans
// déjà écrits (sections toujours ouvertes par `model:`/`effort:`/`stage:`)
// doivent rester collables sans casse silencieuse, alors qu'un `---` isolé
// dans un prompt (aucun champ derrière) redevient du texte normal.
//
// Fence optionnelle (lot 6, correctif §1 — bloquant constaté au premier essai
// terrain) : copier un bloc de code depuis le rendu du chat (sélection ou
// bouton Copy) donne le CONTENU du bloc, pas les ``` qui l'entourent — le
// format attendu par /handoffs n'atteint donc JAMAIS le collage par ce chemin,
// qui est pourtant le geste normal. Repli sur le texte NU quand aucune fence
// n'est trouvée : même parseur strict, mêmes rejets tout-ou-rien, la fence
// devient optionnelle, PAS la structure — donc un garde-fou avant d'essayer :
// un texte collé quelconque (prose, code, mail) n'est tenté comme bloc nu que
// s'il porte un signe structurel du format (une ligne `[---]`, ou sa toute
// première ligne est un champ `group:`/`model:`/`effort:`/`stage:`/`session:`
// reconnu) — un `---` nu seul ne suffit PLUS comme signal (décision du plan :
// c'est précisément l'anodin qu'on tue) ; sinon le texte reste un prompt
// simple, exactement comme avant ce lot.
const FIELD_LINE_RE = /^(session|group|model|effort|stage)\s*:\s*(.*)$/i;
const SEPARATOR_RE = /^\[-{3,}\]$/;
const LEGACY_SEPARATOR_RE = /^---$/;
const BARE_SIGNAL_RE = /^\[-{3,}\]\s*$/m;

function findBareClaudeConvsBlock(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const firstLine = trimmed.split(/\r?\n/, 1)[0] || '';
  if (!BARE_SIGNAL_RE.test(trimmed) && !FIELD_LINE_RE.test(firstLine)) return null;
  return trimmed;
}

// Découpe le corps d'un bloc (fencé ou nu) en sections sur un séparateur.
// `[---]` sépare inconditionnellement ; un `---` nu ne sépare que si la ligne
// suivante est un champ reconnu (legacy, voir commentaire ci-dessus).
function splitSections(lines) {
  const sections = [[]];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (SEPARATOR_RE.test(trimmed)) { sections.push([]); continue; }
    if (LEGACY_SEPARATOR_RE.test(trimmed) && i + 1 < lines.length && FIELD_LINE_RE.test(lines[i + 1])) {
      sections.push([]);
      continue;
    }
    sections[sections.length - 1].push(lines[i]);
  }
  return sections;
}

function findClaudeConvsBlock(text) {
  if (typeof text !== 'string') return null;
  const re = /```claude-convs\r?\n([\s\S]*?)```/g;
  let m;
  let last = null;
  while ((m = re.exec(text))) last = m[1];
  if (last != null) return last;
  return findBareClaudeConvsBlock(text);
}

// Rend `{ found, tasks, group, session, error }`. `found` = un bloc
// ```claude-convs``` existe dans le texte (qu'il soit valide ou non).
// `tasks`/`group`/`session` non-null SEULEMENT quand `error` est null : jamais
// de résultat partiel. `resolved` (lot 14) : les champs `model:`/`effort:`
// restent optionnels DANS LE BLOC — une section qui ne les porte pas se voit
// pré-remplie par le défaut résolu, jamais par un « inherit » affiché.
function parseClaudeConvsBlock(text, resolved = null) {
  const body = findClaudeConvsBlock(text);
  if (body == null) return { found: false, tasks: null, group: null, session: null, error: null };

  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const sections = splitSections(lines);

  let group = null;
  let session = null;
  const tasks = [];
  let error = null;

  sections.forEach((secLines, idx) => {
    if (error) return;
    const fields = {};
    let i = 0;
    while (i < secLines.length) {
      const fm = secLines[i].match(FIELD_LINE_RE);
      if (!fm) break;
      const key = fm[1].toLowerCase();
      const value = fm[2].trim();
      // `session` (lot 11) : propriété du BLOC, pas d'une tâche — même
      // traitement que `group`. Sa valeur n'est validée nulle part ici : ce
      // parseur ne sait pas ce qu'est une session, et un jeton faux ne doit
      // JAMAIS faire rejeter un bloc par ailleurs correct. C'est master.js qui
      // le revalide contre les transcripts, et le jette sans bruit s'il ment.
      if (key === 'session') {
        if (idx !== 0) { error = 'session: only allowed at the top of the first section'; return; }
        if (session !== null) { error = 'session: given more than once'; return; }
        session = value;
        i++;
        continue;
      }
      if (key === 'group') {
        if (idx !== 0) { error = 'group: only allowed at the top of the first section'; return; }
        if (group !== null) { error = 'group: given more than once'; return; }
        group = value;
        i++;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(fields, key)) {
        error = `${key}: given more than once in section ${idx + 1}`;
        return;
      }
      fields[key] = value;
      i++;
    }
    if (error) return;

    const prompt = secLines.slice(i).join('\n').trim();
    if (!prompt) { error = `section ${idx + 1} has no prompt`; return; }

    let model = resolveDefaultModel(resolved);
    let effort = resolveDefaultEffort(model, resolved);
    let wave = 1;
    if (fields.model !== undefined) {
      const v = fields.model.toLowerCase();
      if (!isModel(v)) { error = `section ${idx + 1}: unknown model "${fields.model}"`; return; }
      model = v;
      // Un `model:` explicite peut changer la donne pour l'effort par défaut
      // (haiku n'en a pas, cf. resolveDefaultEffort) — recalculé seulement si
      // `effort:` n'est lui-même pas donné plus bas.
      if (fields.effort === undefined) effort = resolveDefaultEffort(model, resolved);
    }
    if (fields.effort !== undefined) {
      const v = fields.effort.toLowerCase();
      if (!isEffort(v)) { error = `section ${idx + 1}: unknown effort "${fields.effort}"`; return; }
      effort = model === 'haiku' ? null : v;
    }
    if (fields.stage !== undefined) {
      const n = Number(fields.stage);
      if (!Number.isInteger(n) || n < 1) { error = `section ${idx + 1}: invalid stage "${fields.stage}"`; return; }
      wave = n;
    }
    tasks.push({ prompt, model, effort, wave });
  });

  if (error) return { found: true, tasks: null, group: null, session: null, error };
  if (!tasks.length) return { found: true, tasks: null, group: null, session: null, error: 'no task found in block' };

  // Vagues non contiguës = rejeté (décision du plan) : contrairement à
  // normalizeTasks, ce parseur ne renumérote rien — un trou est le signe d'une
  // faute de frappe côté modèle (stage: 3 sans stage: 2), pas d'une vague
  // vidée en cours d'édition (seul cas que normalizeTasks doit couvrir).
  const waves = [...new Set(tasks.map((t) => t.wave))].sort((a, b) => a - b);
  const contiguous = waves.every((w, i) => w === i + 1);
  if (!contiguous) {
    return { found: true, tasks: null, group: null, session: null, error: `wave numbers are not contiguous (${waves.join(', ')})` };
  }

  return { found: true, tasks, group, session, error: null };
}

// Nettoyage d'une liste de tâches venue du webview (donc non fiable) :
// prompts vides jetés, valeurs modèle/effort invalides/absentes ramenées au
// défaut résolu (lot 14 — plus de repli `inherit`, le formulaire est censé
// avoir déjà résolu ; `resolved` est INJECTÉ par l'appelant — extension.js
// passe `readInheritSettings()`, un banc passe ce qu'il veut — jamais lu ici
// même, pour rester un filet purement défensif et testable sans toucher au
// disque), numéros de vague ramenés à une suite CONTIGUË commençant à 1 en
// préservant l'ordre relatif (une vague vidée de ses tâches ne doit pas
// laisser un trou, qui bloquerait le déverrouillage au lot 4).
function normalizeTasks(tasks, resolved = { model: null, effort: null }) {
  const list = Array.isArray(tasks) ? tasks : [];
  const kept = [];
  for (const t of list) {
    const prompt = typeof t?.prompt === 'string' ? t.prompt.trim() : '';
    if (!prompt) continue;
    const model = isModel(t?.model) ? t.model : resolveDefaultModel(resolved);
    const effort = model === 'haiku'
      ? null
      : (isEffort(t?.effort) ? t.effort : resolveDefaultEffort(model, resolved));
    kept.push({
      prompt,
      model,
      effort,
      wave: Number.isFinite(t.wave) && t.wave >= 1 ? Math.floor(t.wave) : 1,
    });
  }
  const waves = [...new Set(kept.map((t) => t.wave))].sort((a, b) => a - b);
  const renum = new Map(waves.map((w, i) => [w, i + 1]));
  for (const t of kept) t.wave = renum.get(t.wave);
  // Ordre d'exécution = ordre des vagues, ordre de saisie à l'intérieur.
  return kept.sort((a, b) => a.wave - b.wave);
}

// Variables à poser pour CETTE tâche. Lot 14 : un modèle sélectionné est
// TOUJOURS explicite (plus de bouton « inherit ») — ANTHROPIC_MODEL est donc
// posée à CHAQUE lancement dès que `task.model` est une valeur connue ; seule
// une tâche défensivement incomplète (valeur inconnue/absente, ne devrait pas
// arriver puisque le formulaire désactive Create tant que rien n'est résolu)
// ne pose rien.
function envForTask(task) {
  const out = {};
  if (task && isModel(task.model)) out[ENV_MODEL] = task.model;
  // haiku n'a pas de notion d'effort dans Claude Code (constat user, 2026-07-23) :
  // ne jamais poser CLAUDE_CODE_EFFORT_LEVEL pour une tâche haiku, quelle que
  // soit la valeur restée enregistrée sur `task.effort` (bloc collé, groupe
  // persisté depuis avant ce lot) — le formulaire désactive aussi le sélecteur,
  // mais c'est ici la garantie qui tient même si une source moins fiable a
  // laissé passer autre chose.
  if (task && task.model !== 'haiku' && isEffort(task.effort)) out[ENV_EFFORT] = task.effort;
  return out;
}

// Pose `vars` sur un objet d'environnement et rend la fonction qui REMET
// exactement l'état d'avant — y compris l'absence de la clé, qui n'est pas la
// même chose qu'une clé vide. Toujours appelée en `finally` par launcher.js :
// une variable laissée en place contaminerait la conversation suivante (et
// c'est justement l'effet de bord que l'on refuse aux settings persistés).
function applyEnv(env, vars) {
  const saved = new Map();
  for (const [k, v] of Object.entries(vars || {})) {
    saved.set(k, Object.prototype.hasOwnProperty.call(env, k) ? env[k] : undefined);
    env[k] = v;
  }
  return function restore() {
    for (const [k, prev] of saved) {
      if (prev === undefined) delete env[k];
      else env[k] = prev;
    }
    saved.clear();
  };
}

// Garde-fou du plan : le réglage VS Code officiel `claudeCode.environmentVariables`
// est appliqué APRÈS process.env par l'extension Claude (fonction Lp(), cf.
// NOTES) — un utilisateur qui y définit nos deux variables écrase donc tout ce
// qu'on pourrait poser. Cas détectable, jamais silencieux : les sélecteurs sont
// désactivés et le panneau dit pourquoi.
// `setting` = le tableau [{name, value}] tel que lu par getConfiguration.
function conflictingEnvVars(setting) {
  const list = Array.isArray(setting) ? setting : [];
  const names = new Set(list.map((e) => e && e.name).filter(Boolean));
  return OUR_ENV_VARS.filter((v) => names.has(v));
}

// ── Intentions de lancement ────────────────────────────────────────────────
// Ce qui a été DEMANDÉ pour une conversation qu'on vient d'ouvrir. En mémoire
// au lot 1 (le lot 2 les persiste avec les groupes dans workspaceState) ;
// clé = sessionId retrouvé au lancement via le registre ~/.claude/sessions
// (cf. launcher.js). Sans sessionId, pas d'intention enregistrée — donc pas de
// badge d'écart : on ne rattache jamais une intention par déduction.
function createIntentStore() {
  const byId = new Map();
  return {
    record(sessionId, intent) {
      if (!sessionId || !intent) return;
      byId.set(sessionId, {
        model: isModel(intent.model) ? intent.model : null,
        effort: isEffort(intent.effort) ? intent.effort : null,
        at: intent.at || Date.now(),
      });
    },
    get(sessionId) { return byId.get(sessionId) || null; },
    forget(sessionId) { byId.delete(sessionId); },
    size() { return byId.size; },
  };
}

// Écart intention ↔ réel. Rend `null` dès qu'il n'y a rien à dire :
//  - pas d'intention pour ce champ (`null` — lot 14 : plus de valeur `inherit`
//    à écarter, une intention enregistrée est TOUJOURS explicite désormais,
//    donc systématiquement vérifiable dès qu'elle existe) ;
//  - réel inconnu (transcript pas encore écrit, modèle non parsable, champ
//    `effort` absent — il ne l'est pas sur tous les modèles).
// Le modèle se compare par FAMILLE : l'intention est un alias (`opus`), le réel
// un id complet (`claude-opus-4-8[1m]`).
function mismatchOf(intent, real) {
  if (!intent) return null;
  const out = {};
  if (intent.model && real && real.modelId) {
    const p = parseModelId(real.modelId);
    if (p && p.family && p.family !== intent.model) {
      out.model = { asked: intent.model, real: p.family };
    }
  }
  if (intent.effort && real && real.effort) {
    if (String(real.effort).toLowerCase() !== intent.effort) {
      out.effort = { asked: intent.effort, real: String(real.effort).toLowerCase() };
    }
  }
  return out.model || out.effort ? out : null;
}

// ── Résolution du défaut (lot 12, rebaptisé lot 14) ────────────────────────
// Un bouton « inherit » seul ne disait pas sur quel modèle/effort une
// conversation allait réellement démarrer — objection user au cadrage
// (« je ne sais jamais sur quel modèle est le sélecteur »). Lot 14 : le
// bouton disparaît, remplacé par une PRÉ-SÉLECTION concrète (resolveDefaultModel/
// resolveDefaultEffort ci-dessus). Les deux champs viennent de
// ~/.claude/settings.json (`model`, `effortLevel`), et JAMAIS en cache : un
// `/effort` dans N'IMPORTE QUELLE conversation fait dériver ce défaut global
// (cf. NOTES_api_claude_code_extension.md) — chaque appel relit le fichier.
// Fichier illisible/absent, JSON invalide, ou champ absent → `null` pour CE
// champ précisément (jamais une valeur inventée) ; le formulaire n'allume
// alors aucun bouton pour ce sélecteur et désactive Create.
const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

function readInheritSettings(settingsPath = SETTINGS_PATH) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    return { model: null, effort: null };
  }
  if (!raw || typeof raw !== 'object') return { model: null, effort: null };
  const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : null;
  const effort = typeof raw.effortLevel === 'string' && raw.effortLevel.trim() ? raw.effortLevel.trim() : null;
  return { model, effort };
}

module.exports = {
  MODELS, EFFORTS, ENV_MODEL, ENV_EFFORT, OUR_ENV_VARS,
  blankTask, normalizeTasks,
  resolveDefaultModel, resolveDefaultEffort,
  findClaudeConvsBlock, parseClaudeConvsBlock,
  envForTask, applyEnv, conflictingEnvVars,
  createIntentStore, mismatchOf,
  SETTINGS_PATH, readInheritSettings,
};
