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
  title: 'Implement part 5 closed tab',
  titleSource: 'ai-title',
  state: 'idle',
  mtime: Date.now(),
  ...o,
});
const gone = (c, t, closed = new Map(), live = new Set()) => state.isGone(c, t, closed, live);

console.log('\n1. Règle de présence (isGone)');
check('aucune info sur les onglets (known:false) → jamais masquée',
  gone(conv(), unknown) === false);
check('onglet ouvert, libellé tronqué ↔ titre complet → affichée',
  gone(conv(), tabs('Implement part 5 closed…')) === false);
check('idle sans onglet → MASQUÉE',
  gone(conv({ state: 'idle' }), noTabs) === true);
check('done sans onglet → MASQUÉE',
  gone(conv({ state: 'done' }), noTabs) === true);
check('stale sans onglet → MASQUÉE (fermeture survenue extension éteinte)',
  gone(conv({ state: 'stale' }), noTabs) === true);
check('busy sans onglet, origine INCONNUE → affichée (filet, cf. 3quinquies)',
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
  gone(conv(), tabs('Rework the mail digest')) === true);

console.log('\n2. Union multi-fenêtres : l\'onglet est chez la voisine');
check('libellé publié par une autre instance → affichée',
  gone(conv(), tabs('README.md', 'Implement part 5 closed…')) === false);

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
  gone(conv({ state: 'idle', mtime: 0 }), tabs('Implement part 5 closed…'), closed) === false);

// ── Identités stables : session vivante + titre d'onglet réel ──────────────
console.log('\n3bis. Session CLI vivante (~/.claude/sessions) → jamais masquée');
const live = new Set(['s1']);
check('ai-title sans onglet matchant MAIS session vivante → affichée',
  gone(conv({ state: 'idle' }), noTabs, new Map(), live) === false);
check('… même conv, session morte → MASQUÉE (comportement d\'avant le lot)',
  gone(conv({ state: 'idle' }), noTabs, new Map(), new Set()) === true);
check('stale + session vivante → affichée',
  gone(conv({ state: 'stale' }), noTabs, new Map(), live) === false);
closed = new Map([['s1', Date.now()]]);
check('fermeture observée pendant la grâce → MASQUÉE malgré la session vivante',
  gone(conv({ state: 'busy' }), noTabs, closed, live) === true);

// ── 3quinquies. Vivante AILLEURS (Remote Control / mobile, terminal, SDK) ────
// Le serveur RC exécute ses sessions ICI, dans le même dossier de travail : même
// dossier de transcripts, donc mêmes candidates. Aucun onglet ne les portera
// jamais → masquées, quel que soit leur état. Signalé par l'user le 2026-08-17.
console.log('\n3quinquies. Session vivante hors VS Code (RC/mobile, terminal, SDK)');
const foreign = new Set(['s1']);
const goneF = (c, t, closed = new Map(), live = new Set(), f = foreign) =>
  state.isGone(c, t, closed, live, f);
check('busy sans onglet + origine étrangère → MASQUÉE (le filet ne joue plus)',
  goneF(conv({ state: 'busy' }), noTabs) === true);
check('waiting sans onglet + origine étrangère → MASQUÉE',
  goneF(conv({ state: 'waiting' }), noTabs) === true);
check('titre de repli (1er message, cas réel du mobile) → MASQUÉE',
  goneF(conv({ state: 'busy', titleSource: 'first-user' }), noTabs) === true);
check('idle + origine étrangère → MASQUÉE',
  goneF(conv({ state: 'idle' }), noTabs) === true);
check('reprise dans VS Code : onglet matchant → affichée malgré l\'origine',
  goneF(conv({ state: 'busy' }), tabs('Implement part 5 closed…')) === false);
check('reprise dans VS Code : process VS Code vivant → affichée malgré l\'origine',
  goneF(conv({ state: 'busy' }), noTabs, new Map(), new Set(['s1'])) === false);
check('une AUTRE conv étrangère ne masque pas celle-ci',
  goneF(conv({ state: 'busy' }), noTabs, new Map(), new Set(), new Set(['autre'])) === false);
check('ensemble vide (entrypoint absent/inconnu) → comportement d\'avant le lot',
  goneF(conv({ state: 'busy' }), noTabs, new Map(), new Set(), new Set()) === false);

console.log('\n3ter. Titre d\'onglet divergent (state.vscdb)');
const divergent = {
  sessionId: 's1',
  title: 'Upload Error TF400898: An Internal Error…',   // titre affiché (store)
  tabTitle: 'Upload Error TF400898: An Internal Error…',
  titleSource: 'tab-store',
  state: 'idle',
  mtime: Date.now(),
};
check('onglet renommé → la conv est reconnue par son titre de store',
  gone(divergent, tabs('Upload Error TF400898: A…')) === false);
check('titre de store matchable : sans onglet nulle part → MASQUÉE',
  gone(divergent, noTabs) === true);
check('l\'ancien titre transcript matche encore un onglet → affichée',
  gone({ ...divergent, title: 'Afficher ? au lieu du loading' },
    tabs('Afficher ? au lieu du l…')) === false);

console.log('\n3quater. pickTitle : on affiche le nom de l\'ONGLET');
const pick = state.pickTitle;
check('store + transcript qui ne matche aucun onglet → titre du store',
  pick('Vieux titre transcript', 'ai-title', 'Titre onglet réel', tabs('Titre onglet réel'))
    .title === 'Titre onglet réel');
check('… et sa source devient tab-store (donc masquable)',
  pick('Vieux titre', 'ai-title', 'Titre onglet réel', tabs('Titre onglet réel'))
    .titleSource === 'tab-store');
check('transcript qui matche un onglet ouvert → titre transcript conservé',
  pick('Conv ouverte à garder', 'ai-title', 'Entrée de store périmée',
    tabs('Conv ouverte à garder')).title === 'Conv ouverte à garder');
check('pas d\'entrée de store → titre transcript intact',
  pick('Conv sans store', 'ai-title', null, noTabs).title === 'Conv sans store');
check('libellé de store terminé par un caractère de remplacement → nettoyé à l\'affichage',
  pick('Vieux titre', 'ai-title', 'Titre tronqué�', noTabs).title === 'Titre tronqué');

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
// e : ai-title, busy, préfixe ambigu (lot « bascule au focus »)
writeTranscript('a', [userMsg('peu importe'), assistant, { type: 'ai-title', aiTitle: 'Conv fermée à masquer' }]);
writeTranscript('b', [userMsg('peu importe'), assistant, { type: 'ai-title', aiTitle: 'Conv ouverte à garder' }]);
writeTranscript('c', [userMsg('Titre de repli sans ai-title'), assistant]);
writeTranscript('d', [userMsg('peu importe'), assistant, { type: 'ai-title', aiTitle: 'Conv CLI au travail' }]);
writeTranscript('e', [userMsg('peu importe'), assistant, { type: 'ai-title', aiTitle: 'Implement part 4 burn-rate and multi-window focus' }]);

fs.writeFileSync(path.join(SANDBOX, '.claude', 'sessions-state.json'), JSON.stringify({
  version: 1,
  sessions: {
    d: { state: 'busy', since: Date.now(), updated_at: Date.now(), transcript: path.join(projectDir, 'd.jsonl') },
    e: { state: 'busy', since: Date.now(), updated_at: Date.now(), transcript: path.join(projectDir, 'e.jsonl') },
  },
}));

function snapshot(tabProvider, extra = {}) {
  const reader = state.createTranscriptReader();
  return state.buildSnapshot({
    workspacePath: WS, recentMs: 4 * 3600 * 1000, maxItems: 12, tabs: tabProvider,
    // Injection : aucun accès au vrai ~/.claude/sessions ni au vrai state.vscdb.
    liveSessions: () => new Set(), sessionTitles: () => new Map(),
    ...extra,
  }, reader);
}

let titles = snapshot(() => tabs('Conv ouverte à garder')).conversations.map((c) => c.title);
check('la conv dont l\'onglet est ouvert reste', titles.includes('Conv ouverte à garder'), titles.join(' | '));
check('la conv ai-title sans onglet disparaît', !titles.includes('Conv fermée à masquer'), titles.join(' | '));
check('la conv à titre de repli reste', titles.includes('Titre de repli sans ai-title'), titles.join(' | '));
check('la conv busy sans onglet (CLI) reste', titles.includes('Conv CLI au travail'), titles.join(' | '));

titles = snapshot(undefined).conversations.map((c) => c.title);
check('sans fournisseur d\'onglets, aucune conv n\'est masquée (compat lot 4)',
  titles.length === 5, titles.join(' | '));

titles = snapshot(() => tabs('Conv fermée à masq…')).conversations.map((c) => c.title);
check('libellé tronqué réel de VS Code → la conv est reconnue et gardée',
  titles.includes('Conv fermée à masquer'), titles.join(' | '));

// ── Snapshot : identités stables de bout en bout ───────────────────────────
console.log('\n4bis. Snapshot : session vivante et titre d\'onglet réel');
{
  // 'a' = la conv de l'incident : ai-title que plus aucun onglet ne porte.
  const openTab = () => tabs('Titre réel de l\'onglet…');
  const titles = () => new Map([['a', 'Titre réel de l\'onglet renommé']]);

  let snap = snapshot(openTab, { sessionTitles: titles });
  let a = snap.conversations.find((c) => c.sessionId === 'a');
  check('conv à onglet renommé : réaffichée', !!a,
    snap.conversations.map((c) => c.title).join(' | '));
  check('… sous le titre de l\'ONGLET', a && a.title === 'Titre réel de l\'onglet renommé',
    a && a.title);
  check('… et le libellé brut du store voyage dans le snapshot (clic-focus)',
    a && a.tabTitle === 'Titre réel de l\'onglet renommé', a && String(a.tabTitle));

  // Même conv, aucun onglet nulle part et pas de session vivante : elle reste
  // masquée — le titre de store est matchable, donc son absence prouve quelque
  // chose (pas de régression du lot 5).
  snap = snapshot(() => noTabs, { sessionTitles: titles });
  check('titre de store sans onglet et sans session vivante → masquée',
    !snap.conversations.some((c) => c.sessionId === 'a'),
    snap.conversations.map((c) => c.title).join(' | '));

  // La même, avec son process CLI vivant : jamais masquée.
  snap = snapshot(() => noTabs, { sessionTitles: titles, liveSessions: () => new Set(['a']) });
  check('session vivante sans onglet matchant → affichée quand même',
    snap.conversations.some((c) => c.sessionId === 'a'),
    snap.conversations.map((c) => c.title).join(' | '));

  // Tri tabOrder + surlignage doivent la retrouver par son titre de store.
  snap = snapshot(() => ({ known: true, labels: ['Conv ouverte à garder', 'Titre réel de l\'onglet…'], activeLabel: 'Titre réel de l\'onglet…' }),
    { sessionTitles: titles, sortOrder: 'tabOrder' });
  const ids = snap.conversations.map((c) => c.sessionId);
  check('tri tabOrder : la conv renommée se range à la position de son onglet',
    ids.indexOf('a') === 1, ids.join(','));
  check('surlignage : l\'onglet actif renommé désigne bien cette conv',
    snap.conversations.find((c) => c.isActive || false) &&
    snap.conversations.find((c) => c.isActive).sessionId === 'a',
    JSON.stringify(snap.conversations.map((c) => [c.sessionId, c.isActive])));
}

console.log('\n4ter. Transcript plus vieux que recentMs mais session vivante');
{
  const old = 'C:\\Users\\Test\\Projets VSCODE\\Old';
  const dir = state.projectDirFor(old);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'zz.jsonl');
  fs.writeFileSync(f, [userMsg('p'), assistant, { type: 'ai-title', aiTitle: 'Conv ouverte ce matin' }]
    .map((l) => JSON.stringify(l)).join('\n') + '\n');
  const when = (Date.now() - 8 * 3600 * 1000) / 1000;          // 8 h → hors recentMs
  fs.utimesSync(f, when, when);
  const build = (liveIds) => state.buildSnapshot({
    workspacePath: old, recentMs: 4 * 3600 * 1000, maxItems: 12,
    tabs: () => unknown, liveSessions: () => new Set(liveIds), sessionTitles: () => new Map(),
  }, state.createTranscriptReader());
  check('transcript inactif depuis 8 h, session morte → hors candidats (inchangé)',
    build([]).conversations.length === 0);
  check('même transcript, session CLI vivante → candidate quand même',
    build(['zz']).conversations.some((c) => c.title === 'Conv ouverte ce matin'));
}

// Le cas témoin du 2026-08-18 : conversation de cadrage d'un lot, terminée dans
// la nuit (CLI éteint, plus rien d'écrit depuis 8 h) mais ONGLET grand ouvert.
// Avant ce lot elle sortait de la liste sur son seul âge, et la ligne maîtresse
// de son groupe la rendait alors BARRÉE « terminée · onglet fermé » —
// member-truth conclut `done-closed` de « pas dans la liste », ce qui suppose
// l'invariant « onglet ouvert ⇒ listée ».
console.log('\n4quater. Transcript vieux, session MORTE, mais onglet resté ouvert');
{
  const kept = 'C:\\Users\\Test\\Projets VSCODE\\Kept';
  const dir = state.projectDirFor(kept);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'mm.jsonl');
  fs.writeFileSync(f, [userMsg('p'), assistant, { type: 'ai-title', aiTitle: 'Master conv of a batch' }]
    .map((l) => JSON.stringify(l)).join('\n') + '\n');
  const when = (Date.now() - 8 * 3600 * 1000) / 1000;        // 8 h → hors recentMs
  fs.utimesSync(f, when, when);
  const build = (tabProvider, store) => state.buildSnapshot({
    workspacePath: kept, recentMs: 4 * 3600 * 1000, maxItems: 12,
    tabs: tabProvider, liveSessions: () => new Set(), sessionTitles: () => store,
  }, state.createTranscriptReader());
  // Le store VS Code connaît la paire sessionId → libellé d'onglet, et l'onglet
  // ouvert porte ce libellé TRONQUÉ, comme le fait l'extension officielle.
  const store = new Map([['mm', 'Master conv of a batch']]);
  const open = () => tabs('Master conv of a bat…');

  const shown = build(open, store).conversations;
  check('vieille conv, CLI mort, onglet ouvert → reste listée',
    shown.length === 1 && shown[0].title === 'Master conv of a batch',
    JSON.stringify(shown.map((c) => c.title)));
  check('…et son onglet est reconnu ouvert (donc jamais barrée)',
    shown.length === 1 && shown[0].tabOpen === true);
  check('store connu mais AUCUN onglet ouvert → hors candidats (inchangé)',
    build(() => noTabs, store).conversations.length === 0);
  check('onglet ouvert mais store muet → hors candidats (dégradation silencieuse)',
    build(open, new Map()).conversations.length === 0);
  check('onglets inconnus (tracker mort) → hors candidats (comportement d\'avant)',
    build(() => unknown, store).conversations.length === 0);
}

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

// L'autre moitié de l'invariant « onglet ouvert ⇒ listée » (2026-08-18) :
// entrer dans les candidats ne suffit pas, il faut entrer dans les maxItems
// places. Douze conversations plus fraîches et VISIBLES (titre de repli, donc
// jamais masquées) suffisaient à évincer la seule dont l'onglet est ouvert.
console.log('\n5bis. Une conv à onglet ouvert passe devant maxItems convs plus fraîches');
{
  const race = 'C:\\Users\\Test\\Projets VSCODE\\Race';
  const dir = state.projectDirFor(race);
  fs.mkdirSync(dir, { recursive: true });
  // 12 conversations fraîches, sans onglet mais VISIBLES : leur titre est un
  // repli (pas d'ai-title), donc isGone ne peut rien conclure de l'absence de
  // correspondance — elles occupent bel et bien les 12 places.
  for (let i = 0; i < 12; i++) {
    const f = path.join(dir, `r${i}.jsonl`);
    fs.writeFileSync(f, [userMsg(`Sans ai-title numero ${i}`), assistant]
      .map((l) => JSON.stringify(l)).join('\n') + '\n');
    const when = (Date.now() - i * 60000) / 1000;
    fs.utimesSync(f, when, when);
  }
  // La 13e : ancienne (8 h), CLI mort, mais son onglet est ouvert.
  const old = path.join(dir, 'rz.jsonl');
  fs.writeFileSync(old, [userMsg('p'), assistant, { type: 'ai-title', aiTitle: 'Old conv with an open tab' }]
    .map((l) => JSON.stringify(l)).join('\n') + '\n');
  const when = (Date.now() - 8 * 3600 * 1000) / 1000;
  fs.utimesSync(old, when, when);

  const snap = state.buildSnapshot({
    workspacePath: race, recentMs: 4 * 3600 * 1000, maxItems: 12,
    tabs: () => tabs('Old conv with an open t…'), liveSessions: () => new Set(),
    sessionTitles: () => new Map([['rz', 'Old conv with an open tab']]),
  }, state.createTranscriptReader());
  const shown = snap.conversations.map((c) => c.title);
  check('la conv à onglet ouvert est listée malgré 12 convs plus fraîches',
    shown.includes('Old conv with an open tab'), shown.length + ' listées');
  check('… et la liste reste bornée à maxItems', shown.length === 12, String(shown.length));
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
// Étape 17 (member-truth.js bug n°6) : `isTabClosed` expose le même fait que
// `markClosed` vient de poser — c'est la source que memberSources() branche
// pour ne plus jamais présumer un onglet ouvert pendant la course
// hooks/registre.
check('isTabClosed(id) → vrai juste après markClosed', engine2.isTabClosed(id) === true);
check('isTabClosed d\'un id jamais fermé → faux', engine2.isTabClosed('jamais-vu') === false);
engine2.dispose();

// ── Lot 2 (2026-07-24) : le chip vert ne doit plus basculer au focus ──────
console.log('\n7. resolveTabOpen : tolère un manque isolé, pas deux consécutifs');
{
  const resolve = state.resolveTabOpen;
  const misses = new Map();
  check('ouvert → true, compteur remis à zéro',
    resolve('s1', true, misses) === true && !misses.has('s1'));
  check('un SEUL manque (le focus bascule ailleurs le temps d\'un recompute) → reste true',
    resolve('s1', false, misses) === true);
  check('un deuxième manque CONSÉCUTIF → bascule enfin à false',
    resolve('s1', false, misses) === false);
  check('un match qui revient repart de zéro',
    resolve('s1', true, misses) === true && !misses.has('s1'));
  check('… donc un manque isolé APRÈS un retour reste toléré',
    resolve('s1', false, misses) === true);
  check('sessions indépendantes : le compteur de l\'une n\'affecte pas l\'autre',
    resolve('s2', false, new Map()) === true);
}

// ── Lot gel-tabs (2026-08-17) : vivante ⇒ ouverte, JAMAIS de tolérance épuisée
console.log('\n7bis. resolveTabOpen : session vivante née VS Code → jamais false, même après N ratés');
{
  const resolve = state.resolveTabOpen;
  const missesLive = new Map();
  check('premier raté, session vivante → true (comme sans le fix)',
    resolve('s1', false, missesLive, true) === true);
  check('deuxième raté CONSÉCUTIF, session vivante → true quand même (le fix)',
    resolve('s1', false, missesLive, true) === true);
  check('dixième raté d\'affilée, toujours vivante → toujours true',
    Array.from({ length: 8 }).every(() => resolve('s1', false, missesLive, true) === true));
  const missesDead = new Map();
  resolve('s1', false, missesDead, false);
  check('… mais la MÊME séquence sans preuve de vivacité retombe à false au 2e raté (comportement d\'avant)',
    resolve('s1', false, missesDead, false) === false);
}

console.log('\n8. buildSnapshot : un recompute isolé sans match ne fait pas tomber le chip');
{
  // 'e' : préfixe partagé avec d'autres membres d'un même groupe (« Implement
  // part N… ») — le cas décrit par le lot. Reste affichée (busy) qu'un onglet
  // matche ou non ; seul tabOpen doit rester stable d'un recompute à l'autre.
  const misses = new Map();
  const eTab = () => tabs('Implement part 4 b…');   // libellé tronqué VS Code
  const findE = (snap) => snap.conversations.find((c) => c.sessionId === 'e');

  let snap = snapshot(eTab, { tabOpenMisses: misses });
  check('onglet ouvert et matché → tabOpen true', findE(snap).tabOpen === true);

  // Un seul recompute où le matching rate (ambiguïté de préfixe résolue autrement
  // ce coup-ci, ou tout autre bruit ponctuel) — l'onglet, lui, n'a pas bougé.
  snap = snapshot(() => noTabs, { tabOpenMisses: misses });
  check('UN recompute sans match (bruit isolé) → le chip reste affiché',
    findE(snap).tabOpen === true);

  // L'onglet revient dès le recompute suivant : le compteur de manques doit
  // être remis à zéro, pas seulement suspendu.
  snap = snapshot(eTab, { tabOpenMisses: misses });
  check('… et redevient vrai dès que le match revient', findE(snap).tabOpen === true);

  // Deux ratés CONSÉCUTIFS (l'onglet a vraiment disparu, ou tabs.known devient
  // durablement incohérent) : là, la vue doit finir par suivre.
  snapshot(() => noTabs, { tabOpenMisses: misses });
  snap = snapshot(() => noTabs, { tabOpenMisses: misses });
  check('deux manques consécutifs → le chip finit par disparaître',
    findE(snap).tabOpen === false);
}

console.log('\n8bis. buildSnapshot : le cas témoin « master barrée au collage » (lot gel-tabs 2026-08-17)');
{
  // Reproduit l'incident : une conv de cadrage VIVANTE vient d'être désignée
  // maîtresse d'un batch. Son ai-title (le seul titre que le transcript
  // connaît) ne matche PAS l'onglet réel — VS Code n'a pas encore renommé
  // l'onglet depuis le premier prompt — et session-titles.js (state.vscdb,
  // écrit par le renderer avec latence) n'a pas encore la paire non plus :
  // AUCUNE des deux sources de titre matchable ne trouve son onglet, deux
  // recomputes consécutifs plus tard. panel.js rend la maîtresse avec la même
  // fabrique qu'une ligne plate (rowFor) et barre `state==='done' && !tabOpen`
  // — c'est ce `tabOpen` que ce banc vérifie, membre ou maîtresse confondus
  // (les deux lisent le même champ du même objet conv).
  const MASTER_WS = 'C:\\Users\\Test\\Projets VSCODE\\MasterBug';
  const dir = state.projectDirFor(MASTER_WS);
  fs.mkdirSync(dir, { recursive: true });
  const mFile = path.join(dir, 'm.jsonl');
  fs.writeFileSync(mFile, [userMsg('peu importe'), assistant, { type: 'ai-title', aiTitle: 'Fix tab focus mismatch with Claude convs' }]
    .map((l) => JSON.stringify(l)).join('\n') + '\n');
  const existingState = JSON.parse(fs.readFileSync(path.join(SANDBOX, '.claude', 'sessions-state.json'), 'utf8'));
  existingState.sessions.m = { state: 'done', since: Date.now(), updated_at: Date.now(), transcript: mFile };
  fs.writeFileSync(path.join(SANDBOX, '.claude', 'sessions-state.json'), JSON.stringify(existingState));

  // L'onglet réel, tel qu'affiché à l'écran : le premier prompt, pas l'ai-title.
  const realTab = () => tabs('tojours et encore le meme souci…');
  const findM = (snap) => snap.conversations.find((c) => c.sessionId === 'm');
  const build = (live, misses) => state.buildSnapshot({
    workspacePath: MASTER_WS, recentMs: 4 * 3600 * 1000, maxItems: 12, tabs: realTab,
    liveSessions: () => new Set(live), sessionTitles: () => new Map(), tabOpenMisses: misses,
  }, state.createTranscriptReader());

  // Session VIVANTE (née d'une fenêtre VS Code) : deux recomputes consécutifs
  // sans aucun match de titre — le titre réel de l'onglet n'arrivera que plus
  // tard (session-titles.js rattrape son retard, cf. plan).
  let misses = new Map();
  build(['m'], misses);
  let snap = build(['m'], misses);
  check('conv done, vivante, AUCUN titre ne matche, 2 recomputes consécutifs → tabOpen reste true',
    findM(snap).tabOpen === true, JSON.stringify(findM(snap)));
  check('… donc pas de rendu barré (panel.js : state===done && !tabOpen)',
    !(findM(snap).state === 'done' && !findM(snap).tabOpen));

  // Même conv, mais SESSION MORTE (CLI déjà éteint) : comportement d'avant —
  // isGone() (mécanisme SÉPARÉ, cf. plus haut §1) masque déjà entièrement une
  // conv `done` sans process vivant dont aucun titre matchable ne matche un
  // onglet, avant même que tabOpen entre en jeu — elle sort donc de la liste,
  // ce qui est le comportement voulu (rien à barrer, rien à afficher). La
  // comparaison au niveau de `resolveTabOpen` seul (avec/sans preuve de
  // vivacité) est déjà faite au §7bis.
  misses = new Map();
  build([], misses);
  snap = build([], misses);
  check('même conv, session MORTE, aucun titre ne matche → masquée entièrement (isGone, inchangé)',
    findM(snap) === undefined, JSON.stringify(snap.conversations.map((c) => c.sessionId)));
}

console.log('\n9. renderKey : tabOpen fait partie de la clé de rendu');
{
  // Deux conversations identiques en tout point SAUF tabOpen : sans lot 2, un
  // recompute qui corrige tabOpen tout seul (cf. §8) ne repousserait rien au
  // panneau tant qu'aucun autre champ n'a changé — la correction resterait
  // invisible jusqu'à un événement sans rapport.
  const base = { sessionId: 's1', title: 'T', state: 'idle', acked: true, model: null, effort: null, ctx: null, isActive: false, message: null };
  const keyOpen = state.renderKey([{ ...base, tabOpen: true }]);
  const keyClosed = state.renderKey([{ ...base, tabOpen: false }]);
  check('tabOpen seul change → la clé de rendu change aussi', keyOpen !== keyClosed);
}

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
