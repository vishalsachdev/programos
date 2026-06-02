# 03 — Channels

Every channel handler is a single TypeScript file in `src/channels/` that does five things:

1. **Receive** — listen on a path under the shared HTTP server (port `3003` by default).
2. **Authenticate** — verify the request actually came from the channel provider.
3. **Filter** — apply allowlists and rate limits before spending an LLM call.
4. **Dispatch** — build a NanoClaw `Message` and hand it to the orchestrator.
5. **Reply** — format the agent's response per channel and send it back.

All channels share one process and one port. NanoClaw's router uses the JID prefix to route messages and replies; design your JIDs so two channels never collide.

## Channel matrix

| Channel | Path | Auth | Inbound format | Outbound format | JID prefix |
|---------|------|------|----------------|-----------------|------------|
| Email (webhook) | `POST /email` | HMAC from email service | parsed MIME | HTML | `webhook-email-<prog>@<prog>` |
| Email (IMAP poll) | (poll, no path) | IMAP credentials | parsed MIME | HTML via SMTP | `imap-email-<prog>@<prog>` |
| Telegram | (long-poll, no path) | bot token | Telegram Update | Markdown V2 | `tg-<prog>@<prog>` |
| Teams (Bot Framework) | `POST /api/messages` | JWT (BF library) | BF Activity | AdaptiveCard | `teams-<prog>@<prog>` |
| Teams (Outgoing Webhook) | `POST /teams/webhook` | HMAC | Teams Outgoing payload | Markdown | `teams-wh-<prog>@<prog>` |
| Web Chat | `POST /chat` | API key header | JSON `{message, sessionId}` | JSON `{reply}` | `webchat-<prog>@<prog>` |
| Copilot Studio | `POST /copilot-studio` | bearer token | Copilot Studio request | Copilot Studio response | `copilot-<prog>@<prog>` |

## Common contract

Every channel handler MUST:

- Reject early — auth failure, allowlist miss, rate limit — without enqueuing the message.
- Audit-log the inbound (see [`05-audit-logging.md`](./05-audit-logging.md)) **before** dispatch, so failed runs still leave a trail.
- Use the same JID for one logical conversation across messages. Telegram uses chat ID; email uses thread/Message-ID; Teams uses conversation reference.
- Audit-log the outbound right before the channel API call, so a successful agent run that fails to send still leaves a trail of what would have been said.
- **Fail safe on allowlist reload.** Allowlists live in the program repo and are re-read on a TTL (the reference impl refreshes every 5 minutes). If a reload fails transiently (mid-`git pull`, file briefly absent, parse error), **retain the last-good copy** rather than falling open (admit everyone) or falling fully closed (lock everyone out). A transient read error must not change who can reach the bot.

## Channel-specific gotchas

### Email — webhook variant (recommended for production)
- Inbound is webhook from your email provider. Validate HMAC.
- The `From` address goes through allowlist. Apply a **two-tier rejection policy** — don't blanket-bounce (that leaks bot existence to spoofed addresses and generates backscatter), but don't blanket-silence either (a real colleague who gets no reply assumes the mailbox is broken):
  - **Unknown / external senders not on the allowlist** → drop silently. No reply.
  - **Recognized-institution senders not on the allowlist** (e.g., the `From` domain matches your own institution's) → send a courteous, **deduped** "access is currently limited — to request access, contact `<admin>`" reply. Dedupe per sender so a repeat emailer is notified once, not on every message.
  - Either way, **audit-log the dropped message** (see [`05-audit-logging.md`](./05-audit-logging.md)) so there's a record of who was turned away.
- Reply via the provider's outbound API. Set `In-Reply-To` and `References` headers to thread correctly.
- The reply body is HTML — sanitize what comes back from the agent. Use a simple Markdown→HTML pipeline; no scripts.

### Email — IMAP polling variant (recommended for laptop/dev)
Use this when you don't have a public webhook URL or your email provider's webhook requires admin involvement (e.g., Microsoft 365 Graph subscriptions). Lets you run the bot from a laptop against any IMAP-accessible mailbox.

- Connect to the mailbox over IMAP using app-password or OAuth2 credentials. For institutional accounts, prefer a dedicated shared mailbox / role mailbox over a personal one.
- Poll on a fixed cadence (default: every 60 seconds). Use `IDLE` if the server supports it to lower latency.
- Move processed messages to a `Processed/` folder (or set the `\Seen` flag) so the same message isn't dispatched twice. Idempotency is on you, not the provider.
- The `From` address goes through allowlist, with the same **two-tier policy** as the webhook variant: unknown/external non-allowlist senders are moved to `Filtered/` silently; recognized-institution non-allowlist senders get a courteous, deduped "access is limited — contact `<admin>`" reply before filing. Audit-log the dropped message either way.
- Reply via SMTP (same provider). Set `In-Reply-To` and `References` headers to thread correctly. Same HTML-body sanitization rules as the webhook variant.
- **Tradeoffs vs webhook**: simpler to set up (no public URL, no HMAC) and unblocks adoption when IT can't grant webhook access; slower (poll-cycle latency), more brittle (long-running IMAP connections drop), and you eat the storage of the mailbox itself.
- **Path to webhook**: when you graduate to a VPS/cloud tier, swap the IMAP poller for the webhook handler. The agent prompts, allowlist, audit log, and JID format don't change — only the transport.

### Telegram
- Long-poll, not webhook (simpler to deploy, no public endpoint for this channel).
- Filter senders against an allowlist. Two options, with a real tradeoff:
  - **Numeric user IDs** — most robust (IDs never change and can't be reassigned), but high-friction to collect: each stakeholder has to message [@userinfobot](https://t.me/userinfobot) and send you their ID, and the list lives in an env var (`TELEGRAM_ALLOWED_USER_IDS`).
  - **`@handles` in the shared allowlist** — lower-friction and what the reference implementation does: store Telegram handles right alongside emails in the program repo's `EMAIL_ALLOWLIST.md`, so stakeholder access is managed in one human-readable file with no redeploy. The cost: handles can change or be reassigned, so re-verify periodically. Senders with **no username** are dropped (there's nothing to match).
  - Pick IDs if your stakeholder set is small and stable and you want maximum robustness; pick handles if you want one allowlist file the program owns. Don't mix silently — be explicit about which one is authoritative.
- Send a typing indicator while the agent runs — runs can take 30+ seconds.
- Respect the 4096-character message limit. Split on paragraph boundaries if exceeded.
- Use Markdown V2; escape `_*[]()~>#+-=|{}.!` in the agent's reply before sending.

**One-time setup (Tier 1):**
1. In Telegram, message [@BotFather](https://t.me/BotFather), `/newbot`. Pick a display name and a username ending in `bot`. BotFather replies with the bot token — that's `TELEGRAM_BOT_TOKEN`.
2. Populate the allowlist (see the filter options above): either collect numeric IDs — each user messages [@userinfobot](https://t.me/userinfobot), comma-separate into `TELEGRAM_ALLOWED_USER_IDS` — or add their `@handle` to a Telegram column in the program repo's `EMAIL_ALLOWLIST.md` (the reference-implementation approach).
3. Optional: BotFather → `/setprivacy` → Disable, if you want the bot to receive group messages without being @mentioned.

### Teams (Bot Framework)
- Bot Framework SDK does the JWT validation; you don't.
- Replies go through `TurnContext.sendActivity()`. Use AdaptiveCards for anything formatted; plain text for short.
- Conversation reference must be persisted if you want to send proactive messages.

### Teams (Outgoing Webhook)
- Lower-feature than Bot Framework but no app registration needed.
- HMAC validation on inbound.
- Synchronous reply only — no proactive sends.
- Markdown subset; test what your tenant renders.

### Web chat
- Synchronous request-response (no queue, no async). Set a 60-second timeout and stream tokens if your front end supports it.
- API key in `Authorization: Bearer <key>` header. Rotate quarterly.
- Session ID stays the same across a conversation — that's what gives the agent memory.

### Copilot Studio
- Pass-through: Copilot Studio handles its own auth on the front; you authenticate the action call from Copilot Studio with a bearer token.
- Useful when your org has standardized on Copilot Studio for Teams chrome but you want NanoClaw doing the actual work.

## When to add a new channel

1. Pick a path or transport.
2. Copy the closest existing channel handler.
3. Add the JID prefix to your channel matrix above.
4. Write a `groups/<channel>/CLAUDE.md` for it (see [`examples/groups/`](../examples/groups/)).
5. Smoke test with the agent in question mode before enabling status-update mode.
