# 05 — Audit logging

Every inbound and every outbound message gets a markdown file in the program repo. Treat it as the **legal record** — the human-readable, git-backed, tamper-evident copy of "what the bot did, when, and why."

## Why ProgramOS audit-logs separately from the runtime

NanoClaw v2 already persists every message in per-session SQLite (`inbound.db` + `outbound.db`) plus a central DB for routing and approvals. v1 / msbai-style adopters typically have similar runtime persistence. **ProgramOS does not duplicate this write path.** The runtime DB is the operational store; the markdown audit log is a **derivative, permanent, accreditation-grade view** that:

- Is **human-readable** — an NSF reviewer or accreditor can read it with `git log` and `cat`, no schema knowledge required.
- Is **git-backed** — commits give tamper-evidence, history, and survive container destruction or DB pruning.
- Is **funder-portable** — the program repo travels independently of the bot. Swap the bot to a different framework and the audit trail keeps working.

The audit-log files are *generated* from the runtime store, not written redundantly during the dispatch path.

## Implementation pattern: post-session exporter

Implement audit-logging as a small **exporter** that runs after each agent session closes (or on a periodic cron, whichever fits your runtime):

- **v2 adopters**: hook the exporter to v2's session-close path. It opens the session's `inbound.db` and `outbound.db`, reads the messages for that session, and writes one markdown file per inbound + one per outbound to the program repo's `discussions/audit-log/<channel>/`. Then commits.
- **v1 / msbai-style adopters**: write the exporter inline in the channel handler, after dispatch completes. Same target schema.
- **Other runtimes** (Express bot, custom framework): wherever your runtime persists messages, the exporter reads from there.

Either way: **the spec doesn't care how messages are persisted at runtime; it cares that a reviewer-readable, git-backed, append-only markdown trail exists in the program repo.**

## Where

Inside the program repo: `discussions/audit-log/<channel>/<ISO-timestamp>-<direction>.md`

- `<channel>` is one of `email`, `telegram`, `teams`, `teams-webhook`, `webchat`, `copilot-studio`.
- `<ISO-timestamp>` is `2026-04-25T16-30-22Z` (replace colons with hyphens for filesystem compatibility).
- `<direction>` is `in` or `out`.

## Inbound file body

```markdown
---
channel: email
direction: in
timestamp: 2026-04-25T16:30:22Z
sender: chair@yourorg.example
sender_name: <NAME>
mode: question
audit_id: 2026-04-25T16-30-22Z-in
---

# Subject (or first line)

<raw message body, lightly formatted>

## Attachments
- file1.pdf (12.4 KB)
- file2.docx (3.1 KB)
```

## Outbound file body

```markdown
---
channel: email
direction: out
timestamp: 2026-04-25T16:31:48Z
recipient: chair@yourorg.example
mode: question
in_reply_to: 2026-04-25T16-30-22Z-in
files_modified: []
commits: []
---

<reply body, as sent>
```

For status-update mode replies, include `files_modified` and `commits`:

```yaml
files_modified:
  - discussions/DECISIONS.md
  - discussions/ACTION_ITEMS.md
commits:
  - 8a3f2c1: "chore(decisions): add Spring 2027 course sequencing"
  - 4e5d8f9: "chore(actions): add notify advisors of sequencing change"
```

### Source snapshots (required when the reply cites an extra mount)

When the agent's reply cites a file from an extra read-only mount (Box, SharePoint, etc., per [`10-content-sources.md`](./10-content-sources.md)), the outbound entry MUST include a `source_snapshots` section. This freezes the cited content into the audit log so "what did the bot tell the dean on Mar 15, and what was it looking at?" stays answerable after the source file is edited.

```yaml
source_snapshots:
  - source: box
    path: syllabi/BADM550-S26.pdf
    read_at: 2026-05-02T14:31:07Z
    sha256: 9f1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c
    excerpt: |
      <verbatim quote of the cited passage, exactly as the agent read it>
```

Program-repo citations don't need a snapshot — the git commit SHA at read time pins the content. The audit-log entry already records the head SHA via the per-run commit.

**Exporter responsibility, not agent responsibility.** The agent quotes the excerpt in its reply (see channel-prompt templates in `examples/groups/`); the exporter parses the quoted excerpt out of the outbound message, hashes the file at session-close (or read time, if the runtime preserved that), and writes the snapshot block. Don't trust the agent to compute the sha256.

## Commit strategy

The exporter commits audit-log files at the **end** of each session (or on each cron tick that finds new messages). One commit per session, message: `chore(audit-log): <channel>/<timestamp>` covering both the inbound and the outbound for that session. This keeps the git history readable without an entry per file.

In status-update mode, the **agent** commits substantive changes (`DECISIONS.md`, `ACTION_ITEMS.md`, `OPEN_QUESTIONS.md`) **before** the session closes — those land first in `git log`. The exporter's audit-log commit comes after, as a trailing commit per conversation. That ordering means an accreditation reviewer scrolling through `git log` sees decisions cleanly grouped, with audit-log entries as separate, traceable trailing commits.

## What NOT to log

- LLM API keys, channel auth tokens, HMAC secrets — even partial.
- Raw HTTP request bodies for channel auth (they may include rotating tokens).
- Anything sent in a system-only channel (e.g., health-check pings).

If you need to log a redacted variant, store it under `audit-log/<channel>/redacted/` with explicit redaction markers.

## Retention

The audit log is in git, so it's permanent by default. If you have a retention policy that requires deletion (e.g., student-channel logs after N years), do it via a scheduled `git filter-branch` or `git filter-repo` run on a maintenance branch — don't delete files inline, since that just hides them in history.

## Why markdown, not (just) a database

The runtime probably already has a database — v2 has `inbound.db`/`outbound.db`, v1 has its own SQLite, etc. ProgramOS doesn't replace those; it **derives** a markdown view from them.

Markdown wins for the audit-log layer because:

- Reviewable by anyone with `git log` and `cat`. Reviewers, accreditation auditors, and program directors all prefer reading text files in a folder to running queries.
- Tamper-evident via git history (with signed commits if you enable them).
- Survives container/runtime destruction — the program repo is permanent.
- Portable — the runtime can be swapped (v1 → v2, NanoClaw → something else) and the audit trail keeps working.
- The agent itself can read the audit log to answer questions like "what did we decide last semester about X?" — no separate query layer needed.

The runtime database remains the operational store: low-latency, transactional, suited for routing and approvals. The markdown audit-log is the **memory of record**.
