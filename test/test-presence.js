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

  // La même, avec son process CLI vivant — MASQUÉE depuis le 2026-08-24.
  // « Le CLI tourne, donc son onglet est ouvert » est faux : un process survit à
  // la fermeture de son onglet (relevé vivant 16 h après, fenêtre jamais
  // rechargée, zéro onglet Claude déclaré par elle) et la ligne restait à
  // l'écran pour toujours. Le store publie ici l'identité d'onglet de 'a' :
  // aucun onglet ne la porte ⇒ c'est une PREUVE de fermeture, pas une ignorance.
  snap = snapshot(() => noTabs, { sessionTitles: titles, liveSessions: () => new Set(['a']) });
  check('identité publiée + aucun onglet : masquée MÊME avec son CLI vivant (CLI orphelin)',
    !snap.conversations.some((c) => c.sessionId === 'a'),
    snap.conversations.map((c) => c.title).join(' | '));

  // …et l'autre moitié, toujours vraie : tant que le store n'a RIEN publié pour
  // cette session (conv qui vient de naître, la vue officielle écrit sa paire
  // sessionId→titre avec latence), il n'existe aucune preuve à opposer au
  // process vivant — elle reste affichée. C'est le cas que protégeait le
  // garde-fou d'origine (2026-07-22), et il est intact.
  snap = snapshot(() => noTabs, { sessionTitles: () => new Map(), liveSessions: () => new Set(['a']) });
  check('identité non publiée + CLI vivant → affichée (conv qui vient de naître)',
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

// ── Les trois échappatoires, fermées dès que l'identité est publiée ─────────
console.log('\n4bis-suite. Identité d\'onglet publiée : plus de ligne sans onglet');
{
  // 'c' (titre de repli) et 'd' (busy, CLI vivant) restaient affichées SANS
  // onglet, chacune par une exemption différente d'isGone — toutes posées pour
  // couvrir un « on ne peut pas encore savoir ». Dès que le store publie leur
  // titre d'onglet, on PEUT savoir : aucun onglet ne les porte ⇒ elles partent.
  // Demande de l'user du 2026-08-23 : les lignes reflètent les onglets ouverts.
  const published = () => new Map([['c', 'Titre de repli sans ai-title'], ['d', 'Conv CLI au travail']]);
  const onlyB = () => tabs('Conv ouverte à garder');

  let snap = snapshot(onlyB, { sessionTitles: published, liveSessions: () => new Set(['d']) });
  let ids = snap.conversations.map((x) => x.sessionId);
  check('titre de repli + identité publiée + aucun onglet → masquée', !ids.includes('c'), ids.join(','));
  check('busy + CLI vivant + identité publiée + aucun onglet → masquée', !ids.includes('d'), ids.join(','));
  check('… la conv dont l\'onglet est ouvert, elle, reste', ids.includes('b'), ids.join(','));

  // Le fait « onglet prouvé absent » est PUBLIÉ par le snapshot, y compris pour
  // les conversations qu'il ne rend pas : c'est de là que member-truth.js tire
  // son `tabClosed` pour les membres de lot, dont l'onglet a pu se fermer hors
  // de la vue (fenêtre éteinte, process orphelin). Sans ça, un membre restait
  // « ouverte » et retenait son lot à l'écran (signalé le 2026-08-24).
  check('tabGoneIds publie les onglets prouvés absents',
    snap.tabGoneIds.has('c') && snap.tabGoneIds.has('d'), [...snap.tabGoneIds].join(','));
  check('… et jamais celui dont l\'onglet est ouvert', !snap.tabGoneIds.has('b'),
    [...snap.tabGoneIds].join(','));

  // Garde-fou de panne : store muet (0 entrée là où le fichier existe) = PANNE,
  // pas dégradation (incident 2026-08-20) — les exemptions reprennent toutes,
  // rien ne disparaît de plus.
  snap = snapshot(onlyB, { sessionTitles: () => new Map(), liveSessions: () => new Set(['d']) });
  ids = snap.conversations.map((x) => x.sessionId);
  check('store muet → les deux reviennent (aucun masquage de plus)',
    ids.includes('c') && ids.includes('d'), ids.join(','));
  check('… et tabGoneIds reste vide : on ne prouve la fermeture de personne',
    snap.tabGoneIds.size === 0, [...snap.tabGoneIds].join(','));

  // La marque « à relire » : seule exemption qui subsiste, parce qu'elle est un
  // ORDRE de l'utilisateur et non une preuve manquante.
  snap = snapshot(onlyB, {
    sessionTitles: published, liveSessions: () => new Set(['d']),
    pinnedSessions: () => new Set(['c']),
  });
  ids = snap.conversations.map((x) => x.sessionId);
  check('... meme marquee : onglet prouve ferme -> la ligne part aussi (decision user 2026-08-26)',
    !ids.includes('c'), ids.join(','));
  check('... et plus aucune conversation ne publie tabGone (champ retire du modele)',
    snap.conversations.every((x) => !('tabGone' in x)), ids.join(','));
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

// Le cas témoin du 2026-08-20 : la ligne BARRÉE qu'aucun geste ne retire.
// Une conv sans ai-title porte un titre de repli (1er prompt) — non matchable,
// donc isGone refuse par construction de conclure quoi que ce soit de l'absence
// d'onglet. La seule échéance qui restait était l'âge du transcript, et une
// fiche hooks retamponée 16 h après le dernier travail de la conversation
// l'annulait : ligne immortelle, une place de maxItems mangée, zéro recours
// côté user (la flèche de sortie n'existe que sur un membre de lot). Constaté
// sur données réelles, deux convs du 2026-08-19 signalées par l'user.
console.log('\n4quinquies. Fiche hooks fraîche + transcript vieux + titre de repli');
{
  const statePath = path.join(SANDBOX, '.claude', 'sessions-state.json');
  const saved = fs.readFileSync(statePath, 'utf8');
  const ghost = 'C:\\Users\\Test\\Projets VSCODE\\Ghost';
  const dir = state.projectDirFor(ghost);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'gh.jsonl');
  // AUCUNE entrée ai-title : le titre affiché sera le 1er message user.
  fs.writeFileSync(f, [userMsg('Rappel moi ce que fait le hook de Claude convs'), assistant]
    .map((l) => JSON.stringify(l)).join('\n') + '\n');
  const when = (Date.now() - 16 * 3600 * 1000) / 1000;      // 16 h → hors recentMs
  fs.utimesSync(f, when, when);
  // …et la fiche hooks vient d'être retamponée, 16 h après le dernier écrit.
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1,
    sessions: {
      gh: { state: 'done', since: Date.now() - 16 * 3600 * 1000, updated_at: Date.now(), transcript: f },
    },
  }));
  const build = (liveIds) => state.buildSnapshot({
    workspacePath: ghost, recentMs: 4 * 3600 * 1000, maxItems: 12,
    tabs: () => noTabs, liveSessions: () => new Set(liveIds), sessionTitles: () => new Map(),
  }, state.createTranscriptReader());
  const shown = build([]).conversations;
  check('transcript muet depuis 16 h, aucun onglet → hors liste MALGRÉ la fiche fraîche',
    shown.length === 0, JSON.stringify(shown.map((c) => c.title)));
  check('…et un process CLI vivant la garde toujours (exemption légitime intacte)',
    build(['gh']).conversations.length === 1);
  fs.writeFileSync(statePath, saved);
}

// ── La marque « à relire » survit à la fermeture (lot 3 du plan
// PLAN_marque_a_relire_2026-08-22.md) ─────────────────────────────────────
// Ce que ce banc verrouille, et que rien d'autre ne verrouille :
//   - une conv MARQUÉE reste listée quand son onglet est parti ET quand son
//     transcript a vieilli — les deux seules portes par lesquelles une ligne
//     quitte la liste ;
//   - elle est publiée `tabGone: true` / `tabOpen: false` : le rendu la barre
//     et son clic rouvre, il ne cherche pas un onglet qui n'existe plus ;
//   - RETIRER la marque la fait re-disparaître aussitôt — autrement dit la
//     marque est bien la SEULE cause de sa présence, et le filtre d'ancienneté
//     (avec son Set `aged`, qui empêche la boucle des fiches hooks de repêcher
//     ce qu'il a écarté) continue de faire son travail ;
//   - dégradations : source absente (appelant d'avant ce lot), tracker
//     d'onglets mort, onglet encore ouvert.
console.log('\n4sexies. Conv MARQUÉE « à relire » : survit à la fermeture de l\'onglet et au vieillissement');
{
  const pinnedWs = 'C:\\Users\\Test\\Projets VSCODE\\Pinned';
  const dir = state.projectDirFor(pinnedWs);
  fs.mkdirSync(dir, { recursive: true });
  const mk = (id, title, ageH) => {
    const f = path.join(dir, id + '.jsonl');
    fs.writeFileSync(f, [userMsg('p'), assistant, { type: 'ai-title', aiTitle: title }]
      .map((l) => JSON.stringify(l)).join('\n') + '\n');
    const when = (Date.now() - ageH * 3600 * 1000) / 1000;
    fs.utimesSync(f, when, when);
  };
  // « pin » : marquée, vieille de 8 h (hors recentMs) ET sans onglet — les deux
  // causes de disparition à la fois. « old » : sa jumelle NON marquée, témoin.
  mk('pin', 'Conv marquee a relire', 8);
  mk('old', 'Conv oubliee non marquee', 8);
  const build = (extra) => state.buildSnapshot(Object.assign({
    workspacePath: pinnedWs, recentMs: 4 * 3600 * 1000, maxItems: 12,
    tabs: () => noTabs, liveSessions: () => new Set(), sessionTitles: () => new Map(),
  }, extra), state.createTranscriptReader());

  const withPin = build({ pinnedSessions: () => new Set(['pin']) }).conversations;
  check('marquee, transcript vieux de 8 h, onglet prouve ferme -> RETIREE comme les autres',
    withPin.length === 0, JSON.stringify(withPin.map((c) => c.sessionId)));
  check('sa jumelle NON marquée reste écartée (le filtre d\'ancienneté n\'est pas désarmé pour tout le monde)',
    !withPin.some((c) => c.sessionId === 'old'));

  check('marque RETIRÉE → la ligne repart (la marque était bien sa seule cause de présence)',
    build({ pinnedSessions: () => new Set() }).conversations.length === 0);
  check('source absente (appelant d\'avant ce lot) → comportement d\'avant à l\'octet près',
    build({}).conversations.length === 0);
  check('tableau au lieu d\'un Set (l\'appelant sérialise un store) → accepté',
    build({ pinnedSessions: () => ['pin'] }).conversations.length === 0);

  // Onglet ouvert : cas nominal, rien ne change — et surtout tabGone reste
  // FAUX, sinon le clic « rouvrirait » une conversation déjà sous les yeux.
  const openTab = build({
    pinnedSessions: () => new Set(['pin']),
    tabs: () => tabs('Conv marquee a relire'),
    sessionTitles: () => new Map([['pin', 'Conv marquee a relire']]),
  }).conversations.find((c) => c.sessionId === 'pin');
  check('marquee AVEC son onglet ouvert -> tabOpen true (le cas nominal ne bouge pas)',
    !!openTab && openTab.tabOpen === true,
    JSON.stringify(openTab && openTab.tabOpen));

  // Tracker d'onglets mort : on ne sait RIEN des onglets, donc aucune
  // fermeture n'est prouvée — la ligne reste (isGone ne masque rien dans ce
  // cas), mais elle ne doit jamais annoncer un onglet fermé.
  const blind = build({ pinnedSessions: () => new Set(['pin']), tabs: () => unknown }).conversations
    .find((c) => c.sessionId === 'pin');
  check('tracker d onglets mort (known:false) -> listee (aucune fermeture prouvee)',
    !!blind, JSON.stringify(blind && blind.sessionId));
}

console.log('\n4septies. Places de maxItems : une marquée passe devant les fraîches, jamais devant un onglet ouvert');
{
  const race = 'C:\\Users\\Test\\Projets VSCODE\\PinRace';
  const dir = state.projectDirFor(race);
  fs.mkdirSync(dir, { recursive: true });
  const mk = (id, title, ageMin) => {
    const f = path.join(dir, id + '.jsonl');
    fs.writeFileSync(f, [userMsg('p'), assistant, { type: 'ai-title', aiTitle: title }]
      .map((l) => JSON.stringify(l)).join('\n') + '\n');
    const when = (Date.now() - ageMin * 60000) / 1000;
    fs.utimesSync(f, when, when);
  };
  mk('pin', 'Conv marquee ancienne', 200);        // marquée, la plus ancienne
  mk('tab', 'Conv avec onglet ouvert', 100);      // onglet ouvert, moins ancienne
  mk('fresh', 'Conv fraiche sans onglet', 1);     // la plus fraîche, mais fermée
  const build = (maxItems) => state.buildSnapshot({
    workspacePath: race, recentMs: 4 * 3600 * 1000, maxItems,
    tabs: () => tabs('Conv avec onglet ouver…'),
    sessionTitles: () => new Map([['tab', 'Conv avec onglet ouvert']]),
    pinnedSessions: () => new Set(['pin']),
  }, state.createTranscriptReader());

  const one = build(1).conversations.map((c) => c.sessionId);
  check('une seule place : l\'onglet OUVERT la prend (invariant « onglet ouvert ⇒ listée », dont member-truth dépend)',
    one.length === 1 && one[0] === 'tab', JSON.stringify(one));
  const two = build(2).conversations.map((c) => c.sessionId);
  check('deux places : la marquee SANS onglet ne rachete plus sa place, l onglet ouvert reste seul',
    two.length === 1 && two[0] === 'tab', JSON.stringify(two));
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

// ── Lot 2 du plan d'appariement (2026-08-21) : la relation onglet↔conv est
// une BIJECTION, calculée une fois par snapshot, pas cherchée par chacune. ──
console.log('\n10. Appariement bijectif : plus d\'emprunt d\'onglet entre sœurs');
{
  // Deux sœurs au même libellé tronqué (24 car. + …), titres complets
  // distincts : le scénario réel du constat (2026-08-15), pas un resume
  // (supersede.js ne les fond pas, leurs premiers messages diffèrent).
  const twins = 'C:\\Users\\Test\\Projets VSCODE\\Twins';
  const dir = state.projectDirFor(twins);
  fs.mkdirSync(dir, { recursive: true });
  const PREFIX = 'y'.repeat(24);
  const liveFile = path.join(dir, 'live.jsonl');
  const closedFile = path.join(dir, 'closed.jsonl');
  fs.writeFileSync(liveFile, [userMsg('sujet A'), assistant, { type: 'ai-title', aiTitle: `${PREFIX} onglet reellement ouvert` }]
    .map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(closedFile, [userMsg('sujet B, tout autre'), assistant, { type: 'ai-title', aiTitle: `${PREFIX} onglet ferme depuis` }]
    .map((l) => JSON.stringify(l)).join('\n') + '\n');
  const when = (Date.now() - 5000) / 1000;
  fs.utimesSync(closedFile, when, when);   // plus ancienne : perd le départage
  const label = `${PREFIX}…`;
  const build = (labels, extra) => state.buildSnapshot({
    workspacePath: twins, recentMs: 4 * 3600 * 1000, maxItems: 12,
    tabs: () => ({ known: true, labels }),
    liveSessions: () => new Set(), sessionTitles: () => new Map(),
    ...extra,
  }, state.createTranscriptReader());

  // Un SEUL appel isolé (Map de tolérance fraîche, comme un premier recompute
  // après activation) : depuis le lot « présence par identifiant » (2026-08-26),
  // la surnuméraire d'un groupe AMBIGU n'est plus retirée sur ce seul constat —
  // cf. resolveHasTabForPresence, testé isolément plus bas (§10ter) et de bout
  // en bout ici (§12). Elle le reste tant que la perte de l'appariement n'est
  // PAS confirmée sur plusieurs recomputes consécutifs.
  const snap1 = build([label]);   // UN SEUL onglet réel pour les deux sœurs
  const titlesTwins = snap1.conversations.map((c) => c.title);
  check('un seul onglet réel pour deux sœurs, UN seul recompute → la surnuméraire reste tolérée (pas de clignotement)',
    titlesTwins.length === 2, JSON.stringify(titlesTwins));
  check('… la conv qui tient réellement l\'onglet a bien tabOpen:true',
    snap1.conversations.find((c) => c.title.includes('reellement ouvert')).tabOpen === true);

  // Recomputes RÉPÉTÉS avec les MÊMES Map de tolérance (le cas réel : le moteur
  // les tient d'un tick à l'autre) : la surnuméraire finit par partir, mais
  // seulement après resolveHasTabForPresence.PRESENCE_MISS_TOLERANCE pertes
  // AMBIGUËS consécutives — jamais sur la première.
  {
    const tabOpenMisses = new Map();
    const presenceMisses = new Map();
    const tick = () => build([label], { tabOpenMisses, presenceMisses });
    const findLoser = (snap) => snap.conversations.find((c) => c.title.includes('ferme depuis'));

    let t = tick();
    check('tick 1 : la surnuméraire est encore là (1re perte ambiguë, tolérée)', !!findLoser(t));
    t = tick();
    check('tick 2 : encore là (2e perte ambiguë, tolérance = 2 pertes)', !!findLoser(t));
    t = tick();
    check('tick 3 : la 3e perte ambiguë consécutive la retire enfin',
      !findLoser(t), JSON.stringify(t.conversations.map((c) => c.title)));
  }

  const snap2 = build([label, label]);   // DEUX onglets réels distincts (m = k)
  const titles2 = snap2.conversations.map((c) => c.title);
  check('deux onglets réels pour deux sœurs → les DEUX restent affichées',
    snap2.conversations.length === 2, JSON.stringify(titles2));
  check('… chacune avec tabOpen:true (bijection : un onglet chacune, plus le même rang)',
    snap2.conversations.every((c) => c.tabOpen === true), JSON.stringify(snap2.conversations.map((c) => c.tabOpen)));
  check('… et toutes deux marquées tabAmbiguous (l\'appariement entre elles est arbitraire)',
    snap2.conversations.every((c) => c.tabAmbiguous === true), JSON.stringify(snap2.conversations.map((c) => c.tabAmbiguous)));
}

console.log('\n11. Lot 3 : ambiguïté résiduelle — se taire plutôt que deviner');
{
  // Même scénario de sœurs que §10 (deux onglets réels, appariement arbitraire
  // dans l'ORDRE), mais cette fois on simule un onglet ACTIF dans ce groupe :
  // sans identifiant vrai pour trancher, aucune des deux ne doit être surlignée.
  const twins2 = 'C:\\Users\\Test\\Projets VSCODE\\Twins2';
  const dir2 = state.projectDirFor(twins2);
  fs.mkdirSync(dir2, { recursive: true });
  const PREFIX2 = 'z'.repeat(24);
  const fileA = path.join(dir2, 'a.jsonl');
  const fileB = path.join(dir2, 'b.jsonl');
  fs.writeFileSync(fileA, [userMsg('sujet A2'), assistant, { type: 'ai-title', aiTitle: `${PREFIX2} sujet A2 complet` }]
    .map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(fileB, [userMsg('sujet B2'), assistant, { type: 'ai-title', aiTitle: `${PREFIX2} sujet B2 complet` }]
    .map((l) => JSON.stringify(l)).join('\n') + '\n');
  const when2 = (Date.now() - 3000) / 1000;
  fs.utimesSync(fileB, when2, when2);   // A plus récente → ordre d'affichage A puis B
  const label2 = `${PREFIX2}…`;
  const ACTIVE_SESSION_PATH2 = path.join(SANDBOX, '.claude', 'active-session.json');
  function build2(activeIndex, activeSessionId) {
    try {
      if (activeSessionId) fs.writeFileSync(ACTIVE_SESSION_PATH2, JSON.stringify({ session_id: activeSessionId }));
      else fs.rmSync(ACTIVE_SESSION_PATH2, { force: true });
    } catch {}
    return state.buildSnapshot({
      workspacePath: twins2, recentMs: 4 * 3600 * 1000, maxItems: 12,
      tabs: () => ({
        known: true, labels: [label2, label2], activeLabel: label2, activeIndex,
        frozen: false, source: 'fresh', windowFocused: true, sinceFocusMs: 10,
      }),
      liveSessions: () => new Set(), sessionTitles: () => new Map(),
    }, state.createTranscriptReader());
  }

  // Appariement dans l'ORDRE (comme §10) : A (affichage 1er, plus récente) →
  // onglet 0, B → onglet 1. L'onglet ACTIF est l'onglet 0 (A), sans
  // active-session.json pour trancher.
  const snapNone = build2(0, null);
  check('groupe ambigu, aucun identifiant vrai → PERSONNE de surligné',
    snapNone.conversations.every((c) => c.isActive === false),
    JSON.stringify(snapNone.conversations.map((c) => [c.title, c.isActive])));
  check('… les deux membres restent marqués tabAmbiguous',
    snapNone.conversations.every((c) => c.tabAmbiguous === true));

  // active-session.json désigne B (l'AUTRE sœur que celle que l'appariement
  // arbitraire aurait choisie) : c'est elle qui doit être surlignée, pas A.
  const bId = snapNone.conversations.find((c) => c.title.includes('sujet B2')).sessionId;
  const snapSister = build2(0, bId);
  const activeConv = snapSister.conversations.find((c) => c.isActive === true);
  check('active-session.json désigne l\'autre sœur → C\'EST ELLE qui est surlignée',
    !!activeConv && activeConv.sessionId === bId,
    JSON.stringify(snapSister.conversations.map((c) => [c.title, c.isActive])));
  check('… une seule conv surlignée à la fois',
    snapSister.conversations.filter((c) => c.isActive).length === 1);

  try { fs.rmSync(ACTIVE_SESSION_PATH2, { force: true }); } catch {}
}

// ── Lot « présence par identifiant » (2026-08-26) : l'identifiant de session
// (memento workbench.parts.editor, session-titles.js createOpenSessionIds)
// devient la source de vérité de la présence — labels.js `pairTabs` en tient
// compte AVANT tout raisonnement sur les libellés, et l'appariement par titre
// devient un repli EXPLICITE. Constat user : « certaine conversation se barre
// sans raison puis se debarre » — deux sœurs au titre tronqué identique dont
// l'appariement (par ORDRE, faute de mieux) peut changer de gagnante d'un
// recompute à l'autre. ────────────────────────────────────────────────────
console.log('\n12. pairTabs (labels.js) : l\'identité tranche, l\'ORDRE ne décide plus');
{
  const { pairTabs } = require(path.join(__dirname, '..', 'labels.js'));
  const sisterA = { sessionId: 'sisterA', title: 'yyy sujet A complet', tabTitle: null };
  const sisterB = { sessionId: 'sisterB', title: 'yyy sujet B complet', tabTitle: null };
  const label = 'yyy…';

  // Sans identité (openIds absent) : c'est l'ORDRE de réception qui décide —
  // exactement le mécanisme derrière le clignotement (l'ordre change d'un
  // recompute à l'autre, cf. commentaire de `prepared` dans state.js).
  const noIdA = pairTabs([sisterA, sisterB], [label]);
  const noIdB = pairTabs([sisterB, sisterA], [label]);
  check('sans identité : la PREMIÈRE de la liste gagne (A d\'abord)',
    noIdA.index.get('sisterA') === 0 && !noIdA.index.has('sisterB'));
  check('sans identité, ordre inversé : la gagnante CHANGE (B d\'abord) — le bug lui-même',
    noIdB.index.get('sisterB') === 0 && !noIdB.index.has('sisterA'));

  // Avec identité (openIds = {sisterB}) : sisterB gagne TOUJOURS, quel que soit
  // l'ordre de réception — l'appariement par libellé ne tranche plus rien pour
  // elle, il n'a plus qu'à ranger sisterA (qui n'a, à raison, plus aucun
  // libellé à revendiquer).
  const openIds = new Set(['sisterB']);
  const idA = pairTabs([sisterA, sisterB], [label], openIds);
  const idB = pairTabs([sisterB, sisterA], [label], openIds);
  check('avec identité : sisterB gagne (ordre A, B)',
    idA.index.get('sisterB') === 0 && !idA.index.has('sisterA'));
  check('avec identité : sisterB gagne PAREIL (ordre B, A) — plus d\'ordre qui compte',
    idB.index.get('sisterB') === 0 && !idB.index.has('sisterA'));
  check('… et ni l\'une ni l\'autre n\'est marquée ambiguë : l\'identité a levé l\'ambiguïté, pas juste tranché dedans',
    !idA.ambiguous.has('sisterA') && !idA.ambiguous.has('sisterB'));

  // Deux onglets réels, LES DEUX sœurs confirmées par identité : chacune son
  // libellé, aucune ambiguïté — même si les deux chaînes de libellé restent
  // strictement identiques.
  const both = pairTabs([sisterA, sisterB], [label, label], new Set(['sisterA', 'sisterB']));
  check('deux onglets réels, deux identités confirmées → les deux appariées, aucune ambiguë',
    both.index.has('sisterA') && both.index.has('sisterB')
    && !both.ambiguous.has('sisterA') && !both.ambiguous.has('sisterB'));

  // Dégradation : une identité publiée mais SANS libellé qui matche encore
  // (mémento en avance sur le libellé republié, ou id résiduel) — ignorée
  // proprement, aucun crash, repli sur la cascade normale pour tout le monde.
  const stale = pairTabs([sisterA, sisterB], [label], new Set(['sisterA', 'ghost-id-inconnu']));
  check('identité publiée sans libellé correspondant → repli sans casse (cascade normale)',
    stale.index.get('sisterA') === 0 && !stale.index.has('sisterB'));

  // Repli explicite total : openIds vide (base illisible/verrouillée, ancienne
  // version de VS Code sans le memento) → identique à l'ancien comportement.
  const empty = pairTabs([sisterA, sisterB], [label], new Set());
  check('openIds vide → comportement identique à l\'ancien appariement (aucun repli oublié)',
    empty.index.get('sisterA') === 0 && !empty.index.has('sisterB'));
}

console.log('\n13. buildSnapshot : identité câblée de bout en bout, plus de clignotement');
{
  // Même scénario que §10 (une sœur avec un vrai onglet, l\'autre un husk),
  // mais avec `openSessionIds` câblé comme extension.js le fait réellement
  // (session-titles.js `createOpenSessionIds`).
  const twins3 = 'C:\\Users\\Test\\Projets VSCODE\\Twins3';
  const dir3 = state.projectDirFor(twins3);
  fs.mkdirSync(dir3, { recursive: true });
  const PREFIX3 = 'w'.repeat(24);
  const liveFile3 = path.join(dir3, 'live3.jsonl');
  const closedFile3 = path.join(dir3, 'closed3.jsonl');
  fs.writeFileSync(liveFile3, [userMsg('sujet A3'), assistant, { type: 'ai-title', aiTitle: `${PREFIX3} onglet reellement ouvert` }]
    .map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(closedFile3, [userMsg('sujet B3, tout autre'), assistant, { type: 'ai-title', aiTitle: `${PREFIX3} onglet ferme depuis` }]
    .map((l) => JSON.stringify(l)).join('\n') + '\n');
  const label3 = `${PREFIX3}…`;
  const build3 = (mtimeOrder, extra) => {
    // `mtimeOrder` fait varier l'ORDRE des candidats (mtime décroissant, cf.
    // `prepared` dans state.js) sans rien changer à la réalité des onglets —
    // exactement ce qui flotte d'un recompute à l'autre en usage réel
    // (activité, republication d'un libellé par une autre fenêtre…).
    const now = Date.now() / 1000;
    if (mtimeOrder === 'closedNewer') {
      fs.utimesSync(liveFile3, now - 10, now - 10);
      fs.utimesSync(closedFile3, now, now);
    } else {
      fs.utimesSync(liveFile3, now, now);
      fs.utimesSync(closedFile3, now - 10, now - 10);
    }
    return state.buildSnapshot({
      workspacePath: twins3, recentMs: 4 * 3600 * 1000, maxItems: 12,
      tabs: () => ({ known: true, labels: [label3] }),
      liveSessions: () => new Set(), sessionTitles: () => new Map(),
      ...extra,
    }, state.createTranscriptReader());
  };
  const idOpts = { openSessionIds: () => new Set(['live3']) };

  // Identité disponible : la surnuméraire part DÈS LE PREMIER recompute — plus
  // besoin d'attendre la tolérance de §10, l'ambiguïté n'existe plus du tout.
  let snap = build3('liveNewer', idOpts);
  let titles3 = snap.conversations.map((c) => c.title);
  check('avec identité : la surnuméraire part DÈS le premier recompute (aucune tolérance nécessaire)',
    titles3.length === 1 && titles3[0].includes('reellement ouvert'), JSON.stringify(titles3));

  // L'ORDRE des candidats s'inverse (mtime), la réalité des onglets non : la
  // gagnante par identité ne bouge pas — c'est exactement le clignotement
  // signalé qui disparaît.
  snap = build3('closedNewer', idOpts);
  titles3 = snap.conversations.map((c) => c.title);
  check('ordre des candidats inversé, MÊME identité → la même conv reste, aucun clignotement',
    titles3.length === 1 && titles3[0].includes('reellement ouvert'), JSON.stringify(titles3));

  // Repli explicite : base illisible/verrouillée ou ancienne version de VS
  // Code → openSessionIds absent des opts, exactement comme avant ce lot.
  // Comparé ici à un openSessionIds explicitement VIDE (dégradation vécue en
  // usage réel, cf. session-titles.js) : les deux doivent produire le MÊME
  // résultat, celui déjà vérifié au §10 (tolérance, pas de disparition
  // immédiate) — la source d'identité n'a changé le résultat que quand elle a
  // quelque chose à dire.
  const noOptSnap = build3('liveNewer', {});
  const emptySnap = build3('liveNewer', { openSessionIds: () => new Set() });
  check('repli explicite (source absente) et openIds vide donnent le même résultat',
    JSON.stringify(noOptSnap.conversations.map((c) => c.sessionId).sort())
    === JSON.stringify(emptySnap.conversations.map((c) => c.sessionId).sort()));
  check('… et ce résultat est bien celui du repli par libellé (les deux sœurs tolérées, comme §10)',
    emptySnap.conversations.length === 2, JSON.stringify(emptySnap.conversations.map((c) => c.title)));
}

console.log('\n14. Fenêtre en cours de remontage : c\'est le RENDERER qui tranche (2026-08-28)');
{
  // Au reload, le store des titres survit intact — il ne purge jamais — alors
  // que les libellés d'onglets sont republiés par des CLI tout juste
  // respawnés. « Identité publiée + aucun onglet à son nom » devient donc vrai
  // pour TOUT LE MONDE pendant quelques dizaines de secondes : une ligne se
  // barre, une autre disparaît (constat user au reload de la 2.86.0).
  //
  // Suspendre le jugement pendant ce creux a été essayé (2.86.1) et c'était
  // PIRE : plus rien ne disparaissant, tout l'historique récent remontait en
  // fantômes (10 lignes pour 4 onglets, capture user). Ce banc tient les deux
  // bouts : l'ouverte reste, la fermée part — et sans le renderer, on ne
  // touche à rien.
  const wsG = 'C:\\Users\\Test\\Projets VSCODE\\Grace';
  const dirG = state.projectDirFor(wsG);
  fs.mkdirSync(dirG, { recursive: true });
  fs.writeFileSync(path.join(dirG, 'g1.jsonl'),
    [userMsg('sujet ouvert'), assistant, { type: 'ai-title', aiTitle: 'Conv bien ouverte' }]
      .map((l) => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(path.join(dirG, 'g2.jsonl'),
    [userMsg('sujet ferme'), assistant, { type: 'ai-title', aiTitle: 'Conv fermee hier' }]
      .map((l) => JSON.stringify(l)).join('\n') + '\n');
  const buildG = (extra) => state.buildSnapshot({
    workspacePath: wsG, recentMs: 4 * 3600 * 1000, maxItems: 12,
    // Onglets connus, mais AUCUN libellé encore republié : l'état exact du
    // creux qui suit un rechargement de fenêtre.
    tabs: () => ({ known: true, labels: [] }),
    liveSessions: () => new Set(),
    // Le store, lui, publie les deux identités — c'est ce qui rendait la
    // fermeture « prouvée » alors qu'une des deux était bien ouverte.
    sessionTitles: () => new Map([['g1', 'Conv bien ouverte'], ['g2', 'Conv fermee hier']]),
    ...extra,
  }, state.createTranscriptReader());
  const titlesOf = (snap) => snap.conversations.map((c) => c.title).sort();

  const noGrace = titlesOf(buildG({}));
  check('sans activatedAt (bancs d\'avant ce lot) : comportement d\'avant, les deux sont déclarées fermées',
    noGrace.length === 0, JSON.stringify(noGrace));

  // Le cœur : le renderer (memento workbench.parts.editor) a survécu au
  // reload et désigne g1. Relevé en réel le 2026-08-28 sur la fenêtre en
  // cause : 4 sessions déclarées, exactement les 4 onglets ouverts.
  const settling = titlesOf(buildG({
    activatedAt: Date.now(),
    openSessionIds: () => new Set(['g1']),
  }));
  check('remontage + renderer : l\'ouverte RESTE…',
    settling.includes('Conv bien ouverte'), JSON.stringify(settling));
  check('… et la fermée ne revient PAS en fantôme (la régression de 2.86.1)',
    !settling.includes('Conv fermee hier') && settling.length === 1, JSON.stringify(settling));

  // Sans renderer, personne ne peut trancher : on ne touche à rien plutôt que
  // de fabriquer des fantômes.
  const blind = titlesOf(buildG({ activatedAt: Date.now(), openSessionIds: () => new Set() }));
  check('remontage SANS renderer (base illisible) : comportement d\'avant, aucune grâce',
    JSON.stringify(blind) === JSON.stringify(noGrace), JSON.stringify(blind));

  // Grâce écoulée : les libellés sont revenus depuis longtemps, la preuve
  // ordinaire reprend tout son rôle.
  const settled = titlesOf(buildG({
    activatedAt: Date.now() - 10 * 60 * 1000,
    openSessionIds: () => new Set(['g1']),
  }));
  check('grâce écoulée : on revient au jugement ordinaire (par les libellés)',
    JSON.stringify(settled) === JSON.stringify(noGrace), JSON.stringify(settled));
}

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
