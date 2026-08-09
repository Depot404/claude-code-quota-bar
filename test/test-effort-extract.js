// Banc : extraction de l'EFFORT réel depuis le transcript (lot 1 du plan
// PLAN_creation_groupes_2026-07-22.md).
//
// Le champ vit au niveau de l'ENTRÉE, pas dans `message` — forme vérifiée sur
// transcripts réels 2026-07-22 :
//   {"type":"assistant","effort":"high","message":{"model":…,"usage":…}}
// Il est absent d'une partie des transcripts (versions antérieures, modèles
// sans effort) : l'absence doit rendre `null`, jamais une valeur par défaut —
// c'est ce qui permet au panneau de n'afficher que le modèle, et au badge
// d'écart de se taire faute de réel connu.
const fs = require('fs');
const os = require('os');
const path = require('path');

const { extractLastAssistant } = require(path.join(__dirname, '..', 'hooks', 'transcript.js'));
const { createTranscriptReader } = require(path.join(__dirname, '..', 'state.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-effort-'));
const line = (o) => JSON.stringify(o) + '\n';
const userMsg = (t) => ({ type: 'user', message: { content: [{ type: 'text', text: t }] } });
const assistant = (model, effort, usage) => {
  const e = { type: 'assistant', message: { model, usage, content: [{ type: 'text', text: 'ok' }] } };
  if (effort) e.effort = effort;
  return e;
};
const hugeToolResult = (id) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'X'.repeat(70000) }] } });

console.log('\n1. Effort présent sur la dernière entrée assistant');
const p1 = path.join(SANDBOX, 'a.jsonl');
fs.writeFileSync(p1, line(userMsg('go')) + line(assistant('claude-opus-4-8[1m]', 'high', { input_tokens: 10, cache_read_input_tokens: 1000 })));
const a1 = extractLastAssistant(p1);
check('effort lu', a1 && a1.effort === 'high', JSON.stringify(a1 && a1.effort));
check('modèle toujours lu (pas de régression)', a1 && a1.modelId === 'claude-opus-4-8[1m]', JSON.stringify(a1 && a1.modelId));

console.log('\n2. Effort ABSENT → null, jamais une valeur inventée');
const p2 = path.join(SANDBOX, 'b.jsonl');
fs.writeFileSync(p2, line(userMsg('go')) + line(assistant('claude-sonnet-5', null, { input_tokens: 10 })));
const a2 = extractLastAssistant(p2);
check('effort null quand le champ manque', a2 && a2.effort === null, JSON.stringify(a2 && a2.effort));

console.log('\n3. C\'est le DERNIER tour qui fait foi (/effort en cours de conv)');
const p3 = path.join(SANDBOX, 'c.jsonl');
fs.writeFileSync(p3, line(assistant('claude-opus-4-8', 'high', { input_tokens: 10 })) + line(assistant('claude-opus-4-8', 'low', { input_tokens: 20 })));
check('dernier effort gagne', extractLastAssistant(p3).effort === 'low');

console.log('\n4. Remontée jusqu\'au reader de state.js (ce que le panneau affiche)');
const reader = createTranscriptReader();
const r1 = reader(p1);
check('reader expose effort', r1.effort === 'high', JSON.stringify(r1.effort));
check('reader expose null quand absent', reader(p2).effort === null, JSON.stringify(reader(p2).effort));

console.log('\n5. Assistant poussé hors des 64 Ko → effort CONSERVÉ comme le modèle');
fs.appendFileSync(p1, line(hugeToolResult('toolu_big')));
const r2 = reader(p1);
check('effort conservé par le cache du reader', r2.effort === 'high', JSON.stringify(r2.effort));
check('modèle conservé aussi', r2.model === r1.model, JSON.stringify(r2.model));

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
