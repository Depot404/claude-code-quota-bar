---
description: Propose follow-up conversations in a claude-convs block, ready to paste into "Claude Convs".
---

Propose the follow-up conversations for the work just framed (or rephrase the ones you just
suggested) in a \`\`\`claude-convs block, one section per task separated by a `[---]` line, optional
first line `model: <haiku|sonnet|opus|fable>` and/or `effort: <low|medium|high|xhigh|max>` (haiku
has no notion of effort: don't set one for a `model: haiku` section), the rest = the prompt as-is.
Optional at the top of the block: `group: <name>`.

**Ordering — MANDATORY as soon as tasks aren't all independent.** Each section carries
`stage: <n>` (absent = 1). Semantics: same number = launched in parallel; wave k+1 only starts once
ALL of wave k is done. If you stated an execution order in the discussion ("first… then…", "X and Y
in parallel", "Z at the end"), you MUST translate it into `stage:` — a block where every task sits
in wave 1 while you just described a sequence is a mistake. Before emitting, check: every task that
depends on another carries a `stage` strictly higher than its own.

Mixed case "X in parallel with a chain (A → B → C)": put X in wave 1 with A (stages: A=1, X=1, B=2,
C=3). Note the nuance: B will then also wait on X — if X is long and that's a problem, say so in one
sentence after the block (the user will force the wave transition with ▶, or make X a separate
batch).

Right AFTER the block, summarize the ordering in ONE readable line, for example:
"Order: (batch 1 ∥ Stripe audit) → batch 2 → cleanup" — it's the only human view of the sequencing
before pasting, never omit it when there's more than one wave.

**Session token.** If this command's context contains a line `claude-convs-session: <uuid>`, copy it
VERBATIM as the very first line of the block, as `session: <uuid>` — it lets the panel attach the
batch to this conversation. Never invent it, never alter it: no `claude-convs-session:` line in the
context = no `session:` line in the block (the example below deliberately has none — there's nothing
to copy from).

If no follow-up conversation genuinely emerges from the discussion, say so in one sentence and do
NOT emit a claude-convs block.

Example (mixed sequence + parallelism):

\`\`\`claude-convs
group: Payment refactor
model: sonnet
effort: medium
Implement batch 1 (refunds table schema) from Tools/X/PLAN.md.
[---]
model: opus
effort: high
Audit existing Stripe calls — independent, in parallel with batch 1.
[---]
model: sonnet
effort: medium
stage: 2
Implement batch 2 (refund endpoint) from Tools/X/PLAN.md — depends on batch 1.
[---]
model: haiku
stage: 3
Cleanup pass (TODOs, dead imports) — after batch 2.
\`\`\`
