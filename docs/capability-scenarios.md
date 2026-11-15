# Coordinator Capability Scenarios — Test Plan

End-to-end capability coverage for the NanoClaw / Program instance ("Coordinator"). Each
scenario is a **realistic narrative** that flows through the same module seams
production does, in production order, rather than asserting one function in
isolation. The executable suite lives in `src/capability-scenarios.test.ts` and
runs under `npm test` alongside the existing unit suites.

## Why a separate suite

The per-module `*.test.ts` files already pin each unit's contract. This suite
sits one level up: it **composes** units into the flows a stakeholder actually
triggers (an allowlisted faculty reply, an out-of-office bounce, the Friday
observer digest, the Monday action-item nudge) and asserts the *flow's* outcome.
A regression that only shows up when modules are wired together — wrong decision
order, a fail-open seam, a thread that forks instead of continuing — is caught
here even when every unit test still passes.

## Methodology

The bar and method were fixed **before** running anything:

- **Success criteria:** each scenario lists an explicit, binary Given/When/Then.
  The assertions in the corresponding `it()` are the success criteria — there is
  no separate subjective rubric.
- **Evaluation method:** automated **pass/fail** via Vitest assertions. A
  scenario passes iff its `it()` passes.
- **Same conditions for every run:** the suite is hermetic. Resend (`fetch`),
  `.env`, and the pinned-SHA repo mirror are stubbed identically for every run,
  so no scenario depends on network, wall-clock, or a real program-repo checkout.
  Time-sensitive scenarios pin `now`/dates explicitly.
- **Evidence:** the `npm test` output (scenario count + pass count) is
  the evidence.
- **Fix loop:** any scenario that misses the bar → fix the **root cause** in
  `src/`, rerun the affected scenario, then rerun the **complete** suite
  (`npm test`) before declaring done.

## Capability coverage matrix

| # | Capability (source) | Scenario | Failure path exercised |
|---|---------------------|----------|------------------------|
| S01 | Email ingest — accept (`webhook-allowlist`, `email-loop-detection`, `webhook-threading`) | Allowlisted faculty reply is accepted with a stable thread JID | — |
| S02 | Email ingest — sender gate (`webhook-allowlist`) | Unknown external sender rejected, fail-closed | ✓ reject |
| S03 | Loop guard — auto-reply (`email-loop-detection`) | Allowlisted sender's Outlook OOO is dropped *despite* being allowlisted | ✓ drop |
| S04 | Loop guard — list/bulk (`email-loop-detection`) | `List-Id` / `X-Autoreply` listserv traffic dropped | ✓ drop |
| S05 | Allowlist outage fallback (`webhook-allowlist`) | Source unreadable → closed rejects, permissive accepts | ✓ both modes |
| S06 | Thread continuity (`webhook-threading`) | A reply carrying `References` lands on the original thread JID | — |
| S07 | Thread derivation (`webhook-threading`) | A fresh email with no references gets a stable synthetic `from|subject` JID | — |
| S08 | Allowlist parsing (`webhook-allowlist`, `telegram-allowlist`) | Email table + Telegram-handle section parsed without cross-contamination | ✓ co-located disambiguation |
| S09 | Outbound — single send (`outbound-email`, `audit-log`) | Allowlisted recipient → one Resend call, bot Reply-To, audited | — |
| S10 | Outbound — multi-To digest (`outbound-email`) | Both observers in one To → single send to both | — |
| S11 | Outbound — multi-To fail-closed (`outbound-email`) | One bad address aborts the **whole** send | ✓ abort |
| S12 | Outbound — CC gate (`outbound-email`) | Non-allowlisted CC dropped, To-only send proceeds | ✓ drop CC |
| S13 | Outbound — Reply-To pinning (`outbound-email`) | `forceBotReplyTo` overrides an injected `reply_to` | ✓ injection |
| S14 | Outreach batch parsing (`send-email-capability`) | Fenced/bare JSON parsed; entry missing `body` rejected | ✓ malformed |
| S15 | Outreach task protection (`send-email-capability`) | Non-main blocked from mutating the approved task; main allowed | ✓ squat |
| S16 | Attachment safety (`attachment-safety`) | `../`-traversal name → timestamped fallback; safe name kept | ✓ traversal |
| S17 | Document extraction (`document-extractor`) | csv/xlsx extracted; unsupported type & 20 MB cap return messages | ✓ unsupported/oversize |
| S18 | Telegram sender gate (`telegram-allowlist`) | Handle parsed & matched; no-username sender dropped (closed) | ✓ drop |
| S19 | Web-chat identity (`web-chat-session`) | Messy session id normalized → stable derived JID, recognized | — |
| S20 | Chat-config allowlist (`sender-allowlist`) | `drop` mode + per-chat trigger allow/deny honoured | ✓ drop/deny |
| S21 | Sensor — action items (`behaviour-sensor`) | Deterministic per-owner open-count index; claim-gate; section select | — |
| S22 | Sensor — verdict/skip (`behaviour-sensor`) | PASS/FLAG/FAIL parsed; empty & `lore:intentional` skipped | ✓ skip |
| S23 | Exceptions digest (`exceptions-report`) | Clean week → no wake; fail+hold+stale+contract-break → wake with samples | ✓ exceptional + governance contract |
| S24 | Scheduler & timezone (`task-scheduler`, `timezone`) | cron/interval/once next-run; Sat/Fri weekday guard | ✓ weekend guard |
| S25 | KB-triage approver CC (`kb-triage-cc`) | Structure conflict → structure approver; sender==approver → content fallback | ✓ self-CC fallback |

> Container/IPC/mount isolation (the "no send capability ever lives in a
> container" boundary) is asserted at the unit level in `ipc-auth.test.ts`,
> `ipc-send-email.test.ts`, `container-runner.test.ts`, and `mount-security`
> coverage; S14–S15 here exercise its outbound-facing edge.
