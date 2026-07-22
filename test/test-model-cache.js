// Banc : un tool_result géant en queue (> TAIL_BYTES : screenshot base64, gros
// fichier lu, longue sortie) pousse le dernier message assistant hors de la
// fenêtre de lecture → extractLastAssistant rend null, et le modèle/ctx
// disparaissaient du panneau (« — » intermittent, signalé 2026-07-22). Le
// reader conserve le dernier assistant connu par fichier et le réaffiche.
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createTranscriptReader } = require(path.join(__dirname, '..', 'state.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' → ' + detail : ''}`); }
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-model-cache-'));
const line = (o) => JSON.stringify(o) + '\n';
const userMsg = (t) => ({ type: 'user', message: { content: [{ type: 'text', text: t }] } });
const assistant = (model, usage) => ({ type: 'assistant', message: { model, usage, content: [{ type: 'text', text: 'ok' }] } });
// tool_result d'une seule ligne > 64 Ko : dépasse TAIL_BYTES à lui seul.
const hugeToolResult = (id) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'X'.repeat(70000) }] } });

const p = path.join(SANDBOX, 'sess.jsonl');

console.log('\n1. Assistant visible → modèle + ctx lus, cache peuplé');
fs.writeFileSync(p, line(userMsg('go')) + line(assistant('claude-opus-4-8', { input_tokens: 1000, cache_read_input_tokens: 120000 })));
const reader = createTranscriptReader();
const r1 = reader(p);
check('modèle lu quand l\'assistant est dans la fenêtre', !!r1.model, JSON.stringify(r1.model));
check('ctx lu aussi', !!r1.ctx && r1.ctx.pct > 0, JSON.stringify(r1.ctx));

console.log('\n2. Gros tool_result en queue → assistant hors fenêtre, mais modèle CONSERVÉ (cache)');
fs.appendFileSync(p, line(hugeToolResult('toolu_big')));
const r2 = reader(p);
check('même reader : modèle conservé malgré le tool_result géant', r2.model === r1.model, JSON.stringify({ before: r1.model, after: r2.model }));
check('ctx conservé aussi (dernière mesure connue)', !!r2.ctx && r2.ctx.pct === r1.ctx.pct, JSON.stringify(r2.ctx));

console.log('\n3. Preuve du bug sans le cache : un reader NEUF ne trouve rien sur ce transcript');
const freshReader = createTranscriptReader();
const rFresh = freshReader(p);
check('reader neuf (cache vide) → modèle null (c\'est bien le cache qui sauve, pas la fenêtre)', rFresh.model == null, JSON.stringify(rFresh.model));

console.log('\n4. Nouvel assistant après le gros bloc → le cache se met à jour');
fs.appendFileSync(p, line(assistant('claude-sonnet-5', { input_tokens: 500, cache_read_input_tokens: 20000 })));
const r4 = reader(p);
check('modèle rafraîchi vers le nouvel assistant', r4.model && r4.model !== r1.model, JSON.stringify(r4.model));

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
