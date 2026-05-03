# 08 — Deployment tiers

ProgramOS deploys at three tiers. Same NanoClaw image, same ProgramOS spec, same program repo — only the channel transports and host runtime change. Start at the lowest tier you can; promote when you outgrow it.

## Why tiers matter

Most adoption failures aren't technical — they're procurement and IT-access failures. A faculty member who can run the bot on their laptop *today* will outlast one who's waiting six weeks for an Azure subscription approval.

Tier 1 exists so you can demo, pilot, and accumulate audit-log evidence before you spend political capital on infrastructure.

## Tier 1 — Laptop

**Goal**: anyone with Docker, a GitHub account, and an LLM API key can run a coordinator bot for their unit by end of day, with no IT involvement.

| What | How |
|---|---|
| Runtime | NanoClaw in Docker Desktop (macOS/Windows/Linux). |
| Process supervision | `launchd` (macOS) or `systemd --user` (Linux). Restart on crash, restart on login. |
| Channels enabled | Telegram (long-poll, no inbound networking), Email via IMAP polling (see [`03-channels.md`](./03-channels.md)). |
| Channels deferred | Web chat (needs a public URL), Teams (needs app registration), Copilot Studio. |
| Public ingress | **None.** No reverse proxy, no domain, no port forwarding. Bot reaches out to Telegram and IMAP; nothing reaches in. |
| Persistence | Program repo on local disk; pushed to a private GitHub repo on every commit. NanoClaw SQLite alongside it. |
| Secrets | `.env` file in the bot directory, mode 600. macOS Keychain or `pass` (Linux) for the LLM API key. |
| Cost | LLM API + GitHub. ~$0 in infra. |

**Adoption pitch**: "Telegram first, email next week. Bot runs on your laptop. The program repo is yours, in your private GitHub. Stop the process and the bot stops; everything it learned is in git."

**When to graduate**: laptop sleeps and stakeholders notice; you want stakeholders outside Telegram (web chat, Teams); you want multi-user reliability.

## Tier 2 — VPS

**Goal**: 24/7 uptime on infrastructure the unit owns, without going through cloud procurement.

| What | How |
|---|---|
| Runtime | NanoClaw in Docker on a small VPS (Hetzner, DigitalOcean, Linode, Vultr — $6–20/mo). |
| Process supervision | `systemd` system service. |
| Channels enabled | All Tier 1 channels + Email via webhook, Web chat, Teams (Outgoing Webhook). |
| Channels deferred | Teams (Bot Framework) and Copilot Studio still need M365 admin app registration; defer until you have admin support. |
| Public ingress | Caddy or nginx reverse proxy on `:443` with Let's Encrypt. One vhost per channel path. |
| Persistence | Program repo cloned on the VPS; commits pushed to private GitHub. NanoClaw SQLite on a persistent volume. Daily snapshot to the program repo (or a separate backup target). |
| Secrets | `.env` mode 600 + restricted ssh access. Optionally [age](https://github.com/FiloSottile/age) or [sops](https://github.com/getsops/sops) for committed-encrypted secrets. |
| Cost | $6–20/mo VPS + LLM API + domain. |

**Migration from Tier 1**: copy the program repo URL, copy the `.env`, switch the email channel from IMAP to webhook (see [`03-channels.md`](./03-channels.md) — same agent prompts and allowlist, only the transport changes), point a subdomain at the VPS. Half a day if you've done it before.

**When to graduate**: stakeholders span multiple time zones and one VPS goes down badly; compliance requires logged infra access; the unit standardizes on a specific cloud.

## Tier 3 — Cloud

**Goal**: managed runtime on the cloud the unit's institution already pays for.

| What | How |
|---|---|
| Runtime | The same Docker image, on Azure Container Apps / AWS ECS Fargate / Google Cloud Run / Fly.io. |
| Process supervision | The platform. |
| Channels enabled | Everything in Tier 2 + Teams (Bot Framework) + Copilot Studio (when M365 admin registers the app). |
| Public ingress | Platform-managed TLS + custom domain. |
| Persistence | Program repo as before (still git-backed). Move SQLite to a managed service (Azure SQL / RDS / Cloud SQL) or accept that container restarts lose it (audit log in git is the source of truth). |
| Secrets | The platform's secret store (Azure Key Vault / AWS Secrets Manager). |
| Cost | $20–100/mo container + LLM API + domain + (optional) managed DB. |

**Migration from Tier 2**: containerize what you have (you already are), point CI at the cloud's deploy hook, move secrets from `.env` to the secret store, retest each channel webhook signature with the new public URL.

**When to graduate**: you don't. Tier 3 is the ceiling for a single-program coordinator.

## What stays constant across tiers

- The program repo layout (`program/`, `discussions/`, `skills/`, `audit-log/`).
- The agent operating modes (question vs status-update; read-only vs workspace-write sandbox).
- Per-channel `groups/<channel>/CLAUDE.md` prompts.
- Audit log format.
- Skill-PR learning loop ([`07-learning-loop.md`](./07-learning-loop.md)).

What changes is *only* the channel transport and the host runtime. That's the point: a Tier-1 deployment is a real deployment, not a toy. You can hand the audit log from a six-month laptop pilot to a Tier-3 deployment and nothing breaks.

## Security posture by tier

| Concern | Tier 1 | Tier 2 | Tier 3 |
|---|---|---|---|
| Container isolation | NanoClaw Docker sandbox (same all tiers). Agent can only see what's mounted; no host filesystem access. | same | same |
| Network exposure | None (no inbound). Bot calls out to Telegram, IMAP, LLM API. | One public ingress (reverse proxy + TLS). | Platform-managed ingress. |
| Secrets at rest | `.env` mode 600 on a personal device. Encrypt the disk. | `.env` mode 600 + ssh-only access + optional sops. | Cloud secret store. |
| Auth on inbound | N/A — no inbound. | HMAC per channel; rotate quarterly. | HMAC + cloud-platform identity controls. |
| Data residency | Wherever your laptop is. | Wherever the VPS is — pick deliberately. | Pick the region during cloud setup. |
| Audit trail integrity | Git commits to a private GitHub repo. Tamper-evident via `git log` + signed commits if you enable them. | same | same |

The Tier 1 security story is genuinely stronger than people expect: Docker sandbox + zero inbound + git-backed audit + LLM-API-only egress. The thing it can't promise is uptime.
