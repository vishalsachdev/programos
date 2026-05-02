# 05 — Audit logging

Every inbound and every outbound message gets a markdown file in the curriculum repo. This is the only persistent store outside of NanoClaw's SQLite, and it's what survives container destruction. Treat it as the legal record.

## Where

Inside the curriculum repo: `discussions/audit-log/<channel>/<ISO-timestamp>-<direction>.md`

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

Curriculum-repo citations don't need a snapshot — the git commit SHA at read time pins the content. The audit-log entry already records the head SHA via the per-run commit.

**Channel-handler responsibility, not agent responsibility.** The agent quotes the excerpt in its reply (see channel-prompt templates in `examples/groups/`); the handler hashes the file at read time and writes the snapshot block before the audit-log commit. Don't trust the agent to compute the sha256.

## Commit strategy

Audit-log files are committed at the **end** of each container run. One commit per run, message: `chore(audit-log): <channel>/<timestamp>` covering both the inbound and the outbound for that run. This keeps the git history readable without an entry per file.

In status-update mode, commit substantive changes (`DECISIONS.md`, `ACTION_ITEMS.md`, `OPEN_QUESTIONS.md`) **before** the audit-log commit. That ordering means an accreditation reviewer scrolling through `git log` sees decisions cleanly grouped, with audit-log entries as separate trailing commits per conversation.

## What NOT to log

- LLM API keys, channel auth tokens, HMAC secrets — even partial.
- Raw HTTP request bodies for channel auth (they may include rotating tokens).
- Anything sent in a system-only channel (e.g., health-check pings).

If you need to log a redacted variant, store it under `audit-log/<channel>/redacted/` with explicit redaction markers.

## Retention

The audit log is in git, so it's permanent by default. If you have a retention policy that requires deletion (e.g., student-channel logs after N years), do it via a scheduled `git filter-branch` or `git filter-repo` run on a maintenance branch — don't delete files inline, since that just hides them in history.

## Why markdown, not a database

Markdown is reviewable by anyone with `git log` and `cat`. Curriculum reviewers, accreditation auditors, and program directors all prefer reading text files in a folder to running queries. The agent itself can also read the audit log to answer questions like "what did we decide last semester about X?" — no separate query layer needed.
