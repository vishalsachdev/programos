# 07 — Learning loop

How the agent gets better over time without breaking the audit trail.

## Problem

A program coordinator that never improves becomes a glorified FAQ tool. A program coordinator that rewrites itself becomes unauditable. ProgramOS resolves this by making *every* improvement a reviewed git commit.

## Two mechanisms

### 1. Skills as agent-proposed pull requests

The program repo gains a `skills/` directory. Each skill is a markdown file describing a procedure the agent should follow when a recurring situation arises (e.g., "when an admissions officer asks about transfer credit limits, check `program/policies/transfer-credit.md` first, then cite the relevant section").

**The contract:**

- In **question mode** (`read-only` sandbox), the agent reads `skills/` and follows applicable skills. It cannot write.
- In **status-update mode** (`workspace-write` sandbox), the agent MAY propose a new skill or an edit to an existing one. It does this by writing the file to a feature branch and opening a pull request — never by committing directly to the default branch.
- A human reviewer (program coordinator, faculty lead, or designated maintainer) merges or rejects the PR. Merged skills become part of the agent's repertoire on the next invocation.

**What this gives you:**

- Every behavior change is a reviewed, signed-off, reverted-able commit.
- The full history of "what the agent learned and when" is `git log skills/`.
- Reviewers see *what* changed and *why* (commit message), not just that the bot's behavior shifted.

**What this does NOT do:**

- The agent does not modify its own runtime code, prompts, or channel handlers — those changes still go through the normal repo's PR flow.
- The agent does not auto-merge its own PRs. Ever.

### 2. FTS5 search over the audit log

The audit log (`discussions/audit-log/`) already contains every inbound and outbound message. Add a SQLite FTS5 index over it (rebuilt on a cron, or incrementally on each write) and expose a `search_audit_log(query)` tool to the agent.

This gives the agent **episodic memory** — "have we answered something like this before?" — without changing the trust model. Citations into prior conversations are file paths in the program repo, the same way program-repo citations work.

The index is derived data; if it's lost, rebuild from the audit log. Don't treat it as a source of truth.

## What this is NOT

- It is not autonomous skill creation. The agent proposes; humans dispose.
- It is not self-modification of the runtime. Skills are data the agent reads; they are not code the agent executes against itself.
- It is not a substitute for prompt iteration. If the agent is wrong in a structural way, fix `groups/<channel>/CLAUDE.md`. Skills are for accumulating *content*, not for patching prompt bugs.

## Skill file format

```markdown
---
name: <short slug>
applies_when: <one-line trigger description>
mode: question | status-update | both
---

# <Skill title>

## When this applies
<2–3 sentences>

## What to do
1. <step>
2. <step>
3. <step>

## Citations to include
- <path in program repo>
- <path in program repo>

## History
- <YYYY-MM-DD>: created from <audit-log path>, PR #<n>
- <YYYY-MM-DD>: edited to <change> after <audit-log path>, PR #<n>
```

The `History` section is mandatory and append-only — it's the local provenance trail for this specific skill.

## Grant / accreditation framing

If you're documenting this for an external audience (NSF reviewer, accreditor, IRB):

- "Agent proposes; human approves." Every behavior change is a git commit signed off by a named human.
- "Episodic recall over an append-only audit log." The agent can find prior decisions but cannot rewrite them.
- "No autonomous self-modification." The agent does not edit its own prompts or runtime.

That language reads well in a "Responsible AI" or "Human-in-the-loop" section without overpromising.

## Related: agent-proposed mount additions

The same proposes-via-PR / humans-merge mechanism extends to content sources: a running bot that detects "users keep asking about content I can't see" can open a PR against the program repo's `MOUNTS.md` proposing a new external mount, backed by the audit-log entries that motivated the proposal. A human reviews, makes the host-side mount change, and redeploys. See [`10-content-sources.md`](./10-content-sources.md) → "Bot-proposed mount additions."

## Future work (optional research overlay)

For a research deployment that explicitly wants to study autonomous skill evolution, you can add a *separate* `skills-experimental/` dir with a different lifecycle (autonomous writes allowed, isolated from production agent invocations, evaluated against a held-out test set). Keep it strictly outside the production trust boundary. Frameworks like Hermes Agent (NousResearch) or DSPy/GEPA can drive that overlay if you go this route.
