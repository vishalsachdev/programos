# ProgramOS

A spec for turning a [NanoClaw](https://github.com/qwibitai/nanoclaw) deployment into a multi-channel **academic program coordinator**: an AI agent that fields questions from faculty, advisors, staff, and other stakeholders, operates on a structured program repository, and keeps decisions auditable.

**Runs on your laptop in an afternoon (Telegram first, email next), graduates to a VPS or cloud when you're ready.** Same spec, same program repo, same audit log — only the channel transports and host runtime change as you scale up. See [`docs/08-deployment-tiers.md`](./docs/08-deployment-tiers.md).

> **This repo is a spec, not code.** ProgramOS is what you get when you fork NanoClaw and apply this spec to it. Adopters clone NanoClaw, hand [`SPEC.md`](./SPEC.md) to their coding agent, and adapt the result to their program.

## Security model in one paragraph

Agent runs in a NanoClaw Docker container — it can only see what you mount, can only call out to APIs you allow. Tier 1 (laptop) has zero inbound networking: the bot polls Telegram and IMAP, nothing reaches in. Every inbound message, every outbound reply, and every commit to the program repo is recorded in an append-only audit log under `discussions/audit-log/`, which lives in a private git repo you own. The agent operates in two modes per message — `read-only` for questions, `workspace-write` for explicit decision-capture — and can never modify its own runtime or auto-merge its own learning. Skill changes go through human-reviewed pull requests. Full posture by tier in [`docs/08-deployment-tiers.md`](./docs/08-deployment-tiers.md), learning-loop contract in [`docs/07-learning-loop.md`](./docs/07-learning-loop.md).

---

## Who is this for

You run an academic program (degree, certificate, executive education, online MOOC) and you want a single AI coordinator that:

- Answers stakeholder questions about program content, policies, and decisions, with citations into a source-of-truth repo.
- Captures decisions, action items, and open questions from emails and chat, then commits them back to that repo.
- Speaks email + Telegram + Teams + web chat from one process, with channel-appropriate formatting.
- Logs every inbound and outbound message for accreditation and audit.

You're already comfortable running a NanoClaw deployment (Docker, a VPS, a webhook URL, and an LLM API key).

---

## What's in this repo

| File | What it gives you |
|------|-------------------|
| [`SPEC.md`](./SPEC.md) | The canonical spec. Feed this to your coding agent. |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | How ProgramOS sits on top of NanoClaw — what's framework, what's adopter-supplied. |
| [`docs/01-prerequisites.md`](./docs/01-prerequisites.md) | NanoClaw fork, Docker, secrets, channel apps. |
| [`docs/02-program-repo.md`](./docs/02-program-repo.md) | Required structure of the program-side repo (`CONCEPT.md`, `EMAIL_ALLOWLIST.md`, `discussions/`, etc.). |
| [`docs/03-channels.md`](./docs/03-channels.md) | Per-channel contract: email webhook, Telegram, Teams, web chat. |
| [`docs/04-agent-modes.md`](./docs/04-agent-modes.md) | Question vs Status-update modes. When to commit, when not to. |
| [`docs/05-audit-logging.md`](./docs/05-audit-logging.md) | Inbound/outbound logging contract. |
| [`docs/06-customization.md`](./docs/06-customization.md) | What to rename, what to keep. Branding the agent persona. |
| [`docs/07-learning-loop.md`](./docs/07-learning-loop.md) | How the agent learns over time without breaking the audit trail (skills-as-PRs + FTS5 episodic recall). |
| [`docs/08-deployment-tiers.md`](./docs/08-deployment-tiers.md) | Laptop → VPS → Cloud. What changes between tiers (channels, ingress, secrets), what stays constant (program repo, audit log, skill loop). |
| [`docs/09-illinois-quickstart.md`](./docs/09-illinois-quickstart.md) | UIUC-specific recipe for letting an `@illinois.edu` address talk to the bot without an M365 admin app registration (forwarding rule + external inbound). |
| [`docs/10-content-sources.md`](./docs/10-content-sources.md) | How to relate an external content store (Box, SharePoint, network share) to ProgramOS. Three patterns; recommended default is "coexist + bot-as-frontend" — team keeps editing in Box, bot reads both stores and labels every claim. |
| [`docs/11-multi-program-mesh.md`](./docs/11-multi-program-mesh.md) | Deploying multiple ProgramOS agents across programs at one institution. Two-level KB hierarchy, per-agent Nostr identity, A2A cross-agent routing, and shared-policy deduplication. |
| [`scripts/init.sh`](./scripts/init.sh) | One-command bootstrap for a new adopter — scaffolds a program repo and seeds it with a brainstorm prompt. |
| [`examples/BRAINSTORM.md`](./examples/BRAINSTORM.md) | Discovery prompt the bootstrap drops into the new repo; hand it to your coding agent. |
| [`examples/groups/`](./examples/groups/) | Generic per-channel agent instruction templates. |
| [`examples/program-repo/`](./examples/program-repo/) | Reference layout for the program-side repository. |

---

## Quickstart — laptop tier (no IT involvement, ~1 afternoon)

Goal: a working Telegram bot for your unit by end of day, with email to follow within a week.

1. **Bootstrap your program repo**:
   ```
   git clone https://github.com/vishalsachdev/programos.git
   ./programos/scripts/init.sh <unit-slug> ~/code/<unit-slug>
   ```
   Scaffolds a fresh git repo with the canonical layout (`program/`, `discussions/`, `skills/`, audit-log subdirs) and drops a `BRAINSTORM.md` in it.
2. **Hand `BRAINSTORM.md` to your coding agent** (Claude Code, Cursor, Codex — any agent that can read markdown and edit files). It interviews you about stakeholders, channels, and content (Group C asks which deployment tier you're starting at — pick laptop), then fills in the placeholders. Agent-agnostic by design.
3. **Fork NanoClaw and apply the spec**: `gh repo fork qwibitai/nanoclaw --clone && cd nanoclaw`, then ask your agent:
   ```
   Read https://github.com/vishalsachdev/programos/blob/main/SPEC.md
   and https://github.com/vishalsachdev/programos/blob/main/docs/08-deployment-tiers.md
   then adapt this NanoClaw fork to that spec at Tier 1 (laptop). My program repo
   is at <path>; the channels, persona, and content-source pattern are defined in
   its PROGRAMOS_SETUP.md (produced by the BRAINSTORM step). Enable Telegram
   (long-poll) first; add email via IMAP polling next if PROGRAMOS_SETUP.md says so.
   ```
4. **Iterate** on per-channel `groups/<channel>/CLAUDE.md` files using the docs in this repo as reference. When you outgrow the laptop tier (24/7 uptime, web chat, team channels), graduate to Tier 2 — same spec, swap channel transports per [`docs/08-deployment-tiers.md`](./docs/08-deployment-tiers.md).

UIUC units that want `@illinois.edu` email working without a Microsoft 365 admin app registration: see [`docs/09-illinois-quickstart.md`](./docs/09-illinois-quickstart.md).

---

## Why a spec, not a fork

NanoClaw is the engine. Most of the work to make it a program coordinator is *outside* the framework — it's in:

- the structure of the program repo,
- the per-channel agent prompts,
- the decision/action/audit pipeline,
- the channel-specific input filters (allowlists, HMAC, JWT).

Cloning a templated repo gets stale fast (NanoClaw moves, your program is different). A spec stays useful: your agent reads it, reads the current NanoClaw, and produces an adaptation that matches both. The instance referenced in [`ARCHITECTURE.md`](./ARCHITECTURE.md) (a Master's-program coordinator running this spec in production) only had ~600 lines of MSBAi-specific code on top of NanoClaw — the rest was config and prompts.

---

## Production reference

This spec was extracted from a production deployment serving an online Master's program at a U.S. business school. The deployment handles email + Telegram + web chat (Teams and Copilot Studio handlers were built early on and retired in June 2026, once it was clear stakeholders didn't use them), runs in Docker on a small VPS, and commits to a private program repo. Source for that instance is private (it contains stakeholder PII and program-specific strategy); the spec here is the part that generalizes.

---

## Status

v0.1 — initial spec. Channels covered: email (webhook), Telegram, Teams (Bot Framework), Teams (Outgoing Webhook), Web Chat, Microsoft Copilot Studio. Not yet covered: Slack, Discord, WhatsApp (NanoClaw upstream supports these but the program-coordinator workflows haven't been spec'd here).

## License

MIT. The NanoClaw framework has its own license — see upstream.
