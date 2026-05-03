# 09 — Illinois (UIUC) email quickstart

A unit-level recipe for letting an `@illinois.edu` address talk to a ProgramOS bot **without** waiting on a Microsoft 365 admin app registration. Optimized for fastest legitimate start.

This doc is Illinois-specific by design. If you're at another institution, the same pattern (forwarding rule + external inbound webhook + sending alias) usually works — substitute your provider's equivalents.

## What you'll get

- Stakeholders email a real-looking `<unit>@illinois.edu` alias.
- The bot receives the message via an external inbound provider (no UIUC IT involvement).
- The bot replies *as* `<unit>@illinois.edu` so threads look normal in Outlook.
- Audit log captures every inbound and outbound message.

## What it costs

- One internet domain you control (e.g., a `.org` or a subdomain you can add MX records to). ~$12/year.
- One inbound-email provider. [Postmark](https://postmarkapp.com) ($15/mo for 10k messages, generous free tier for inbound), [SendGrid](https://sendgrid.com), or [Mailgun](https://www.mailgun.com) all work.
- ~30 minutes of setup + the time it takes the unit to add an Outlook forwarding rule.

## What it does NOT need

- A Microsoft 365 admin app registration.
- A Microsoft Graph API subscription.
- An exception from Tech Services.
- Any modification to the `illinois.edu` MX records.

## Prerequisites

- A ProgramOS deployment at Tier 2 (VPS) or Tier 3 (Cloud) with a public webhook URL. Tier 1 (laptop) doesn't apply — for laptop deployments, use the IMAP-polling email variant in [`03-channels.md`](./03-channels.md) instead, polling the shared mailbox directly.
- A unit-controlled `@illinois.edu` mailbox. Best practice: a **role/shared mailbox** the unit's admin team owns (not a personal account). If you don't have one, request a shared mailbox from Tech Services — that ask is uncontroversial and usually fast.
- A separate domain you control. Call it `bot.example.org` for the rest of this doc.

## Setup

### 1. Configure the inbound provider

In Postmark (or your provider of choice):

- Create an inbound stream. It will give you an inbound address like `<hash>@inbound.postmarkapp.com` and an inbound webhook URL field.
- Set the inbound webhook URL to your ProgramOS deployment's email channel path: `https://<your-vps-domain>/email`.
- Enable HMAC signing on the webhook. Copy the signing secret into your ProgramOS `.env`.

### 2. Add an MX record on `bot.example.org`

Point `bot.example.org` MX to the provider's inbound MX (Postmark's is `inbound.postmarkapp.com`, weight 10). DNS propagation: usually < 15 minutes.

Verify with `dig MX bot.example.org` before continuing.

### 3. Set up a forwarding rule on the UIUC mailbox

The unit's mailbox owner (a faculty member or admin with write access to the shared mailbox) does this **themselves**, in Outlook on the web — no IT ticket needed:

1. Open the shared mailbox in Outlook on the web.
2. Settings → Mail → Rules → Add new rule.
3. Name: "Forward to coordinator bot".
4. Condition: *Apply to all messages* (or scope to From: allowlist if you want belt-and-suspenders filtering before the bot even sees it).
5. Action: *Forward to* → `<unit>@bot.example.org`.
6. **Important**: also check *Stop processing more rules* and *Keep a copy in the Inbox* (so the human-readable archive in Outlook still accumulates).

Note: UIUC's M365 tenant does allow user-controlled forwarding to external domains for shared mailboxes by default, but admin policy can change this. If the rule is rejected, ask Tech Services to whitelist `bot.example.org` as a permitted forwarding target — that's a smaller ask than a Graph subscription.

### 4. Configure outbound (so replies look like they're from `@illinois.edu`)

Three options, in order of preference:

**A. SMTP relay through the shared mailbox.** The bot authenticates to `smtp.office365.com` as the shared mailbox using an app password or OAuth2 client credentials, and sends `From: <unit>@illinois.edu`. Cleanest — replies look identical to a human reply, threading is perfect, no SPF/DKIM gymnastics. Requires the mailbox to have SMTP AUTH enabled (default-on for most UIUC accounts; if disabled, Tech Services can enable per-account).

**B. Send via the inbound provider with `From: <unit>@illinois.edu`.** Works, but you'll fail SPF/DKIM checks unless you can add `include:_spf.<provider>` to the `illinois.edu` SPF record (you can't). Recipients may see "via postmarkapp.com" in the From header. Acceptable for internal stakeholders, awkward for external.

**C. Send from `bot.example.org` and let the user-facing address be the bot's domain.** Cleanest technically, but loses the "feels institutional" property that makes email easy to adopt. Reserve for cases where A and B both fail.

### 5. Update ProgramOS configuration

In the bot's `.env`:

```
EMAIL_INBOUND_HMAC_SECRET=<from step 1>
EMAIL_OUTBOUND_MODE=smtp-relay        # or postmark, or bot-domain
EMAIL_SMTP_HOST=smtp.office365.com
EMAIL_SMTP_USER=<unit>@illinois.edu
EMAIL_SMTP_PASS=<app password>
EMAIL_FROM_DISPLAY=Coordinator Bot <<unit>@illinois.edu>
```

In the program repo's `program/EMAIL_ALLOWLIST.md`, add the addresses that may interact with the bot. Stakeholders not in this list get filtered silently.

### 6. Smoke test

1. Send a test email from an allowlisted address to `<unit>@illinois.edu`.
2. Check the Outlook rule fired and a copy went to `<unit>@bot.example.org`.
3. Check the inbound webhook hit your VPS (`tail -f` the bot logs).
4. Check the bot replied; reply lands in the original sender's inbox with `From: <unit>@illinois.edu`.
5. Check `discussions/audit-log/email/` in the program repo for the inbound + outbound files.

If any step fails, fix that step before adding more channels.

## Operational notes

- **Forwarding rule is a single point of failure.** If the unit's admin user disables it (or leaves and their account is locked), email to the bot stops silently. Document the rule in the unit's runbook and add it to onboarding/offboarding checklists.
- **PII surface.** Inbound messages now traverse a third-party provider. Confirm this is acceptable under the unit's data-handling policies before going live. Postmark's data residency is US; some providers offer EU regions.
- **App passwords vs OAuth2.** App passwords are easier but blockable by tenant policy. OAuth2 client credentials require a one-time IT-assisted app registration but are more durable. Start with app passwords; migrate to OAuth2 when you have IT support.
- **Webhook signing rotation.** Rotate the inbound HMAC secret quarterly. Schedule it; don't wait for a security review to remind you.

## When to escalate to a real Graph subscription

Move off this recipe and onto a proper Microsoft Graph mailbox subscription when:

- The unit needs SSO-authenticated stakeholder identity (right now, allowlist is by `From` address — spoofable in theory).
- Compliance requires that PII never leave the M365 tenant.
- You're consolidating multiple unit bots and the per-unit forwarding-rule sprawl becomes a maintenance burden.

By that point you'll have audit-log evidence to justify the IT ask.
