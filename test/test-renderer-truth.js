// Banc de l'arbitre « LE RENDERER EST LE JUGE » (refactor surlignage,
// 2026-08-27) — state.js buildSnapshot, aval du verdict par libellés.
//
// L'incident fondateur (journal 2026-08-27, fenêtre « 142 modifications ») :
// la copie miroir tabGroups adopte une bascule fantôme fenêtre SANS focus,
// puis plus AUCUN événement ne vient jamais la corriger — surlignage faux 14
// minutes, réparé par rien. Pendant tout ce temps, le memento
// workbench.parts.editor du state.vscdb (écrit par le RENDERER, le processus
// qui peint l'écran) disait vrai, par identité. Ce banc prouve le contrat qui
// ferme la classe entière :
//   §1 vérité renderer FRAÎCHE et divergente → elle gagne (correction visible,
//      journalisée, publiée au panneau) ;
//   §2 le même épisode ne se journalise qu'UNE fois (l'arbitrage, lui, se
//      réapplique à chaque recompute) ;
//   §3 vérité PLUS VIEILLE que le dernier avis du tracker → elle ne
//      rétrograde JAMAIS un choix frais ;
//   §4 vérité = verdict → aucun épisode ;
//   §5 vérité hors liste, ou actif non-Claude → l'arbitre se tait ;
//   §6 tabs sans labelChangedAt (bancs/appelants d'avant ce lot) → inactif ;
//   §7 l'épisode publié expire (le bandeau ne vit pas éternellement).
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-renderer-truth-'));
os.homedir = () => SANDBOX;                       // AVANT le require de state.js
fs.mkdirSync(path.join(SANDBOX, '.claude'), { recursive: true });

const state = require(path.join(__dirname, '..', 'state.js'));
const journal = require(path.join(__dirname, '..', 'ack-journal.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

const WS = 'C:\\Users\\Test\\Projets VSCODE\\DemoRendererTruth';
const projectDir = state.projectDirFor(WS);
fs.mkdirSync(projectDir, { recursive: true });

const assistant = { type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000 } } };
const userMsg = (t) => ({ type: 'user', message: { content: [{ type: 'text', text: t }] } });
function writeTranscript(sessionId, title, mtimeOffsetSec) {
  const p = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(p, [userMsg(`premier message ${sessionId}`), assistant, { type: 'ai-title', aiTitle: title }]
    .map((l) => JSON.stringify(l)).join('\n') + '\n');
  const when = (Date.now() - mtimeOffsetSec * 1000) / 1000;
  fs.utimesSync(p, when, when);
}
writeTranscript('a', 'Conv A', 20);
writeTranscript('b', 'Conv B', 10);

const DEFAULT_JOURNAL = path.join(SANDBOX, '.claude', 'quotabar-ack-journal.jsonl');
const lines = () => journal.readJournal(DEFAULT_JOURNAL);
const reconciles = () => lines().filter((l) => l.event === 'highlight-reconciled');
const verdicts = () => lines().filter((l) => l.event === 'highlight-verdict');

// Les marges réelles restent en place — 45 s pour écraser un choix
// (QUOTABAR_TRUTH_MARGIN_MS, dimensionnée sur la latence mesurée du memento),
// 3 s pour combler un vide (QUOTABAR_TRUTH_FILL_MARGIN_MS) : les timestamps
// fabriqués ci-dessous les encadrent largement des deux côtés.
const NOW = Date.now();
const tabsWith = (labelChangedAt) => () => ({
  known: true, labels: ['Conv A', 'Conv B'], activeLabel: 'Conv A', frozen: false,
  source: 'fresh', windowFocused: true, sinceFocusMs: 42, labelChangedAt,
});
function snapshot(rendererActive, labelChangedAt, memory) {
  const reader = state.createTranscriptReader();
  return state.buildSnapshot({
    workspacePath: WS, recentMs: 4 * 3600 * 1000, maxItems: 12,
    tabs: tabsWith(labelChangedAt),
    rendererActive: () => rendererActive,
    reconcileMemory: memory,
  }, reader);
}

console.log('\n1. Vérité renderer fraîche et divergente → correction immédiate, alerte différée');
{
  const mem = {};
  // Tracker : dernier avis il y a 60 s (le fantôme adopté) ; renderer : flush
  // il y a 1 s, actif = Conv B. flushedAt - marge > labelChangedAt → arbitrage.
  const snap = snapshot({ sessionId: 'b', claude: true, flushedAt: NOW - 1000 }, NOW - 60 * 1000, mem);
  const b = snap.conversations.find((c) => c.sessionId === 'b');
  const a = snap.conversations.find((c) => c.sessionId === 'a');
  check('la conv désignée par le renderer est surlignée', b && b.isActive === true,
    JSON.stringify(snap.conversations.map((c) => [c.sessionId, c.isActive])));
  check('… et une seule (l\'ancienne s\'éteint)', a && a.isActive === false);
  check('le verdict journalisé porte via:renderer-truth',
    verdicts().length > 0 && verdicts()[verdicts().length - 1].via === 'renderer-truth',
    JSON.stringify(verdicts()[verdicts().length - 1]));
  check('l\'épisode highlight-reconciled est journalisé avec les deux identités',
    reconciles().length === 1 && reconciles()[0].wasSessionId === 'a' && reconciles()[0].nowSessionId === 'b'
    && reconciles()[0].wasTitle === 'Conv A' && reconciles()[0].nowTitle === 'Conv B',
    JSON.stringify(reconciles()[0]));
  check('… mais PAS de bandeau immédiat : l\'alerte attend la grâce',
    !snap.highlightReconcile, JSON.stringify(snap.highlightReconcile));

  console.log('\n2. Même épisode, recomputes suivants : arbitrage réappliqué, journal muet');
  const snap2 = snapshot({ sessionId: 'b', claude: true, flushedAt: NOW - 1000 }, NOW - 60 * 1000, mem);
  check('le surlignage reste corrigé au recompute suivant',
    snap2.conversations.find((c) => c.sessionId === 'b').isActive === true);
  check('aucune seconde ligne highlight-reconciled', reconciles().length === 1, String(reconciles().length));
  check('toujours pas de bandeau avant la grâce', !snap2.highlightReconcile);

  console.log('\n2bis. La divergence persiste au-delà de la grâce → bandeau promu');
  process.env.QUOTABAR_RECONCILE_GRACE_MS = '0';
  const snap3 = snapshot({ sessionId: 'b', claude: true, flushedAt: NOW - 1000 }, NOW - 60 * 1000, mem);
  delete process.env.QUOTABAR_RECONCILE_GRACE_MS;
  check('bandeau publié, daté du DÉBUT de l\'épisode',
    snap3.highlightReconcile && snap3.highlightReconcile.nowSessionId === 'b'
    && snap3.highlightReconcile.at === reconciles()[0].at,
    JSON.stringify(snap3.highlightReconcile));
  check('la promotion laisse une ligne highlight-banner',
    lines().filter((l) => l.event === 'highlight-banner').length === 1);
  check('… et toujours une seule ligne highlight-reconciled', reconciles().length === 1);
}

console.log('\n3. Vérité PLUS VIEILLE que le dernier avis du tracker → jamais de rétrogradation');
{
  const mem = {};
  // Clic tout frais (labelChangedAt il y a 1 s) ; memento flushé il y a 70 s.
  const snap = snapshot({ sessionId: 'b', claude: true, flushedAt: NOW - 70 * 1000 }, NOW - 1000, mem);
  check('le verdict par libellés (Conv A) reste intact',
    snap.conversations.find((c) => c.sessionId === 'a').isActive === true
    && snap.conversations.find((c) => c.sessionId === 'b').isActive === false,
    JSON.stringify(snap.conversations.map((c) => [c.sessionId, c.isActive])));
  check('aucun épisode fabriqué', !snap.highlightReconcile && reconciles().length === 1);
}

console.log('\n4. Vérité = verdict → concordance silencieuse');
{
  const mem = {};
  const snap = snapshot({ sessionId: 'a', claude: true, flushedAt: NOW - 1000 }, NOW - 60 * 1000, mem);
  check('surlignage inchangé, aucun épisode',
    snap.conversations.find((c) => c.sessionId === 'a').isActive === true
    && !snap.highlightReconcile && reconciles().length === 1);
}

console.log('\n5. Vérité inutilisable → l\'arbitre se tait');
{
  const mem = {};
  const snapUnknown = snapshot({ sessionId: 'zz-hors-liste', claude: true, flushedAt: NOW - 1000 }, NOW - 60 * 1000, mem);
  check('sessionId hors liste → verdict par libellés conservé, jamais de surlignage invisible',
    snapUnknown.conversations.find((c) => c.sessionId === 'a').isActive === true && !snapUnknown.highlightReconcile);
  const snapFile = snapshot({ sessionId: null, claude: false, flushedAt: NOW - 1000 }, NOW - 60 * 1000, mem);
  check('actif non-Claude (fichier) → repli-souvenir conservé',
    snapFile.conversations.find((c) => c.sessionId === 'a').isActive === true && !snapFile.highlightReconcile);
}

console.log('\n6. Appelant d\'avant ce lot (tabs sans labelChangedAt) → arbitre inactif');
{
  const reader = state.createTranscriptReader();
  const snap = state.buildSnapshot({
    workspacePath: WS, recentMs: 4 * 3600 * 1000, maxItems: 12,
    tabs: () => ({ known: true, labels: ['Conv A', 'Conv B'], activeLabel: 'Conv A', frozen: false, source: 'fresh', windowFocused: true, sinceFocusMs: 42 }),
    rendererActive: () => ({ sessionId: 'b', claude: true, flushedAt: NOW - 1000 }),
    reconcileMemory: {},
  }, reader);
  check('sans référence temporelle, jamais d\'arbitrage (comportement d\'avant)',
    snap.conversations.find((c) => c.sessionId === 'a').isActive === true && !snap.highlightReconcile);
}

console.log('\n7. L\'épisode publié expire');
{
  const mem = {};
  process.env.QUOTABAR_RECONCILE_GRACE_MS = '0';
  snapshot({ sessionId: 'b', claude: true, flushedAt: NOW - 1000 }, NOW - 60 * 1000, mem);
  const promoted = snapshot({ sessionId: 'b', claude: true, flushedAt: NOW - 1000 }, NOW - 60 * 1000, mem);
  delete process.env.QUOTABAR_RECONCILE_GRACE_MS;
  check('épisode promu (grâce 0, deux recomputes)', !!promoted.highlightReconcile);
  // On vieillit l'épisode mémorisé au-delà du TTL : la publication cesse, le
  // journal garde sa trace (c'est son rôle).
  mem.last.at = Date.now() - 11 * 60 * 1000;
  const snap = snapshot({ sessionId: 'b', claude: true, flushedAt: NOW - 1000 }, NOW - 60 * 1000, mem);
  check('après 10 min, highlightReconcile n\'est plus publié',
    !snap.highlightReconcile, JSON.stringify(snap.highlightReconcile));
  check('… mais l\'arbitrage, lui, continue de s\'appliquer',
    snap.conversations.find((c) => c.sessionId === 'b').isActive === true);
}

console.log('\n8. Un surlignage VIDE comblé n\'est jamais une alerte (les deux faux positifs du 2026-08-27)');
{
  const mem = {};
  // Verdict par libellés muet : l'onglet actif ne matche AUCUNE conv (état
  // transitoire « Claude Code » / renommage) et pas d'active-session de repli
  // pour cette liste — wasSessionId sera null.
  const reader = state.createTranscriptReader();
  const tabsNoMatch = () => ({
    known: true, labels: ['Conv A', 'Conv B'], activeLabel: 'Aucun onglet ne matche…', frozen: false,
    source: 'fresh', windowFocused: true, sinceFocusMs: 42, labelChangedAt: NOW - 60 * 1000,
  });
  const args = {
    workspacePath: WS, recentMs: 4 * 3600 * 1000, maxItems: 12,
    tabs: tabsNoMatch,
    rendererActive: () => ({ sessionId: 'b', claude: true, flushedAt: NOW - 1000 }),
    reconcileMemory: mem,
  };
  process.env.QUOTABAR_RECONCILE_GRACE_MS = '0';
  const s1 = state.buildSnapshot(args, reader);
  const s2 = state.buildSnapshot(args, reader);
  delete process.env.QUOTABAR_RECONCILE_GRACE_MS;
  check('le vide est comblé (la conv du renderer est surlignée)',
    s2.conversations.find((c) => c.sessionId === 'b').isActive === true);
  check('mais aucun bandeau, même la grâce écoulée',
    !s1.highlightReconcile && !s2.highlightReconcile,
    JSON.stringify(s2.highlightReconcile));
}

console.log('\n9. Un transitoire résorbé avant la grâce s\'éteint sans bandeau');
{
  const mem = {};
  const before = reconciles().length;
  snapshot({ sessionId: 'b', claude: true, flushedAt: NOW - 1000 }, NOW - 60 * 1000, mem);
  check('épisode en observation journalisé', reconciles().length === before + 1);
  // Le tracker se réaligne (vérité = verdict) : l'observation s'annule.
  const aligned = snapshot({ sessionId: 'a', claude: true, flushedAt: NOW - 1000 }, NOW - 60 * 1000, mem);
  check('résorbé avant la grâce → aucun bandeau', !aligned.highlightReconcile && !mem.pending && !mem.last);
  // Une re-divergence repart de zéro : nouvelle observation, pas de bandeau
  // hérité de la précédente.
  const again = snapshot({ sessionId: 'b', claude: true, flushedAt: NOW - 1000 }, NOW - 60 * 1000, mem);
  check('la re-divergence repart de zéro (nouvelle observation, pas de bandeau immédiat)',
    reconciles().length === before + 2 && !again.highlightReconcile,
    `${reconciles().length - before} épisodes`);
}

console.log('\n10. Le juge ne rétrograde pas un clic frais avec un memento en RETARD (les 4 faux épisodes du 2026-08-27)');
{
  // Reconstitution à l'échelle réelle de l'épisode 18:02:15 → 18:02:23 : clic
  // panneau isTrusted il y a 7 s (labelChangedAt), state.vscdb flushé il y a
  // 0,4 s — mais ce flush ne portait PAS le clic (la clé workbench.parts.editor
  // met jusqu'à 27 s à le refléter, mesuré). Avec l'ancienne marge de 3 s,
  // l'arbitre corrigeait ; il doit maintenant se taire.
  const mem = {};
  const before = reconciles().length;
  const deferred = () => lines().filter((l) => l.event === 'highlight-truth-deferred');
  // Le §3 en a déjà produit une (même garde, autre scénario) : on compte le
  // DELTA de cet épisode-ci, pas le total du banc.
  const beforeDeferred = deferred().length;
  const snap = snapshot({ sessionId: 'b', claude: true, flushedAt: NOW - 400 }, NOW - 7000, mem);
  check('le clic de 7 s reste surligné (aucune rétrogradation)',
    snap.conversations.find((c) => c.sessionId === 'a').isActive === true
    && snap.conversations.find((c) => c.sessionId === 'b').isActive === false,
    JSON.stringify(snap.conversations.map((c) => [c.sessionId, c.isActive])));
  check('aucun épisode journalisé', reconciles().length === before);
  check('… mais le refus, lui, laisse une trace mesurable',
    deferred().length === beforeDeferred + 1, JSON.stringify(deferred().slice(beforeDeferred)));
  check('… une seule fois pour le même épisode retenu',
    (snapshot({ sessionId: 'b', claude: true, flushedAt: NOW - 400 }, NOW - 7000, mem),
     deferred().length === beforeDeferred + 1), String(deferred().length - beforeDeferred));
  // Le même avis du tracker, jugé par un memento assez vieux pour l'avoir vu :
  // le filet universel doit rester capable de corriger un vrai mensonge.
  const late = snapshot({ sessionId: 'b', claude: true, flushedAt: NOW - 400 }, NOW - 60 * 1000, mem);
  check('mensonge DURABLE (avis du tracker vieux de 60 s) → le filet joue encore',
    late.conversations.find((c) => c.sessionId === 'b').isActive === true,
    JSON.stringify(late.conversations.map((c) => [c.sessionId, c.isActive])));
}

console.log('\n11. Combler un VIDE garde la marge courte (rien à rétrograder)');
{
  const mem = {};
  const reader = state.createTranscriptReader();
  // Verdict par libellés muet ET clic tout frais (5 s) : le juge n'écrase
  // aucun choix, il remplit — la marge de 45 s ne s'applique pas ici.
  const snap = state.buildSnapshot({
    workspacePath: WS, recentMs: 4 * 3600 * 1000, maxItems: 12,
    tabs: () => ({
      known: true, labels: ['Conv A', 'Conv B'], activeLabel: 'Aucun onglet ne matche…', frozen: false,
      source: 'fresh', windowFocused: true, sinceFocusMs: 42, labelChangedAt: NOW - 5000,
    }),
    rendererActive: () => ({ sessionId: 'b', claude: true, flushedAt: NOW - 400 }),
    reconcileMemory: mem,
  }, reader);
  check('le vide est comblé tout de suite',
    snap.conversations.find((c) => c.sessionId === 'b').isActive === true,
    JSON.stringify(snap.conversations.map((c) => [c.sessionId, c.isActive])));
}

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
