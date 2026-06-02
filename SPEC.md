# ProgramOS — Canonical Spec

> Hand this file to your coding agent along with a fresh fork of [NanoClaw](https://github.com/qwibitai/nanoclaw). The agent should produce an adaptation matching this spec.

## 1. Goal

Turn a NanoClaw deployment into a **multi-channel AI program coordinator** that:

1. Receives messages from stakeholders (faculty, staff, advisors, admissions, etc.) across email, Telegram, Teams, and web chat.
2. Routes each message to a Claude Code agent running in a Docker container with a program repository mounted.
3. Operates in one of two modes per message: **Question** (read-only, cite, reply) or **Status update** (extract decisions/actions/questions, commit, push, summarize).
4. Logs every inbound and outbound message to an audit trail inside the program repo.
5. Replies via the original channel with channel-appropriate formatting.

## 2. Components

| Component | Source |
|-----------|--------|
| Container runtime, channel registry, message router, group queue, SQLite store | NanoClaw upstream — **do not modify** unless absolutely necessary |
| Per-channel handler (email/Telegram/Teams/web chat/Copilot Studio) | Adopter-supplied in `src/channels/` |
| Per-channel agent instructions | Adopter-supplied in `groups/<channel>/CLAUDE.md` |
| Audit log writer | Adopter-supplied in `src/audit-log.ts` |
| Program repository | Separate adopter-owned repo, mounted into containers at `/workspace/extra/<repo-name>` |
| Email allowlist | Markdown file *inside the program repo*, not in this codebase |
| Skills directory | `skills/` *inside the program repo*. Read in question mode; written by the agent only via PR in status-update mode. See [`docs/07-learning-loop.md`](./docs/07-learning-loop.md). |
| Audit-log search index | Optional SQLite FTS5 index over `discussions/audit-log/`, exposed to the agent as a `search_audit_log(query)` tool. Derived data; rebuildable. |
| Extra content mounts | Optional read-only bind mounts under `/workspace/extra/<source-name>/` for external content stores (Box, SharePoint, network shares, partner repos). Adopter-supplied. The program repo remains the source of truth for *bot operations* (decisions, audit, skills); extra mounts hold *content* the team edits elsewhere. Precedence rule, snapshot-with-cite, and source-labeling requirements in [`docs/10-content-sources.md`](./docs/10-content-sources.md). |

## 3. Channel contract

Every channel handler MUST:

- Accept inbound traffic on a path under the single shared HTTP server (default port `3003`).
- Validate authenticity (HMAC for webhooks, JWT for Teams, bot token for Telegram, API key for web chat).
- Apply input filters before dispatch (allowlist for email, allowed user IDs or handles for Telegram, etc.).
- Construct a NanoClaw `Message` with channel-specific JID format: `<channel>-<program>@<program>` (e.g., `webhook-email@msbai`, `tg-msbai@msbai`).
- Hand off to the orchestrator and await the agent's reply.
- Format reply per channel (HTML for email, Markdown for Telegram, AdaptiveCards for Teams, plain JSON for web chat).
- Send via the channel's outbound API.
- Trigger audit-log writes for both inbound and outbound.

See [`docs/03-channels.md`](./docs/03-channels.md) for per-channel details.

## 4. Agent operating modes

Every container invocation operates in exactly one of these modes, chosen by the channel handler based on message content:

### Question mode (default)
- **Trigger**: any inbound that isn't an explicit status update.
- **Behavior**: search the program repo, compose an answer with file-path citations, reply. **No commits.**
- **Container sandbox**: `read-only`.

### Status-update mode
- **Trigger**: explicit signal from sender (subject line prefix, command keyword, or channel-specific marker), OR sender role of "decision-maker" *and* message contains decision-shaped language.
- **Behavior**: extract decisions, action items, and open questions; commit each to the appropriate file in the program repo with a granular commit per category; push; reply with a structured summary of what was captured.
- **Container sandbox**: `workspace-write`.

See [`docs/04-agent-modes.md`](./docs/04-agent-modes.md) for the full decision tree.

## 5. Program repository contract

The program repo is mounted read-write into agent containers. It MUST contain:

| Path | Purpose |
|------|---------|
| `program/CONCEPT.md` | Source of truth: program structure, courses, credits, sequencing |
| `program/EMAIL_ALLOWLIST.md` | Markdown table of authorized email senders. **Filename is load-bearing** — channel code reads this exact path. |
| `discussions/DECISIONS.md` | Append-only log of program decisions, written by the agent in status-update mode |
| `discussions/ACTION_ITEMS.md` | Open action items extracted from messages |
| `discussions/OPEN_QUESTIONS.md` | Unresolved questions surfaced by the agent |
| `discussions/audit-log/` | One subdirectory per channel; one file per inbound and per outbound message |
| `skills/` | One markdown file per skill the agent has learned. Agent reads in question mode; agent proposes new/edited skills via PR in status-update mode. Never auto-merged. Format and contract in [`docs/07-learning-loop.md`](./docs/07-learning-loop.md). |

See [`docs/02-program-repo.md`](./docs/02-program-repo.md) and [`examples/program-repo/SKELETON.md`](./examples/program-repo/SKELETON.md).

## 6. Audit log contract

For every inbound message, write a file to `discussions/audit-log/<channel>/<timestamp>-in.md` containing:
- channel, sender identifier, timestamp, raw message body, attachments list.

For every outbound reply, write `discussions/audit-log/<channel>/<timestamp>-out.md` containing:
- channel, recipient, timestamp, reply body, mode used (question/status), files modified (if any), commit SHAs (if any).

The audit log is the only persistent store outside of NanoClaw's SQLite — it's what survives container destruction and what gets reviewed for accreditation.

See [`docs/05-audit-logging.md`](./docs/05-audit-logging.md).

## 6.5. Learning loop

The agent improves over time without breaking the audit trail. Two mechanisms, both grounded in the program repo:

- **Skills as PRs**: in status-update mode, the agent MAY propose a new file under `skills/` (or an edit to an existing one) by writing to a feature branch and opening a pull request. A human merges. Direct commits to the default branch from the agent are forbidden. In question mode, the agent reads `skills/` but cannot write.
- **Episodic recall via FTS5**: an optional SQLite FTS5 index over `discussions/audit-log/`, exposed as a `search_audit_log(query)` tool, lets the agent find prior conversations on the same topic. The index is derived from the audit log and is rebuildable.

Autonomous self-modification of agent prompts, channel handlers, or runtime code is **out of scope** for production. A separate `skills-experimental/` overlay can host research on autonomous skill evolution; it MUST be isolated from production agent invocations.

Full contract, skill file format, and grant/accreditation framing in [`docs/07-learning-loop.md`](./docs/07-learning-loop.md).

## 7. Per-channel agent prompts

Each channel has a `groups/<channel>/CLAUDE.md` file that becomes the agent's system prompt when handling that channel's messages. These prompts MUST:

- Identify the channel and the agent persona.
- Reference the program repo path (mounted at `/workspace/extra/<repo>`).
- Define the question-vs-status-update decision rule for this channel.
- Specify the reply format (HTML, Markdown, AdaptiveCard).
- Specify the audit-log writing behavior.
- List channel-specific quirks (Teams character limits, Telegram entity escaping, email reply threading).

Templates live in [`examples/groups/`](./examples/groups/).

## 8. Customization checklist for the adopter

Before going live, the adopter MUST replace:

- [ ] Program name throughout (default placeholder: `<PROGRAM>`)
- [ ] Agent persona name (default placeholder: `<AGENT_NAME>`)
- [ ] Program repo name and path
- [ ] Email domain for inbound webhook (must match outbound `From` domain in the email service)
- [ ] Telegram bot token, Teams app credentials, web chat API key
- [ ] HTTP port (default `3003`)
- [ ] Channel JID prefixes if running multiple ProgramOS instances on the same NanoClaw deployment

See [`docs/06-customization.md`](./docs/06-customization.md).

## 9. Out of scope (intentionally)

This spec does **not** cover:

- Student-facing channels (different threat model — see future spec).
- Generative content creation (the agent reads/cites existing program content, does not invent).
- Autonomous skill creation or self-modification of runtime code (see §6.5 — agent proposes via PR, humans merge).
- Grade pass-back or LMS integration (separate concern; see Canvas MCP if you need that).
- Multi-tenant deployments serving multiple programs from one container (possible but not specified here).

## 10. Reference implementation

A production deployment running this spec serves an online Master's program at a U.S. business school. Source is private; behavior matches every requirement in this document. Excerpts and architecture diagrams in [`ARCHITECTURE.md`](./ARCHITECTURE.md).
