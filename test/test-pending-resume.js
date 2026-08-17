// Banc : « fin de tour » ≠ « tâche finie » (incident vagues 2026-08-17).
// Batch SNCF réel : le lot 1 délègue à un agent de fond et termine son tour à
// 13:37:50 → le moteur de vagues lit « done » et ouvre la vague 2 à 13:37:55,
// alors que le lot reprend à 13:39:23 (task-notification) et ne finit qu'à
// 13:47:41. Même trou côté hook Stop à feedback : `done` posé à 13:48:38,
// tour relancé par doc-commit-reminder (exit 2), vague 3 ouverte dans la
// fenêtre de ~4 s avant la première écriture de reprise.
// Deux verrous, testés ici :
//  1. pendingResumeSignals (transcript.js) + effectiveState (state.js) : une
//     conv `done` VIVANTE qui va reprendre toute seule (tâche de fond sans
//     notification, réveil programmé futur) est corrigée en `busy` ;
//  2. advanceGate (waves.js) : plus de lancement sur lecture instantanée — la
//     vague doit rester prête WAVE_STABLE_MS d'affilée, toute rechute désarme.
const fs = require('fs');
const os = require('os');
const path = require('path');

const { pendingResumeSignals } = require(path.join(__dirname, '..', 'hooks', 'transcript.js'));
const { effectiveState, createTranscriptReader } = require(path.join(__dirname, '..', 'state.js'));
const { advanceGate, WAVE_STABLE_MS } = require(path.join(__dirname, '..', 'waves.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-pending-'));
const write = (name, lines) => {
  const p = path.join(SANDBOX, name);
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
};
const iso = (ms) => new Date(ms).toISOString();
const NOW = Date.now();
const T0 = NOW - 300 * 1000;

// Formes RELEVÉES sur transcripts réels (CLI 2.1.233, 2026-08-17) — ne pas
// « simplifier » : c'est exactement ce que la détection doit reconnaître.
const agentLaunch = (toolUseId, agentId, ms) => ({
  type: 'user', timestamp: iso(ms),
  message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content: [{ type: 'text', text: `Async agent launched successfully. (This tool result is internal metadata)\nagentId: ${agentId} (internal ID - do not mention to user.)\nThe agent is working in the background.` }] }] },
  toolUseResult: { status: 'async_launched' },
});
const bashLaunch = (toolUseId, bashId, ms) => ({
  type: 'user', timestamp: iso(ms),
  message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content: `Command running in background with ID: ${bashId}. Output is being written to: C:\\tmp\\${bashId}.output. You will be notified when it completes.` }] },
});
const taskNotif = (taskId, toolUseId, ms) => ({
  type: 'user', timestamp: iso(ms),
  message: { role: 'user', content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\nRésultat de la tâche.\n</task-notification>` },
});
const wakeup = (scheduledFor, ms) => ({
  type: 'user', timestamp: iso(ms),
  message: { role: 'user', content: [{ tool_use_id: 'toolu_wake', type: 'tool_result', content: 'Next wakeup scheduled.' }] },
  toolUseResult: { scheduledFor },
});
const assistant = (ms) => ({ type: 'assistant', timestamp: iso(ms), message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: 'ok' }] } });

console.log('\n1. pendingResumeSignals : appariement lancement ↔ notification');
{
  const p1 = write('a.jsonl', [agentLaunch('toolu_A', 'agent111', T0), assistant(T0 + 1000)]);
  const s1 = pendingResumeSignals(p1);
  check('agent lancé, aucune notification → pendingTask', !!s1 && s1.pendingTask === true, JSON.stringify(s1));

  const p2 = write('b.jsonl', [agentLaunch('toolu_A', 'agent111', T0), taskNotif('agent111', 'toolu_A', T0 + 60000)]);
  const s2 = pendingResumeSignals(p2);
  check('agent lancé + notification arrivée → plus rien en attente', !!s2 && s2.pendingTask === false, JSON.stringify(s2));

  const p3 = write('c.jsonl', [bashLaunch('toolu_B', 'b4wb778cz', T0)]);
  check('bash de fond sans notification → pendingTask', pendingResumeSignals(p3).pendingTask === true);

  const p4 = write('d.jsonl', [bashLaunch('toolu_B', 'b4wb778cz', T0), taskNotif('b4wb778cz', 'toolu_B', T0 + 5000)]);
  check('bash de fond notifié → rien en attente', pendingResumeSignals(p4).pendingTask === false);

  // Appariement par tool-use-id SEUL (task-id absent du texte de lancement —
  // robustesse si le libellé agentId change) :
  const noId = { ...agentLaunch('toolu_C', 'zzz', T0) };
  noId.message = { role: 'user', content: [{ tool_use_id: 'toolu_C', type: 'tool_result', content: [{ type: 'text', text: 'Async agent launched successfully. The agent is working in the background.' }] }] };
  const p5 = write('e.jsonl', [noId, taskNotif('whatever', 'toolu_C', T0 + 9000)]);
  check('appariement par tool-use-id quand le task-id manque', pendingResumeSignals(p5).pendingTask === false);

  const p6 = write('f.jsonl', [agentLaunch('toolu_D', 'agentD', T0), agentLaunch('toolu_E', 'agentE', T0 + 1000), taskNotif('agentD', 'toolu_D', T0 + 30000)]);
  check('2 lancements, 1 notifié → toujours pending', pendingResumeSignals(p6).pendingTask === true);

  check('fichier absent → null', pendingResumeSignals(path.join(SANDBOX, 'absent.jsonl')) === null);
}

console.log('\n1bis. Citations ≠ signaux (faux positif du 2026-08-17, jour même)');
{
  // La conv qui a CONSTRUIT la détection grep-ait des transcripts : ses
  // tool_results CONTENAIENT les libellés de lancement, en plein milieu du
  // texte — et le panneau la voyait « en attente » pour toujours.
  const quoteLaunch = {
    type: 'user', timestamp: iso(T0),
    message: { role: 'user', content: [{ tool_use_id: 'toolu_ps', type: 'tool_result', content: '=== 4b6cfdc3.jsonl ===\n{"type":"user","message":{"content":[{"type":"tool_result","content":"Command running in background with ID: b4wb778cz. Output..."}]}}' }] },
  };
  const p1 = write('q1.jsonl', [quoteLaunch]);
  check('un lancement CITÉ dans un tool_result (grep) ne crée aucune attente',
    pendingResumeSignals(p1).pendingTask === false, JSON.stringify(pendingResumeSignals(p1)));

  // L'inverse est aussi vital : une notification CITÉE ne doit pas ÉTEINDRE
  // une vraie attente (sinon retour du bug d'origine, vague ouverte trop tôt).
  const quoteNotif = {
    type: 'user', timestamp: iso(T0 + 2000),
    message: { role: 'user', content: [{ tool_use_id: 'toolu_ps2', type: 'tool_result', content: 'DERNIER USER REEL (14:24:45) : "<task-notification>\\n<task-id>agentQ</task-id>\\n<tool-use-id>toolu_Q</tool-use-id>"' }] },
  };
  const p2 = write('q2.jsonl', [agentLaunch('toolu_Q', 'agentQ', T0), quoteNotif]);
  check('une notification CITÉE dans un tool_result n\'éteint PAS une vraie attente',
    pendingResumeSignals(p2).pendingTask === true, JSON.stringify(pendingResumeSignals(p2)));

  // Une vraie notification en blocs `text` (pas string brute) reste reconnue.
  const notifBlocks = {
    type: 'user', timestamp: iso(T0 + 3000),
    message: { role: 'user', content: [{ type: 'text', text: '<task-notification>\n<task-id>agentQ</task-id>\n<tool-use-id>toolu_Q</tool-use-id>\n</task-notification>' }] },
  };
  const p3 = write('q3.jsonl', [agentLaunch('toolu_Q', 'agentQ', T0), notifBlocks]);
  check('une vraie notification en blocs text éteint l\'attente', pendingResumeSignals(p3).pendingTask === false);
}

console.log('\n2. pendingResumeSignals : réveils programmés (ScheduleWakeup)');
{
  const future = NOW + 600 * 1000;
  const p1 = write('g.jsonl', [wakeup(future, T0)]);
  check('dernier réveil dans le futur → wakeupAt le porte', pendingResumeSignals(p1).wakeupAt === future);

  const p2 = write('h.jsonl', [wakeup(NOW - 60000, T0)]);
  check('réveil passé → wakeupAt passé (l\'appelant le juge inoffensif)', pendingResumeSignals(p2).wakeupAt === NOW - 60000);

  const p3 = write('i.jsonl', [wakeup(NOW - 60000, T0), wakeup(future, T0 + 1000)]);
  check('c\'est le DERNIER réveil qui compte', pendingResumeSignals(p3).wakeupAt === future);

  // Fin de /loop : `stop: true` rend {scheduledFor: 0, stopped: true} (forme
  // réelle) et ANNULE les réveils armés — plus rien à attendre.
  const stop = {
    type: 'user', timestamp: iso(T0 + 2000),
    message: { role: 'user', content: [{ tool_use_id: 'toolu_stop', type: 'tool_result', content: 'Loop stopped — cancelled 1 pending wakeup(s).' }] },
    toolUseResult: { scheduledFor: 0, clampedDelaySeconds: 0, wasClamped: false, stopped: true, cancelledWakeups: 1 },
  };
  const p4 = write('i2.jsonl', [wakeup(future, T0), stop]);
  check('un stop de boucle annule le réveil armé', pendingResumeSignals(p4).wakeupAt === null, JSON.stringify(pendingResumeSignals(p4)));
}

console.log('\n3. effectiveState : done + reprise autonome à venir = busy (si vivante)');
{
  const entry = { state: 'done', since: T0 };
  const pending = () => ({ pendingTask: true, wakeupAt: null });
  const clean = () => ({ pendingTask: false, wakeupAt: null });
  const sleeping = () => ({ pendingTask: false, wakeupAt: NOW + 120000 });
  const fired = () => ({ pendingTask: false, wakeupAt: NOW - 120000 });

  check('done + tâche de fond en attente + VIVANTE → busy', effectiveState(entry, T0, NOW, true, T0, pending) === 'busy');
  check('done + réveil programmé futur + VIVANTE → busy', effectiveState(entry, T0, NOW, true, T0, sleeping) === 'busy');
  check('done + réveil déjà tiré → reste done', effectiveState(entry, T0, NOW, true, T0, fired) === 'done');
  check('done + rien en attente → reste done', effectiveState(entry, T0, NOW, true, T0, clean) === 'done');
  check('done + tâche en attente mais session MORTE → done (la notification n\'arrivera jamais, on ne gèle pas la vague)',
    effectiveState(entry, T0, NOW, false, T0, pending) === 'done');
  check('sans thunk (banc, reader nu) → comportement d\'avant', effectiveState(entry, T0, NOW, true, T0) === 'done');

  // Le thunk ne doit PAS être tiré quand isResuming a déjà tranché (perf : pas
  // de scan 4 Mo pendant qu'une conv écrit).
  let called = 0;
  const spy = () => { called++; return { pendingTask: true, wakeupAt: null }; };
  const v = effectiveState(entry, NOW, NOW, true, NOW - 1000, spy);
  check('reprise déjà détectée par isResuming → busy sans consulter le scan', v === 'busy' && called === 0, `state=${v} called=${called}`);
}

console.log('\n4. Lecteur : resumeSignals caché par (mtime, size)');
{
  const reader = createTranscriptReader();
  const p = write('j.jsonl', [agentLaunch('toolu_X', 'agentX', T0)]);
  const s1 = reader.resumeSignals(p);
  const s2 = reader.resumeSignals(p);
  check('même fichier intact → même objet (cache hit)', s1 === s2);
  check('valeur correcte au passage', !!s1 && s1.pendingTask === true);
  fs.appendFileSync(p, JSON.stringify(taskNotif('agentX', 'toolu_X', NOW)) + '\n');
  const s3 = reader.resumeSignals(p);
  check('écriture (notification arrivée) → recalcul, plus rien en attente', !!s3 && s3.pendingTask === false, JSON.stringify(s3));
  check('chemin null → null (membre sans transcript)', reader.resumeSignals(null) === null);
}

console.log('\n5. advanceGate : la vague doit rester prête STABLE_MS d\'affilée');
{
  const t0 = 1000000;
  // Rien à lancer : jamais d'armement.
  let g = advanceGate(null, null, t0);
  check('vague null → ni lancement ni armement', g.launch === null && g.pending === null);

  // Premier « prêt » : on ARME, on ne lance pas.
  g = advanceGate(null, 2, t0);
  check('première lecture prête → armement, pas de lancement', g.launch === null && !!g.pending && g.pending.wave === 2 && g.pending.since === t0, JSON.stringify(g));

  // Toujours prêt mais trop tôt : armement conservé tel quel.
  const early = advanceGate(g.pending, 2, t0 + WAVE_STABLE_MS - 1);
  check('prêt mais avant l\'échéance → on attend encore', early.launch === null && early.pending === g.pending);

  // Échéance atteinte : lancement, armement consommé.
  const due = advanceGate(g.pending, 2, t0 + WAVE_STABLE_MS);
  check('prêt depuis STABLE_MS → lancement', due.launch === 2 && due.pending === null, JSON.stringify(due));

  // La RECHUTE (reprise du hook Stop à feedback) désarme : le scénario exact
  // de l'incident — done à 13:48:38, reprise ~4 s plus tard.
  const relapse = advanceGate(g.pending, null, t0 + 4000);
  check('rechute (vague plus prête) → désarmé', relapse.launch === null && relapse.pending === null);
  const rearm = advanceGate(relapse.pending, 2, t0 + 240000);
  check('re-prête bien plus tard → le compteur repart de zéro', rearm.launch === null && !!rearm.pending && rearm.pending.since === t0 + 240000);

  // Changement de cible (une vague a été forcée au ▶ entre-temps) : re-armement.
  const switched = advanceGate({ wave: 2, since: t0 }, 3, t0 + WAVE_STABLE_MS + 5000);
  check('numéro de vague différent de l\'armement → on repart de zéro', switched.launch === null && !!switched.pending && switched.pending.wave === 3);
}

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
