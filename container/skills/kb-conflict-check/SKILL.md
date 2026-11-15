---
name: kb-conflict-check
description: Runs a separate skeptical-reviewer pass before any DECISIONS.md commit to detect contradictions with existing entries — and, for facts sourced from external documents (spreadsheets, policy docs, meeting notes), cross-checks them against incumbent statements in courses/*.md and program/ files (v2 ingestion cross-check). Required step in the KB Write Protocol — invoke before staging a new DECISIONS.md entry, never after.
---

# KB Conflict Check — Pre-Commit Gate

A second-pass conflict detector for `discussions/DECISIONS.md`. The same model that wrote a decision tends to confirm its own output (Xu et al. EMNLP 2024). This skill runs a **separate Task subagent** with a skeptical-reviewer prompt to catch contradictions before they reach the repo.

**v2:** when the proposed facts come from an external document, the gate additionally cross-checks them against incumbent statements in `courses/*.md`, `program/curriculum.md`, `program/course_names.md`, and `program/target_profile.md` (Step 2b), and downgrades uncorroborated spreadsheet-cell facts to `Confidence: low`.

**v2.1 (G47 amendments + G51):** (a) a spreadsheet-cell fact with NO incumbent anywhere in the KB and no corroborating prose routes to `discussions/OPEN_QUESTIONS.md` — never into DECISIONS.md at any confidence (Step 2b, `route: open-questions`); (b) the cross-check script extracts distinctive phrases from the proposed entry text itself (deterministic 2-3-gram extraction — no hand-curated term list to go stale); (c) every gate script run's JSON verdict is reported to the host audit log via IPC (Step 2c) so "gate result: clean" claims have a machine-logged counterpart.

**You MUST invoke this skill before committing any new entry to `discussions/DECISIONS.md`.** It is the programmatic counterpart to the conventions in `/workspace/extra/program-repo/CLAUDE.md` § "KB Write Protocol".

If the user message contains `lore: intentional` (or `this supersedes`, `overrides the previous decision`, `intentional change`), **skip this skill entirely** and follow the supersede path in the KB Write Protocol instead — the user has signaled an intentional override and the gate would be in the way.

---

## Workflow

### Step 1 — Stage but do not commit

Write the proposed entry to a tempfile (not yet to DECISIONS.md):

```bash
mkdir -p /tmp/kb-conflict
cat > /tmp/kb-conflict/proposed.md <<'PROPOSED_END'
<the new DECISIONS.md entry block, including heading, body, and provenance line>
PROPOSED_END
```

### Step 2 — Retrieve top related entries

Find the 5 most semantically related existing entries. Topic similarity = keyword overlap on the heading and first paragraph; no vector DB needed at this scale.

```bash
cd /workspace/extra/program-repo
# List all decision headings with line numbers:
grep -nE '^### ' discussions/DECISIONS.md > /tmp/kb-conflict/headings.txt
```

Pick the 5 headings whose topic words best overlap with the proposed entry's heading and key terms. For each, extract that section's full body (heading line through the line before the next `### ` or end-of-file) into `/tmp/kb-conflict/related.md`, separated by `---`.

> **Retrieval only — not placement.** This grep and the headings it surfaces exist solely to assemble `related.md` for the skeptical reviewer. They do **not** determine where the new entry is filed. Conflict detection is position-independent (it works on `grep` + the `Category` tag), so the matched neighbors have no bearing on placement — see Step 4.

### Step 2b — Ingestion cross-check (v2, external-document sources)

**Applies whenever the proposed entry's facts come from an EXTERNAL DOCUMENT** — a spreadsheet, policy doc, meeting-notes file, or any attachment — rather than from statements the sender wrote directly in the message body. Source documents contain errors (for example, a prep requirement entered on the wrong course's row), and DECISIONS.md alone cannot catch them: the wrong fact may have no DECISIONS counterpart while a course file already states the truth.

Run the cross-check script against the wider KB:

```bash
cd /workspace/extra/program-repo
node ~/.claude/skills/kb-conflict-check/check-ingestion-crosscheck.mjs \
  --proposed /tmp/kb-conflict/proposed.md \
  --kb /workspace/extra/program-repo \
  > /tmp/kb-conflict/crosscheck.json
echo "crosscheck exit: $?"
```

The script extracts entities from the proposed entry — course codes, plus **distinctive 2-3-gram phrases pulled deterministically from the entry text itself** (stoplist-filtered; nothing course-specific is hardcoded) and generic attribute terms (prep/prerequisite/instructor/credits, subject + program files only) — and searches `courses/*.md`, `program/curriculum.md`, `program/course_names.md`, and `program/target_profile.md` for incumbent statements. It judges nothing — it is retrieval for the Step 3 reviewer.

- **Exit 0 (`no-incumbents`)** — nothing in the wider KB speaks to these facts.
  - **If the JSON carries `route: "open-questions"`** (the proposed entry is sourced from a spreadsheet cell): verify whether the source document contains corroborating prose (narrative text, not just the cell). If it does NOT — the fact's only support is a bare cell that nothing in the KB corroborates — **do NOT write it to DECISIONS.md at any confidence.** Record it in `discussions/OPEN_QUESTIONS.md` instead (through the `kb-entry-gate` skill), noting the claimed fact, the document + sheet/row/cell, and that it awaits human confirmation. In your reply to the submitter, say the fact was **"recorded as an open question pending confirmation"** — do not present it as recorded fact. If the document DOES contain corroborating prose, proceed to Step 3 and record at `Confidence: low` per the downgrade rule below.
  - Otherwise continue to Step 3 with `related.md` as-is.
- **Exit 3 (`incumbents-found`)** — append every match from `crosscheck.json` to `/tmp/kb-conflict/related.md` under a heading `INCUMBENT KB STATEMENTS (course/program files)`, one block per match in the form `file:line (section) — excerpt`. Pay special attention to `kind: incumbent-statement-elsewhere` matches: a distinctive fact (e.g. "linear algebra") already living in a DIFFERENT course's file than the one the source document attaches it to is exactly the reversed-row failure mode. These excerpts count as evidence the reviewer must weigh — incumbent facts in course files are evidence, not just registry entries.

If the entry is NOT sourced from an external document (the sender stated the facts themselves), skip this step.

### Step 2c — Report the gate verdict to the host audit log (G51)

**After EVERY gate script run in this skill (and every `kb-entry-gate` run), report the machine verdict to the host** so your later claim about the gate outcome has a machine-logged counterpart in `discussions/audit-log/`. Write a `log_gate_result` IPC payload (atomic: temp file then rename — the host only picks up `.json`):

```bash
EXIT_CODE=<the script's exit code>
TS="$(date +%s%3N)-gate"
cat > /workspace/ipc/tasks/${TS}.json.tmp <<GATE_END
{
  "type": "log_gate_result",
  "gate": "kb-conflict-check/ingestion-crosscheck",
  "script": "check-ingestion-crosscheck.mjs",
  "status": "$(node -e 'console.log(JSON.parse(require("fs").readFileSync("/tmp/kb-conflict/crosscheck.json","utf-8")).status)')",
  "exit_code": ${EXIT_CODE},
  "entry_heading": "<first heading line of the proposed entry>",
  "result": $(cat /tmp/kb-conflict/crosscheck.json)
}
GATE_END
mv /workspace/ipc/tasks/${TS}.json.tmp /workspace/ipc/tasks/${TS}.json
```

For the Step 3 skeptical-reviewer verdict, send a second payload with `"gate": "kb-conflict-check/skeptical-reviewer"`, `"status": "no-conflict"` or `"conflict-detected"`, and the verdict line as `result`. **Never claim "gate result: clean" (or any gate outcome) in a reply or pilot log unless you sent the matching `log_gate_result` payload in the same run** — the host audit log is the corroborating record.

### Step 3 — Spawn a skeptical-reviewer subagent

**Use the Task tool with `subagent_type: "kb-gate-reviewer"`** to spawn a fresh subagent. This agent type is registered by the agent runner and runs on a stronger model than the main session (Opus tier by default — `NANOCLAW_GATE_MODEL`), because false negatives here corrupt the KB silently. The subagent must NOT see your reasoning or the original message — only the proposed entry and the related entries. This is the core of the gate: a separate context, separate model call. If the `kb-gate-reviewer` agent type is unavailable (e.g. an older agent runner), fall back to a plain Task subagent with the same prompt.

**CRITICAL — subagent output must stay internal.** The subagent inherits the parent container's `NANOCLAW_CHAT_JID`. Any text it emits that is not wrapped in `<internal>` tags **will be delivered to the stakeholder** as a reply from Coordinator. The prompt below wraps the verdict in `<internal>` to prevent this. Do not remove that wrapper.

**Subagent communication rules:**
- The subagent must NEVER call `send_email`, `mcp__nanoclaw__send_email`, or any email/messaging tool
- The subagent has ONE job: output a verdict wrapped in `<internal>` tags and nothing else

```
Task tool call:
  description: "KB conflict check"
  subagent_type: "kb-gate-reviewer"
  prompt: |
    You are a skeptical knowledge auditor reviewing a proposed addition to
    a decision registry. Your only job is to detect direct contradictions
    with existing entries. Do not try to resolve, rewrite, or judge which
    entry is "correct."

    IMPORTANT: You must NOT call send_email, send_telegram, or any
    messaging tool. Return your verdict wrapped in <internal> tags only.

    PROPOSED ADDITION:
    [paste contents of /tmp/kb-conflict/proposed.md]

    EXISTING RELATED ENTRIES:
    [paste contents of /tmp/kb-conflict/related.md — including any
    "INCUMBENT KB STATEMENTS (course/program files)" section from Step 2b]

    A "direct contradiction" means the proposed entry asserts a fact that
    cannot simultaneously be true with a fact in an existing entry OR an
    incumbent statement from a course/program file. Examples:
      - Existing: "Priority deadline is June 4." Proposed: "Priority deadline is July 4."
      - Existing: "Team projects, 4-person teams." Proposed: "All projects are individual."
      - Incumbent (courses/quantum_optimization.md): "Linear algebra pre-course
        module before Week 1." Proposed (from a spreadsheet row): "Agentic AI
        requires a Linear Algebra prep." — the same distinctive fact already
        attached to a DIFFERENT course is a likely mis-attributed source row;
        treat it as a contradiction.

    Refinements, additional context, or scope expansions are NOT contradictions.
    An incumbent statement that AGREES with the proposed entry is corroboration,
    not a conflict.

    Output EXACTLY the following block — no other text, no preamble:

    <internal>
    NO CONFLICT DETECTED
    </internal>

    OR:

    <internal>
    CONFLICT DETECTED: [one-sentence description] | with: [heading of conflicting entry, or file:line of the incumbent KB statement]
    </internal>

    If you are uncertain whether something is a contradiction (multi-hop
    or requires reasoning across more than one existing entry), output:

    <internal>
    CONFLICT DETECTED: uncertain — multi-hop, requires human review | with: [best-guess heading]
    </internal>

    The <internal> wrapper is MANDATORY. It prevents this result from being
    sent as an email to the stakeholder. Do not remove it. Do not output
    anything outside the <internal> block.
```

### Step 4 — Gate

Parse the subagent's output. Strip the `<internal>…</internal>` wrapper first — the verdict text is inside it.

**`NO CONFLICT DETECTED`** → proceed:
1. Append the proposed entry at the **end** of `discussions/DECISIONS.md` — after the last entry's trailing `---`. **Never** insert it beside a topically-related neighbor or anywhere mid-file: the Step 2 grep is for conflict detection / retrieval only, not placement. The only in-place edit to an existing (older) entry is adding a `**Superseded** — see [date]` marker when superseding (per Step 3 / the KB Write Protocol).
2. Cross-reference and update `ACTION_ITEMS.md` and `OPEN_QUESTIONS.md` (Tripartite Atomicity per KB Write Protocol)
3. Commit with message ending: `[conflict-check: clean — N entries reviewed]` where N is the count of related entries
4. Continue with normal reply flow

**`CONFLICT DETECTED: ...`** → block and escalate:
1. **Do NOT commit the proposed entry to DECISIONS.md.**
2. Append it instead to `discussions/kb-triage/YYYY-MM-DD-conflicts.md` (create the directory if needed) with:
   ```
   ## [Proposed entry heading] — [CONFLICTED — requires human review]

   **Detected:** YYYY-MM-DD HH:MM CDT
   **Conflicts with:** [heading of conflicting entry]
   **Reviewer note:** [the one-sentence description from the subagent]

   ### Proposed entry (not committed)
   [full proposed entry]

   ### Existing entry it conflicts with
   [full text of the conflicting entry, with permalink-style line reference: `discussions/DECISIONS.md:NNN`]
   ```
   **When the conflict is a Step 2b ingestion cross-check mismatch** (source document vs. an incumbent course/program file, not two DECISIONS entries), quote BOTH statements verbatim — replace the last section with:
   ```
   ### Source document claim (not committed)
   [the exact claim, naming the document and sheet/row/cell, e.g. "curriculum spreadsheet, row 14 (Agentic AI): 'Linear Algebra / TBD'"]

   ### Incumbent KB statement it conflicts with
   `courses/quantum_optimization.md:NNN` — [the incumbent line/passage, quoted verbatim]
   ```
3. Commit the triage file with message: `kb-triage: flagged [topic] for human review — see kb-triage/YYYY-MM-DD-conflicts.md`
4. **Notify Avery** via Telegram with a brief message: `KB conflict flagged for review: [topic]. Proposed entry in kb-triage/YYYY-MM-DD-conflicts.md. I did NOT commit to DECISIONS.md.` Use the `mcp__nanoclaw__send_telegram` tool (or the standard reply path on the Telegram channel). This admin ping is separate from email-thread CC routing.
5. In your reply to the original sender:
   - **DECISIONS-vs-DECISIONS conflict:** briefly acknowledge: "I noted [topic] but flagged a possible contradiction with prior records — the appropriate approver will review and confirm." Do not paraphrase the conflicting entries; the human resolves.
   - **Ingestion cross-check mismatch (source document vs. KB file):** name the discrepancy explicitly so the submitter can fix their document — quote both sides: "Your document says [X, with sheet/row]; the KB course file (`courses/….md`) says [Y]. Please confirm which is correct — I have NOT recorded this fact yet." The submitter owns the document and is the fastest path to resolution; this is the one conflict class where quoting both statements in the reply is required, not forbidden.
   - On the email channel, the host automatically CCs the domain approver (or maker-checker fallback) when the new `kb-triage/YYYY-MM-DD-conflicts.md` entry is created in the same run.

### Confidence downgrade for spreadsheet-cell facts (v2, amended v2.1)

**Routing first (G47a):** a spreadsheet-cell fact with **no incumbent KB statement at all** (cross-check exit 0, `route: open-questions`) **and** no corroborating prose anywhere (email body or the document's narrative text) does not enter DECISIONS.md at any confidence — it goes to `discussions/OPEN_QUESTIONS.md` for human confirmation (see Step 2b), and the submitter is told it was "recorded as an open question pending confirmation."

For a spreadsheet-cell fact that DOES have corroboration but only weakly (prose in the same document, or an agreeing incumbent that is itself thin): record at **`Confidence: low`** (not medium), and the provenance line MUST name the sheet and row/cell so the fact is traceable to its exact origin:

```
> _Source: sender@example.edu (curriculum spreadsheet, "Courses" sheet, row 14) | Date: YYYY-MM-DD | Confidence: low | Session: FW: curriculum spreadsheet_
```

Rationale: spreadsheet rows carry no surrounding context, so a value pasted on the wrong row reads exactly like a correct one. Corroborating prose or an agreeing incumbent KB statement restores the normal medium/high heuristics.

### Step 5 — Cleanup

```bash
rm -rf /tmp/kb-conflict
```

---

## When to skip

- The write is to `ACTION_ITEMS.md` or `OPEN_QUESTIONS.md` only — those files use the lighter `kb-entry-gate` skill instead.
- The user message contains a `lore: intentional` override marker (or equivalents listed in the KB Write Protocol). The supersede path replaces the gate.
- You are appending a provenance line, audit-log entry, or formatting fix to an existing entry without changing its substance.
- The proposed entry is a NEW topic (no related existing entries found in Step 2). Note this in the commit message: `[conflict-check: clean — no related entries]`.

## What this skill does NOT do

- It does not resolve conflicts. The human resolves.
- It does not validate semantic correctness of the new decision (e.g. it won't catch a wrong date that conflicts with nothing — neither a DECISIONS entry nor any incumbent course/program statement).
- It does not re-check entries on every commit. Aging-entry detection lives in the weekly FDE scan (Step 6).

---

## Background

- SemanticCommit (UIST 2025, arXiv:2504.09283) — validated pattern: flag, do not auto-resolve.
- MemoryAgentBench (arXiv:2507.05257) — LLMs resolve single-hop conflicts ~60%, multi-hop <7%.
- Xu et al. EMNLP 2024 — same model that wrote an update tends to confirm it; separate reviewer required.
