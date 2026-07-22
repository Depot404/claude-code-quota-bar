// Banc du lot 6 : dérivation d'état (6b/6d) + accusé de lecture (6a).
// Le module `vscode` est bouchonné et HOME est un bac à sable → aucune fenêtre
// ni aucun fichier réel n'est touché.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-ack-'));
os.homedir = () => SANDBOX;                       // AVANT les require
fs.mkdirSync(path.join(SANDBOX, '.claude'), { recursive: true });

// ── Bouchon vscode : onglets + focus de fenêtre pilotables ────────────────
let ACTIVE_TAB = null;      // onglet actif du groupe actif
let FOCUSED = true;         // la fenêtre a-t-elle le focus
const listeners = { tabs: [], groups: [], window: [] };
const emit = (k) => listeners[k].forEach((cb) => cb({}));
const sub = (k) => (cb) => { listeners[k].push(cb); return { dispose() {} }; };
const stub = {
  window: {
    get state() { return { focused: FOCUSED }; },
    onDidChangeWindowState: sub('window'),
    tabGroups: {
      get activeTabGroup() { return { activeTab: ACTIVE_TAB }; },
      get all() { return [{ viewColumn: 1, isActive: true, tabs: ACTIVE_TAB ? [ACTIVE_TAB] : [] }]; },
      onDidChangeTabs: sub('tabs'),
      onDidChangeTabGroups: sub('groups'),
    },
  },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'vscode') return stub;
  return origLoad.call(this, req, ...rest);
};

const state = require(path.join(__dirname, '..', 'state.js'));
const { createAckTracker } = require(path.join(__dirname, '..', 'ack.js'));
const { updateSession, readState } = require(path.join(__dirname, '..', 'hooks', 'sessions-state.js'));
const { labelMatches } = require(path.join(__dirname, '..', 'labels.js'));

const claudeTab = (label) => ({ label, input: { viewType: 'mainThreadWebview-claudeVSCodePanel' } });
const fileTab = (label) => ({ label, input: { viewType: 'default' } });

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN = 60 * 1000;

// ── 1. Dérivation d'état : le ✓ n'expire plus, et ne ment plus (6b.1 + 6d) ─
console.log('\n1. État dérivé : fin du fade 30 min (6b.1) et done pendant le travail (6d)');
{
  const now = Date.now();
  const done = (since, extra = {}) => ({ state: 'done', since, updated_at: since, ...extra });

  check('done tout frais → done',
    state.effectiveState(done(now - 5000), now - 5000, now) === 'done');
  check('done vieux de 45 min SANS lecture → toujours done (le fade 30 min est mort)',
    state.effectiveState(done(now - 45 * MIN), now - 45 * MIN, now) === 'done',
    state.effectiveState(done(now - 45 * MIN), now - 45 * MIN, now));
  check('done vieux de 3 h → toujours done (seul recentMs sort la conv du panneau)',
    state.effectiveState(done(now - 180 * MIN), now - 180 * MIN, now) === 'done');

  // 6d — Stop hook à feedback : le hook a dit « done », le transcript continue.
  const stopAt = now - 30 * 1000;
  check('done + le transcript écrit ENCORE, après le Stop → busy (Stop hook à feedback)',
    state.effectiveState(done(stopAt), now - 1000, now) === 'busy',
    state.effectiveState(done(stopAt), now - 1000, now));
  check('anti-rebond : dernier message du tour écrit 1 s après le Stop → reste done',
    state.effectiveState(done(stopAt), stopAt + 1000, now) === 'done',
    state.effectiveState(done(stopAt), stopAt + 1000, now));
  check('anti-rebond : écriture 3 s après le Stop mais plus rien depuis 20 min → done, PAS stale',
    state.effectiveState(done(now - 20 * MIN), now - 20 * MIN + 3000, now) === 'done',
    state.effectiveState(done(now - 20 * MIN), now - 20 * MIN + 3000, now));
  check('busy dont le transcript est muet depuis 10 min → stale (zombie, lot 2 intact)',
    state.effectiveState({ state: 'busy', since: now - 10 * MIN }, now - 10 * MIN, now) === 'stale');
  check('waiting : reprise après permission → busy (lot 2 intact)',
    state.effectiveState({ state: 'waiting', since: now - 60000 }, now - 1000, now) === 'busy');
}

// ── 2. Non-lu / lu (6a.2, 6b.2) ───────────────────────────────────────────
console.log('\n2. Règle « lu » (isAcked)');
{
  const now = Date.now();
  check('done sans ack → NON lu (✓ vif)',
    state.isAcked({ state: 'done', since: now }) === false);
  check('done avec ack postérieur → lu (✓ atténué)',
    state.isAcked({ state: 'done', since: now - 5000, ack_ts: now }) === true);
  check('nouveau Stop après une lecture → redevient NON lu, sans rien effacer',
    state.isAcked({ state: 'done', since: now, ack_ts: now - 5000 }) === false);
  check('conv sans état hooks (pré-lot 2) → rien à relire (✓ atténué)',
    state.isAcked(null) === true);
  check('conv busy → pas concernée',
    state.isAcked({ state: 'busy', since: now }) === true);
}

// ── 3. Le dwell (6a.1) ────────────────────────────────────────────────────
console.log('\n3. Consultation = onglet actif + fenêtre focus, tenu ~2 s');
async function dwellTests() {
  const dwelt = [];
  ACTIVE_TAB = null; FOCUSED = true;
  const tracker = createAckTracker({ dwellMs: 120, onDwell: (l) => dwelt.push(l) });

  check('aucun onglet Claude actif → rien à acquitter', tracker.dwellLabel() === null);

  ACTIVE_TAB = claudeTab('Lot 6 deux teintes du c…'); emit('tabs');
  check('juste arrivé sur l\'onglet → pas encore lu (le dwell court)', tracker.dwellLabel() === null);
  await sleep(200);
  check('après le dwell → lu', tracker.dwellLabel() === 'Lot 6 deux teintes du c…', tracker.dwellLabel());
  check('… et onDwell a prévenu une fois', dwelt.length === 1 && dwelt[0] === 'Lot 6 deux teintes du c…',
    JSON.stringify(dwelt));

  // Ctrl+Tab qui traverse : deux bascules rapides, aucune ne doit compter.
  ACTIVE_TAB = claudeTab('Refonte du digest ma…'); emit('tabs');
  await sleep(40);
  ACTIVE_TAB = claudeTab('Watchdog Jeedom Z-W…'); emit('tabs');
  await sleep(40);
  check('Ctrl+Tab au travers → aucun des onglets traversés n\'est acquitté',
    dwelt.length === 1, JSON.stringify(dwelt));
  ACTIVE_TAB = claudeTab('Lot 6 deux teintes du c…'); emit('tabs');
  await sleep(200);

  // Fenêtre en arrière-plan : l'onglet est affiché, pas consulté.
  FOCUSED = false; emit('window');
  check('fenêtre sans focus → l\'onglet affiché ne compte pas comme lu',
    tracker.dwellLabel() === null);
  FOCUSED = true; emit('window');
  check('retour du focus → il faut re-tenir le dwell', tracker.dwellLabel() === null);
  await sleep(200);
  check('… puis c\'est lu', tracker.dwellLabel() === 'Lot 6 deux teintes du c…');

  // Un onglet non-Claude actif n'acquitte rien.
  ACTIVE_TAB = fileTab('README.md'); emit('tabs');
  await sleep(200);
  check('onglet de fichier actif → rien à acquitter', tracker.dwellLabel() === null);

  // Événement sans changement : ne doit PAS réarmer le compteur.
  ACTIVE_TAB = claudeTab('Lot 6 deux teintes du c…'); emit('tabs');
  await sleep(200);
  emit('tabs'); emit('window'); emit('groups');
  check('un événement qui ne change rien ne remet pas le dwell à zéro',
    tracker.dwellLabel() === 'Lot 6 deux teintes du c…');

  // Re-titrage de l'onglet ACTIF par l'extension officielle (`rename_tab` en fin
  // de tour) : même onglet, libellé neuf. Le séjour doit survivre tel quel — un
  // séjour qui renaît ici est un accusé de lecture fabriqué par l'outil.
  const stayBefore = tracker.dwellSince();
  ACTIVE_TAB.label = 'Lot 6 deux teintes du ch…';
  emit('tabs');
  check('rename de l\'onglet actif → le séjour n\'est PAS redémarré',
    tracker.dwellSince() === stayBefore, `${tracker.dwellSince()} vs ${stayBefore}`);
  check('… et le libellé suivi est bien le nouveau',
    tracker.stayLabel() === 'Lot 6 deux teintes du ch…', tracker.stayLabel());
  check('… le dwell reste acquis, sans attendre à nouveau',
    tracker.dwellLabel() === 'Lot 6 deux teintes du ch…', tracker.dwellLabel());

  // Un VRAI changement d'onglet, lui, redémarre bien le séjour.
  ACTIVE_TAB = claudeTab('Refonte du digest ma…'); emit('tabs');
  check('changement d\'onglet réel → nouveau séjour', tracker.dwellSince() > stayBefore
    && tracker.dwellLabel() === null, `${tracker.dwellSince()} vs ${stayBefore}`);

  tracker.dispose();
  check('après dispose → plus de séjour suivi', tracker.stayLabel() === null);
  check('après dispose → plus rien n\'est acquitté', tracker.dwellLabel() === null);
}

// ── 4. Bout en bout : le ✓ vif s'éteint quand on lit, se rallume au Stop ──
console.log('\n4. Bout en bout : snapshot ↔ ack, sur de vrais fichiers');
async function e2eTests() {
  const WS = 'C:\\Users\\Test\\Projets VSCODE\\Demo';
  const dir = state.projectDirFor(WS);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'sess.jsonl');
  const line = (o) => JSON.stringify(o) + '\n';
  fs.writeFileSync(file,
    line({ type: 'user', message: { content: 'go' } })
    + line({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000 } } })
    + line({ type: 'ai-title', aiTitle: 'Lot 6 deux teintes du check' }));

  // Stop : la conv est terminée, jamais relue.
  updateSession('sess', { state: 'done', transcript: file });

  ACTIVE_TAB = null; FOCUSED = true;
  const tracker = createAckTracker({ dwellMs: 120, onDwell: () => ack() });
  const engine = state.createStateEngine({
    workspacePath: WS, tabs: () => ({ known: true, labels: ['Lot 6 deux teintes du c…'] }),
    tickMs: 3600000, debounceMs: 10,
  });
  // Réplique fidèle du câblage d'extension.js (ackConversations +
  // ackConversationById) : lot 10 — ack strict, le séjour ne compte comme acte
  // observé que s'il a commencé APRÈS busySince du run qui vient de finir ; et
  // correctif 2026-07-22 — le seuil de séjour court à partir de la FIN du tour
  // (`since`), avec re-check programmé quand il n'est pas encore atteint.
  const ACK_DWELL = 120;
  let recheck = null;
  function ack() {
    clearTimeout(recheck);
    recheck = null;
    const label = tracker.stayLabel();
    if (!label) return;
    const dwellSince = tracker.dwellSince();
    const now = Date.now();
    let soonest = Infinity;
    for (const c of engine.getSnapshot().conversations) {
      if (c.state !== 'done' || c.acked) continue;
      if (!labelMatches(label, c.title)) continue;
      if (c.busySince != null && dwellSince != null && dwellSince <= c.busySince) continue;
      const watchedSince = Math.max(dwellSince || 0, c.since || 0);
      const remaining = ACK_DWELL - (now - watchedSince);
      if (remaining > 0) { soonest = Math.min(soonest, remaining); continue; }
      updateSession(c.sessionId, { ack_ts: Date.now() });
    }
    if (soonest !== Infinity) recheck = setTimeout(() => { recheck = null; ack(); }, soonest + 20);
  }
  function ackById(id) {
    const c = engine.getSnapshot().conversations.find((x) => x.sessionId === id);
    if (!c || c.state !== 'done' || c.acked) return;
    updateSession(id, { ack_ts: Date.now() });
  }
  const conv = () => engine.getSnapshot().conversations.find((c) => c.sessionId === 'sess');

  check('conv terminée jamais lue → ✓ vif', conv() && conv().state === 'done' && conv().acked === false,
    JSON.stringify(conv()));

  // L'utilisateur va lire le résultat.
  ACTIVE_TAB = claudeTab('Lot 6 deux teintes du c…'); emit('tabs');
  await sleep(220);
  engine.refresh();
  check('après consultation de l\'onglet → ✓ atténué', conv().acked === true, JSON.stringify(conv()));
  check('ack_ts est bien persisté dans sessions-state.json (survit à un restart)',
    typeof readState().sessions.sess.ack_ts === 'number', JSON.stringify(readState().sessions.sess));
  check('l\'ack n\'a pas écrasé l\'état posé par le hook',
    readState().sessions.sess.state === 'done' && readState().sessions.sess.transcript === file);

  // CAS DE L'INCIDENT (lot 10, 2026-07-15, conv « Déboguer tbid 44220 ») :
  // l'onglet est DÉJÀ actif depuis AVANT le lancement du run — le dwell est
  // tenu, mais aucun acte observé ne s'est produit pendant que ça travaillait.
  await sleep(5);
  const busyBeforeTs = Date.now();
  updateSession('sess', { state: 'busy', busy_since: busyBeforeTs });
  engine.refresh();
  check('nouveau tour : la conv repasse busy', conv().state === 'busy', JSON.stringify(conv()));
  updateSession('sess', { state: 'done' });
  engine.refresh();
  check('Stop alors que l\'onglet est déjà actif → d\'abord vif (rien ne l\'a encore lu)',
    conv().state === 'done' && conv().acked === false, JSON.stringify(conv()));
  check('busySince bien exposé et antérieur au dwell en cours',
    conv().busySince === busyBeforeTs && tracker.dwellSince() < busyBeforeTs,
    `busySince=${conv().busySince} dwellSince=${tracker.dwellSince()}`);
  ack();                                    // ce que fait onChange dans extension.js
  engine.refresh();
  check('CAS DE L\'INCIDENT REJOUÉ : dwell antérieur au démarrage du run → PAS d\'ack',
    conv().acked === false, JSON.stringify(conv()));

  // Arrivée sur l'onglet PENDANT le run (après busy_since) → l'acte est observé,
  // le ✓ s'éteint dès le done qui suit.
  ACTIVE_TAB = null; emit('tabs');
  await sleep(150);                         // laisse le séjour précédent expirer
  const busyDuringTs = Date.now();
  updateSession('sess', { state: 'busy', busy_since: busyDuringTs });
  engine.refresh();
  await sleep(30);
  ACTIVE_TAB = claudeTab('Lot 6 deux teintes du c…'); emit('tabs');   // arrivée mid-run
  await sleep(150);                         // dwell tenu AVANT même le done
  updateSession('sess', { state: 'done' });
  engine.refresh();
  check('arrivée mi-run, après busySince', tracker.dwellSince() > busyDuringTs,
    `dwellSince=${tracker.dwellSince()} busySince=${busyDuringTs}`);
  ack();
  engine.refresh();
  check('le done tout juste arrivé ne s\'acquitte PAS instantanément (seuil postérieur au résultat)',
    conv().acked === false, JSON.stringify(conv()));
  await sleep(ACK_DWELL + 80);              // le re-check programmé fait le travail
  engine.refresh();
  check('arrivée sur l\'onglet PENDANT le run, tenue jusqu\'au done PUIS le seuil → ack',
    conv().acked === true, JSON.stringify(conv()));

  // Clic panneau (lot 10, point 1c) : même incident (onglet actif depuis avant
  // le run), mais cette fois un CLIC explicite doit acquitter quand même — la
  // seule porte de sortie du mono-onglet.
  await sleep(5);
  updateSession('sess', { state: 'busy', busy_since: Date.now() });
  engine.refresh();
  updateSession('sess', { state: 'done' });
  engine.refresh();
  ack();
  check('même incident (onglet déjà actif) → toujours pas d\'ack automatique',
    conv().acked === false, JSON.stringify(conv()));
  ackById('sess');
  engine.refresh();
  check('… mais le clic sur la ligne acquitte, même onglet déjà actif',
    conv().acked === true, JSON.stringify(conv()));

  // CAS DE L'INCIDENT 2026-07-22 (signalé plusieurs fois : « le ✓ vif passe pâle
  // tout seul au bout de quelques secondes, sans que j'aie regardé l'onglet »).
  // L'onglet est actif depuis AVANT le run — la garde du lot 10 doit bloquer.
  // Puis, à la fin du tour, l'extension Claude officielle réécrit l'onglet
  // (`rename_tab` : title réaffecté + iconPath → claude-logo-done.svg). Avant le
  // correctif, cette réécriture fabriquait un séjour tout neuf, postérieur à
  // busySince, qui BLANCHISSAIT la garde du lot 10 → ack ~2 s après le done.
  await sleep(5);
  ACTIVE_TAB = null; emit('tabs');
  await sleep(ACK_DWELL + 30);
  ACTIVE_TAB = claudeTab('Lot 6 deux teintes du c…'); emit('tabs');
  await sleep(ACK_DWELL + 30);              // séjour bien établi AVANT le run
  const busyBeforeRename = Date.now();
  updateSession('sess', { state: 'busy', busy_since: busyBeforeRename });
  engine.refresh();
  await sleep(10);
  updateSession('sess', { state: 'done' });
  engine.refresh();
  ack();
  check('rename : ✓ vif au moment du done (séjour antérieur au run)',
    conv().acked === false, JSON.stringify(conv()));
  // La réécriture de l'onglet par l'extension officielle : MÊME objet Tab, seuls
  // le libellé et l'icône changent.
  ACTIVE_TAB.label = 'Lot 6 deux teintes du ch…';
  emit('tabs');
  check('le rename ne redémarre pas le séjour (dwellSince reste antérieur au run)',
    tracker.dwellSince() < busyBeforeRename,
    `dwellSince=${tracker.dwellSince()} busySince=${busyBeforeRename}`);
  await sleep(ACK_DWELL + 80);
  engine.refresh();
  check('INCIDENT REJOUÉ : rename_tab de fin de tour → toujours PAS d\'ack automatique',
    conv().acked === false, JSON.stringify(conv()));

  // Réarmement automatique : un nouveau Stop doit redonner un ✓ vif.
  await sleep(5);
  updateSession('sess', { state: 'busy', busy_since: Date.now() });
  updateSession('sess', { state: 'done' });
  engine.refresh();
  check('nouveau Stop sur une conv déjà lue → le ✓ redevient vif tout seul',
    conv().acked === false, JSON.stringify(conv()));

  // Multi-fenêtres : l'ack posé « ailleurs » (autre process → même fichier).
  updateSession('sess', { ack_ts: Date.now() });
  engine.refresh();
  check('ack posé par une AUTRE fenêtre → propagé ici (fichier partagé, déjà watché)',
    conv().acked === true, JSON.stringify(conv()));

  // Une conv sans entrée d'état n'a rien à relire.
  const file2 = path.join(dir, 'plain.jsonl');
  fs.writeFileSync(file2, line({ type: 'user', message: { content: 'vieille conv' } })
    + line({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 10 } } }));
  engine.refresh();
  const plain = engine.getSnapshot().conversations.find((c) => c.sessionId === 'plain');
  check('conv sans état hooks → idle + acked (✓ atténué, jamais de pastille grise)',
    plain && plain.state === 'idle' && plain.acked === true, JSON.stringify(plain));

  clearTimeout(recheck);
  tracker.dispose();
  engine.dispose();
}

// ── 5. Le bruit qui cassait le spinner (6c) ──────────────────────────────
console.log('\n5. Bruit de rendu : mtime seul ne doit plus réveiller le panneau');
async function noiseTests() {
  const WS = 'C:\\Users\\Test\\Projets VSCODE\\Noise';
  const dir = state.projectDirFor(WS);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'run.jsonl');
  const line = (o) => JSON.stringify(o) + '\n';
  fs.writeFileSync(file, line({ type: 'user', message: { content: 'go' } })
    + line({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000 } } })
    + line({ type: 'ai-title', aiTitle: 'Conv au travail' }));
  updateSession('run', { state: 'busy', transcript: file });

  let pushes = 0;
  const engine = state.createStateEngine({
    workspacePath: WS, tabs: () => ({ known: true, labels: ['Conv au travail'] }),
    tickMs: 3600000, debounceMs: 10, onChange: () => { pushes++; },
  });
  check('la conv travaille', engine.getSnapshot().conversations[0].state === 'busy');

  // 6 lignes écrites : le transcript bouge, le RENDU est identique.
  for (let i = 0; i < 6; i++) {
    fs.appendFileSync(file, line({ type: 'tool_use', n: i }));
    engine.refresh();
  }
  check('6 écritures transcript sans effet visible → 0 re-rendu (le spinner garde sa rotation)',
    pushes === 0, String(pushes));

  // Un vrai changement visible, lui, doit passer.
  fs.appendFileSync(file, line({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 90000 } } }));
  engine.refresh();
  check('ctx% qui bouge → le panneau est bien notifié', pushes === 1, String(pushes));

  engine.dispose();
}

// ── 6. Le VRAI hook Stop, dans un vrai process (6d) ──────────────────────
// Les tests ci-dessus prouvent la règle ; celui-ci prouve la chaîne complète —
// le hook tel que Claude Code l'exécute (payload sur stdin, HOME du sandbox),
// puis le moteur qui relit son écriture. C'est le scénario que le plan décrit :
// un Stop hook à feedback relance Claude, donc `Stop` tire alors que le tour
// continue.
console.log('\n6. Chaîne réelle : hook Stop exécuté pour de vrai, tour qui continue');
async function realHookTests() {
  const { spawn } = require('child_process');
  const WS = 'C:\\Users\\Test\\Projets VSCODE\\Hook';
  const dir = state.projectDirFor(WS);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'live.jsonl');
  const line = (o) => JSON.stringify(o) + '\n';
  fs.writeFileSync(file, line({ type: 'user', message: { content: 'go' } })
    + line({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000 } } })
    + line({ type: 'ai-title', aiTitle: 'Tour qui continue après le Stop' }));

  // Le hook tourne dans SON process : c'est USERPROFILE qui lui donne le HOME.
  function runHook(payload) {
    return new Promise((res, rej) => {
      const p = spawn(process.execPath, [path.join(__dirname, '..', 'hooks', 'hook-session-state.js')], {
        env: { ...process.env, USERPROFILE: SANDBOX, HOME: SANDBOX },
        stdio: ['pipe', 'ignore', 'inherit'],
      });
      p.on('error', rej);
      p.on('close', (code) => (code === 0 ? res() : rej(new Error('hook exit ' + code))));
      p.stdin.end(JSON.stringify(payload));
    });
  }

  const engine = state.createStateEngine({
    workspacePath: WS, tabs: () => ({ known: true, labels: ['Tour qui continue aprè…'] }),
    tickMs: 3600000, debounceMs: 10,
  });
  const conv = () => engine.getSnapshot().conversations.find((c) => c.sessionId === 'live');

  await runHook({ hook_event_name: 'Stop', session_id: 'live', cwd: WS, transcript_path: file });
  engine.refresh();
  check('le vrai hook Stop a bien posé done', conv() && conv().state === 'done', JSON.stringify(conv()));
  check('… et le ✓ est vif (personne ne l\'a lu)', conv().acked === false);

  // Le Stop hook a renvoyé un feedback : Claude repart, le transcript reprend.
  await sleep(2100);                       // au-delà de l'anti-rebond (~2 s)
  fs.appendFileSync(file, line({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1200 } } }));
  engine.refresh();
  check('écriture postérieure au Stop → la conv redevient busy (le ✓ mentait)',
    conv().state === 'busy', JSON.stringify(conv()));

  // Fin réelle du tour : nouveau Stop, le dernier message est tout proche.
  await runHook({ hook_event_name: 'Stop', session_id: 'live', cwd: WS, transcript_path: file });
  fs.appendFileSync(file, line({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1300 } } }));
  engine.refresh();
  check('vrai Stop final → done, et l\'anti-rebond ne le renvoie pas en busy',
    conv().state === 'done', JSON.stringify(conv()));
  await sleep(300);
  engine.refresh();
  check('… et ça tient (pas de clignotement done/busy)', conv().state === 'done', JSON.stringify(conv()));

  // Le ✓ doit se rallumer : il y a du neuf depuis la dernière lecture.
  updateSession('live', { ack_ts: Date.now() });
  engine.refresh();
  check('lu → ✓ atténué', conv().acked === true, JSON.stringify(conv()));
  await sleep(5);
  await runHook({ hook_event_name: 'Stop', session_id: 'live', cwd: WS, transcript_path: file });
  engine.refresh();
  check('nouveau Stop RÉEL après lecture → le ✓ se rallume (2 done d\'affilée)',
    conv().acked === false, JSON.stringify(conv()));

  // Le frère du même bug : deux permissions d'affilée.
  await runHook({
    hook_event_name: 'Notification', session_id: 'live', cwd: WS, transcript_path: file,
    notification_type: 'permission_prompt', message: 'Autoriser Bash ?',
  });
  engine.refresh();
  check('1re permission → waiting', conv().state === 'waiting', JSON.stringify(conv()));
  // Permission accordée : Claude reprend et écrit.
  await sleep(2100);
  fs.appendFileSync(file, line({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1400 } } }));
  engine.refresh();
  check('permission accordée, le transcript reprend → busy (lot 2)', conv().state === 'busy', JSON.stringify(conv()));
  // 2e permission : sans réarmement de `since`, l'écriture ci-dessus la ferait
  // passer pour une reprise et la conv « travaillerait » en attendant l'user.
  await runHook({
    hook_event_name: 'Notification', session_id: 'live', cwd: WS, transcript_path: file,
    notification_type: 'permission_prompt', message: 'Autoriser Write ?',
  });
  engine.refresh();
  check('2e permission d\'affilée → waiting, PAS busy (même bug que 6d, chassé)',
    conv().state === 'waiting', JSON.stringify(conv()));
  check('… et le panneau affiche la bonne question', conv().message === 'Autoriser Write ?', JSON.stringify(conv()));

  engine.dispose();
}

(async () => {
  await dwellTests();
  await e2eTests();
  await noiseTests();
  await realHookTests();
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
