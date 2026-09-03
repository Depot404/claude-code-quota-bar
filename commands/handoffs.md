---
description: Propose follow-up conversations in a claude-convs block, ready to paste into "QuotaSaver".
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

**Repeat invocation — say whether the block REPLACES or COMPLETES the previous one.** When a
claude-convs block was already emitted earlier in the conversation, the user cannot tell from the
block itself: pasting a re-emitted block on top of the first one duplicates every repeated task in
their panel. So state it in ONE line right after the ordering line, in French:
- re-emitted tasks: "Ce bloc REMPLACE le precedent : supprime les lots deja colles qui n'ont pas
  encore demarre, garde ceux d'ici (les `stage:` ont change)."
- new tasks only: "Ce bloc COMPLETE le precedent : colle-le a la suite, les lots deja lances
  continuent."
Measure what actually started before claiming it (`whodunit.py`), never assume the earlier block
was pasted — or wasn't.

**Session token — child, sibling, or a wave of the EXISTING batch: judge it, then say it.** The
`claude-convs-session: <uuid>` line is ALWAYS injected on an /handoffs invocation, whether or not
the proposed work actually belongs to this conversation. Copy it VERBATIM or omit it — never
invent or alter it. Decide in this order:
1. **Ordering with already-pasted lots trumps everything.** Waves sequence tasks only INSIDE one
   batch — two batches NEVER wait for each other, even when both are attached to this
   conversation. So a task that must run before/after a lot already pasted from this conversation
   (shared files, version bump, same CHANGELOG…) must NOT ship as a stand-alone block with a
   textual "launch it after X" warning: emit it and tell the user to put it INTO the existing
   batch, in a wave after X (insertion gesture on the batch's rows, or the task's wave menu once
   pasted). Announce: "A poser DANS le lot existant, vague apres <X> — deux lots separes ne
   s'attendent jamais."
2. **Child of this conversation**: the user will come back to THIS conversation to drive or judge
   the work — it holds the plan, the diagnosis, the decisions the tasks pick up. Then put
   `session: <uuid>` as the very first line of the block, so the panel attaches the batch here.
   Same topic is only a HINT: coordination decides, not theme.
3. **Siblings**: the work is self-contained — its prompt carries all its context and it will live
   and be judged without this conversation (typical: a fix on another subject that merely got
   discovered here). Then OMIT the `session:` line entirely, even though the token is present in
   the context — copying it would wrongly nest an independent batch under this one.
Announce the verdict WITH its reason in one French line right after the "Ordre :" line, so the
user can correct it before pasting:
- rule 1: "A poser DANS le lot existant, vague apres <X> — deux lots separes ne s'attendent jamais."
- child: "Lot rattache a cette conversation (prolonge ce chantier)."
- siblings: "Lot independant — place-le ou tu veux dans le panneau."
Genuine doubt: say so in that same line and let the user pick. And a user QUESTION ("lot soeur,
non ?") asks for your judgment — answer with a verdict and its why, never by just complying.

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
