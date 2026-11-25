# Email at the University of Illinois: a unit mailbox in front of the bot

**Status: rewritten 2026-11-20 against the code on `main`. The flow has not run end to end, at the university or anywhere else.** Statements about what the university's mail system allows are quoted from public university pages read on 2026-11-20, with the link; anything those pages do not say is marked "not verified, ask the central IT office". This page states no university policy of its own.

It is part of the Illinois track ([`README.md`](./README.md)). The generic pages it relies on are [`../../inbound/README.md`](../../inbound/README.md) (the intake worker), [`../setup-reference.md`](../setup-reference.md) (settings, the inbound contract, outbound mail over SMTP) and `AGENTS.md`, choices 5 and 6.

## The flow

```
colleague ──mail──▶ unit mailbox @illinois.edu
                     │  inbox rule: redirect (keeps the sender)
                     ▼
              program@bot.example.org   (a domain the unit controls, on Cloudflare Email Routing)
                     │  intake worker in inbound/
                     │  1. commits the mail (.md copy + .eml) to the knowledge-base repo
                     │  2. calls the host's webhook
                     ▼
                the ProgramOS host ──reply──▶ colleague
                     from program@bot.example.org (default provider)
                     or from the unit mailbox (SMTP; see "Replies", option B)
```

Colleagues write to an address on the university's domain. The bot never receives mail there itself: a rule in that mailbox passes each message to the bot's own address, where the intake worker files it and tells the host. The host answers from the knowledge base and sends the reply.

Two parts of this flow have **never run against live services**: the intake worker (issue 45; `inbound/README.md`, "Not verified") and the SMTP provider (`OUTBOUND_MAIL_PROVIDER=smtp`, tested only against a local test server). Plan one real test of each before colleagues are told the address.

## What you need

| Item | Who provides it | Notes |
|---|---|---|
| A unit mailbox with an `@illinois.edu` address, not one person's own mailbox | The unit's IT staff and the campus mail service | See step 1 |
| A domain or subdomain the unit controls, used only for the bot's mail | The unit (or its IT staff) | For example `bot.example.org`. Cloudflare Email Routing takes over its MX records (`inbound/README.md`, step 1) |
| A Cloudflare account, held by a unit account | The unit | [`../service-ownership.md`](../service-ownership.md) |
| A private knowledge-base repo in the unit's github.com organisation, and a token for it limited to that repo | The unit | `AGENTS.md`, choice 7; [`github-enterprise.md`](./github-enterprise.md) |
| A running host with a public HTTPS name | The unit | [`../deployment.md`](../deployment.md), [`hosting.md`](./hosting.md) |
| An outbound mail account for the bot's domain (the default provider) | The unit | `AGENTS.md`, choice 6, option (a) |
| Written answers on data handling | The offices in [`data-handling.md`](./data-handling.md) | Before any colleague writes to the bot |

## 1. The unit mailbox

What the university's public pages say (read 2026-11-20):

- An `@illinois.edu` departmental address is a separate request: "If you want an @illinois.edu departmental shared email, you'll need to submit a Departmental Shared Email request." ([Office 365, Email Administration, Support, and Best Practices](https://answers.uillinois.edu/150071), a page for unit IT staff, updated 2026-01-13.) That page also says "By default, all resource accounts use @mx.uillinois.edu email addresses unless otherwise requested."
- The request itself: [Identity and Access Management, Departmental Shared Email (non-person NetID Alias)](https://answers.uillinois.edu/159273) (updated 2026-06-01): "A departmental shared email is a non-person entry used to direct external email".

Not verified, ask the central IT office: whether a departmental shared email can hold an inbox rule that sends mail to an outside domain (step 3), or whether you need a mailbox with its own inbox for that; who in the unit must own it.

Use a unit address, not a person's own: the forwarding restriction below applies to individual employees, and a rule in one person's mailbox stops when that person leaves.

## 2. The bot's own address and the intake worker

Follow [`../../inbound/README.md`](../../inbound/README.md), steps 1 to 5, on the unit's domain: Email Routing, the token, the worker's settings, deploy, route `program@bot.example.org` to the worker. Two values must match on both sides:

- the worker's webhook secret and `WEBHOOK_SECRET` in the host's `.env`;
- the worker's git author and `INTAKE_GIT_AUTHOR_EMAIL` in the host's `.env`. With a different address on one side, plain questions work and routed approvals are held.

Test it first with mail sent straight to `program@bot.example.org` from an allowlisted address (`inbound/README.md`, step 6), before any rule at the university points at it.

## 3. The rule that passes mail to the bot

**Use a redirect, not a forward.** The host checks the sender against the allowlist using the `From` header of the message the worker receives. Microsoft's support page ([Manage email messages by using rules in Outlook](https://support.microsoft.com/en-us/office/use-inbox-rules-in-outlook-c24f5dea-9465-4df4-ad17-a50704d66c59), read 2026-11-20) says: "A redirected message keeps the original sender on the From line", while "A forwarded message appears as a message you received and then forwarded to another recipient." A forwarded message would arrive from the unit mailbox, not from the colleague, and would not match the colleague's allowlist row.

What the university's public pages say about sending mail to an outside address:

- [Privacy & Cybersecurity, Faculty and Staff Email Auto-forwarding Retirement FAQ](https://answers.uillinois.edu/110048) (updated 2025-09-17): the university acted "as of October 5, 2021, to restrict university employees' ability to auto forward from @illinois.edu, @uillinois.edu, and @uiuc.edu email addresses." And: "Role accounts, group accounts, service accounts, mail enabled groups or lists and other non-individual email accounts are not affected." On exceptions: "the risks of any variance requested must be accepted by the executive officer at the unit level."
- [Office 365, Email Rules, Forwarding, Redirection, and Troubleshooting](https://answers.uillinois.edu/150155) (updated 2026-04-08): "Faculty and staff can not redirect or auto-forward their Illinois email."

So, per those pages, a rule in a person's own mailbox is restricted, and a non-individual account is outside that restriction. Whether a redirect from your unit's mailbox to your outside domain is accepted in practice is **not verified, ask the central IT office**. Microsoft 365 has its own tenant settings that can block external forwarding regardless of the inbox rule; a blocked message returns "5.7.520 Access denied, Your organization does not allow external forwarding." ([Control external email forwarding](https://learn.microsoft.com/en-us/defender-office-365/outbound-spam-policies-external-email-forwarding), read 2026-11-20). If you see that error, the answer is the central IT office's, not this repo's.

Keep a copy in the unit mailbox if the unit wants a readable archive there. Write the rule into the unit's runbook: if it is turned off, mail to the bot stops with no alert.

## 4. Settings on the host

In `.env` (see [`../setup-reference.md`](../setup-reference.md) for each key):

| Setting | Value for this flow |
|---|---|
| `WEBHOOK_SECRET` | The same value as the worker's webhook secret |
| `INTAKE_GIT_AUTHOR_EMAIL` | The worker's git author |
| `INSTITUTION_DOMAIN` | `illinois.edu`. The host uses it for the one courtesy reply to a blocked sender at the institution and for approver addresses; with a real program repo it refuses to start without it |
| `ADMIN_AUTHOR_EMAILS` | The admin's real git author addresses. Ask the admin; do not guess |
| `SEND_FROM_EMAIL`, `SEND_FROM_NAME`, `BOT_MAIL_DOMAIN` | See step 5 |
| `OUTBOUND_MAIL_PROVIDER` | `resend` (option A, the default) or `smtp` (option B) |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` | Option A |
| `SMTP_HOST`, `SMTP_SECURITY`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_ENVELOPE_FROM` | Option B only |
| `ADMIN_ALERT_ROUTE`, `OPERATOR_CC_EMAIL` | Where operator alerts go (`AGENTS.md`, choice 4) |

In the knowledge-base repo, `program/EMAIL_ALLOWLIST.md` holds each colleague's `@illinois.edu` address. The unit mailbox's own address does not go on it.

## 5. Replies

**Option A: reply from the bot's domain (the default, and the one to start with).** Set `SEND_FROM_EMAIL=program@bot.example.org`, `BOT_MAIL_DOMAIN=bot.example.org`, and the default provider's key. The provider asks you to prove you control `bot.example.org` with DNS records; the unit holds that domain, so no university system is involved. Colleagues see the reply come from the bot's domain, and a reply to it goes straight to the bot. This needs nothing from the central IT office beyond step 3.

**Option B: reply as the unit mailbox, by SMTP.** The code's SMTP provider logs in with a username and a password or app password; it does not implement OAuth login and does not send through Microsoft Graph (issue 67). What the university's public pages say:

- [Office 365, Email, Exchange, University Email with Exchange](https://answers.uillinois.edu/47591) (updated 2025-09-05): "Outgoing mail server: smtp.office365.com Outgoing protocol: requires authentication, STARTTLS, port 587, OAuth2", and "The Basic Authentication protocol is considered outdated and insecure, and was disabled for University accounts in August of 2022."

Per that page, a login with a username and password is disabled for university accounts, so the SMTP provider as written is **not expected to work against the university's Exchange Online**. Whether an exception exists for a unit mailbox is not verified, ask the central IT office. A separate service exists: [Cloud Email Delivery Service, Configuring use of the Cloud Email Delivery Service](https://answers.uillinois.edu/85412) (updated 2026-01-27) names `smtp.socketlabs.com`, port "587 (Preferred, others also supported)" with STARTTLS, and "You will need either an API key, or SMTP credentials for authentication." Who may use it, for which From addresses, and whether its mail keeps the `Message-ID` the bot sets (replies are threaded on it): not verified, ask the central IT office. If the office offers it, the settings are `OUTBOUND_MAIL_PROVIDER=smtp`, `SMTP_HOST`, `SMTP_SECURITY=starttls`, `SMTP_PORT=587`, `SMTP_USERNAME`, `SMTP_PASSWORD`, with `SEND_FROM_EMAIL` and `BOT_MAIL_DOMAIN` set to the address and domain they approve. What SMTP loses (no bounce reports, no delivery check) is in [`../setup-reference.md`](../setup-reference.md), "Outbound mail over SMTP". The questions to ask are in [`institutional-address.md`](./institutional-address.md).

Start with option A. Move to option B only with a written answer from the central IT office.

## 6. Test, in this order

1. Mail sent straight to `program@bot.example.org` from an allowlisted address: one commit with two files in `discussions/raw/` by the intake author; the host answers (`inbound/README.md`, step 6).
2. The same through the unit mailbox: the rule fires, the committed `.md` copy shows the colleague (not the unit mailbox) on its `From:` line, and the host answers.
3. A routed approval through the unit mailbox: the approver gets the sender's own words.
4. A sender who is not on the allowlist: no answer, or the one courtesy reply when the sender is at `INSTITUTION_DOMAIN`.
5. `discussions/audit-log/<date>.md` in the program repo holds the inbound and outbound entries for each.

If a step fails, fix it before the next one.

## Is the sender who they say they are?

The allowlist matches the `From` address, which a sender can forge. Since 2026-11-20 the host records a sender-authentication verdict for each message and can be set to drop mail that is not authenticated (`EMAIL_AUTH_MODE`; [`../setup-reference.md`](../setup-reference.md), "Sender authentication for inbound mail"). By default it only records, and with no mail server named every verdict is `unknown`. A redirected message is passed on by the university's mail system, so the results the bot's domain sees are not those of the original sender; the intake worker can read the university system's own result instead, when it is told that system's names. Those names are not known: [`mail-authentication.md`](./mail-authentication.md) has the steps to read them off a real message, and what to ask first. Until that is done and `enforce` is set, the allowlist is not proof of who wrote a message; [`../data-handling.md`](../data-handling.md), "What the allowlist does and does not protect", says what follows from that.

## Questions for the central IT office (not verified)

| Question | Answer |
|---|---|
| Can our unit's departmental shared email, or a unit mailbox, redirect all incoming mail to an address on a domain the unit controls? Is that covered by "non-individual email accounts are not affected"? Does the tenant's external forwarding setting allow it? | Not verified |
| If a variance is needed, who requests it and who accepts the risk? | The FAQ above names "the executive officer at the unit level"; the process for this case is not verified |
| May a program send as the unit mailbox? By which route: SMTP with OAuth2 only, an exception for a password login, the Cloud Email Delivery Service, or Microsoft Graph with an app registration? | Not verified |
| Are there sending limits for that route? | Not verified |
| Where do bounces for that route go, and who reads them? | Not verified |

Record each answer here with the office, the person and the date.
