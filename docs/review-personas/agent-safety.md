---
type: review-persona
domain: agent-safety+resilience+audit
repo: programos
version: 1.1.1
source: distilled from past bugfixes in a reference deployment
---

# NanoClaw Program — Review Persona: Agent Safety, Resilience, Audit

Use this checklist when reviewing any PR touching `src/`, `container/`, or `groups/` (the routing table in `CLAUDE.md` is authoritative).
An LLM-as-judge should flag any item below that the PR violates or fails to address.

---

## Agent Safety & Guardrails

- [ ] **`send_email` is main-group-only**: no non-main group CLAUDE.md instructs Coordinator to call `send_email`.
  Why: `send_email` from non-main groups fails invisibly inside containers — Coordinator believes it sent, audit log has no record.
- [ ] **Task-tool subagent prompts require `<internal>` wrapper on ALL output.** Any subagent spawned via the Task tool inherits `NANOCLAW_CHAT_JID` from the parent container; bare text output is delivered to the stakeholder as a Coordinator reply.
  Why: Unwrapped subagent text reaches the stakeholder as if it were a reply. Guard: the subagent prompt must end with "Wrap your entire output in `<internal>…</internal>` tags."
- [ ] **Action item counts read from `action_item_counts.json`**, never hand-tallied from `ACTION_ITEMS.md`.
  Why: Hand-tallying includes closed `[x]`/✅ items and nested sub-bullets, producing wrong counts in outreach emails.
  Note: this is a **runtime IPC artifact**, not a repo file — the host pre-computes per-owner counts at outreach-task time and writes `/workspace/ipc/action_item_counts.json` into the container (`src/task-scheduler.ts`). Searching program-repo for it and concluding "the counts file is missing" is a known false alarm.
- [ ] **Behaviour sensor verifies counts against index line only** (`Owner: N open`), never re-tallying section bodies.
  Why: Section bodies contain closed items and sub-bullets that mislead manual tallying.
- [ ] **Task scheduler alert count inputs are digits-only validated** before use as integers.
  Why: `parseInt('2026-06-16T10:00:00')` returns `2026`, creating a 2-second interval instead of failing.
- [ ] **Task ID gates use immutable host-owned task ID OR flexible prompt pattern matching** — never shape-match alone.
  Why: Shape-identical tasks under different IDs could inherit `send_email` grants.
- [ ] **`schedule_value` for interval tasks validated as digits-only** before `parseInt`.
  Why: Date-like strings parse to millisecond intervals silently.
- [ ] **Weekend backstop only fires when `schedule_value` (fire date) changes**, not on prompt/script-only updates.
  Why: Prompt edits that redundantly include `schedule_type` were incorrectly triggering the weekend pause.

---

## Resilience

- [ ] **API/transport errors classified and retried**, not suppressed: distinguish retryable failures (network, 5xx, timeout) from permanent content errors (4xx, validation) before deciding whether to retry.
  Why: Previous behaviour silently lost stakeholder replies when outbound API calls failed.
- [ ] **All file reads in async functions use `await fs.promises.readFile`**, not `fs.readFileSync`.
  Why: Blocking I/O in async context stalls the Node event loop.
- [ ] **CSV/spreadsheet parsing uses `sheet_to_json({header: 1})`**, not `sheet_to_csv` + `split(',')`.
  Why: Cell values like `"Smith, John"` or `"$1,200"` are split incorrectly by naive comma splitting.
- [ ] **Dynamic imports check `.default`** for CommonJS namespace objects before use.
  Why: `mammoth` and similar CJS modules export via `.default` in ESM dynamic imports; direct use throws.
- [ ] **No synchronous blocking work on the event loop in async paths** — use async I/O or offload CPU-bound work; avoid `*Sync` APIs (`execSync`, sync crypto/compression) and large inline loops/`JSON.parse` on big payloads.
  Why: A sync call blocks every concurrent message handler across all channels until it returns — one slow operation stalls the whole process, not just the current request.

---

## Audit & Traceability

- [ ] **After each audit log commit, `chown -R 1000:1000 .git/objects`** is run.
  Why: Root-owned git objects block container reads (containers run as uid 1000).
- [ ] **Every successful `send_email` call writes a host-side `[OUTBOUND EMAIL]` record** to the audit log.
  Why: Coordinator self-reports in pilot logs cannot be corroborated without a deterministic host-side entry.
- [ ] **Behaviour sensor `failTypeFromDesc` anchors to trailing `| type:` form** and uses last-match fallback.
  Why: Body text containing `"type:"` (e.g. `"item type: Lecture video ... | type: factual"`) caused misclassification.
- [ ] **`ACTION_ITEM_CLAIM_RE` matches broad ownership language**: `owns`, `ownership`, `responsible for`, `following up on` — not just `action item`.
  Why: Narrow pattern missed legitimate ownership claims, producing false sensor negatives.
