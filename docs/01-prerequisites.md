# 01 — Prerequisites

Before you start, line up the following. None of this is unusual — it's the standard NanoClaw deployment surface plus a curriculum repo.

## Code

- [ ] Fork of [NanoClaw](https://github.com/qwibitai/nanoclaw) — your working repo.
- [ ] A separate **curriculum repository** (private is fine) you control. It will be mounted read-write into agent containers. See [`02-curriculum-repo.md`](./02-curriculum-repo.md) for required structure.

## Runtime

- [ ] Docker (`docker --version` should report 20.10+).
- [ ] A small VPS — 4 GB RAM is enough for a single ProgramClaw instance with all six channels. Provision more if you expect concurrent containers.
- [ ] A reverse proxy (nginx or Caddy) for HTTPS termination on a public-facing subdomain.
- [ ] A process manager — PM2 if you want pid files and `pm2 logs`, systemd if you prefer that.

## Secrets

You'll need API keys / tokens for:

- [ ] **Anthropic** (or your LLM provider) — Claude Code agent calls.
- [ ] **Email service** with both inbound (webhook) and outbound APIs. Resend, Postmark, and SendGrid all work; pick one with HMAC-signed webhooks.
- [ ] **Telegram BotFather** token if using Telegram.
- [ ] **Microsoft App Registration** + bot password if using Teams Bot Framework, plus an HMAC secret for Outgoing Webhooks.
- [ ] **Microsoft Copilot Studio** bot credentials if proxying through Copilot Studio.
- [ ] An **API key of your own choosing** for the web chat endpoint (use a long random string).

## Domain

- [ ] A subdomain you can point at the VPS (e.g., `programcoordinator.yourorg.example`). All six channels will share one HTTP server on a single port (default `3003`); the reverse proxy maps subdomain → port.

## Decisions to make before you start

- **Agent persona name.** Pick something short, memorable, and not tied to your institution if you ever expect to talk about the system publicly. Replace `<AGENT_NAME>` everywhere.
- **Channel JID prefix.** A short string identifying your program in NanoClaw's internal routing (e.g., `myprog`). All channels will use JIDs like `webhook-email@myprog`. Don't reuse across deployments on the same NanoClaw instance.
- **Email allowlist policy.** Names + roles of who can email the bot. This is markdown in your curriculum repo; it can change without redeploying.
- **Decision-authority list.** Which sender identities are allowed to put the agent in status-update mode (vs read-only question mode). Usually a subset of the email allowlist.

## Smoke test (before committing to ProgramClaw)

Run vanilla NanoClaw on your VPS first. If you can talk to it on Telegram and it can spawn a container, you're ready. If you can't, debug NanoClaw before adding ProgramClaw on top — the layering will be much easier to reason about.
