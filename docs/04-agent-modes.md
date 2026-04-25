# 04 — Agent modes

Every agent run is in **exactly one** of two modes. The mode determines:

- The container's filesystem sandbox (`read-only` vs `workspace-write`).
- Whether the agent commits and pushes.
- The output format of the reply.

Pick the mode in the channel handler **before dispatch**, based on the message and the sender. Don't let the agent decide mid-run.

## Question mode

**Default. Use this unless you have a reason not to.**

- Sandbox: `read-only`.
- Behavior: search the curriculum repo, compose a cited answer, reply.
- No commits. No file writes outside the audit log.
- Output: prose answer with file-path citations like `program/CURRICULUM.md:42`.

Most stakeholder traffic is in this mode. Faculty asking "what's the prereq for Course 401?" Advisors asking about admission deadlines. Anyone on a channel with no decision authority.

## Status-update mode

- Sandbox: `workspace-write`.
- Behavior: extract decisions, action items, and open questions from the message; commit each category in a separate granular commit; push; reply with a structured summary.
- Output: structured summary listing what was committed, with commit SHAs.

## Decision rule (run this in the channel handler, not the agent)

```
If channel == web chat or telegram or copilot-studio (student/lightweight channels):
    → Question mode, always.

Else (email, Teams):
    Look up sender in EMAIL_ALLOWLIST.md (or channel-specific equivalent).
    Is sender's "Decision authority" column "yes"?
        No  → Question mode.
        Yes → Check message for explicit signal:
              • Subject line starts with "[DECISION]" or "[STATUS]"
              • Body starts with `/decide` or `/status`
              • Body contains decision-shaped language: "we decided", "going forward",
                "as of <date>", "the policy is now"
              Yes → Status-update mode.
              No  → Question mode.
```

## Why this rule and not "let the agent decide"

- **Sandbox safety.** The container's write capability is set at spawn time. The agent can't ask for write access mid-run.
- **Predictability for users.** A chair sending a casual question shouldn't accidentally get their question committed as a "decision."
- **Audit clarity.** Mode is logged with every audit entry. "Why did the agent commit?" is answerable from the log alone, without re-reading the agent's reasoning.

## Granular commits in status-update mode

The agent writes three categories. Commit each separately:

- `chore(decisions): add <title>` — appended to `discussions/DECISIONS.md`
- `chore(actions): add <title>` — appended to `discussions/ACTION_ITEMS.md`
- `chore(questions): add <title>` — appended to `discussions/OPEN_QUESTIONS.md`

Audit-log files commit *separately* from these, with `chore(audit-log): <channel>/<timestamp>`. This way an accreditation reviewer can see only the substantive commits without log noise.

## Reply format in status-update mode

Reply must include:

```
Captured:
  Decisions (N):
    • <title>  — commit <sha>
    • ...
  Action items (N):
    • <title> (owner: <name>) — commit <sha>
  Open questions (N):
    • <title> — commit <sha>

Audit log: <commit-sha>
```

If the sender wants the bot to do something else with their decision (e.g., email an announcement), they should make a separate explicit request — don't auto-act on extracted content.
