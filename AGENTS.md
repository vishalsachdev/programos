# AGENTS.md: setting up ProgramOS with the person who cloned it

You are the coding agent of a person who cloned this repo to run a coordinator for
their own project or program. That person may be a program director or a
coordinator, not an engineer. This file tells you how to guide them, what choices
exist, what you must change, and where you must stop and ask.

Read the whole file once before your first reply. Parts 1 to 6 are the guided
conversation. Parts 7 to 15 are reference; use them when a step sends you there.
[`docs/setup-reference.md`](./docs/setup-reference.md) holds the longer reference:
every setting key, the inbound mail contract, and the two optional webhooks.

## 1. What this repo is

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
- [`docs/start-here.md`](./docs/start-here.md) is the page for the person. Point
  them to it. It says the same things as parts 3 and 4 below, in fewer words.

## 2. Rules for you

1. **Stop and ask the user at every choice marked ASK.** Do not guess.
2. **Do not deploy, send mail, or contact any service** until the user says so.
3. Keep the tests passing: `npm ci && npm run typecheck && npm test`. The baseline
   is 2,170 passing tests (1,761 from the source, 409 added here). One timing test
   in `src/channels/webhook-ingest-context.test.ts` can fail under load; rerun it
   alone before you treat it as real.
4. Change placeholders consistently in code AND tests. A half-changed name fails tests.
5. Never put real secrets, real people's data, or mail content in this repo.

## 3. How to work with this person

Assume the person knows their program well and knows little about servers. Follow
these rules in every message.

1. **Ask one decision at a time.** Do not send a list of questions. Wait for the
   answer before the next one.
2. **Explain before you ask.** For each decision say, in plain words: what it is,
   why it matters, what the options are, which one you recommend for a first pilot
   and why, and what it costs them in accounts, approvals or effort. Part 5 has
   this for every choice.
3. **Never assume a technical term is known.** The first time you use a word such
   as webhook, container, DNS record, API key, repository or allowlist, explain it
   in one sentence. Part 6 has wording you can use.
4. **Say who does what.** You can read and change files, run the tests, and write
   settings. Only the person can create an account, pay for a service, ask their
   IT or data office for an approval, or add a DNS record at their domain. Say
   which it is each time, and give them the exact words to send to their IT office
   when they need to ask for something.
5. **Confirm before anything that costs money, sends mail, or goes live.** Name the
   action and its effect, and wait for a clear yes. This includes: creating a paid
   account or a machine, sending any test mail or test alert, registering a
   webhook at an outside service, starting a schedule, and adding real people to
   an allowlist.
6. **Do not invent a price, a time estimate or a policy.** For cost, name the
   provider and say "check their current pricing". For what an institution allows,
   say that only their own offices can answer, and help them write the question.
7. **Keep a written record.** Create `setup-decisions.md` in the repo root at the
   start (it is in `.gitignore`, so it is not pushed). After each answer, add the
   question, the answer, who gave it and the date. For an approval, add its
   source. Tell the person where the file is. When the program repo exists, copy
   the policy answers into its `program/kb-governance.md`.
8. **Say what is not tested.** Some options here have run only against test
   doubles. Parts 4 and 5 mark each one. Repeat that mark when you offer the option.
9. **Stop when an answer is "I do not know".** Help the person find who can answer.
   Do not pick for them on a policy question.

### Your first reply

Do not start with questions about servers. In your first reply:

1. Say in three sentences what this is (part 1, first bullet, in plain words).
2. Say that you will ask one thing at a time and write the answers in
   `setup-decisions.md`, and that nothing is sent or deployed without their yes.
3. Describe the three ways to start (part 4), each in two or three plain sentences.
4. Recommend one, and ask which they want. If they only want to see it work, that
   is "Try it". If they have a real team in mind, that is "Pilot".

Then ask the policy questions in part 4 that apply to the chosen path, one at a time.

## 4. Three ways to start

Smallest first. Each later path contains the earlier one's work, so a person can
move up without starting again. "First start" means part 14.

### (a) Try it: one person, one laptop

- **What you get:** the bot answers the person's own questions in one private
  Telegram chat, from a small knowledge-base repo, with citations.
- **What you need:** a laptop that can run Docker and Node; an account with the
  model provider and its key (choice 1); a Telegram account and a bot token (ask
  Telegram's BotFather for one); a private repo on a git host for the knowledge
  base, started from `templates/program-repo/`.
- **Why a git host even for a trial:** the bot reads the list of allowed Telegram
  handles from a mirror that it clones from the program repo's origin
  (`src/repo-reader.ts`, `src/channels/telegram-allowlist.ts`). With a real
  origin, `PROGRAM_ORIGIN_PATTERN`, `INSTITUTION_DOMAIN` and `ADMIN_AUTHOR_EMAILS`
  must be set, or the host refuses to start.
- **What it does NOT give you:** no email, so no colleague can use it; no routed
  approval by mail; no public address; it stops when the laptop sleeps. It is a look at the
  behaviour, not a service. On a laptop with Docker Desktop the agent container's
  network is open by default (choice 17): what the agent reads can leave the
  machine unseen. Use test data only.
- **Steps that apply:** part 13 steps 1 to 6 with only the model, identity and
  Telegram settings; First start steps 1, 2, 3, 4 (the main group and the Telegram
  group; no email group), 5, 6 and 7. Skip "Inbound mail" and both optional webhooks.
  Keep the reply sensor off (choice 2).
- **Not verified:** `docs/deployment.md` names this stage ("Trial"), but no
  step-by-step run of it is recorded in this repo. Treat the first start as the
  test and tell the person so.

### (b) Pilot: the recommended MVP

- **What you get:** a handful of allowlisted colleagues write to one mail
  address. The bot answers from the knowledge base with citations, records
  decisions and action items, routes approval requests, checks each reply at the
  delivery gate, writes the audit log, and alerts the operator when something fails.
- **What you need:**
  - a small virtual machine that is always on (choice 8), and a public name for it
    (a DNS record);
  - the model provider account (choice 1);
  - a private knowledge-base repo on a git host (choice 7);
  - an outbound mail provider account and a sending address (choice 6). The
    default provider asks you to prove you control the sending domain with DNS
    records. To send as an address on the institution's own mail domain, see
    choice 6, option (b);
  - an inbound mail intake service (choice 5). The one in `inbound/` needs a
    Cloudflare account and a domain or subdomain that receives no other mail;
  - a route for operator alerts (choice 4): a Telegram account, or the operator's
    mailbox, or both;
  - the names and addresses of the first colleagues, and who approves for each
    (choice 10);
  - where the institution requires it, an answer from the IT or data office on
    which AI service and mail service this team's mail may reach (part 4, policy
    questions).
- **What it does NOT give you:** no channel for students or the public; no
  single sign-on; no retention or deletion of old mail (the code never deletes
  from the program repo); one outbound mail service at a time, with no fallback
  to another; no web search, web fetch or
  browsing for the agent unless you turn them on (choice 17). Sender caps are in
  memory and reset on restart. No second check of email replies by the reply
  sensor: it is off in the pilot, and when on it checks chat replies only unless
  `SENSOR_EMAIL_REPLIES=1` (choice 2).
- **Steps that apply:** all of part 13, all of First start, "Inbound mail", and
  the supported hosting recipe in `docs/deployment.md`. Add the two optional
  webhooks when the machine has its public HTTPS name.
- **Not verified:** the hosting recipe has not been run end to end (each step in
  `docs/deployment.md` says what was checked). The intake worker in `inbound/`
  has never run against a live Cloudflare account, mailbox or GitHub repo. Operator
  alerts by email have not been sent through a live mail provider. Plan one real
  test of each before colleagues are told the address.
- **Who pushes:** the host, with its own deploy key. The agent commits in its
  checkout and holds no git credential; the host takes those commits out,
  checks them and pushes them (`docs/deployment.md`, step 4; part 10, "The host
  runs no git in the agent's checkout"). This ran against local repositories
  only: watch one agent commit arrive on your git host before real users.

**The MVP, exactly.** The smallest setup that does these four things with a real
colleague, not the operator:

1. answers a real question sent by email, from the knowledge base, with a citation;
2. records one decision in the program repo;
3. routes one approval request to the right approver;
4. leaves an audit entry for each of these.

**MVP exit checklist.** Copy it into `setup-decisions.md` and tick each line with
the person. The pilot is not done until every line is ticked or has a written reason.

- [ ] An allowlisted colleague sent a real question by email and got an answer
      that cites a file in the knowledge-base repo.
- [ ] A status update by email produced one entry in `discussions/DECISIONS.md`,
      committed and pushed to the git host.
- [ ] One approval request from a read-only sender reached the approver named in
      that sender's allowlist row, with the sender's own words quoted.
- [ ] `discussions/audit-log/<date>.md` holds the inbound and outbound entries
      for the three exchanges above.
- [ ] A sender who is not on the allowlist got no answer (or the one courtesy
      reply, if they are at the institution's domain).
- [ ] A test alert reached the operator on each enabled route (First start, step 8).
- [ ] Every line of "Decide before go-live" in `docs/data-handling.md` has a
      written answer.
- [ ] The person has read "Before real users" in `docs/deployment.md` and agreed
      to each line.

### (c) Institutional: approved services only

- **What you get:** the same bot and the same code as the pilot, placed on
  services the institution has approved.
- **What you need,** in addition to the pilot:
  - a virtual machine from a host the institution approves for this data. The
    same recipe applies (`docs/deployment.md`);
  - a model provider the institution approves: an endpoint that serves the
    Anthropic API (`ANTHROPIC_BASE_URL`), or Claude on Microsoft Foundry in the
    institution's own Azure subscription (`MODEL_PROVIDERS`). See choice 1;
  - institutional mail. With the worker in `inbound/`, the mail administrators add
    a forwarding rule or alias from an institutional address to the worker's
    address (`inbound/README.md`, step 1). If mail must stay inside the
    institution's own mail system, you must write the intake service
    (`docs/setup-reference.md`, "Inbound mail");
  - the knowledge-base repo on the institution's git host if it has one, such as
    a GitHub Enterprise host (choice 7);
  - a written sign-off on data handling from the offices that approve it. Take
    them `docs/data-handling.md`.
- **What it does NOT give you:** no new feature. This repo holds no institution's
  policy and no approval. It supports an API key for Foundry only (no Entra ID or
  managed identity). One instance serves one program.
- **Steps that apply:** the pilot's steps, with the approved values. Do the live
  checks in `docs/model-providers.md`, section 6, before the person relies on Foundry.
- **Not verified:** no request from this repo has reached a real Foundry
  endpoint; the failover was tested against fake servers only. One university's
  open questions are under `docs/illinois/`; none of them is answered there.

### Policy questions (ASK)

Policy comes before setup. Get these answers before you change anything. Ask them
one at a time, after the person has chosen a path, with the explanation from the
matching choice in part 5.

1. **Which AI service may this team's mail reach?** The agent sends message text to
   a model. The user's institution may limit this. The code uses Claude through the
   Claude Agent SDK. Other model families need a different agent runner (not included).
   The destinations the code supports:
   - the Anthropic API or a Claude subscription (the default);
   - an endpoint that serves the Anthropic API, set with `ANTHROPIC_BASE_URL`;
   - Claude on Microsoft Foundry in the user's own Azure subscription
     (`MODEL_PROVIDERS`, [`docs/model-providers.md`](./docs/model-providers.md)).
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
   (`src/behaviour-sensor.ts`) calls a model API directly from the host, with
   its own API key, but it goes to the same place as the agent's first choice:
   the first provider in `MODEL_PROVIDERS` (or `anthropic`), and on `anthropic`
   the host in `ANTHROPIC_BASE_URL` when that is set. `SENSOR_PROVIDER`
   overrides the provider. It does not fail over, and it needs an API key (a
   subscription token cannot call it); with no usable key it does nothing. The
   host logs the provider and host it sends to. Still keep
   `BEHAVIOUR_SENSOR_DISABLED=1` unless the user confirms that destination is
   approved. Not tested against a live endpoint. By default the sensor checks
   chat replies only; `SENSOR_EMAIL_REPLIES=1` makes it check email replies
   too, which sends their text to that destination (choice 2).
2. **Who may approve records and access changes?** (the admin and any approvers)
3. **Which address does the bot send from?** And which mail provider delivers it.
   An address on a domain the team controls works today with the default
   provider. An address on the institution's own mail domain needs that
   institution's mail system to accept a login from the bot (choice 6, option
   (b)); only the mail administrators can say whether it does. Do not tell the
   user it is allowed. ASK them to get the answer in writing.
4. **Where does the data live?** The host for the bot, and the git host for the program repo.
5. **What consent wording do senders see**, if any, and who is on the allowlist.
6. **Which channels?** Email only is the simplest. Telegram and web chat are optional.
   Ask also where operator alerts should go: Telegram (the default), email to the
   operator's address, or both (`ADMIN_ALERT_ROUTE`; see "Safety items").

For "Try it", questions 1, 2 and 4 apply. Questions 3 and 5 apply as soon as
email is used.

## 5. Every choice you will be asked to make

One entry for each setup choice that exists on `main`. For each: what it means in
plain words, the options, what the code does when nothing is set, what to choose
for a first pilot, the setting names, and where the detail is. Setting names were
checked against `config/instance.env.example` and the code; a test
(`scripts/upstream-sync/test_setup_docs.py`) fails when a key in that file is
named neither here nor in `docs/setup-reference.md`.

Two places hold settings. Keys marked **(.env)** go in the `.env` file. Keys marked
**(process)** are read only from the process environment, and a line in `.env`
does nothing for them. `docs/setup-reference.md` has the full table.

**1. Model provider, and the order of providers**
- *Plain words:* the bot sends each message, and the files it reads, to an AI
  service that writes the reply. You choose which service, and whether a second
  one takes over when the first fails.
- *Options:* (a) Anthropic directly, with an API key or a Claude subscription
  token; (b) another endpoint that serves the Anthropic API; (c) Claude on
  Microsoft Foundry in your own Azure subscription, alone, as the primary, or as
  the backup.
- *Code default:* Anthropic only.
- *First pilot:* one provider, the one your institution allows. No backup yet: a
  backup is a second place your team's mail goes, and the failover has run only
  against fake servers.
- *Cost to the person:* an account with the provider and a key; usage is billed
  by the provider (check Anthropic's or Microsoft's current pricing). For
  Foundry, an Azure subscription and three deployments.
- *Settings:* `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` (one of the two),
  `ANTHROPIC_BASE_URL`, `MODEL_PROVIDERS` (`anthropic`, `foundry`,
  `anthropic,foundry`, `foundry,anthropic`), `ANTHROPIC_FOUNDRY_RESOURCE` or
  `ANTHROPIC_FOUNDRY_BASE_URL`, `ANTHROPIC_FOUNDRY_API_KEY`, `FOUNDRY_KEY_HEADER`,
  `FOUNDRY_AGENT_MODEL`, `FOUNDRY_GATE_MODEL`, `FOUNDRY_OPUS_MODEL`,
  `FOUNDRY_SONNET_MODEL`, `FOUNDRY_HAIKU_MODEL`, `MODEL_FAILOVER_THRESHOLD`,
  `MODEL_FAILOVER_COOLDOWN_MS` (all .env). Which model and how much reasoning:
  `NANOCLAW_AGENT_MODEL`, `NANOCLAW_GATE_MODEL`, `NANOCLAW_AGENT_EFFORT` (process).
- *Detail:* policy question 1; "Safety items" (model endpoint, backup provider);
  `docs/model-providers.md`.

**2. Reply sensor: on or off, and which provider it uses**
- *Plain words:* a second check that compares a reply with the facts that must
  not be wrong (the ground-truth files). It makes its own call to an AI service,
  separate from the bot's.
- *Options:* off; on, following the agent's first provider (the public
  Anthropic API, the endpoint in `ANTHROPIC_BASE_URL`, or Foundry); on with a
  provider chosen on its own.
- *Code default:* on, when a key and the ground-truth file exist. It checks chat
  replies (Telegram and web chat), not email replies (`docs/data-handling.md`).
- *Email replies:* a second switch, `SENSOR_EMAIL_REPLIES`, off by default. With
  it off, no email reply is checked, and email is where most replies go. With
  `SENSOR_EMAIL_REPLIES=1` the sensor also checks each email reply once, after
  it has been sent; it never delays or stops a reply. ASK before turning it on:
  it sends the text of every email reply, the start of the mail it answers and
  knowledge-base excerpts to the sensor's AI service, which is a new place for
  mail text to go. It does not check mail the bot sends on its own (the
  `send_email` tool, scheduled mail, operator alerts). `BEHAVIOUR_SENSOR_DISABLED=1`
  turns both off. Tested with the AI service stubbed, not against a live one.
- *First pilot:* off, and `SENSOR_EMAIL_REPLIES` unset. Turn it on only when
  its destination is approved for your data and the ground-truth files fit your
  project (part 8).
- *Settings:* `BEHAVIOUR_SENSOR_DISABLED=1` (process), `SENSOR_EMAIL_REPLIES`
  (`1` to check email replies; .env or process; unset is off), `SENSOR_PROVIDER`
  (`anthropic` or `foundry`; .env or process; unset follows the first entry of
  `MODEL_PROVIDERS`), `SENSOR_MODEL` (process). It also reads
  `ANTHROPIC_BASE_URL` and `MODEL_PROVIDERS` (.env).
- *Detail:* policy question 1; part 8; `docs/data-handling.md`.

**3. Channels: email, Telegram, web chat**
- *Plain words:* the ways people reach the bot.
- *Options and limits:*
  - **Email.** The main channel. Needs choices 5 and 6 and a public HTTPS
    address. Has a per-person allowlist and per-sender daily caps.
  - **Telegram.** Use it with one chat only, the admin's: with two chats a reply
    can go to the wrong one. No per-sender cap. Needs the handle list in the
    program repo and the chat sender allowlist file (choice 10).
  - **Web chat.** Anyone who has its shared secret is answered; there is no list
    of people and no cap. The reference deployment retired it. Treat it as untested.
- *Code default:* a channel runs when its settings are present (`WEBHOOK_SECRET`
  for the mail listener, `TELEGRAM_BOT_TOKEN` for Telegram, `WEBCHAT_SECRET` for
  web chat). **Web chat also needs `WEBHOOK_SECRET`:** the one HTTP listener is
  started by the mail webhook channel (`src/channels/webhook.ts`), and web chat
  only adds its `/chat` route to it. With `WEBCHAT_SECRET` alone the channel
  reports ready and no port is open.
- *First pilot:* email for the team; Telegram for the admin only, if the admin
  wants it; web chat off.
- *Settings:* `WEBHOOK_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID`,
  `WEBCHAT_SECRET` (.env); `WEBHOOK_HOST`, `WEBHOOK_PORT` (process).
- *Detail:* part 9; "Safety items"; `SPEC.md` sections 3 and 11.

**4. Where operator alerts go**
- *Plain words:* when a reply is refused, a mail bounces or a check fails, the
  bot tells one person, the operator. You choose how.
- *Options:* Telegram; email to the operator's own mailbox; both.
- *Code default:* Telegram. With no bot token, alerts are not delivered.
- *First pilot:* Telegram if the operator will use it (it is the route tested in
  production), with email added as a second route. Email alone works without a
  Telegram account, but it has limits ("Safety items") and has not been sent
  through a live mail provider.
- *Cost to the person:* a Telegram account and a bot token, or nothing new for email.
- *Settings:* `ADMIN_ALERT_ROUTE` (`telegram`, `email`, `telegram,email`),
  `OPERATOR_CC_EMAIL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID`,
  `DEAD_LETTER_ALERT_JID`, `OUTREACH_SUMMARY_JID` (.env); `ADMIN_ALERT_TEST=1`
  (process, first start only).
- *Detail:* "Safety items" (operator alerts); First start, step 8.

**5. Inbound mail intake**
- *Plain words:* the bot does not receive mail itself. A small separate service
  receives each message, files a copy in the knowledge-base repo, and tells the bot.
- *Options:* (a) the worker in `inbound/`, which runs at Cloudflare; (b) a
  service you write for your own mail provider.
- *Code default:* none. Without an intake service there is no email channel.
- *First pilot:* the worker in `inbound/`, on a domain or subdomain that receives
  no other mail. It has never run against live services: plan a real test.
- *Cost to the person:* a Cloudflare account, a domain whose DNS they or their IT
  office can change, and a GitHub token limited to the knowledge-base repo. For
  an institutional address, a forwarding rule from the mail administrators.
- *Settings:* `WEBHOOK_SECRET`, `INTAKE_GIT_AUTHOR_EMAIL` (.env). The worker's own
  settings are in `inbound/wrangler.toml`.
- *Detail:* part 12; `inbound/README.md`; `docs/setup-reference.md`, "Inbound mail".

**6. Outbound mail provider and the from-address**
- *Plain words:* a mail service that delivers the bot's replies, and the address
  those replies come from.
- *Options:*
  - (a) **Your own domain, through Resend.** The default, and the only path
    that has run in production. You prove you control the sending domain with
    DNS records. It cannot send as an address on a domain someone else runs:
    an institution's own mail domain is not supported on this path.
  - (b) **SMTP submission** (`OUTBOUND_MAIL_PROVIDER=smtp`). The bot logs in
    to a mail server you name, as a mailbox there, and hands it each mail.
    This is how the bot can send as an address on the institution's mail
    domain, if the institution's mail system allows a program to log in with
    a username and a password or app password. ASK the user to ask the mail
    administrators; do not assume it. New in this repo (2026-11-20), tested
    against a local test server only, never against a real mail system.
  - Another service needs code. Sending through Microsoft Graph is not
    implemented (issue 67).
- *What option (b) loses:* no bounce or complaint reports and no
  "unconfirmed after 12 hours" report. A bounce arrives as mail in the sending
  mailbox, the bot ignores it, and nobody is alerted: a person must read that
  mailbox. If the connection drops after a mail was handed over and before
  the server answered, the bot cannot tell whether it was delivered; it
  reports that to the operator and does not send again. Tell the user both.
- *Code default:* option (a). Without the key no mail is sent, and each send
  is reported as a shortfall. With option (b) the host does not start until
  the SMTP settings are complete and name an encrypted mode.
- *First pilot:* option (a), with an address on a domain you control, the same
  address colleagues write to. Choose (b) only when the address must be on
  the institution's domain and the mail administrators have said yes.
- *Cost to the person:* (a) an account with the provider (check Resend's
  current pricing) and DNS records on the sending domain. (b) a mailbox on the
  mail system, its login, and whatever approval the mail administrators ask for.
- *Settings:* `OUTBOUND_MAIL_PROVIDER` (`resend`, `smtp`), `SEND_FROM_EMAIL`,
  `SEND_FROM_NAME`, `BOT_MAIL_DOMAIN`, `OUTBOUND_EMAIL_STAGGER_MS` (.env).
  For (a): `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` (bounce reports). For
  (b): `SMTP_HOST`, `SMTP_SECURITY` (`starttls` or `tls`; there is no
  unencrypted mode), `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD` (a secret,
  `.env` only), `SMTP_ENVELOPE_FROM` (optional). With (b), set
  `SEND_FROM_EMAIL` to the mailbox's address and `BOT_MAIL_DOMAIN` to its domain.
- *Detail:* policy question 3; `docs/setup-reference.md`, "Outbound mail over
  SMTP" (how each server answer is treated, and the setup steps) and "Mail
  delivery events".

**7. Knowledge-base repo: which git host, and who can push**
- *Plain words:* the team's record lives in its own private repository (a folder
  with full history, kept at a hosting service). The bot reads and writes it. It
  also holds every inbound mail and the audit log, so whoever can read it can
  read all the team's mail to the bot.
- *Options:* github.com, or a GitHub Enterprise host at your institution. Any git
  host works for reading and writing; the push webhook and the `inbound/` worker
  are written for GitHub's API.
- *Code default:* the placeholder origin `example-org/program-repo`. Any other
  origin is refused until the pattern is set.
- *First pilot:* a private repo; readers are the pilot team and the operator;
  push rights for the admin, the bot's machine (a deploy key for that one repo)
  and the intake service (a token for that one repo).
- *Settings:* `PROGRAM_REPO`, `PROGRAM_ORIGIN_URL`, `PROGRAM_ORIGIN_PATTERN`,
  `PROGRAM_READ_MIRROR`, `PROGRAM_HOST_REPO` (process); `GITHUB_PUSH_WEBHOOK_SECRET` (.env or process).
- *Detail:* part 11; First start, step 5; `docs/illinois/github-enterprise.md`;
  `docs/data-handling.md`, "Who can read the audit log and the raw mail".

**8. Hosting: where the bot runs**
- *Plain words:* the bot is a program that must stay running on a computer that
  can start containers (small sealed workspaces, one per message).
- *Options:* (a) a laptop, for "Try it" only; (b) one virtual machine with the
  systemd recipe in `docs/deployment.md`, the one supported recipe; (c) the pm2
  files `start.sh`, `ecosystem.config.cjs` and `scripts/deploy.sh`, which are
  examples from the reference deployment and not supported here.
- *Code default:* none; you start it.
- *First pilot:* (b), run as a dedicated non-root user. The recipe has not been
  run end to end.
- *Cost to the person:* a virtual machine from a cloud provider or their
  institution (check the provider's current pricing), and a DNS name for it.
- *Settings:* `WEBHOOK_HOST=127.0.0.1`, `WEBHOOK_PORT`, `CREDENTIAL_PROXY_PORT`
  (process); `TZ` (.env). `WEBHOOK_HOST` matters for choice 17 too: left unset,
  the listener is on all interfaces and the agent container can reach it. Only when the host process runs as root, which the
  recipe does not do: `CHECKOUT_OWNER_UID`, `CHECKOUT_OWNER_GID`,
  `CHECKOUT_OWNER_HOME` (process).
- *Detail:* `docs/deployment.md`; `docs/illinois/hosting.md` (a stub).

**9. Identity: names and domains**
- *Plain words:* what the bot is called, which mail domain is "yours", and which
  people count as the admin.
- *Required:* `ASSISTANT_NAME` and `SEND_FROM_EMAIL` (marked REQUIRED in the
  settings example). With a real program
  repo, `INSTITUTION_DOMAIN` and `ADMIN_AUTHOR_EMAILS`: the host refuses to start
  when either is missing or still a placeholder. For the domain, `example.edu`
  and any subdomain of it (`mail.example.edu`) count as the placeholder.
- *Not enforced, but set them:* `BOT_MAIL_DOMAIN`, `INTAKE_GIT_AUTHOR_EMAIL`,
  `OPERATOR_CC_EMAIL`. Each default is a placeholder.
- *First pilot:* set all of them. ASK for the admin's real git commit addresses;
  do not guess them.
- *Settings:* all (.env). The placeholders that are still text in code and
  prompts are in part 7.
- *Accounts and secrets:* every account and key the bot uses belongs to a role
  held through a unit or service account, not to one person's own login. ASK who
  holds each, and fill in the table in `docs/service-ownership.md` with the person.
  A model subscription on one person's own account is the weakest item there.
- *Detail:* part 7; First start, step 7; `docs/service-ownership.md`.

**10. Allowlists: who may write to the bot**
- *Plain words:* an allowlist is the list of people the bot will answer. Anyone
  else gets no answer.
- *The three lists:*
  - the email allowlist, a table in the program repo
    (`program/EMAIL_ALLOWLIST.md`): address, role, access tier (may this person's
    updates be recorded as fact, or only as a request), and approver;
  - the Telegram handle list, a section of the same file;
  - the chat sender allowlist, a file on the bot's machine
    (`~/.config/nanoclaw/sender-allowlist.json`). **If this file is missing or
    invalid, nobody is allowed on chat.**
- *Code default:* the template's placeholder rows. Email caps: 30 messages a day
  for a person, 10 for an automated agent or an unknown sender.
- *First pilot:* staff only, a handful of people, each with an approver. No
  students. Only the admin on Telegram.
- *Settings:* `EMAIL_SENDER_DAILY_CAP`, `EMAIL_PERSON_SENDER_DAILY_CAP` (process).
- *Detail:* "Safety items"; First start, step 3; `templates/program-repo/`.

**11. Approvers and routed approvals**
- *Plain words:* when someone asks for something that another person must
  approve, the bot records the request and sends it to that approver.
- *Options:* who the admin is, and who approves for each sender (one column in
  the allowlist).
- *First pilot:* one admin; one approver per sender. Test one exchange.
- *Settings:* the allowlist rows; `INSTITUTION_DOMAIN`; `ADMIN_AUTHOR_EMAILS`.
- *Detail:* policy question 2; `SPEC.md` section 4.

**12. Reminders and scheduled outreach**
- *Plain words:* the bot can send mail on a schedule, such as a weekly list of
  open action items to their owners.
- *Options:* none; or jobs you list in a reminder registry.
- *Code default:* no outreach mail is sent until one approved task id is set.
- *First pilot:* none until the MVP checklist is ticked. Then one job, listed in
  the registry, started only after the operator agrees (ASK).
- *Settings:* `EMAIL_OUTREACH_TASK_ID`, `OUTREACH_SUMMARY_JID` (.env).
- *Detail:* `docs/reminder-registry.md`; `SPEC.md` section 4.

**13. Optional webhooks from other services**
- *Plain words:* a webhook is a message one service sends to another when
  something happens. Two are optional: the mail provider reporting a bounce, and
  the git host reporting a change to the knowledge-base repo.
- *Code default:* both off (the route answers 503 with no secret).
- *First pilot:* add the mail delivery one, so bounces are reported. Add the
  push one if the repo is on GitHub.
- *Settings:* `RESEND_WEBHOOK_SECRET` (.env), `GITHUB_PUSH_WEBHOOK_SECRET`.
- *Detail:* `docs/setup-reference.md`, "Webhooks from other services". ASK
  before you create either one.

**14. Data handling and retention**
- *Plain words:* where the team's messages go, who can read them, and how long
  they are kept.
- *What the code does:* message text reaches the model provider, the mail
  provider, the intake service, Telegram if used, and the git host. The code
  never deletes anything from the program repo, and there is no retention setting.
- *First pilot:* the conservative default in `docs/data-handling.md`: staff
  senders only, no student records, the reply sensor off, a private repo, web
  chat off. Take that page to the people who approve data use, and write each
  answer in `setup-decisions.md`.
- *Settings:* none for retention. Leave `LOG_LEVEL` unset.
- *Detail:* `docs/data-handling.md`; `docs/illinois/data-handling.md` (open
  questions only).

**15. What senders are told**
- *Plain words:* the words colleagues see about where their mail goes.
- *Options:* the person writes them; the code has no fixed text.
- *First pilot:* a short written note to each pilot colleague before their
  address is added, including what not to send.
- *Detail:* policy question 5; `docs/data-handling.md`.

**16. Vocabulary and the facts that must not be wrong**
- *Plain words:* the examples in the bot's instructions come from an academic
  program. For another kind of project the words, and the list of facts the
  reply sensor checks, need adapting.
- *First pilot:* adapt the wording; keep the sensor off unless the ground-truth
  files are right for the project.
- *Detail:* part 8.

**17. What the agent can reach: the container's network and web tools**
- *Plain words:* the agent works in a sealed workspace (a container). Two
  settings decide whether anything it reads (the team's mail, the knowledge
  base) can leave that workspace by a route other than a reply. The first is the
  workspace's network. The second is whether the agent may search the web and
  fetch pages. Neither route is checked by the delivery gate or written to the
  audit log.
- *Options for the network (`CONTAINER_NETWORK`):*
  - `restricted`: the container reaches the credential proxy on the host and
    nothing outside: no website, no git host, no outside name lookup.
  - `open`: the container can reach any host. The host logs a warning at each start.
- *Options for web tools (`AGENT_WEB_TOOLS`):* unset (off) or `1` (on). A web
  search is run by the model provider, so the agent's query leaves through the
  proxy even on the restricted network. Web fetch and `agent-browser` also need
  the network `open`.
- *Code default:* network `restricted` on Docker Engine on Linux and `open` on
  Docker Desktop (macOS, Windows with WSL), where `restricted` was not verified.
  Web tools off. Any other value of `CONTAINER_NETWORK` stops the start.
- *First pilot:* `restricted` and web tools off, on a Linux machine. ASK before
  you set `open` or turn web tools on, and write the answer in `setup-decisions.md`.
- *What stops working with the pilot choice:* web search and web fetch;
  `agent-browser`; `curl` and any other network use from the agent's shell;
  `git push` inside the container (the host pushes; `git pull` still works,
  because it reads the host's read-only export: First start, step 5); a scheduled-task script that fetches a URL (the example in
  `groups/global/references/scheduled-task-scripts.md` does). With web tools off
  the proxy also refuses requests that would make the model provider reach an
  outside host for the agent: a web search or fetch tool, a remote MCP server, an
  image or document given as a URL, and the provider's managed agents API
  ("Safety items").
- *What the restricted network does not stop.* Tell the person each of these:
  - **A host service that listens on all interfaces is reachable from the
    container**, on the network's gateway address. The webhook listener does that
    unless `WEBHOOK_HOST=127.0.0.1` is set, and the host logs a warning at each
    start while it is not. Set it (choice 8).
  - Whatever the agent puts in a model request goes to the model provider.
- *Settings:* `CONTAINER_NETWORK`, `AGENT_WEB_TOOLS` (process, else .env; both
  are read at start, so a change needs a restart); `CONTAINER_NETWORK_NAME`
  (process; the Docker network's name, default `nanoclaw-agents`; change it only
  if the name is taken); `CREDENTIAL_PROXY_HOST` (process; used on the open
  network only).
- *Not tested:* no agent turn has run against a real model provider on the
  restricted network. On 2026-11-20 real agent containers on that network
  completed a turn against a local stand-in for the provider (API-key mode and
  OAuth mode); the proxy's refusals have run against stand-ins only. Foundry was
  not run in a container. `restricted` is not
  verified on Docker Desktop or on Docker older than 29. First start, step 9,
  checks the network on the machine in use.
- *Detail:* "Safety items"; First start, step 9; `SPEC.md` sections 2 and 11;
  `docs/data-handling.md`, "The container's network".

## 6. Words to explain

Use these, or your own words of the same length, the first time each term comes up.

- **Allowlist:** the list of people the bot will answer. A message from anyone
  else is not answered and never reaches the AI service.
- **Delivery gate:** a check on the bot's machine that every reply and every
  outgoing mail must pass before it is sent. A reply that fails is not sent, and
  the operator is told.
- **Audit log:** a dated file in the knowledge-base repo where the bot's machine
  writes each accepted message and each reply, so a person can review later what
  was asked and what was answered.
- **Knowledge-base repo (program repo):** a private, versioned folder at a git
  host that holds the team's record: decisions, action items, open questions,
  the allowlist, the mail copies and the audit log. Every change is kept in its history.
- **Routed approval:** a request that needs another person's yes. The bot
  records it and sends it to the approver named for that sender; it does not
  decide.
- **Container:** a sealed workspace that the bot's machine starts for one
  message and then removes. The AI agent works inside it and sees only the
  folders it was given.
- **Webhook:** a message one service sends to another over the internet when
  something happens, such as "a new mail arrived" or "this mail bounced".
- **Credential proxy:** a small relay on the bot's machine that adds the secret
  key to each request to the AI service, so the key is never inside the container.
- **Model provider:** the company or cloud service that runs the AI model the bot
  sends text to.
- **API key (or token):** a long secret string that proves to a service that a
  request comes from your account. Treat it like a password.
- **DNS record:** an entry at the place that manages a domain name, which says
  where mail or web traffic for that name should go.
- **Operator (admin):** the one person who looks after the bot, receives its
  alerts, and is the only one who may change roles and access.

## 7. Placeholders to replace

Search for each placeholder (include tests; exclude `node_modules`):

| Placeholder | Meaning | Where it lives |
|---|---|---|
| `Coordinator` (also `Co-ordinator`, `co[\s-]?ordinator` in patterns) | The bot's name | `ASSISTANT_NAME` in `.env`, prompts in `groups/`, several `src/` files and patterns that recognise the name |
| `Program`, `program-email`, `program-telegram`, `web-chat-program`, `tg-program` | The program or project name and its channel group names | `groups/` folder names, `seed-db.cjs`, `src/index.ts`, `src/task-scheduler.ts` and others |
| `program-repo`, `/workspace/extra/program-repo` | The knowledge-base repo and its mount point in the container | `PROGRAM_REPO` (process environment), `src/program-repo.ts`, prompts, container skills |
| `example-org/program-repo` | The git origin the host accepts for the program repo. A different origin is refused and the read mirror is not created. | `isExpectedOrigin` in `src/program-origin.ts`; set `PROGRAM_ORIGIN_PATTERN` and `PROGRAM_ORIGIN_URL` (process environment). Any git host works, including a GitHub Enterprise host; `config/instance.env.example` has example patterns |
| `example.edu` | The institution mail domain. It is used in logic: the "access closed" courtesy reply (`src/channels/webhook.ts`) and approver addresses in `src/routed-approvals.ts` | Setting: `INSTITUTION_DOMAIN` in `.env`. **Required for a real program repo:** the host refuses to start when it is missing, `example.edu` or a subdomain of `example.edu` (`src/identity-settings-check.ts`). The operator's address, the shared mailbox in `src/trusted-body-mailboxes.ts`, prompts and tests still hold `example.edu` as text |
| `example.org` | The bot's own mail domain: the default bot address, the Message-ID domain, and the bot's git author `program-bot@example.org` | Setting: `BOT_MAIL_DOMAIN` in `.env`. Prompts in `groups/` and skills in `container/skills/` name the git author as text; change them to match. The site address `program-repo.example.org` in `src/behaviour-sensor.ts` is not covered by the setting |
| `email-inbox@example.org` | The git author of the inbound mail intake service (see "Inbound mail") | Setting: `INTAKE_GIT_AUTHOR_EMAIL` in `.env` |
| `Avery Morgan`, `avery@example.edu`, `tg-avery@program` | The operator (admin). Outreach, routed approvals and admin checks name this person | `src/config.ts`, `src/outreach-recipient-roster.ts`, `src/routed-approvals.ts`, `src/channels/webhook.ts`, prompts |
| `ADMIN_AUTHOR_EMAILS` (`avery@example.edu`, `avery.personal@gmail.com`, a `users.noreply.github.com` address) | The git author identities allowed to change protected governance files | Setting: `ADMIN_AUTHOR_EMAILS` in `.env`, separated by commas. **Required for a real program repo.** Use the admin's real commit identities. The setting replaces the placeholder list. With a real program repo the host refuses to start when the setting is missing or names a placeholder address (`src/identity-settings-check.ts`); the placeholders count as admin only with the placeholder repo |
| `/^greta\b/i` | A one-person exception in the outreach roster (a departed owner whose section is skipped) | `src/outreach-recipient-roster.ts`, near `unmatchedOwners`. Remove it or replace it with your own case. |
| Other synthetic people (in `OWNER_ALIASES` in `src/outreach-recipient-roster.ts`) | A short-name table for the team | Replace with the user's team or empty it |
| `PeerAgent`, `averybot@gmail.com` | A second automated agent that also mails the bot | `src/config.ts` (`AGENT_INBOX_ADDRESSES`); empty the list if the user has none |
| `CRS`, `ELC`, `LAB` plus three digits | Course-code prefixes | See part 8 |

Settings that already exist are in `config/instance.env.example`. **Read its header first.** Some keys are read from the `.env` file; others are read only from the process environment, and a line in `.env` does nothing for them (this includes `PROGRAM_REPO`, `PROGRAM_HOST_REPO`, `PROGRAM_ORIGIN_URL`, `PROGRAM_ORIGIN_PATTERN`, `WEBHOOK_HOST` and `BEHAVIOUR_SENSOR_DISABLED`). The parser does not strip inline comments. The supported way to run the bot is the systemd recipe in `docs/deployment.md`; `start.sh` and `ecosystem.config.cjs` are pm2 examples from the reference deployment.

## 8. Academic examples

The prompts, skills and two pieces of logic use an academic program as the example
domain: courses, faculty, curriculum, cohort. This text is kept because it is the
tested text. Adapt the vocabulary to the user's project. The logic that knows about
courses is in:

- `src/behaviour-sensor.ts` (the reply checker, for chat replies by default:
  ground-truth files such as `program/curriculum.md`, course-code patterns)
- `src/open-questions-scan.ts`
- `container/skills/kb-conflict-check/check-ingestion-crosscheck.mjs` and
  `container/skills/kb-entry-gate/check-kb-entry.mjs`

For a project with no course-like codes, ASK the user what the equivalent "facts
that must not be wrong" are, or turn the sensor off (`BEHAVIOUR_SENSOR_DISABLED=1`)
and say so.

## 9. Features and what each needs

| Feature | Status | Needs |
|---|---|---|
| Email questions and status updates | In production in K-ai | **An inbound mail intake service** (see "Inbound mail"), outbound provider key, allowlist file in the program repo |
| Inbound mail intake worker (`inbound/`) | **New; never run against live services.** Not the worker K-ai uses | A domain on Cloudflare Email Routing, a GitHub token for the program repo, the webhook secret |
| Delivery gate and audit log | In production in K-ai | Nothing extra |
| Reminders and scheduled outreach | In production in K-ai | A reminder registry (`docs/reminder-registry.md` is the template); ASK before any schedule goes live |
| Routed approvals | In production in K-ai | Approver recorded per sender in the allowlist; the institution domain set correctly |
| Telegram admin channel | In production in K-ai. The default route for operator alerts (see "Safety items") | Bot token, admin chat ID, **the chat sender allowlist file** |
| Operator alerts by email (`ADMIN_ALERT_ROUTE=email`) | New in this repo, not in K-ai. Tested here with the mail provider stubbed; **not yet run against a live provider** | `OPERATOR_CC_EMAIL` set to one person's address, the outbound provider key |
| Outbound mail over SMTP (`OUTBOUND_MAIL_PROVIDER=smtp`) | New in this repo (2026-11-20), not in K-ai. Tested with a local SMTP server inside the tests; **never run against a real mail server**. No bounce reports | A mailbox on a mail server that accepts an encrypted login with a username and password; the mail administrators' agreement |
| Behaviour sensor and evaluation scripts | In production in K-ai | Ground-truth files in the program repo; see "Academic examples" |
| Restricted container network (`CONTAINER_NETWORK`) | New in this repo (2026-11-20); not in K-ai. Checked with real containers on Docker Engine on Linux only | Docker Engine on Linux for the default; see "Safety items" |
| Web search, web fetch, `agent-browser` | Off by default since 2026-11-20 | `AGENT_WEB_TOOLS=1`; fetch and browser also need `CONTAINER_NETWORK=open`. ASK first |
| Web chat | Was in production, later retired there | A secret and a reverse proxy; treat as untested. **No allowlist of people: any caller with the secret is answered** |

## 10. Safety items you must handle

- **Chat sender allowlist:** if `~/.config/nanoclaw/sender-allowlist.json` is missing,
  unreadable or invalid, the chat trigger check allows nobody and the host logs the
  path once (`src/sender-allowlist.ts`). It applies to every group registered with
  a required trigger, except the main group. Senders are matched exactly on the id the channel
  reports: for Telegram `tg:<numeric user id>`, not the `@handle`. The Telegram
  handle list in the program repo is a separate, earlier check. Start from
  `config-examples/sender-allowlist.json` ("First start", step 3).
- **Accounts, keys and handover:** `docs/service-ownership.md` lists every credential,
  its owner role, where it is stored and how to rotate it, with a handover checklist
  for when the builder or operator leaves. Run `chmod 600 .env` when you create the
  file (`docs/deployment.md`, step 3); no step in this guide does it for you. Do not
  paste a secret into the chat or into `setup-decisions.md`.
- **Listener address:** set `WEBHOOK_HOST=127.0.0.1` and use a reverse proxy. The code
  default listens on all interfaces.
- **The host runs no git in the agent's checkout.** The agent can write the whole
  checkout, `.git/config` and `.git/hooks` included, and git obeys both. So the host
  keeps its own repository (`PROGRAM_HOST_REPO`, `src/host-repo.ts`) that no container
  mounts. The audit log is written and committed there, and every fetch and push with
  the host's credential runs there. Commits leave the checkout through a fetch from
  its path, are checked, and are pushed to the origin the host was given
  (`PROGRAM_ORIGIN_URL`, or the read mirror's origin), never to an address the checkout
  names. Do not add a host git call that uses the checkout as its repository:
  `src/host-git-guard.test.ts` fails when one appears. Do not mount the host repo, its
  export or the read mirror into a container; the host refuses such an extra mount.
  `SPEC.md` section 11 lists what this does not cover.
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
  - With `OUTBOUND_MAIL_PROVIDER=smtp`, alert mail goes through the same SMTP
    server, and a bounced mail raises no alert at all (there are no bounce reports).
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
  `docs/model-providers.md` before the user relies on the backup.
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
- **The container's network is restricted by default on Linux.** `CONTAINER_NETWORK`
  (`src/container-runtime.ts`) has two values. `restricted` puts the container on a
  Docker network created with `--internal`: it reaches the host's credential proxy and
  no outside host, no git host and no outside DNS name. `open` is the runtime's default
  network, where the agent can send what it reads (mail, the knowledge base) to any
  host, unseen by the delivery gate and the audit log; the host logs a warning at each
  start. The default is `restricted` on Docker Engine on Linux, where it was checked
  with real containers, and `open` on Docker Desktop (macOS, WSL), where it was not.
  ASK before you set `open` (choice 17). Limits the user must know:
  - **The container still reaches any host service that listens on all interfaces.**
    The webhook listener does so unless `WEBHOOK_HOST=127.0.0.1` is set in the process
    environment; the code default is all interfaces, and the host warns at each start
    while the network is restricted and that address is not loopback. Set it.
- **Web search and web fetch are off by default.** `AGENT_WEB_TOOLS=1` turns them on
  (`src/web-tools.ts`). Web fetch and `agent-browser` need `CONTAINER_NETWORK=open` as
  well. While the setting is off, the tools are removed from the agent's list, and the
  credential proxy is the boundary: it reads every request the container sends, and
  refuses one that would make the model provider contact an outside host. That is a
  web search or web fetch tool, a remote MCP server (`mcp_servers`, `mcp_toolset`), an
  image or document given as a URL, and the managed agents API (`/v1/agents`,
  `/v1/sessions`, `/v1/environments`). On a model path it also refuses a body it
  cannot read as JSON, or one with a content encoding. It forwards only the model
  paths (`/v1/messages` and below, `/v1/complete`), the model list and the OAuth key
  exchange; any other path on the provider's host is refused and named once in the
  host log. Limits: the refused features were read from the type definitions of the
  pinned SDK, not seen at a live provider; and a tool type the proxy does not know is
  forwarded with one warning in the host log, so tool types are not an allowlist. If
  an agent turn fails with "Refused by this deployment", read the host log for the
  reason before you change a setting. ASK before you turn web tools on.
- **Mounts:** `config-examples/mount-allowlist.json` must list only the program repo. The email group is not the main group and it must write to the program repo in status-update mode, so `nonMainReadOnly` is `false` in the example. Keep the web chat group's own mount read-only in its group registration.
- **Protected files are guarded for the agent's file-editing tools only.** `container/agent-runner/src/protected-write-guard.ts` blocks Write, Edit and NotebookEdit on protected paths. It does not inspect shell commands, so the agent can still change such a file in its checkout. The host does not push that: a commit from the checkout that changes a protected path is refused, whatever author it names, and the operator is alerted (`src/host-repo.ts`). The git-author check in `src/governance-protection.ts` still judges commits that reach the origin another way. Do not describe the tool guard to the user as a hard block.
- **Known gaps inherited from the source** (reported there): the conflict-check skill tells the agent to notify the admin with a Telegram tool that is not registered; two prompts and that skill disagree on how to record an uncorroborated spreadsheet fact (the skill is stricter: it goes to open questions); `groups/main/CLAUDE.md` is mostly upstream framework text.
- **Operations scripts are examples.** `scripts/deploy.sh`, `scripts/state-snapshot*.{sh,mjs}`
  and `ecosystem.config.cjs` come from the reference deployment. `deploy.sh` runs
  `git reset --hard` in a fixed folder. Read each script, change its paths and
  remotes, and ASK before you run any of them.
- **Email addresses come only from the allowlist or the inbound mail** (enforced for email; an instruction for chat). Do not
  weaken this rule (G59) when you adapt prompts.

## 11. The program repo

The bot needs a separate git repo for the team's knowledge base. Start from
`templates/program-repo/`: it has the file names and table formats this code reads.
ASK where the repo will be hosted
and who can push.

## 12. Inbound mail and the optional webhooks

The host does not receive mail itself. A separate intake service does.
The four things it must do (file a Markdown copy in the program repo, call this
host's webhook, keep the original message, and pass a routed-approval test) are
in [`docs/setup-reference.md`](./docs/setup-reference.md), "Inbound mail: the
contract". Read it before you set up or write an intake service.

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
- Its git author is a setting in the worker (`GIT_AUTHOR_EMAIL`, default
  `email-inbox@example.org`). The host must hold the same address in
  `INTAKE_GIT_AUTHOR_EMAIL` (`.env`). With a different address on one side,
  plain questions still work but routed approvals are held.

ASK which mail provider the user has. If it is not Cloudflare, or the user's
institution requires mail to stay inside its own mail system, you must write the
service: read the contract, then the handler in `src/channels/webhook.ts` (search for
`Missing filename or subject`) and `src/cc-context.ts`, check the service's git
author against `src/governance-protection.ts`, and use `inbound/` and its fixtures
as the worked example. `src/channels/webhook-inbound-intake.test.ts` runs those
fixtures through the real handler; a new service should pass the same checks.


**Two optional webhooks** share the listener with inbound mail: mail delivery
events from the mail provider (`/resend/webhook`; not used when
`OUTBOUND_MAIL_PROVIDER=smtp`) and pushes to the program repo
(`/api/github-push`). Each tells an outside service to send data to this host, so
ASK before you create either one. Set them up after First start, when the host
has a public HTTPS name. The steps and checks are in
[`docs/setup-reference.md`](./docs/setup-reference.md), "Webhooks from other services".

## 13. Order of work

1. Send your first reply (part 3). Help the person choose one of the three ways
   to start (part 4). Create `setup-decisions.md` and record the choice.
2. Ask the policy questions (part 4) and then each choice in part 5 that the
   chosen path needs, one at a time. Write each answer down for the user.
3. Create the program repo skeleton and the allowlist.
4. Copy `config/instance.env.example` to `.env`; fill the REQUIRED lines.
5. Replace placeholders (part 7). Run the tests after each group.
6. Adapt prompts in `groups/` and skills in `container/skills/`. `src/channel-claude-sync.test.ts`
   checks exact phrases in the prompts; update that test with the prompts.
7. Do the "First start" steps, set up the inbound mail service, and run locally with a test mailbox.
   Add the two optional webhooks (part 12) when the host has a public HTTPS name.
8. Show the user a test exchange. For a pilot, go through the MVP exit checklist
   (part 4) with them. Deploy only when they say so.

## 14. First start

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
5. Clone the program repo at the mounted path, and set `PROGRAM_ORIGIN_URL` to its
   origin (process environment). The agent commits in that checkout. The host does
   not run git there. At its first start the host creates its own repository
   (`PROGRAM_HOST_REPO`; default `program-repo-host` beside the read mirror) and
   from then on it alone fetches and pushes, with the host's credential: before
   each turn, after each agent result, and with each audit-log commit
   (`src/host-repo.ts`). The container needs no git credential: its `git pull`
   reads a read-only export of the host's repository, and the host pushes its
   commits. When the host process runs as root, its git runs as user and group
   1000 with home `/home/ubuntu` unless `CHECKOUT_OWNER_UID`, `CHECKOUT_OWNER_GID`
   and `CHECKOUT_OWNER_HOME` say otherwise (`src/checkout-fs.ts`,
   `src/program-repo.ts`), so a root-owned clone fails. Use a deploy key or token
   limited to the program repo, held by that host user. Then run
   `npx tsx scripts/check-host-git-trust.ts --network` as that user with the bot's
   environment: every line must say PASS or NOTE. It checks that this host's git
   runs nothing a repository names while serving it, that the host repo is outside
   the checkout, that the origin comes from host settings, and that the credential
   reads the origin and can push (a dry run).
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
9. Run `npx tsx scripts/check-container-egress.ts` as the service user, with the
   service's environment. It starts containers the way the host does and must print
   PASS for each line: the container reaches the host's proxy address; on the
   restricted network it reaches no outside host and resolves no outside name; a
   commit made inside the container is taken out of a (temporary) checkout by the
   host and arrives on a (temporary) remote. The host's credential against the
   real origin is step 5's check. Do not send the first test message until both pass.

## 15. Governance

The prompts and code cite numbered rules (G6, G39, G46 and so on). `docs/12-governance.md`
defines each number and says what failure it prevents. Keep the numbers when you
adapt text. To change a rule, follow the change protocol in that file; do not
edit a rule in one prompt only.
