# Coordinator Reminder Registry (template)

**Canonical list of every scheduled reminder or notification Coordinator sends** —
to stakeholders, to observers, and to the program admin. Fill the tables from
your own scheduler (`store/messages.db` → `scheduled_tasks`) and keep this file
current. The rows below are fictional examples; replace them.

> **GUARDRAIL — read before scheduling anything.**
> **Do not add a reminder to anyone (including the admin) without first reviewing this
> registry.** If a new request overlaps an existing job's _cadence + recipient_, **merge
> into that job** instead of creating a second one. Every new inward stream competes with
> the existing digests for attention; every new outward stream is one more thing in a
> stakeholder's inbox. Specifically:
>
> - **Inward (to the admin):** prefer folding into the Daily Digest or the Monday Health
>   Report. Two digests covering "what happened" is one too many.
> - **Outward (to stakeholders/observers):** requires admin approval, and the
>   public governance page's "Notifications you receive" section **must** be updated so
>   recipients know what they're subscribed to.
> - After any change, update this file **and** the governance reliability changelog.

All times are **server-local**. Direction: **outward** = to stakeholders;
**inward** = to the admin only; **internal** = writes to the repo, no notification.

## Live jobs

Scheduler tasks (rows of `scheduled_tasks`). Example rows, fictional:

| Task id                 | Cadence     | What                                                              | Recipient                                             | Direction   |
| ----------------------- | ----------- | ----------------------------------------------------------------- | ----------------------------------------------------- | ----------- |
| `task-example-weekly`   | Mon 08:00   | Weekly per-owner action-item alert                                | owners with open items (host-resolved from allowlist) | **outward** |
| `task-example-digest`   | Daily 20:00 | Daily digest (KB changes + interactions; sensor alerts unreviewed) | admin (email)                                         | inward      |

Host-side notifications that are not scheduler tasks go in a second table, so the
registry shows every stream a person can receive. Example row, fictional:

| Source                        | Cadence       | What                                                        | Recipient                    | Notes                            |
| ----------------------------- | ------------- | ----------------------------------------------------------- | ---------------------------- | -------------------------------- |
| host: `src/example-relay.ts`  | event + day 3 | Relay of a routed item to its approver, one reminder at day 3 | the approver (allowlist row) | **outward**; not `scheduled_tasks` |

List retired or cancelled jobs with a strikethrough and the reason, so nobody re-adds them.

## Recipient rules

- Resolve audiences at run time from `program/EMAIL_ALLOWLIST.md`. Do not hardcode a
  recipient list in a task prompt; a hardcoded list drifts from the allowlist.
- Monday action-item reminders: every human allowlist member is eligible when they own
  open items, regardless of access tier or observer status. Only automated agent
  principals are excluded. Per-person `monday-reminder:` markers are inert and must not
  be added or interpreted. Eligibility does not itself generate an email when the person
  has no open items.
- Before any message is sent, the host requires the composed batch to match the derived
  audience exactly. Missing, extra, duplicate, unavailable, or over-cap audiences fail
  the whole batch loudly.
- Enrollment in a weekly update is a separate approval decision from allowlisting, even
  when the mechanism is automatic.
- When this file and the live scheduler disagree, the scheduler wins and this file is
  stale. Correct this file.
- A high-frequency "one-shot monitor" that relies on the agent to cancel itself cannot
  self-terminate, because an in-container agent cannot change the scheduler. Give such
  tasks an end time on the host scheduler, or do not schedule them at high frequency.

## Consolidation

Keep inward streams few. When two inward jobs cover the same ground, merge them into one
report and pause the other. Record here which job survived and why. If a host hook keys
off a phrase in a task prompt, the merged prompt must keep that phrase.

## Loop-closing

Alerts that are fire-and-forget detect a problem but do not track whether it was closed,
so open loops build up unseen. The design adds **nothing the admin maintains** — no new
file, no new scheduled nag, no new surface:

- The **Monday Health Report** ends with a **🔁 Open loops — oldest first** list,
  _derived_ each week from sources that already exist (aging ACTION_ITEMS / OPEN_QUESTIONS
  / DECISIONS, open kb-triage holds, failed/paused tasks, dead-letters). Age = priority;
  position nags. It is **not** a maintained ledger.
- Closing a loop = acting on it (it drops off next week) or replying to have Coordinator close it.
- `/loop` is an **optional on-demand accelerator** (clear several with a host session at
  once), not a scheduled obligation — it never pings.

A heavier design (a new open-loops file, a scheduled triage ritual, disposition verbs) is
rejected: it adds things to track in order to fix a too-many-things problem.

## Why this registry exists

Reminders accrete one at a time. Without a single place that shows the whole picture,
each new "just add a reminder for X" risks a duplicate stream, and the admin and
stakeholders end up with more notifications than they can read. A proposed new job whose
role an existing job already covers should be declined. The guardrail above is the
general rule: **review the whole before adding to it.**
