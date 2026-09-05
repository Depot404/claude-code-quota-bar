// Banc du lot 0 (PLAN_appariement_onglets_2026-08-15.md) : journal du verdict
// de surlignage. Un OBSERVATEUR pur — ce banc prouve qu'il n'écrit qu'au
// changement de verdict (pas à chaque recompute), qu'il porte tous les champs
// promis (matches, via, source, focus…) et que QUOTABAR_ACK_JOURNAL=off le
// coupe sans rien casser au rendu.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-highlight-journal-'));
os.homedir = () => SANDBOX;                       // AVANT le require de state.js
fs.mkdirSync(path.join(SANDBOX, '.claude'), { recursive: true });

const state = require(path.join(__dirname, '..', 'state.js'));
const journal = require(path.join(__dirname, '..', 'ack-journal.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

const WS = 'C:\\Users\\Test\\Projets VSCODE\\DemoHighlight';
const projectDir = state.projectDirFor(WS);
fs.mkdirSync(projectDir, { recursive: true });

const assistant = { type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000 } } };
const userMsg = (t) => ({ type: 'user', message: { content: [{ type: 'text', text: t }] } });

// Premier message DIFFÉRENT à chaque fois : deux sœurs au même titre restent
// deux conversations distinctes (sinon supersede.js les fusionne en husk/
// successeur d'un même resume — pas le scénario visé ici, cf. lot 2 du plan).
function writeTranscript(sessionId, title, mtimeOffsetSec, firstMsg) {
  const p = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(p, [userMsg(firstMsg || `peu importe ${sessionId}`), assistant, { type: 'ai-title', aiTitle: title }]
    .map((l) => JSON.stringify(l)).join('\n') + '\n');
  const when = (Date.now() - mtimeOffsetSec * 1000) / 1000;
  fs.utimesSync(p, when, when);
  return p;
}

writeTranscript('a', 'Conv A', 20);
writeTranscript('b', 'Conv B', 10);

const DEFAULT_JOURNAL = path.join(SANDBOX, '.claude', 'quotabar-ack-journal.jsonl');
const lines = () => journal.readJournal(DEFAULT_JOURNAL);
const verdicts = () => lines().filter((l) => l.event === 'highlight-verdict');
function resetJournal() { try { fs.rmSync(DEFAULT_JOURNAL, { force: true }); } catch {} }

function snapshot(tabsProvider, extra) {
  const reader = state.createTranscriptReader();
  return state.buildSnapshot(Object.assign({
    workspacePath: WS, recentMs: 4 * 3600 * 1000, maxItems: 12, tabs: tabsProvider,
  }, extra || {}), reader);
}

const tabsFresh = (label) => () => ({
  known: true, labels: ['Conv A', 'Conv B'], activeLabel: label,
  source: 'fresh', windowFocused: true, sinceFocusMs: 42,
});

console.log('\n1. Un verdict répété n\'écrit qu\'une ligne');
resetJournal();
snapshot(tabsFresh('Conv A'));
snapshot(tabsFresh('Conv A'));
snapshot(tabsFresh('Conv A'));
check('trois recomputes identiques → une seule ligne', verdicts().length === 1, String(verdicts().length));
check('… avec les champs promis (matches, via, source, focus)', (() => {
  const v = verdicts()[0];
  return v.activeLabel === 'Conv A' && v.sessionId === 'a' && v.matches === 1
    && v.via === 'label' && v.source === 'fresh'
    && v.windowFocused === true && v.sinceFocusMs === 42;
})(), JSON.stringify(verdicts()[0]));

console.log('\n2. Un changement de conversation surlignée écrit une ligne de plus');
snapshot(tabsFresh('Conv B'));
check('deux verdicts distincts → deux lignes', verdicts().length === 2, String(verdicts().length));
check('la seconde ligne porte la nouvelle conv et le nombre de répétitions tues',
  verdicts()[1].sessionId === 'b' && verdicts()[1].repeatsSkipped === 2, JSON.stringify(verdicts()[1]));

console.log('\n3. Collision de titres tronqués → matches ≥ 2 ; le rendu SE TAIT (lot 3), sauf identifiant vrai');
resetJournal();
// Deux titres COMPLETS distincts (donc jamais fondus par supersede.js, qui
// groupe sur le titre EXACT) mais dont l'onglet tronqué à 24 car. est
// identique — le scénario réel du constat (2026-08-15), pas un resume.
const PREFIX = 'x'.repeat(24);
writeTranscript('c', `${PREFIX} variante C`, 5, 'un tout autre sujet');
writeTranscript('d', `${PREFIX} variante D`, 3, 'encore un autre sujet');
// Toutes deux BUSY (lot 2 du plan d'appariement, 2026-08-21) : depuis
// l'appariement bijectif, une seule des deux sœurs peut se voir assigner
// l'unique onglet ambigu — la surnuméraire, si elle était idle, serait
// désormais correctement MASQUÉE (c'est le fix). Ce banc teste la collision
// elle-même (le journal doit la voir), pas ce masquage : busy garde les deux
// visibles quel que soit l'onglet, exactement comme deux vrais travaux en
// cours dont les titres tronqués coïncident.
fs.writeFileSync(path.join(SANDBOX, '.claude', 'sessions-state.json'), JSON.stringify({
  version: 1,
  sessions: {
    c: { state: 'busy', since: Date.now(), updated_at: Date.now(), transcript: path.join(projectDir, 'c.jsonl') },
    d: { state: 'busy', since: Date.now(), updated_at: Date.now(), transcript: path.join(projectDir, 'd.jsonl') },
  },
}));
const collisionLabel = `${PREFIX}…`;
const ACTIVE_SESSION_PATH = path.join(SANDBOX, '.claude', 'active-session.json');
try { fs.rmSync(ACTIVE_SESSION_PATH, { force: true }); } catch {}
const snap = snapshot(() => ({
  known: true, labels: ['Conv B', collisionLabel], activeLabel: collisionLabel, frozen: false,
  source: 'fresh', windowFocused: true, sinceFocusMs: 42,
}));
check('le journal voit la collision (matches ≥ 2)', verdicts()[0].matches >= 2, JSON.stringify(verdicts()[0]));
// Lot 3 du plan d'appariement (2026-08-21) : l'appariement qui aurait désigné
// une sœur plutôt que l'autre est ARBITRAIRE (ordre d'affichage, pas
// l'onglet réellement sélectionné) — se taire vaut mieux qu'un surlignage au
// hasard, exactement le symptôme signalé (« ça surligne la mauvaise »).
check('… sans identifiant vrai (active-session.json), PERSONNE n\'est surligné',
  snap.conversations.every((c) => c.isActive === false), JSON.stringify(snap.conversations.map((c) => c.isActive)));
check('… le verdict journalisé porte via:none, pas via:label au hasard',
  verdicts()[verdicts().length - 1].via === 'none', JSON.stringify(verdicts()[verdicts().length - 1]));

// active-session.json (la conv du DERNIER PROMPT SOUMIS) ne départage PLUS ce
// groupe ambigu depuis 2.110.0 : écrire dans une conversation ne dit pas quel
// onglet est AFFICHÉ — on peut soumettre dans l'une des sœurs puis aller lire
// l'autre, et le surlignage restait faux sans recours. Il reste écrit au
// journal (champ activeSessionId), il ne décide plus rien.
fs.writeFileSync(ACTIVE_SESSION_PATH, JSON.stringify({ session_id: 'd' }));
const snapStillMute = snapshot(() => ({
  known: true, labels: ['Conv B', collisionLabel], activeLabel: collisionLabel,
  source: 'fresh', windowFocused: true, sinceFocusMs: 42,
}));
check('… active-session.json ne départage plus : personne n\'est surligné',
  snapStillMute.conversations.every((c) => c.isActive === false),
  JSON.stringify(snapStillMute.conversations.map((c) => [c.sessionId, c.isActive])));
check('… mais il reste PUBLIÉ par le snapshot (jeton /handoffs, diagnostic)',
  snapStillMute.activeSessionId === 'd', String(snapStillMute.activeSessionId));

// QUI PORTE L'INFORMATION À SA PLACE, et c'est une preuve exacte : se taire
// laisse `highlightSessionId` nul, donc le juge renderer (memento du renderer,
// IDENTITÉ de l'éditeur affiché) comble — il désigne 'c', la sœur réellement à
// l'écran, pas celle où le dernier prompt a été soumis.
const snapJudged = snapshot(() => ({
  known: true, labels: ['Conv B', collisionLabel], activeLabel: collisionLabel,
  source: 'fresh', windowFocused: true, sinceFocusMs: 42, labelChangedAt: Date.now() - 60000,
}), { rendererActive: () => ({ sessionId: 'c', claude: true, flushedAt: Date.now() }) });
check('… le juge renderer comble par IDENTITÉ (la sœur affichée, pas celle du dernier prompt)',
  snapJudged.conversations.find((c) => c.sessionId === 'c').isActive === true
  && snapJudged.conversations.filter((c) => c.isActive).length === 1,
  JSON.stringify(snapJudged.conversations.map((c) => [c.sessionId, c.isActive])));
try { fs.rmSync(ACTIVE_SESSION_PATH, { force: true }); } catch {}

console.log('\n4. QUOTABAR_ACK_JOURNAL=off coupe tout sans rien casser');
resetJournal();
const before = process.env.QUOTABAR_ACK_JOURNAL;
process.env.QUOTABAR_ACK_JOURNAL = 'off';
let threw = false;
let snapOff;
// Nouveau libellé (jamais vu par le filtre) : force une tentative d'écriture
// même journal coupé, sinon le test ne prouverait que la dédup, pas la coupure.
try { snapOff = snapshot(tabsFresh('Conv B')); } catch { threw = true; }
process.env.QUOTABAR_ACK_JOURNAL = before === undefined ? '' : before;
if (before === undefined) delete process.env.QUOTABAR_ACK_JOURNAL;
check('journal désactivé → aucune exception', threw === false);
check('… et le surlignage reste correct malgré le journal coupé',
  snapOff && snapOff.conversations.some((c) => c.isActive));
check('… et rien n\'a été écrit', lines().length === 0, String(lines().length));

console.log('\n4. Onglet renommé au DERNIER PROMPT (réouverture, 2026-09-04) → reconnu par lastPrompt, via:label');
// Après toute réouverture, l'extension officielle baptise l'onglet du dernier
// prompt (24 car. + « … ») et le garde. Le libellé ne matche alors NI le titre
// NI le store : sans `lastPrompt` (transcript `last-prompt`), la conv était
// absente ou éteinte le temps que le memento soit flushé — dizaines de secondes.
resetJournal();
{
  const p = path.join(projectDir, 'e.jsonl');
  fs.writeFileSync(p, [
    userMsg('on va coder from scratch un anti bruit de fond ?'), assistant,
    { type: 'ai-title', aiTitle: 'Voix du compagnon — récriture Kokoro local et découpage' },
    { type: 'last-prompt', lastPrompt: 'on va coder from scratch un anti bruit de fond ?' },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const snapE = snapshot(() => ({
    known: true, labels: ['Conv A', 'Conv B', 'on va coder from scratch…'], activeLabel: 'on va coder from scratch…',
    source: 'fresh', windowFocused: true, sinceFocusMs: 42,
  }));
  const e = snapE.conversations.find((c) => c.sessionId === 'e');
  check('la conv rouverte est PRÉSENTE (son onglet porte son prompt, pas son titre)',
    !!e, JSON.stringify(snapE.conversations.map((c) => c.sessionId)));
  check('… et SURLIGNÉE quand cet onglet est l\'actif', !!e && e.isActive === true, JSON.stringify(e && e.isActive));
  const v = verdicts()[verdicts().length - 1];
  check('… verdict via:label, matches:1 — le prompt est un libellé reconnu, pas un tirage au sort',
    !!v && v.via === 'label' && v.matches === 1 && v.sessionId === 'e', JSON.stringify(v));
}

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
