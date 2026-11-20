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
   is 1,761 passing tests. One timing test in `src/channels/webhook-ingest-context.test.ts`
   can fail under load; rerun it alone before you treat it as real.
4. Change placeholders consistently in code AND tests. A half-changed name fails tests.
5. Never put real secrets, real people's data, or mail content in this repo.

## Ask the user first (ASK)

Policy comes before setup. Get these answers before you change anything:

1. **Which AI service may this team's mail reach?** The agent sends message text to
   a model. The user's institution may limit this. The code uses Claude through the
   Claude Agent SDK; `ANTHROPIC_BASE_URL` can point at an approved endpoint that
   serves Claude. Other model families need a different agent runner (not included).
   **There are two model call paths.** The agent goes through the host proxy and
   follows `ANTHROPIC_BASE_URL`. The reply sensor (`src/behaviour-sensor.ts`) calls
   the provider's public API directly with its own key and ignores that setting.
   Keep `BEHAVIOUR_SENSOR_DISABLED=1` unless the user confirms that destination is
   approved too, or change the sensor to use the approved endpoint.
2. **Who may approve records and access changes?** (the admin and any approvers)
3. **Which address does the bot send from?** And which mail provider delivers it.
4. **Where does the data live?** The host for the bot, and the git host for the program repo.
5. **What consent wording do senders see**, if any, and who is on the allowlist.
6. **Which channels?** Email only is the simplest. Telegram and web chat are optional.

## Placeholders to replace

Search for each placeholder (include tests; exclude `node_modules`):

| Placeholder | Meaning | Where it lives |
|---|---|---|
| `Coordinator` (also `Co-ordinator`, `co[\s-]?ordinator` in patterns) | The bot's name | `ASSISTANT_NAME` in `.env`, prompts in `groups/`, several `src/` files and patterns that recognise the name |
| `Program`, `program-email`, `program-telegram`, `web-chat-program`, `tg-program` | The program or project name and its channel group names | `groups/` folder names, `seed-db.cjs`, `src/index.ts`, `src/task-scheduler.ts` and others |
| `program-repo`, `/workspace/extra/program-repo` | The knowledge-base repo and its mount point in the container | `PROGRAM_REPO` (process environment), `src/program-repo.ts`, prompts, container skills |
| `example-org/program-repo` | The git origin the host accepts for the program repo. A different origin is refused and the read mirror is not created. | `isExpectedOrigin` in `src/repo-reader.ts`; set `PROGRAM_ORIGIN_PATTERN` or change the patterns |
| `example.edu` | The institution mail domain. It is used in logic: the "access closed" courtesy reply (`INSTITUTION_DOMAIN` in `src/channels/webhook.ts`) and approver addresses in `src/routed-approvals.ts` | about 10 `src/` files |
| `example.org` | The bot's own mail domain and site | `src/config.ts` (default bot address), others |
| `Avery Morgan`, `avery@example.edu`, `tg-avery@program` | The operator (admin). Outreach, routed approvals and admin checks name this person | `src/config.ts`, `src/outreach-recipient-roster.ts`, `src/routed-approvals.ts`, `src/channels/webhook.ts`, prompts |
| `ADMIN_AUTHOR_EMAILS` (`avery@example.edu`, `avery.personal@gmail.com`, a `users.noreply.github.com` address) | The git author identities allowed to change protected governance files | `src/governance-protection.ts`. Use the admin's real commit identities. |
| `/^greta\b/i` | A one-person exception in the outreach roster (a departed owner whose section is skipped) | `src/outreach-recipient-roster.ts`, near `unmatchedOwners`. Remove it or replace it with your own case. |
| Other synthetic people (in `OWNER_ALIASES` in `src/outreach-recipient-roster.ts`) | A short-name table for the team | Replace with the user's team or empty it |
| `PeerAgent`, `averybot@gmail.com` | A second automated agent that also mails the bot | `src/config.ts` (`AGENT_INBOX_ADDRESSES`); empty the list if the user has none |
| `CRS`, `ELC`, `LAB` plus three digits | Course-code prefixes | See "Academic examples" below |

Settings that already exist are in `config/instance.env.example`. **Read its header first.** Some keys are read from the `.env` file; others are read only from the process environment, and a line in `.env` does nothing for them (this includes `PROGRAM_REPO`, `WEBHOOK_HOST` and `BEHAVIOUR_SENSOR_DISABLED`). The parser does not strip inline comments. `start.sh` and `ecosystem.config.cjs` hold a fixed path from the reference deployment; change them.

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
| Email questions and status updates | In production in K-ai | **A separate inbound mail intake service (not in this repo; see "Inbound mail")**, outbound provider key, allowlist file in the program repo |
| Delivery gate and audit log | In production in K-ai | Nothing extra |
| Reminders and scheduled outreach | In production in K-ai | A reminder registry (`docs/reminder-registry.md` is the template); ASK before any schedule goes live |
| Routed approvals | In production in K-ai | Approver recorded per sender in the allowlist; the institution domain set correctly |
| Telegram admin channel | In production in K-ai. **Required for operator alerts** (see "Safety items") | Bot token, admin chat ID, **the chat sender allowlist file** |
| Behaviour sensor and evaluation scripts | In production in K-ai | Ground-truth files in the program repo; see "Academic examples" |
| Restricted container network (`CONTAINER_NETWORK`) | New in this repo (2026-11-20); not in K-ai. Checked with real containers on Docker Engine on Linux only | Docker Engine on Linux for the default; see "Safety items" |
| Host pulls and pushes the program repo (`src/checkout-sync.ts`) | New in this repo (2026-11-20); not in K-ai. Tested against a local remote | A git credential for the host user that runs git; an operator alert channel |
| Web search, web fetch, `agent-browser` | Off by default since 2026-11-20 | `AGENT_WEB_TOOLS=1`; fetch and browser also need `CONTAINER_NETWORK=open`. ASK first |
| Web chat | Was in production, later retired there | A secret and a reverse proxy; treat as untested. **No allowlist of people: any caller with the secret is answered** |

## Safety items you must handle

- **Chat sender allowlist:** if the file is missing, the chat trigger check allows
  everyone (`src/sender-allowlist.ts`). Create it before enabling Telegram.
- **Listener address:** set `WEBHOOK_HOST=127.0.0.1` and use a reverse proxy. The code
  default listens on all interfaces.
- **Operator alerts go to Telegram.** Delivery-failure alerts default to the Telegram
  owner chat (`src/index.ts`), and routed-approval notices and several other alerts
  call Telegram directly (`pingAdminViaTelegram` in `src/channels/webhook.ts`).
  Without a bot token these alerts are not delivered. An email-only deployment is
  not tested. Set up Telegram for the admin, and send a test alert before go-live.
- **Model endpoint must be at the root of its host.** The credential proxy
  (`src/credential-proxy.ts`) uses only the host and port of `ANTHROPIC_BASE_URL`
  and drops any path. `https://gateway.example.edu` works;
  `https://gateway.example.edu/anthropic` does not. If the approved endpoint has a
  path prefix, tell the user; the proxy needs a code change (reported to the source).
- **Sender caps exist only on email.** Telegram and web chat have no per-sender
  limit (`src/channels/sender-quota.ts` is called only from the email handler).
  Keep the chat allowlists short, and do not put an automated agent on a chat channel.
- **Gate coverage and audit coverage differ.** Scheduled and direct chat sends pass the
  delivery gate but get no audit entry and no durable retry. Notices sent by
  `pingAdminViaTelegram` and web chat's timeout reply skip the gate too. `SPEC.md`
  sections 6 and 11 have the full list.
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
  ASK before you set `open`. Limits the user must know: the container still reaches any
  host service that listens on all interfaces (keep `WEBHOOK_HOST=127.0.0.1`); and the
  host runs git in the checkout, whose `.git/config` and hooks the agent can write, so
  a planted hook runs on the host with the host's network (`SPEC.md` section 11).
- **Web search and web fetch are off by default.** `AGENT_WEB_TOOLS=1` turns them on
  (`src/web-tools.ts`). Web search runs at the model provider, so the agent's query
  leaves through the credential proxy even on the restricted network; while the
  setting is off the proxy refuses such a request. Web fetch and `agent-browser` need
  `CONTAINER_NETWORK=open` as well. With both off, `groups/main/CLAUDE.md` ("Search the
  web", "Browse the web"), the `agent-browser` skill, and the "Web" lines of the
  `capabilities` and `status` skills describe tools the agent does not have. ASK
  before you turn either on.
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

This repo does **not** contain the service that receives mail. The reference
deployment uses a small separate worker at its mail provider. You must supply one.
For each inbound message it must:

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
   by the git author `email-inbox@example.org`. That address is fixed in
   `src/repo-reader.ts` (search for it) and in `src/channels/github-push-events.ts`.
   Use that author for the service, or change both places together.
4. After setup, test one routed-approval exchange, not only a plain question.

Read the handler in `src/channels/webhook.ts` (search for `Missing filename or subject`)
and `src/cc-context.ts` before you write the service. Also check the service's git author against `src/governance-protection.ts`. ASK which
mail provider the user has; this is the largest piece of work not covered by the repo.

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
3. Register each channel group. Registration creates the database. Email must be
   registered with the id `webhook-email@program` (the router looks for that exact
   id in `src/index.ts`) and with the program repo as a read-write extra mount.
   `npx tsx setup/index.ts --step register` registers a group but does not set
   mounts. `seed-db.cjs` shows the full row with `additionalMounts`; it needs the
   database to exist first, and its host path is a placeholder. Read both, then
   register the email group, the main group and (if used) the Telegram group.
4. Clone the program repo at the mounted path, with an upstream branch set
   (`git clone` does this). Two writers use the files: the host and the agent inside
   the container. Only the host talks to the git host. The container gets no git
   credential, no SSH client and, on the restricted network, no route to the git host;
   do not try to give it a key or a token. The agent commits in the mounted checkout.
   The host pulls before each turn and pushes after each agent result, before the
   reply is handed on (`src/checkout-sync.ts`); a push that fails is reported to the
   operator on the alert channel. So the git credential belongs to the host user that
   runs git: when the host process runs as root, that is user and group 1000 with home
   `/home/ubuntu` (`src/checkout-fs.ts`, `src/program-repo.ts`), and a root-owned
   clone fails. Give that user a credential limited to the program repo (a deploy key
   in its `~/.ssh`, or a token in its git credential store). Check it as that user:
   `git pull` and `git push --dry-run` in the checkout.
5. Build the container image (`container/build.sh`).
6. Run `npx tsx scripts/check-container-egress.ts` as the service user, with the
   service's environment. It starts containers the way the host does and must print
   PASS for each line: the container reaches the host's proxy address; on the
   restricted network it reaches no outside host and resolves no outside name; a
   commit made inside the container arrives on a (temporary) remote through the
   host's push; and the host's credential can push from the real checkout (a dry
   run). Do not send the first test message until it passes.

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
