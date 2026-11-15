---
name: kb-entry-gate
description: Duplicate/redundancy/conflict gate for ACTION_ITEMS.md and OPEN_QUESTIONS.md — lexical pre-filter plus a semantic subagent verdict. Use before appending new action items or open questions.
---

# KB Entry Gate (v2 — semantic)

Pre-write check for `discussions/ACTION_ITEMS.md` and
`discussions/OPEN_QUESTIONS.md`. It answers three questions about a proposed
entry before it is appended:

- **redundant** — is this already tracked (same file OR the sibling tracking
  file OR DECISIONS.md), possibly in different words?
- **already-satisfied** — has the world already done this? (The evidence
  usually lives in KB state — allowlist rows, rosters, course files — not in
  any tracking file.)
- **conflicting** — does its premise contradict a confirmed decision?

v1 of this gate was lexical only and missed paraphrases and
KB-satisfied premises. v2 keeps the script as a
**candidate pre-filter** and gives the **verdict to a subagent**. This is the
G38-authorized promotion; registry rows G37/G38 describe it.

## Required Use

Run this skill before adding any new `- [ ]` or `- [x]` entry to either
tracking file, before staging or committing the change.

## Workflow

### Step 1 — Write the proposed entry to a temp file

```bash
mkdir -p /tmp/kb-entry-gate
cat > /tmp/kb-entry-gate/proposed.md <<'PROPOSED_END'
<the proposed bullet(s)>
PROPOSED_END
```

### Step 2 — Run the pre-filter script

The FIRST `--current` is the file you intend to append to (stamping keys off
it). Always pass both tracking files; always pass `--kb-root` and
`--emit-candidates`.

```bash
cd /workspace/extra/program-repo
node ~/.claude/skills/kb-entry-gate/check-kb-entry.mjs \
  --current discussions/ACTION_ITEMS.md \
  --current discussions/OPEN_QUESTIONS.md \
  --kb-root /workspace/extra/program-repo \
  --emit-candidates \
  --proposed /tmp/kb-entry-gate/proposed.md \
  > /tmp/kb-entry-gate/result.json; EXIT_CODE=$?
```

(For an OPEN_QUESTIONS append, list OPEN_QUESTIONS.md first instead.)

Exit `2` (lexical `blocked`): a near-verbatim twin exists. Do NOT append; read
`issues[].existingFile`/`existingLine` and update the existing item instead
(G38 path). You may skip Step 3 — the lexical block already carries evidence.

Exit `0` (lexical `clean`): **not a verdict.** Proceed to Step 3 — the misses
this gate exists to catch are exactly the ones the script cannot see.

### Step 3 — Semantic verdict (subagent, ALWAYS on lexical clean)

Spawn a subagent via the Task tool with `subagent_type: "kb-gate-reviewer"`
(registered by the agent runner; runs on a stronger model than the main
session — Opus tier by default via `NANOCLAW_GATE_MODEL` — because the
premise-check misses this gate exists to catch are reasoning failures. Fall
back to a plain Task subagent if the agent type is unavailable). Its prompt
must contain:

1. The proposed entry (verbatim).
2. `candidates.trackingTwins`, `candidates.kbSnippets`, and
   `candidates.entities` from `result.json`.
3. These instructions, verbatim:

> You are a skeptical reviewer. Judge whether this proposed tracking entry
> should be appended. Three failure axes: **redundant** (already tracked
> anywhere, including reworded), **already-satisfied** (KB state shows the
> work is done or the premise is dead), **conflicting** (premise contradicts
> a confirmed decision). You may read the cited files to verify context.
> Rules: (a) a block REQUIRES at least one file+line citation you have
> verified — no citation, no block; (b) if the proposal references a decision
> but asks a genuinely new downstream question, that is ALLOW; (c) entity
> overlap alone (same person/course, different ask) is NOT redundancy;
> (d) a conflict is verdict "hold", never "block" — humans resolve conflicts;
> (e) when genuinely uncertain, ALLOW and say so — over-blocking trains
> people to route around the gate. Return ONLY this JSON:
> `{"verdict":"allow|block|hold","axis":"redundant|already-satisfied|conflicting|no-match","evidence":[{"file":"…","line":N,"quote":"…"}],"reasoning":"one paragraph"}`
> Return your answer as text only — do not send any email or message, do not
> use any outbound tool.

Handling the verdict:

- **allow** → append (for OPEN_QUESTIONS use `stampedProposal` verbatim, G55).
- **block** → verify each cited quote exists (`grep -n "<quote fragment>"
  <file>`). Citation verifies → do not append; update/point to the existing
  state instead, and say why in your reply. Citation does NOT verify → treat
  as allow, but note the unverifiable block in the gate log (see Step 4).
- **hold** (conflicting) → do not append and do not resolve: route per the
  conflict path (G8) — surface `[CONFLICT — needs human review]` with the
  cited decision to Avery, CC per kb-triage rules.

### Step 4 — Log the gate result (G51)

After EVERY run — lexical-only or lexical+semantic — send the machine verdict:

```bash
TS="$(date +%s%3N)-gate"
cat > /workspace/ipc/tasks/${TS}.json.tmp <<GATE_END
{
  "type": "log_gate_result",
  "gate": "kb-entry-gate",
  "script": "check-kb-entry.mjs",
  "status": "<clean|blocked>",
  "exit_code": ${EXIT_CODE},
  "semantic_verdict": <the subagent JSON, or null if Step 3 was skipped>,
  "entry_heading": "<first line of the proposed bullet(s)>",
  "result": $(cat /tmp/kb-entry-gate/result.json)
}
GATE_END
mv /workspace/ipc/tasks/${TS}.json.tmp /workspace/ipc/tasks/${TS}.json
```

Never claim a gate outcome in a reply or pilot log unless you sent the
matching payload in the same run. A semantic block you acted on must appear
here with its evidence.

### Step 5 — Cleanup

```bash
rm -rf /tmp/kb-entry-gate
```

## When to Skip

- Wording/formatting/provenance edits to an existing item.
- You already found the existing item and are updating it in place (G38).
- The write is to `DECISIONS.md` — use `kb-conflict-check` instead.
- `lore: intentional` override (G6) — activates the supersede path.

## Important Limits

- The subagent's verdict is judgment, not proof: a clean result does not make
  the item correct, owned, or complete.
- The candidate lists are bounded (top 10 tracking twins, top 12 KB snippets).
  If the subagent says "insufficient context," widen by reading the named
  files directly — do not lower the evidence bar.
- Eval suite: `evals/golden.jsonl` is the behavioural spec for this skill.
  Any change to this file or the script must re-run it.
