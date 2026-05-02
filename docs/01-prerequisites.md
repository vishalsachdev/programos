# 01 — Prerequisites

What you need before you start. Requirements vary sharply by deployment tier — start at the lowest tier you can. Tier definitions in [`08-deployment-tiers.md`](./08-deployment-tiers.md).

## Tier 1 — Laptop (start here)

For a working Telegram bot in an afternoon, with no IT involvement.

### Code & runtime

- [ ] Docker — Docker Desktop (macOS/Windows), Colima, OrbStack, or Docker Engine. `docker --version` should report 20.10+.
- [ ] [`gh` CLI](https://cli.github.com/) authenticated (`gh auth login`) — needed to fork NanoClaw via the quickstart. Optional if you fork in the browser instead.
- [ ] Git configured globally with your name and email (`git config --global user.name`, `git config --global user.email`). The `init.sh` bootstrap commits the scaffold and will fail without these.
- [ ] A fork of [NanoClaw](https://github.com/qwibitai/nanoclaw) — your working repo.
- [ ] A separate **curriculum repository** (private GitHub repo) you control. Created by `scripts/init.sh` from this spec; mounted read-write into agent containers. See [`02-curriculum-repo.md`](./02-curriculum-repo.md).

### Secrets

Put these in a `.env` file alongside the NanoClaw fork (mode 600). Minimum for Tier 1:

```
ANTHROPIC_API_KEY=sk-ant-...           # or OPENAI_API_KEY etc., per your LLM provider
TELEGRAM_BOT_TOKEN=...                 # from @BotFather (see 03-channels.md)
TELEGRAM_ALLOWED_USER_IDS=12345,67890  # comma-separated; from @userinfobot
# Optional, only if you enable the IMAP email variant on Tier 1:
EMAIL_IMAP_HOST=imap.gmail.com
EMAIL_IMAP_USER=<unit>@example.org
EMAIL_IMAP_PASS=<app password>
EMAIL_SMTP_HOST=smtp.gmail.com
EMAIL_SMTP_USER=<unit>@example.org
EMAIL_SMTP_PASS=<app password>
```

No webhook URL, no domain, no public IP, no reverse proxy.

### Decisions to make before you start

- **Agent persona name.** Pick something short, memorable, and not tied to your institution if you ever expect to talk about the system publicly. Replace `<AGENT_NAME>` everywhere.
- **Channel JID prefix.** A short string identifying your program in NanoClaw's internal routing (e.g., `myprog`). All channels use JIDs like `tg-myprog@myprog`. Don't reuse across deployments on the same NanoClaw instance.
- **Email allowlist policy.** Names + roles of who can email the bot, if you enable email at Tier 1 via IMAP. Markdown in your curriculum repo; can change without redeploying.

### Smoke test

Before adding ProgramOS, run vanilla NanoClaw locally with just Telegram. If it can long-poll Telegram and spawn a container that echoes a message back, you're ready. If not, debug NanoClaw before layering ProgramOS on top.

## Tier 2 — VPS (graduate to this when laptop is the bottleneck)

Adds to Tier 1:

- [ ] A small VPS — 4 GB RAM is enough for a single ProgramOS instance with all six channels. Provision more if you expect concurrent containers.
- [ ] A reverse proxy (nginx or Caddy) for HTTPS termination on a public-facing subdomain.
- [ ] A process manager — PM2 if you want pid files and `pm2 logs`, systemd if you prefer that.
- [ ] A subdomain you can point at the VPS (e.g., `programcoordinator.yourorg.example`). All six channels share one HTTP server on a single port (default `3003`); the reverse proxy maps subdomain → port.
- [ ] **Email service** with both inbound (webhook) and outbound APIs. Postmark, Resend, and SendGrid all work; pick one with HMAC-signed webhooks. (For UIUC's `@illinois.edu`, see [`09-illinois-quickstart.md`](./09-illinois-quickstart.md).)
- [ ] **API key of your own choosing** for the web chat endpoint (use a long random string).
- [ ] **Decision-authority list.** Which sender identities are allowed to put the agent in status-update mode (vs read-only question mode). Usually a subset of the email allowlist.

Add to `.env`:

```
EMAIL_INBOUND_HMAC_SECRET=...
WEBCHAT_API_KEY=...
```

## Tier 3 — Cloud (Azure / AWS / GCP / Fly)

Adds to Tier 2:

- [ ] **Microsoft App Registration** + bot password if using Teams Bot Framework, plus an HMAC secret for Outgoing Webhooks.
- [ ] **Microsoft Copilot Studio** bot credentials if proxying through Copilot Studio.
- [ ] Cloud platform secret store (Azure Key Vault / AWS Secrets Manager / GCP Secret Manager) — replaces the `.env` file at this tier.
- [ ] CI/CD wired to the platform's deploy hook.

Most adopters never reach Tier 3. The earlier tiers are full deployments, not toys.
