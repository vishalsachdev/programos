# ProgramClaw

A spec for turning a [NanoClaw](https://github.com/qwibitai/nanoclaw) deployment into a multi-channel **academic program coordinator**: an AI agent that fields questions from faculty, advisors, staff, and other stakeholders, operates on a structured curriculum repository, and keeps decisions auditable.

> **This repo is a spec, not code.** ProgramClaw is what you get when you fork NanoClaw and apply this spec to it. Adopters clone NanoClaw, hand [`SPEC.md`](./SPEC.md) to their coding agent, and adapt the result to their program.

---

## Who is this for

You run an academic program (degree, certificate, executive education, online MOOC) and you want a single AI coordinator that:

- Answers stakeholder questions about curriculum, policies, and decisions, with citations into a source-of-truth repo.
- Captures decisions, action items, and open questions from emails and chat, then commits them back to that repo.
- Speaks email + Telegram + Teams + web chat from one process, with channel-appropriate formatting.
- Logs every inbound and outbound message for accreditation and audit.

You're already comfortable running a NanoClaw deployment (Docker, a VPS, a webhook URL, and an LLM API key).

---

## What's in this repo

| File | What it gives you |
|------|-------------------|
| [`SPEC.md`](./SPEC.md) | The canonical spec. Feed this to your coding agent. |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | How ProgramClaw sits on top of NanoClaw — what's framework, what's adopter-supplied. |
| [`docs/01-prerequisites.md`](./docs/01-prerequisites.md) | NanoClaw fork, Docker, secrets, channel apps. |
| [`docs/02-curriculum-repo.md`](./docs/02-curriculum-repo.md) | Required structure of the program-side repo (`CURRICULUM.md`, `EMAIL_ALLOWLIST.md`, `discussions/`, etc.). |
| [`docs/03-channels.md`](./docs/03-channels.md) | Per-channel contract: email webhook, Telegram, Teams, web chat. |
| [`docs/04-agent-modes.md`](./docs/04-agent-modes.md) | Question vs Status-update modes. When to commit, when not to. |
| [`docs/05-audit-logging.md`](./docs/05-audit-logging.md) | Inbound/outbound logging contract. |
| [`docs/06-customization.md`](./docs/06-customization.md) | What to rename, what to keep. Branding the agent persona. |
| [`examples/groups/`](./examples/groups/) | Generic per-channel agent instruction templates. |
| [`examples/curriculum-repo/`](./examples/curriculum-repo/) | Reference layout for the program-side repository. |

---

## Quickstart (5 minutes to a runnable plan)

1. **Fork NanoClaw**: `gh repo fork qwibitai/nanoclaw --clone && cd nanoclaw`
2. **Create your program-side repo** following [`examples/curriculum-repo/SKELETON.md`](./examples/curriculum-repo/SKELETON.md). This is where curriculum lives and where the agent commits decisions.
3. **Hand the spec to your agent**:
   ```
   Read https://github.com/vishalsachdev/programclaw/blob/main/SPEC.md
   then adapt this NanoClaw fork to that spec. My program is <name>, my channels are
   <list>, my curriculum repo is at <path>.
   ```
4. **Iterate** with the agent on the per-channel `groups/<channel>/CLAUDE.md` files and the audit log paths, using the docs in this repo as reference.

---

## Why a spec, not a fork

NanoClaw is the engine. Most of the work to make it a program coordinator is *outside* the framework — it's in:

- the structure of the curriculum repo,
- the per-channel agent prompts,
- the decision/action/audit pipeline,
- the channel-specific input filters (allowlists, HMAC, JWT).

Cloning a templated repo gets stale fast (NanoClaw moves, your program is different). A spec stays useful: your agent reads it, reads the current NanoClaw, and produces an adaptation that matches both. The instance referenced in [`ARCHITECTURE.md`](./ARCHITECTURE.md) (a Master's-program coordinator running this spec in production) only had ~600 lines of MSBAi-specific code on top of NanoClaw — the rest was config and prompts.

---

## Production reference

This spec was extracted from a production deployment serving an online Master's program at a U.S. business school. The deployment handles email + Telegram + Teams + web chat + Microsoft Copilot Studio, runs in Docker on a small VPS, and commits to a private curriculum repo. Source for that instance is private (it contains stakeholder PII and program-specific strategy); the spec here is the part that generalizes.

---

## Status

v0.1 — initial spec. Channels covered: email (webhook), Telegram, Teams (Bot Framework), Teams (Outgoing Webhook), Web Chat, Microsoft Copilot Studio. Not yet covered: Slack, Discord, WhatsApp (NanoClaw upstream supports these but the program-coordinator workflows haven't been spec'd here).

## License

MIT. The NanoClaw framework has its own license — see upstream.
