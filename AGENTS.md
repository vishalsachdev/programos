# AGENTS.md: adapting ProgramOS to a new project

You are the coding agent of a person who cloned this repo to run a coordinator for
their own project or program. This file tells you what is here, what you must
change, and where you must stop and ask.

## What this repo is

- A working coordinator bot: it answers email (and optionally Telegram or web chat)
  from an allowlisted team, reads and writes a knowledge-base repo (the "program
  repo"), sends reminders, routes approval requests, gates its replies,
  and keeps an audit log. `SPEC.md` section 11 lists where each guarantee stops.
- The code is a close copy of K-ai, a deployment for an academic program. It has been
  tested in production with one program since April 2026. Program content was removed and replaced with placeholders.
  See `UPSTREAM.md`. **The code is the source of truth.** `SPEC.md`, `ARCHITECTURE.md` and `docs/` explain intent; where they differ from the code, trust the code and tell the user. `docs/design/` holds ideas that are not implemented.
- **We did not rewrite the code to be configurable.** Many identity values are
  still written in the code as placeholders. Your job is to replace them for this
  user. The tests tell you if you broke something.

## Rules for you

1. **Stop and ask the user at every choice marked ASK.** Do not guess.
2. **Do not deploy, send mail, or contact any service** until the user says so.
3. Keep the tests passing: `npm ci && npm run typecheck && npm test`. The baseline
   is 1,824 passing tests (1,761 from the source, 63 for the model provider
   setting added here). One timing test in `src/channels/webhook-ingest-context.test.ts`
   can fail under load; rerun it alone before you treat it as real.
4. Change placeholders consistently in code AND tests. A half-changed name fails tests.
5. Never put real secrets, real people's data, or mail content in this repo.

## Ask the user first (ASK)

Policy comes before setup. Get these answers before you change anything:

1. **Which AI service may this team's mail reach?** The agent sends message text to
   a model. The user's institution may limit this. The code uses Claude through the
   Claude Agent SDK. Other model families need a different agent runner (not included).
   The destinations the code supports:
   - the Anthropic API or a Claude subscription (the default);
   - an endpoint that serves the Anthropic API, set with `ANTHROPIC_BASE_URL`;
   - Claude on Microsoft Foundry in the user's own Azure subscription
     (`MODEL_PROVIDERS`, [`docs/illinois/model-foundry.md`](./docs/illinois/model-foundry.md)).
     Tested here against fake servers only; that page has the live checks.

   `MODEL_PROVIDERS` is an ordered list. A second entry is a backup, and it
   receives the same mail text when the first fails, so ASK about **every**
   provider in the list. For Foundry, also ASK which hosting option each
   deployment has ("Hosted on Azure" or "Hosted on Anthropic"); it decides
   where prompts are processed. This repo does not record which service any
   institution has approved, Illinois included: not verified. Get the answer
   from the user and write down its source and date.
   **There are two model call paths.** The agent goes through the host proxy and
   follows `MODEL_PROVIDERS` and `ANTHROPIC_BASE_URL`. The reply sensor
   (`src/behaviour-sensor.ts`) calls a model API directly with its own key and
   follows neither. Its destination is `SENSOR_PROVIDER`: the public Anthropic
   API by default, or `foundry`. It does not fail over.
   Keep `BEHAVIOUR_SENSOR_DISABLED=1` unless the user confirms the sensor's
   destination is approved too.
2. **Who may approve records and access changes?** (the admin and any approvers)
3. **Which address does the bot send from?** And which mail provider delivers it.
4. **Where does the data live?** The host for the bot, and the git host for the program repo.
5. **What consent wording do senders see**, if any, and who is on the allowlist.
6. **Which channels?** Email only is the simplest. Telegram and web chat are optional.
   Ask also where operator alerts should go: Telegram (the default), email to the
   operator's address, or both (`ADMIN_ALERT_ROUTE`; see "Safety items").

## Placeholders to replace

Search for each placeholder (include tests; exclude `node_modules`):

| Placeholder | Meaning | Where it lives |
|---|---|---|
| `Coordinator` (also `Co-ordinator`, `co[\s-]?ordinator` in patterns) | The bot's name | `ASSISTANT_NAME` in `.env`, prompts in `groups/`, several `src/` files and patterns that recognise the name |
| `Program`, `program-email`, `program-telegram`, `web-chat-program`, `tg-program` | The program or project name and its channel group names | `groups/` folder names, `seed-db.cjs`, `src/index.ts`, `src/task-scheduler.ts` and others |
| `program-repo`, `/workspace/extra/program-repo` | The knowledge-base repo and its mount point in the container | `PROGRAM_REPO` (process environment), `src/program-repo.ts`, prompts, container skills |
| `example-org/program-repo` | The git origin the host accepts for the program repo. A different origin is refused and the read mirror is not created. | `isExpectedOrigin` in `src/repo-reader.ts`; set `PROGRAM_ORIGIN_PATTERN` (process environment). Any git host works, including a GitHub Enterprise host; `config/instance.env.example` has example patterns |
| `example.edu` | The institution mail domain. It is used in logic: the "access closed" courtesy reply (`src/channels/webhook.ts`) and approver addresses in `src/routed-approvals.ts` | Setting: `INSTITUTION_DOMAIN` in `.env`. **Required for a real program repo:** the host refuses to start when it is missing, `example.edu` or a subdomain of `example.edu` (`src/identity-settings-check.ts`). The operator's address, the shared mailbox in `src/trusted-body-mailboxes.ts`, prompts and tests still hold `example.edu` as text |
| `example.org` | The bot's own mail domain: the default bot address, the Message-ID domain, and the bot's git author `program-bot@example.org` | Setting: `BOT_MAIL_DOMAIN` in `.env`. Prompts in `groups/` and skills in `container/skills/` name the git author as text; change them to match. The site address `program-repo.example.org` in `src/behaviour-sensor.ts` is not covered by the setting |
| `email-inbox@example.org` | The git author of the inbound mail intake service (see "Inbound mail") | Setting: `INTAKE_GIT_AUTHOR_EMAIL` in `.env` |
| `Avery Morgan`, `avery@example.edu`, `tg-avery@program` | The operator (admin). Outreach, routed approvals and admin checks name this person | `src/config.ts`, `src/outreach-recipient-roster.ts`, `src/routed-approvals.ts`, `src/channels/webhook.ts`, prompts |
| `ADMIN_AUTHOR_EMAILS` (`avery@example.edu`, `avery.personal@gmail.com`, a `users.noreply.github.com` address) | The git author identities allowed to change protected governance files | Setting: `ADMIN_AUTHOR_EMAILS` in `.env`, separated by commas. **Required for a real program repo.** Use the admin's real commit identities. The setting replaces the placeholder list. With a real program repo the host refuses to start when the setting is missing or names a placeholder address (`src/identity-settings-check.ts`); the placeholders count as admin only with the placeholder repo |
| `/^greta\b/i` | A one-person exception in the outreach roster (a departed owner whose section is skipped) | `src/outreach-recipient-roster.ts`, near `unmatchedOwners`. Remove it or replace it with your own case. |
| Other synthetic people (in `OWNER_ALIASES` in `src/outreach-recipient-roster.ts`) | A short-name table for the team | Replace with the user's team or empty it |
| `PeerAgent`, `averybot@gmail.com` | A second automated agent that also mails the bot | `src/config.ts` (`AGENT_INBOX_ADDRESSES`); empty the list if the user has none |
| `CRS`, `ELC`, `LAB` plus three digits | Course-code prefixes | See "Academic examples" below |

Settings that already exist are in `config/instance.env.example`. **Read its header first.** Some keys are read from the `.env` file; others are read only from the process environment, and a line in `.env` does nothing for them (this includes `PROGRAM_REPO`, `PROGRAM_ORIGIN_PATTERN`, `WEBHOOK_HOST` and `BEHAVIOUR_SENSOR_DISABLED`). The parser does not strip inline comments. The supported way to run the bot is the systemd recipe in `docs/deployment.md`; `start.sh` and `ecosystem.config.cjs` are pm2 examples from the reference deployment.

## Academic examples

The prompts, skills and two pieces of logic use an academic program as the example
domain: courses, faculty, curriculum, cohort. This text is kept because it is the
tested text. Adapt the vocabulary to the user's project. The logic that knows about
courses is in:

- `src/behaviour-sensor.ts` (the reply checker: ground-truth files such as
  `program/curriculum.md`, course-code patterns)
- `src/open-questions-scan.ts`
- `container/skills/kb-conflict-check/check-ingestion-crosscheck.mjs` and
  `container/skills/kb-entry-gate/check-kb-entry.mjs`

For a project with no course-like codes, ASK the user what the equivalent "facts
that must not be wrong" are, or turn the sensor off (`BEHAVIOUR_SENSOR_DISABLED=1`)
and say so.

## Features and what each needs

| Feature | Status | Needs |
|---|---|---|
| Email questions and status updates | In production in K-ai | **An inbound mail intake service** (see "Inbound mail"), outbound provider key, allowlist file in the program repo |
| Inbound mail intake worker (`inbound/`) | **New; never run against live services.** Not the worker K-ai uses | A domain on Cloudflare Email Routing, a GitHub token for the program repo, the webhook secret |
| Delivery gate and audit log | In production in K-ai | Nothing extra |
| Reminders and scheduled outreach | In production in K-ai | A reminder registry (`docs/reminder-registry.md` is the template); ASK before any schedule goes live |
| Routed approvals | In production in K-ai | Approver recorded per sender in the allowlist; the institution domain set correctly |
| Telegram admin channel | In production in K-ai. The default route for operator alerts (see "Safety items") | Bot token, admin chat ID, **the chat sender allowlist file** |
| Operator alerts by email (`ADMIN_ALERT_ROUTE=email`) | New in this repo, not in K-ai. Tested here with the mail provider stubbed; **not yet run against a live provider** | `OPERATOR_CC_EMAIL` set to one person's address, the outbound provider key |
| Behaviour sensor and evaluation scripts | In production in K-ai | Ground-truth files in the program repo; see "Academic examples" |
| Web chat | Was in production, later retired there | A secret and a reverse proxy; treat as untested. **No allowlist of people: any caller with the secret is answered** |

## Safety items you must handle

- **Chat sender allowlist:** if `~/.config/nanoclaw/sender-allowlist.json` is missing,
  unreadable or invalid, the chat trigger check allows nobody and the host logs the
  path once (`src/sender-allowlist.ts`). It applies to every group registered with
  a required trigger, except the main group. Senders are matched exactly on the id the channel
  reports: for Telegram `tg:<numeric user id>`, not the `@handle`. The Telegram
  handle list in the program repo is a separate, earlier check. Start from
  `config-examples/sender-allowlist.json` ("First start", step 3).
- **Listener address:** set `WEBHOOK_HOST=127.0.0.1` and use a reverse proxy. The code
  default listens on all interfaces.
- **Operator alerts need a route that works.** Every operator alert goes through
  `src/admin-alert.ts`, which follows `ADMIN_ALERT_ROUTE`: `telegram` (the default),
  `email`, or `telegram,email`. On the Telegram route, delivery-failure alerts go to the
  Telegram owner chat (`src/index.ts`) and the webhook's alerts call the Telegram API
  (`pingAdminViaTelegram` in `src/channels/webhook.ts`); without a bot token they are
  not delivered. On the email route, each alert is one mail to `OPERATOR_CC_EMAIL`
  through the outbox and the delivery gate, with an audit entry. The email route has
  limits; tell the user:
  - It uses the same mail provider as everything else. When the provider or its key
    is the thing that failed, the alert about it cannot be mailed either. It is then
    in the host log only. Use `telegram,email` if the user needs a second path.
  - An alert about an alert mail (it bounced, or could not be sent) is never mailed
    again. It goes to Telegram if that route is on; otherwise it is logged and dropped.
  - Alert mail waits in its own queue (about 30 seconds between mails), and at most
    a few can wait at once; more are refused and logged.
  - The operator's reply to an alert mail goes to the bot's address and is handled
    as ordinary mail from the operator.
  - Weekly outreach summaries (`OUTREACH_SUMMARY_JID`) do not follow this setting.
  The bot logs an error at startup for each setting an enabled route lacks. Send a
  test alert on each enabled route before go-live ("First start", step 8).
- **Model endpoint with a path prefix.** The credential proxy
  (`src/credential-proxy.ts`) joins a path in `ANTHROPIC_BASE_URL` to the request
  path: `https://gateway.example.edu/claude` receives `/claude/v1/messages`. The
  endpoint must still speak the Anthropic API and accept the key in `x-api-key`
  (or the OAuth exchange). For Claude on Microsoft Foundry use
  `MODEL_PROVIDERS=foundry`, not `ANTHROPIC_BASE_URL`: Foundry needs its own
  SDK mode and key header.
- **A backup model provider is a second data destination.** With two entries in
  `MODEL_PROVIDERS`, three failures in a row (network error, 401, 403, 429, 5xx)
  move new runs to the next provider for 30 minutes, and the operator gets an
  alert. The turn that hit the failure still fails and is retried. The state is
  in memory, the audit log has no per-turn provider field, and resuming a
  session on the other provider is untested. Do the live checks in
  `docs/illinois/model-foundry.md` before the user relies on the backup.
- **Sender caps exist only on email.** Telegram and web chat have no per-sender
  limit (`src/channels/sender-quota.ts` is called only from the email handler).
  Keep the chat allowlists short, and do not put an automated agent on a chat channel.
- **Gate coverage and audit coverage differ.** Scheduled and direct chat sends pass the
  delivery gate but get no audit entry and no durable retry. Notices sent by
  `pingAdminViaTelegram` and web chat's timeout reply skip the gate too. Operator
  alerts sent by email pass the gate and are logged; the same alerts on Telegram are
  not logged. `SPEC.md` sections 6 and 11 have the full list.
- **Use Telegram with one chat only.** The Telegram handler keeps a single reply
  destination: the chat that wrote most recently (`replyTargets` in
  `src/channels/telegram.ts`). With two chats, a reply meant for one can go to the
  other. Put only the admin's handle on the Telegram allowlist until the source fixes this.
- **Retired people:** delete their allowlist row and handle. The email check accepts
  an address in any table row in the allowlist file, also below the "Retired access" note.
- **Mounts:** `config-examples/mount-allowlist.json` must list only the program repo. The email group is not the main group and it must write to the program repo in status-update mode, so `nonMainReadOnly` is `false` in the example. Keep the web chat group's own mount read-only in its group registration.
- **Protected files are guarded for the agent's file-editing tools only.** `container/agent-runner/src/protected-write-guard.ts` blocks Write, Edit and NotebookEdit on protected paths. It does not inspect shell commands. The git-author check in `src/governance-protection.ts` is the second line. Do not describe this to the user as a hard block.
- **Known gaps inherited from the source** (reported there): the conflict-check skill tells the agent to notify the admin with a Telegram tool that is not registered; two prompts and that skill disagree on how to record an uncorroborated spreadsheet fact (the skill is stricter: it goes to open questions); `groups/main/CLAUDE.md` is mostly upstream framework text.
- **Operations scripts are examples.** `scripts/deploy.sh`, `scripts/state-snapshot*.{sh,mjs}`
  and `ecosystem.config.cjs` come from the reference deployment. `deploy.sh` runs
  `git reset --hard` in a fixed folder. Read each script, change its paths and
  remotes, and ASK before you run any of them.
- **Email addresses come only from the allowlist or the inbound mail** (enforced for email; an instruction for chat). Do not
  weaken this rule (G59) when you adapt prompts.

## Governance

The prompts and code cite numbered rules (G6, G39, G46 and so on). `docs/12-governance.md`
defines each number and says what failure it prevents. Keep the numbers when you
adapt text. To change a rule, follow the change protocol in that file; do not
edit a rule in one prompt only.

## The program repo

The bot needs a separate git repo for the team's knowledge base. Start from
`templates/program-repo/`: it has the file names and table formats this code reads.
ASK where the repo will be hosted
and who can push.

## Inbound mail

The host does not receive mail itself. A separate intake service does, and for
each inbound message it must:

1. Write the message as a Markdown file into the program repo's email inbox folder,
   commit and push it. The agent reads that committed file; the webhook does not
   carry the body as the source of record.
2. POST JSON to this host's webhook with `Authorization: Bearer <WEBHOOK_SECRET>`.
   `filename` and `subject` are required. The handler also reads `from`, `to`, `cc`,
   `date`, `message_id`, `raw_file_path`, `eml_file_path`, `raw_email`,
   `inbound_text`, `phase`, `attachment_count` and `attachment_state`.

3. Keep the original message too. Routed approvals compare a sender's quoted words
   with the original mail, not with the Markdown copy. The host takes the original
   from `raw_email` or `inbound_text` in the payload, or from an `.eml` file the
   service committed (`eml_file_path`; the default raw path is `discussions/raw/<filename>`).
   When the host reads the committed `.eml`, it accepts only a file first committed
   by the intake service's git author. Set `INTAKE_GIT_AUTHOR_EMAIL` in `.env` to
   the author email on the service's commits (the default is the placeholder
   `email-inbox@example.org`). `src/repo-reader.ts` and
   `src/channels/github-push-events.ts` both read that one setting.
4. After setup, test one routed-approval exchange, not only a plain question.

**`inbound/` holds one such service: a Cloudflare Email Worker.** It needs a domain
on Cloudflare Email Routing. `inbound/README.md` has the setup steps, the file
format it writes, its choices for failures and attachments, and its limits. Tell
the user these three things before they choose it:

- It was written for this repo from the contract above. It is not the worker the
  reference deployment runs, and **it has never run against a live Cloudflare
  account, domain, mailbox or GitHub repo.** Its tests use a mocked network.
  Plan a real test (README, step 6) before go-live.
- Mail it files gets no text extraction of PDF, Word or Excel attachments on the
  host. The attachments stay inside the committed `.eml`.
- Its git author is a setting (`GIT_AUTHOR_EMAIL`), with the address above as the
  default. The host side is still fixed in the two files named in point 3.

ASK which mail provider the user has. If it is not Cloudflare, or the user's
institution requires mail to stay inside its own mail system, you must write the
service: read the handler in `src/channels/webhook.ts` (search for
`Missing filename or subject`) and `src/cc-context.ts`, check the service's git
author against `src/governance-protection.ts`, and use `inbound/` and its fixtures
as the worked example. `src/channels/webhook-inbound-intake.test.ts` runs those
fixtures through the real handler; a new service should pass the same checks.

## Webhooks from other services

Two more routes share the listener with the inbound mail webhook (`src/channels/webhook.ts`). Both are optional, and both exist only when `WEBHOOK_SECRET` is set, because the listener does not start without it. Each checks its own signature and does not use `WEBHOOK_SECRET`. A route with no secret set answers 503. Set them up after "First start", when the host has a public HTTPS name. ASK before you create either one: each tells an outside service to send data to this host.

### Mail delivery events: `/resend/webhook`

What it does (`src/channels/resend-events.ts`): records each recipient's delivery outcome, and on a bounce, a complaint or a failure it writes a delivery-problem record and alerts the admin on Telegram. Without it, the bot does not learn that a sent mail bounced. The handler is written for the reference deployment's provider, Resend, which signs with Svix headers. Another provider needs a different handler.

1. In the provider's dashboard, add a webhook endpoint with the URL `https://<your-host>/resend/webhook`.
2. Subscribe it to four events: `email.delivered`, `email.bounced`, `email.complained`, `email.failed`. The handler acts on these only; any other event is logged and answered 200.
3. Copy the endpoint's signing secret (it starts with `whsec_`) into `.env` as `RESEND_WEBHOOK_SECRET=`. This key is read from the `.env` file only; the process environment is not read for it. Restart the host process.
4. Check: send a test event from the dashboard. It must show 200. A 401 means the secret does not match. The check is HMAC-SHA256 over `<svix-id>.<svix-timestamp>.<body>`, compared with the `svix-signature` header. The handler does not reject an old timestamp.
5. Check the alert path: a bounce event must produce a Telegram message to the admin. If Telegram is down for a short time the handler answers 500 so that the provider retries.

### Program repo pushes: `/api/github-push`

What it does (`src/channels/github-push-events.ts`): on each push to `main` of the program repo it refreshes the host's read mirror at once, writes an audit-log entry for each knowledge-base commit a person made directly, and alerts the admin when an author who is not an admin changes a protected governance file. Without it, direct commits get no audit entry and that tripwire does not run. The handler reads GitHub's push payload; another git host needs a different handler.

1. Choose a long random secret (for example `openssl rand -hex 32`). Put it in `.env` as `GITHUB_PUSH_WEBHOOK_SECRET=`, or export it in the process environment; the `.env` value wins. Restart the host process.
2. In the **program repo** on GitHub (not this repo): Settings, Webhooks, Add webhook.
   - Payload URL: `https://<your-host>/api/github-push`
   - Content type: `application/json`. The handler parses the raw body as JSON; the form-encoded type fails.
   - Secret: the same value.
   - Events: "Just the push event".
3. Check: GitHub sends a `ping` when you save. A 200 there shows that the signature matches (`X-Hub-Signature-256`, HMAC-SHA256 of the body). A 401 means the secret differs. Then push a commit to `main`: the delivery must show 200 and the log must show `GitHub push: read mirror refreshed`. Pushes to other branches are ignored. The mirror path is `PROGRAM_READ_MIRROR` (process environment); the code default is a fixed path from the reference deployment.
4. Before you rely on it, set the three identity lists in code: `BOT_AUTHORS` in `src/channels/github-push-events.ts` (commits by these authors get no audit entry; use the bot's and the mail service's git author addresses), the admin identities in `src/governance-protection.ts`, and the path prefixes that count as knowledge base (`KB_INCLUDE_PREFIXES`, `KB_EXCLUDE_PREFIXES`), which follow the reference program's folder layout.
5. Tell the user: GitHub does not retry a failed delivery. When an alert cannot reach Telegram or an audit entry cannot be written, the handler answers 500 on purpose, so the failure shows in the webhook's "Recent Deliveries" list. Someone must look there and press "Redeliver". The audit entry is written once per commit, so a redelivery is safe.

## First start

Do these once, in this order, before the first test message:

1. `npm install`, then `npm run build`.
2. Copy `config-examples/mount-allowlist.json` to `~/.config/nanoclaw/mount-allowlist.json`
   and set the real program repo path. The host reads only that location
   (`MOUNT_ALLOWLIST_PATH` in `src/config.ts`). Without it, every extra mount is refused.
3. If a chat channel is used, copy `config-examples/sender-allowlist.json` to
   `~/.config/nanoclaw/sender-allowlist.json` (`SENDER_ALLOWLIST_PATH` in
   `src/config.ts`). `default` covers chats with no entry of their own; keep its
   `allow` list empty. Under `chats`, the key is the registered group id
   (`tg-program@program` for Telegram) and `allow` lists sender ids
   (`tg:<numeric user id>`; ASK the user for the admin's). `"allow": "*"` admits everyone in
   that chat. `mode` is `trigger` (store the message, do not act) or `drop`
   (discard it). The file is read again for each message, so an edit needs no restart.
4. Register each channel group. Registration creates the database. Email must be
   registered with the id `webhook-email@program` (the router looks for that exact
   id in `src/index.ts`) and with the program repo as a read-write extra mount.
   `npx tsx setup/index.ts --step register` registers a group but does not set
   mounts. `seed-db.cjs` shows the full row with `additionalMounts`; it needs the
   database to exist first, and its host path is a placeholder. Read both, then
   register the email group, the main group and (if used) the Telegram group.
5. Clone the program repo at the mounted path. Two writers use it, and both need
   file ownership and git credentials that work: the host's repository operations
   and the agent inside the container. When the host process runs as root, its
   repository operations run as user and group 1000 with home `/home/ubuntu`
   unless `CHECKOUT_OWNER_UID`, `CHECKOUT_OWNER_GID` and `CHECKOUT_OWNER_HOME` say
   otherwise (`src/checkout-fs.ts`, `src/program-repo.ts`), so a root-owned clone fails. The
   container does not get the operator's SSH agent or home folder. Use a deploy key
   or token limited to the program repo. Before the first test message, run a pull,
   a commit and a push as each writer.
6. Build the container image (`container/build.sh`).
7. Set `INSTITUTION_DOMAIN` and `ADMIN_AUTHOR_EMAILS` in `.env` before the first
   start with the real program repo: the institution's mail domain, and the
   admin's real git author emails. The host refuses to start when either is
   missing or still a placeholder (`example.edu` or a subdomain of it, or a
   placeholder address in the list) once the repo is a real one: `PROGRAM_ORIGIN_PATTERN` is set, or the
   origin of the checkout or the read mirror is not `example-org/program-repo`.
   The error names each setting to fix.
8. Test the operator alert routes. This sends real messages, so do it only when the
   user says so. Start the bot once with `ADMIN_ALERT_TEST=1` in the process
   environment (for example `ADMIN_ALERT_TEST=1 npm start`). It sends one test alert on
   each route enabled by `ADMIN_ALERT_ROUTE` and logs `Admin alert test delivered` or
   `Admin alert test NOT delivered` for each. Check that the user received each one,
   then remove the variable. For the email route, "delivered" means the mail provider
   accepted the mail; confirm it reached the inbox.

## Order of work

1. Ask the ASK questions. Write the answers down for the user.
2. Create the program repo skeleton and the allowlist.
3. Copy `config/instance.env.example` to `.env`; fill the REQUIRED lines.
4. Replace placeholders (table above). Run the tests after each group.
5. Adapt prompts in `groups/` and skills in `container/skills/`. `src/channel-claude-sync.test.ts`
   checks exact phrases in the prompts; update that test with the prompts.
6. Do the "First start" steps, set up the inbound mail service, and run locally with a test mailbox.
   Add the two optional webhooks ("Webhooks from other services") when the host has a public HTTPS name.
7. Show the user a test exchange. Deploy only when they say so.
