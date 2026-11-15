# Program repo: rules for the coordinator agent

This repo is the source of truth for the team. The coordinator agent reads it to
answer questions and writes to it in status-update mode.

## KB Write Protocol

Follow these steps for every write to `discussions/DECISIONS.md`. (Do not rename
this heading: the host checks for it.)

1. Pull first. Work on the current state.
2. Search for related entries. This is to detect conflicts, not to choose where the entry goes.
3. Run the `kb-conflict-check` skill before staging. On a conflict, stop: the entry goes to `discussions/kb-triage/` for a person to review. Never resolve a conflict yourself.
4. On a clean check, append the new entry at the end of `DECISIONS.md`. Never edit or delete an earlier decision; supersede it with a new entry that names it.
5. Record the source: who said it, in which message, on what date.
6. Cross-reference: update related items in `ACTION_ITEMS.md` and `OPEN_QUESTIONS.md` in the same commit.
7. If the decision touches a topic in `docs/faq.md`, re-check that answer in the same pass.
8. If you changed a source-of-truth file, follow `reference/DEPENDENCY_GRAPH.md`.
9. One commit per logical change. Push after all commits.
10. Never change `program/curriculum.md`, `program/EMAIL_ALLOWLIST.md` or `program/kb-governance.md`. Flag the needed change to the admin in your reply.

## Entry format for a decision

```
### <short title>

- **Date:** YYYY-MM-DD
- **Category:** <topic>
- **Decision:** <one or two sentences>
- **Status:** Confirmed
- **Source:** <sender>, <channel>, <date>
- **Supersedes:** <earlier entry, if any>
```

The host reads two of these fields. The reply checker uses only entries whose
`**Status:**` starts with `Confirmed`. Write `Proposed` when the decision is not
final; write `Confirmed` only when the person who owns the topic said so. The
open-question scan uses only entries with a `**Date:**` line in `YYYY-MM-DD`
form. A date in the heading is not read.
