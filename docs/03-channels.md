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
| Email (webhook) | `POST /` | HMAC from email service | parsed MIME | HTML | `webhook-email-<prog>@<prog>` |
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

## Channel-specific gotchas

### Email — webhook variant (recommended for production)
- Inbound is webhook from your email provider. Validate HMAC.
- The `From` address goes through allowlist; reject silently for non-allowlist senders (don't bounce — leaks bot existence).
- Reply via the provider's outbound API. Set `In-Reply-To` and `References` headers to thread correctly.
- The reply body is HTML — sanitize what comes back from the agent. Use a simple Markdown→HTML pipeline; no scripts.

### Email — IMAP polling variant (recommended for laptop/dev)
Use this when you don't have a public webhook URL or your email provider's webhook requires admin involvement (e.g., Microsoft 365 Graph subscriptions). Lets you run the bot from a laptop against any IMAP-accessible mailbox.

- Connect to the mailbox over IMAP using app-password or OAuth2 credentials. For institutional accounts, prefer a dedicated shared mailbox / role mailbox over a personal one.
- Poll on a fixed cadence (default: every 60 seconds). Use `IDLE` if the server supports it to lower latency.
- Move processed messages to a `Processed/` folder (or set the `\Seen` flag) so the same message isn't dispatched twice. Idempotency is on you, not the provider.
- The `From` address goes through allowlist; non-allowlist messages get moved to `Filtered/` silently.
- Reply via SMTP (same provider). Set `In-Reply-To` and `References` headers to thread correctly. Same HTML-body sanitization rules as the webhook variant.
- **Tradeoffs vs webhook**: simpler to set up (no public URL, no HMAC) and unblocks adoption when IT can't grant webhook access; slower (poll-cycle latency), more brittle (long-running IMAP connections drop), and you eat the storage of the mailbox itself.
- **Path to webhook**: when you graduate to a VPS/cloud tier, swap the IMAP poller for the webhook handler. The agent prompts, allowlist, audit log, and JID format don't change — only the transport.

### Telegram
- Long-poll, not webhook (simpler to deploy, no public endpoint for this channel).
- Filter on allowed user IDs, not usernames (usernames change, IDs don't).
- Send a typing indicator while the agent runs — runs can take 30+ seconds.
- Respect the 4096-character message limit. Split on paragraph boundaries if exceeded.
- Use Markdown V2; escape `_*[]()~>#+-=|{}.!` in the agent's reply before sending.

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
