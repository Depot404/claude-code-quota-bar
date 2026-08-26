// Banc du lot « spinner pendant une compaction » (constat user 2026-08-25,
// cf. hook-session-state.js pour le pourquoi complet) : PreCompact pose un
// marqueur `compacting`/`compact_since` sur l'entrée de sessions-state.json,
// state.js le lit pour forcer l'affichage `busy` — le spinner EXISTANT, sans
// toucher à panel.js — et PostCompact/UserPromptSubmit/Stop le lèvent.
//
// Couverture demandée : POSE (PreCompact force busy même sur une entrée
// `done`), LEVÉE par les trois voies (PostCompact, UserPromptSubmit, Stop),
// et NON-LEVÉE — le plafond de durée et la garde process-vivant, pour ne
// jamais reproduire le spinner éternel (cf. hooks/transcript.js:434-509).
//
// Les hooks tournent POUR DE VRAI (process node séparé, payload sur stdin,
// HOME bac à sable) comme test-permission-hooks.js : c'est la seule façon de
// prouver aussi que PreCompact (hook DÉCISIONNEL, exit 2 = bloque la
// compaction) reste strictement silencieux sur stdout.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-compact-'));
os.homedir = () => SANDBOX;                       // AVANT les require
fs.mkdirSync(path.join(SANDBOX, '.claude'), { recursive: true });

const state = require(path.join(__dirname, '..', 'state.js'));
const { readState } = require(path.join(__dirname, '..', 'hooks', 'sessions-state.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

const SESSION_HOOK = path.join(__dirname, '..', 'hooks', 'hook-session-state.js');
const TRACK_HOOK = path.join(__dirname, '..', 'hooks', 'track-active-session.js');
const WS = 'C:\\Users\\Test\\Projets VSCODE\\Compact';
const dir = state.projectDirFor(WS);
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'live.jsonl');
const line = (o) => JSON.stringify(o) + '\n';

fs.writeFileSync(file,
  line({ type: 'user', message: { content: 'go' } })
  + line({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000 } } })
  + line({ type: 'ai-title', aiTitle: 'Compaction en cours' }));

function runHook(script, payload) {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [script], {
      env: { ...process.env, USERPROFILE: SANDBOX, HOME: SANDBOX },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('error', rej);
    p.on('close', (code) => res({ code, out, err }));
    p.stdin.end(JSON.stringify(payload));
  });
}

const base = { session_id: 'live', cwd: WS, transcript_path: file };

(async () => {
  // `liveSessions` forcé sur cette session : la garde process-vivant du
  // marqueur (cf. state.js effectiveState) exige isLive=true, et le vrai
  // registre ~/.claude/sessions est vide dans ce bac à sable.
  const engine = state.createStateEngine({
    workspacePath: WS,
    tabs: () => ({ known: true, labels: ['Compaction en cours'] }),
    liveSessions: () => new Set(['live']),
    tickMs: 3600000, debounceMs: 10,
  });
  const conv = () => engine.getSnapshot().conversations.find((c) => c.sessionId === 'live');
  const refresh = () => engine.refresh();
  const entry = () => (readState().sessions || {}).live;

  // ── 1. État de départ : conv terminée (Stop), donc `done` ────────────────
  console.log('\n1. Départ : conversation déjà `done`');
  {
    await runHook(SESSION_HOOK, { ...base, hook_event_name: 'Stop' });
    refresh();
    check('état = done', conv() && conv().state === 'done', JSON.stringify(conv()));
  }

  // ── 2. POSE : PreCompact force `busy`, même sur une entrée `done` ────────
  console.log('\n2. PreCompact — pose du marqueur, force busy par-dessus `done`');
  {
    const r = await runHook(SESSION_HOOK, { ...base, hook_event_name: 'PreCompact', trigger: 'auto' });
    refresh();
    check('exit 0', r.code === 0, `code ${r.code} err=${r.err}`);
    // Non négociable : PreCompact peut BLOQUER la compaction (exit 2 = deny) —
    // le moindre octet sur stdout serait interprété comme une décision.
    check('stdout VIDE (le hook ne bloque jamais la compaction)', r.out === '', JSON.stringify(r.out));
    check('marqueur posé : compacting=true', entry().compacting === true, JSON.stringify(entry()));
    check('… et daté', typeof entry().compact_since === 'number');
    check('`state` de l\'entrée INCHANGÉ (reste done, pas écrasé)', entry().state === 'done', JSON.stringify(entry()));
    check('affichage forcé à busy MALGRÉ state=done', conv() && conv().state === 'busy', JSON.stringify(conv()));
  }

  // ── 3. LEVÉE #1 : PostCompact — retour à l'état réel, marqueur effacé ────
  console.log('\n3. PostCompact — lève le marqueur, l\'affichage retrouve `done`');
  {
    const r = await runHook(SESSION_HOOK, { ...base, hook_event_name: 'PostCompact', trigger: 'auto' });
    refresh();
    check('exit 0', r.code === 0, `code ${r.code}`);
    check('marqueur effacé : compacting absent', !('compacting' in entry()), JSON.stringify(entry()));
    check('compact_since absent', !('compact_since' in entry()), JSON.stringify(entry()));
    check('affichage revenu à done (state jamais touché)', conv() && conv().state === 'done', JSON.stringify(conv()));
  }

  // ── 4. LEVÉE #2 : PostCompact jamais tiré → UserPromptSubmit lève quand même
  console.log('\n4. PreCompact SANS PostCompact, puis un nouveau prompt — filet UserPromptSubmit');
  {
    await runHook(SESSION_HOOK, { ...base, hook_event_name: 'PreCompact', trigger: 'manual' });
    refresh();
    check('marqueur reposé', entry().compacting === true, JSON.stringify(entry()));

    const r = await runHook(TRACK_HOOK, { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'continue' });
    refresh();
    check('exit 0', r.code === 0, `code ${r.code} err=${r.err}`);
    check('marqueur levé par UserPromptSubmit', !('compacting' in entry()), JSON.stringify(entry()));
    check('… et par construction, la conv est busy (nouveau prompt)', conv() && conv().state === 'busy', JSON.stringify(conv()));
  }

  // ── 5. LEVÉE #3 : PostCompact jamais tiré → Stop lève quand même ─────────
  console.log('\n5. PreCompact SANS PostCompact, puis Stop — filet Stop');
  {
    await runHook(SESSION_HOOK, { ...base, hook_event_name: 'PreCompact', trigger: 'auto' });
    refresh();
    check('marqueur reposé', entry().compacting === true, JSON.stringify(entry()));

    await runHook(SESSION_HOOK, { ...base, hook_event_name: 'Stop' });
    refresh();
    check('marqueur levé par Stop', !('compacting' in entry()), JSON.stringify(entry()));
    check('… état retombe sur done', conv() && conv().state === 'done', JSON.stringify(conv()));
  }

  engine.dispose();

  // ── 6. NON-LEVÉE : ni PostCompact, ni UserPromptSubmit, ni Stop ──────────
  // Les deux gardes qui empêchent le spinner ÉTERNEL quand aucun des trois
  // filets ci-dessus ne joue (CLI tué en plein milieu de la compaction).
  // Vérifiées ICI en appelant `effectiveState` directement (fonction pure
  // exportée) : simuler un vrai dépassement de COMPACTING_CAP_MS (10 min) par
  // un sleep réel serait à la fois lent et redondant avec ce que prouve déjà
  // la section 2 (le mécanisme d'activation) — cf. test-permission-hooks.js
  // §5, même méthode pour `isWaitingNotification`.
  console.log('\n6. Non-levée : plafond de durée + garde process-mort (fonction pure)');
  {
    const NOW = 2_000_000_000_000; // horodatage fixe, arbitraire
    const CAP_MS = 10 * 60 * 1000; // doit rester en phase avec COMPACTING_CAP_MS (state.js)

    const withinCapLive = { state: 'done', since: NOW - 500000, compacting: true, compact_since: NOW - 1000 };
    check('témoin : dans le plafond + process vivant → busy forcé',
      state.effectiveState(withinCapLive, NOW - 1000, NOW, true) === 'busy');

    const pastCap = { state: 'done', since: NOW - 500000, compacting: true, compact_since: NOW - CAP_MS - 1000 };
    check('plafond dépassé → retombe sur l\'état réel (done), plus de spinner forcé',
      state.effectiveState(pastCap, NOW - 500000, NOW, true) === 'done');

    const deadProcess = { state: 'busy', since: NOW - 500000, compacting: true, compact_since: NOW - 1000 };
    // Process mort ET transcript muet depuis plus de STALE_MS : sans la garde
    // isLive, ce serait un `busy` forcé pour toujours (PostCompact ne tirera
    // jamais sur un CLI mort) ; avec la garde, l'entrée retombe sur son état
    // réel — ici `stale`, comme n'importe quel `busy` muet sans process vivant.
    check('process MORT (isLive=false) → le marqueur n\'est pas cru, comportement normal (stale)',
      state.effectiveState(deadProcess, NOW - 10 * 60 * 1000, NOW, false) === 'stale');

    const noCompactSince = { state: 'done', since: NOW - 500000, compacting: true };
    check('compacting=true sans compact_since (payload incomplet) → ignoré, pas de crash',
      state.effectiveState(noCompactSince, NOW - 500000, NOW, true) === 'done');
  }

  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
