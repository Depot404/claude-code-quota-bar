// Banc du filtre de présence (lot 5) : une conv sans onglet ouvert disparaît.
// Deux niveaux : la règle seule (isGone), puis le snapshot complet construit sur
// de VRAIS transcripts fabriqués (os.homedir monkeypatché → aucun fichier réel
// de l'utilisateur n'est lu ni écrit).
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-presence-'));
os.homedir = () => SANDBOX;                       // AVANT le require de state.js
fs.mkdirSync(path.join(SANDBOX, '.claude'), { recursive: true });

const state = require(path.join(__dirname, '..', 'state.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

const tabs = (...labels) => ({ known: true, labels });
const noTabs = { known: true, labels: [] };
const unknown = { known: false, labels: [] };
const conv = (o) => ({
  sessionId: 's1',
  title: 'Implémenter lot 5 onglet fermé',
  titleSource: 'ai-title',
  state: 'idle',
  mtime: Date.now(),
  ...o,
});
const gone = (c, t, closed = new Map()) => state.isGone(c, t, closed);

console.log('\n1. Règle de présence (isGone)');
check('aucune info sur les onglets (known:false) → jamais masquée',
  gone(conv(), unknown) === false);
check('onglet ouvert, libellé tronqué ↔ titre complet → affichée',
  gone(conv(), tabs('Implémenter lot 5 onglet…')) === false);
check('idle sans onglet → MASQUÉE',
  gone(conv({ state: 'idle' }), noTabs) === true);
check('done sans onglet → MASQUÉE',
  gone(conv({ state: 'done' }), noTabs) === true);
check('stale sans onglet → MASQUÉE (fermeture survenue extension éteinte)',
  gone(conv({ state: 'stale' }), noTabs) === true);
check('busy sans onglet → affichée (session CLI/terminal légitime)',
  gone(conv({ state: 'busy' }), noTabs) === false);
check('waiting sans onglet → affichée',
  gone(conv({ state: 'waiting' }), noTabs) === false);
check('titre de repli (1er message) sans onglet → affichée (non matchable)',
  gone(conv({ titleSource: 'first-user' }), noTabs) === false);
check('titre de repli (last-prompt) sans onglet → affichée',
  gone(conv({ titleSource: 'last-prompt' }), noTabs) === false);
check('titre absent (aucune source) sans onglet → affichée',
  gone(conv({ title: 'Conversation', titleSource: null }), noTabs) === false);
check('onglet d\'une AUTRE conv ouvert → masquée quand même',
  gone(conv(), tabs('Refonte du digest mail')) === true);

console.log('\n2. Union multi-fenêtres : l\'onglet est chez la voisine');
check('libellé publié par une autre instance → affichée',
  gone(conv(), tabs('README.md', 'Implémenter lot 5 onglet…')) === false);

console.log('\n3. Onglet fermé sous nos yeux (règle user : même busy)');
let closed = new Map([['s1', Date.now()]]);
check('fermée alors qu\'elle était busy → MASQUÉE',
  gone(conv({ state: 'busy' }), noTabs, closed) === true);
closed = new Map([['s1', Date.now()]]);
check('fermée alors qu\'elle était waiting → MASQUÉE',
  gone(conv({ state: 'waiting' }), noTabs, closed) === true);
closed = new Map([['s1', Date.now()]]);
check('fermée + titre de repli → MASQUÉE (la fermeture observée prime)',
  gone(conv({ state: 'busy', titleSource: 'first-user' }), noTabs, closed) === true);
closed = new Map([['s1', Date.now() - 60000]]);
check('reprise : écriture transcript bien après la fermeture → réaffichée',
  gone(conv({ state: 'busy', mtime: Date.now() }), noTabs, closed) === false);
check('… et la marque de fermeture est purgée', closed.has('s1') === false);
closed = new Map([['s1', Date.now()]]);
check('écriture résiduelle juste après la fermeture (grâce) → reste masquée',
  gone(conv({ state: 'busy', mtime: Date.now() + 500 }), noTabs, closed) === true);
closed = new Map([['s1', Date.now() - 60000]]);
check('rouverte (onglet de retour) → affichée malgré la marque',
  gone(conv({ state: 'idle', mtime: 0 }), tabs('Implémenter lot 5 onglet…'), closed) === false);

// ── Snapshot complet sur de vrais fichiers ────────────────────────────────
console.log('\n4. buildSnapshot de bout en bout (transcripts réels fabriqués)');

const WS = 'C:\\Users\\Test\\Projets VSCODE\\Demo';
const projectDir = state.projectDirFor(WS);
fs.mkdirSync(projectDir, { recursive: true });

function writeTranscript(sessionId, lines) {
  const p = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}
const assistant = { type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000 } } };
const userMsg = (t) => ({ type: 'user', message: { content: [{ type: 'text', text: t }] } });

// a : titre ai-title, onglet fermé            → doit disparaître
// b : titre ai-title, onglet ouvert           → doit rester
// c : titre de repli (pas d'ai-title), fermé  → doit rester (non matchable)
// d : ai-title, busy sans onglet (CLI)        → doit rester
writeTranscript('a', [userMsg('peu importe'), assistant, { type: 'ai-title', aiTitle: 'Conv fermée à masquer' }]);
writeTranscript('b', [userMsg('peu importe'), assistant, { type: 'ai-title', aiTitle: 'Conv ouverte à garder' }]);
writeTranscript('c', [userMsg('Titre de repli sans ai-title'), assistant]);
writeTranscript('d', [userMsg('peu importe'), assistant, { type: 'ai-title', aiTitle: 'Conv CLI au travail' }]);

fs.writeFileSync(path.join(SANDBOX, '.claude', 'sessions-state.json'), JSON.stringify({
  version: 1,
  sessions: {
    d: { state: 'busy', since: Date.now(), updated_at: Date.now(), transcript: path.join(projectDir, 'd.jsonl') },
  },
}));

function snapshot(tabProvider) {
  const reader = state.createTranscriptReader();
  return state.buildSnapshot({
    workspacePath: WS, recentMs: 4 * 3600 * 1000, maxItems: 12, tabs: tabProvider,
  }, reader);
}

let titles = snapshot(() => tabs('Conv ouverte à garder')).conversations.map((c) => c.title);
check('la conv dont l\'onglet est ouvert reste', titles.includes('Conv ouverte à garder'), titles.join(' | '));
check('la conv ai-title sans onglet disparaît', !titles.includes('Conv fermée à masquer'), titles.join(' | '));
check('la conv à titre de repli reste', titles.includes('Titre de repli sans ai-title'), titles.join(' | '));
check('la conv busy sans onglet (CLI) reste', titles.includes('Conv CLI au travail'), titles.join(' | '));

titles = snapshot(undefined).conversations.map((c) => c.title);
check('sans fournisseur d\'onglets, aucune conv n\'est masquée (compat lot 4)',
  titles.length === 4, titles.join(' | '));

titles = snapshot(() => tabs('Conv fermée à masq…')).conversations.map((c) => c.title);
check('libellé tronqué réel de VS Code → la conv est reconnue et gardée',
  titles.includes('Conv fermée à masquer'), titles.join(' | '));

// ── Les convs masquées ne doivent pas manger les places de la liste ────────
console.log('\n5. Une conv ouverte reste listée même derrière maxItems convs fermées');
{
  const many = 'C:\\Users\\Test\\Projets VSCODE\\Many';
  const dir = state.projectDirFor(many);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 13; i++) {
    // La conv OUVERTE est la PLUS ANCIENNE → 13e au tri, hors des 12 premières.
    const t = i === 12 ? 'Conv ouverte mais ancienne' : `Conv fermée numéro ${i}`;
    const f = path.join(dir, `s${i}.jsonl`);
    fs.writeFileSync(f, [userMsg('p'), assistant, { type: 'ai-title', aiTitle: t }]
      .map((l) => JSON.stringify(l)).join('\n') + '\n');
    const when = (Date.now() - i * 60000) / 1000;
    fs.utimesSync(f, when, when);
  }
  const snap = state.buildSnapshot({
    workspacePath: many, recentMs: 4 * 3600 * 1000, maxItems: 12,
    tabs: () => tabs('Conv ouverte mais ancien…'),
  }, state.createTranscriptReader());
  const shown = snap.conversations.map((c) => c.title);
  check('la seule conv ouverte est affichée (et pas un panneau vide)',
    shown.length === 1 && shown[0] === 'Conv ouverte mais ancienne', JSON.stringify(shown));

  // Le tri/troncature du lot 2 doit survivre : sans onglet connu, on ne lit et
  // n'affiche toujours que maxItems, pas les 13.
  const all = state.buildSnapshot({
    workspacePath: many, recentMs: 4 * 3600 * 1000, maxItems: 12, tabs: () => unknown,
  }, state.createTranscriptReader());
  check('sans info d\'onglets : toujours borné à maxItems (perf du lot 2 intacte)',
    all.conversations.length === 12, String(all.conversations.length));
}

// ── Moteur : markClosed retire sans attendre la purge du fichier d'état ────
console.log('\n6. Moteur : markClosed → retrait immédiat');
const engine = state.createStateEngine({
  workspacePath: WS, tabs: () => tabs('Conv CLI au travail'), tickMs: 3600000, debounceMs: 5,
});
let before = engine.getSnapshot().conversations.map((c) => c.title);
check('avant : la conv busy est là', before.includes('Conv CLI au travail'), before.join(' | '));
const id = engine.getSnapshot().conversations.find((c) => c.title === 'Conv CLI au travail').sessionId;
// Onglet fermé : le libellé disparaît de l'union ET la session est marquée.
engine.dispose();

const engine2 = state.createStateEngine({
  workspacePath: WS, tabs: () => noTabs, tickMs: 3600000, debounceMs: 5,
});
check('busy sans onglet : toujours affichée tant qu\'aucune fermeture n\'est observée',
  engine2.getSnapshot().conversations.some((c) => c.title === 'Conv CLI au travail'));
engine2.markClosed([id]);
const after = engine2.getSnapshot().conversations.map((c) => c.title);
check('après markClosed : partie, sans dépendre de sessions-state.json',
  !after.includes('Conv CLI au travail'), after.join(' | '));
check('les autres conversations ne bougent pas',
  after.includes('Titre de repli sans ai-title'), after.join(' | '));
engine2.dispose();

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
