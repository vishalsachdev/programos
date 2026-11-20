# Setup reference

Reference material for [`AGENTS.md`](../AGENTS.md): every setting key, the inbound mail contract, and the two optional webhooks. `AGENTS.md` holds the guided conversation, the three ways to start and the list of choices; read it first. The code is the source of truth; where this page and the code differ, trust the code and report it.

## Every setting

The keys are those in [`config/instance.env.example`](../config/instance.env.example). A test (`scripts/upstream-sync/test_setup_docs.py`) fails when a key in that file is named neither here nor in `AGENTS.md`.

**Where a key is read matters.** ".env" means the file `.env` in the repo root. "process" means the process environment only: a line in `.env` does nothing for that key, so export it in the service definition (the systemd `Environment=` lines in [`deployment.md`](./deployment.md), step 6). The parser does not strip inline comments; put nothing after a value. Never commit `.env`.

"Choice" is the entry in `AGENTS.md`, part 5.

### Identity and mail addresses

| Key | Read from | When nothing is set | Meaning | Choice |
|---|---|---|---|---|
| `ASSISTANT_NAME` | .env | The upstream framework's default name, not "Coordinator" | The bot's name. Marked REQUIRED | 9 |
| `SEND_FROM_EMAIL` | .env | `program@<BOT_MAIL_DOMAIN>` | The address the bot sends from and replies to. Marked REQUIRED | 6, 9 |
| `SEND_FROM_NAME` | .env | `Coordinator` | The display name on outgoing mail | 6 |
| `OPERATOR_CC_EMAIL` | .env | Empty | The operator's address for host mail copies. With the email alert route it is the one address alerts are mailed to: one person's mailbox, never the bot's own address | 4, 9 |
| `INSTITUTION_DOMAIN` | .env | The placeholder `example.edu` | The institution's mail domain. A blocked sender on it gets one "access closed" reply, and a route named in an allowlist row resolves to `<name>@<domain>`. **With a real program repo the host refuses to start when this is missing, the placeholder or a subdomain of it (`mail.example.edu`)** | 9, 11 |
| `BOT_MAIL_DOMAIN` | .env | The placeholder `example.org` | The bot's own mail domain: the default bot address, the Message-ID domain, and the bot's git author `program-bot@<domain>` | 6, 9 |
| `INTAKE_GIT_AUTHOR_EMAIL` | .env | The placeholder `email-inbox@example.org` | The git author of the inbound mail intake service. It must equal the author on that service's commits exactly | 5, 9 |
| `ADMIN_AUTHOR_EMAILS` | .env | The placeholder list | The admin's git author emails, separated by commas: the only identities allowed to change protected governance files. **With a real program repo the host refuses to start when this is missing or names a placeholder** | 9, 11 |
| `TZ` | .env or process | The system's time zone | The time zone for schedules | 8 |

A "real program repo" means `PROGRAM_ORIGIN_PATTERN` or `PROGRAM_ORIGIN_URL` is set, or the origin of the checkout or the read mirror is not `example-org/program-repo` (`src/identity-settings-check.ts`).

### Model provider and reply sensor

| Key | Read from | When nothing is set | Meaning | Choice |
|---|---|---|---|---|
| `ANTHROPIC_API_KEY` | .env | No key | The Anthropic API key for the agent. Use this or the next key, not both. The reply sensor also uses it when its provider is Anthropic | 1, 2 |
| `CLAUDE_CODE_OAUTH_TOKEN` | .env | No token | A Claude subscription token for the agent | 1 |
| `ANTHROPIC_BASE_URL` | .env | The Anthropic API | Another endpoint that serves the Anthropic API. The agent uses it, and so does the reply sensor when its provider is Anthropic. A path prefix is kept | 1 |
| `MODEL_PROVIDERS` | .env | `anthropic` | Ordered list of providers for the agent: `anthropic`, `foundry`. A second entry is the backup. A provider listed without its settings stops the host at startup | 1 |
| `ANTHROPIC_FOUNDRY_RESOURCE` | .env | None | The Foundry resource name (this or the next key) | 1 |
| `ANTHROPIC_FOUNDRY_BASE_URL` | .env | None | The full Foundry base URL | 1 |
| `ANTHROPIC_FOUNDRY_API_KEY` | .env | None | The Foundry key. It stays on the host | 1 |
| `FOUNDRY_KEY_HEADER` | .env | `api-key` | The header that carries the Foundry key: `api-key` or `x-api-key` | 1 |
| `FOUNDRY_AGENT_MODEL`, `FOUNDRY_GATE_MODEL` | .env | None | Deployment names that replace `NANOCLAW_AGENT_MODEL` and `NANOCLAW_GATE_MODEL` on a Foundry run | 1 |
| `FOUNDRY_OPUS_MODEL`, `FOUNDRY_SONNET_MODEL`, `FOUNDRY_HAIKU_MODEL` | .env | None | Deployment names for the aliases `opus`, `sonnet` and `haiku` | 1 |
| `MODEL_FAILOVER_THRESHOLD` | .env | `3` | Failures in a row before a provider is set aside | 1 |
| `MODEL_FAILOVER_COOLDOWN_MS` | .env | `1800000` (30 minutes) | How long a provider stays set aside | 1 |
| `NANOCLAW_AGENT_MODEL` | process | `claude-opus-5-5` | The agent's model: an alias or a full model ID | 1 |
| `NANOCLAW_GATE_MODEL` | process | `opus` | The model of the reviewer that checks knowledge-base writes | 1 |
| `NANOCLAW_AGENT_EFFORT` | process | `high` | Reasoning effort: `low`, `medium`, `high`, `xhigh` or `max` | 1 |
| `BEHAVIOUR_SENSOR_DISABLED` | process | The sensor runs | `1` turns the reply sensor off, for chat and email replies | 2 |
| `SENSOR_EMAIL_REPLIES` | .env or process | Off: the sensor checks chat replies only | `1` (or `true`, `on`) makes the reply sensor also check each delivered email reply, once, after it is sent. It sends the reply, the start of the mail it answers and knowledge-base excerpts to the sensor's provider. Tested with the provider stubbed only | 2 |
| `SENSOR_PROVIDER` | .env or process | First entry of `MODEL_PROVIDERS`, else `anthropic` | The reply sensor's provider: `anthropic` or `foundry`. Unset, it follows the first entry of `MODEL_PROVIDERS`. Setting it overrides that. It does not fail over | 2 |
| `SENSOR_MODEL` | process | `claude-haiku-5-5` | The reply sensor's model. With Foundry, a deployment name | 2 |

The Foundry path and the failover were tested against fake servers only. [`model-providers.md`](./model-providers.md) has the live checks.

### Channels, alerts and mail

| Key | Read from | When nothing is set | Meaning | Choice |
|---|---|---|---|---|
| `WEBHOOK_SECRET` | .env or process | The HTTP listener does not start: no inbound mail, no web chat, no optional webhooks | Shared secret that the inbound mail intake service sends. Marked REQUIRED for email | 3, 5 |
| `DELIVERY_STATE_SIGNING_KEY` | process, then .env; read once at start | The host signs with the first one set of `WEBHOOK_SECRET`, `TELEGRAM_BOT_TOKEN` and `RESEND_API_KEY` (from `.env`), and warns at each start. With none of them, saved state is not signed | The key that signs the saved state of a reply in delivery (`src/delivery-state.ts`). A long random value of its own (`openssl rand -hex 32`). Changing the key that signs makes a reply in delivery at that moment fail its check: it is dead-lettered, the operator is alerted and the message is handled again. State signed with the fallback secret before this key was set still loads: the fallback stays accepted for checking, with no end date | 18 |
| `REQUIRE_PRIVATE_ENV_FILE` | process, then .env | The host logs an error at each start when the group or others can read `.env`, and starts | `true`: the host refuses to start while `.env` is readable by the group or others. Fix with `chmod 600 .env`. Not checked on Windows | 18 |
| `WEBHOOK_HOST` | process | All interfaces | The listener address. Set `127.0.0.1` and use a reverse proxy. Left unset, the agent container can reach the listener even on the restricted network; the host warns at each start | 3, 8, 17 |
| `WEBHOOK_PORT` | process | `3003` | The listener port | 8 |
| `CREDENTIAL_PROXY_PORT` | process | `3001` | The port of the credential proxy that containers call | 8 |
| `CREDENTIAL_PROXY_HOST` | process | The Docker bridge address | The address the credential proxy binds to. Used on the open container network only; on the restricted network the proxy binds to that network's gateway address and this key is ignored with a warning (`0.0.0.0` excepted) | 17 |
| `TELEGRAM_BOT_TOKEN` | .env | No Telegram channel, and no alerts on the Telegram route | The Telegram bot's token | 3, 4 |
| `TELEGRAM_ADMIN_CHAT_ID` | .env | None | The admin's Telegram chat, for alerts | 3, 4 |
| `WEBCHAT_SECRET` | .env | No web chat | The web chat's shared secret. Anyone who holds it is answered. Web chat is reachable only when `WEBHOOK_SECRET` is set too, because that channel starts the one HTTP listener | 3 |
| `ADMIN_ALERT_ROUTE` | .env | `telegram` | Where operator alerts go: `telegram`, `email`, or `telegram,email` | 4 |
| `ADMIN_ALERT_TEST` | process | No test | `1` sends one test alert on each enabled route at startup. First start only; remove it after | 4 |
| `DEAD_LETTER_ALERT_JID` | .env or process | The operator's Telegram chat (`tg-avery@program`, a placeholder) | The chat id that receives dead-letter and delivery-shortfall alerts on the Telegram route | 4 |
| `OUTREACH_SUMMARY_JID` | .env or process | The same operator chat | The chat id that receives weekly outreach summaries. It does not follow `ADMIN_ALERT_ROUTE` | 4, 12 |
| `RESEND_API_KEY` | .env | No mail is sent; each send is reported as a shortfall | The outbound mail provider's key | 6 |
| `RESEND_WEBHOOK_SECRET` | .env only | `/resend/webhook` answers 503; bounces are not reported | Signing secret of the provider's events webhook | 6, 13 |
| `OUTBOUND_EMAIL_STAGGER_MS` | .env or process | `30000` | The wait between outgoing mails, in milliseconds (30000 to 60000) | 6 |
| `EMAIL_SENDER_DAILY_CAP` | process | `10` | Messages in 24 hours from an automated agent or a sender the allowlist cannot vouch for | 10 |
| `EMAIL_PERSON_SENDER_DAILY_CAP` | process | `30` | Messages in 24 hours from a person on the allowlist | 10 |
| `EMAIL_OUTREACH_TASK_ID` | .env or process | No scheduled outreach mail is sent | The one scheduled task that the operator approved to send outreach mail | 12 |

The caps count in memory and reset when the process restarts. They apply to email only.

### Program repo and host

| Key | Read from | When nothing is set | Meaning | Choice |
|---|---|---|---|---|
| `PROGRAM_REPO` | process | `/srv/program-repo` | Absolute path of the program repo checkout. The same path is in `seed-db.cjs` and `config-examples/mount-allowlist.json`; change them together. Marked REQUIRED | 7 |
| `PROGRAM_ORIGIN_PATTERN` | process | Only the placeholder origin `example-org/program-repo` is accepted | A regular expression that the repo's git origin URL must match. Keep `^` and `$`; write a dot as `[.]` | 7 |
| `PROGRAM_READ_MIRROR` | process | `/srv/repos/program-repo-read.git` | Path of the bare mirror the host reads the allowlists from | 7 |
| `PROGRAM_ORIGIN_URL` | process | The origin of the read mirror, if that exists; else none, and nothing is fetched or pushed | The git origin of the program repo, as the host fetches and pushes it. The host never takes this address from the checkout, whose git config the agent can write. It must match `PROGRAM_ORIGIN_PATTERN`. Also the address the read mirror is first cloned from. An HTTPS address may hold a token; the host keeps the address without it in its git config and on git command lines, and gives git the token through the process environment only (`src/origin-credential.ts`; needs git 2.31). Keep the file that sets this value readable by its owner only (`chmod 600`) | 7, 18 |
| `PROGRAM_HOST_REPO` | process | `program-repo-host` in the folder of the read mirror (`/srv/repos/program-repo-host`) | Path of the host's own repository: the audit log is committed there and every fetch and push runs there (`src/host-repo.ts`). The host creates it. It must not be inside `PROGRAM_REPO`, and no container may mount it. The host keeps the folder at mode 0700 and its `.git/config` at 0600, and tightens an existing one at start | 7, 18 |
| `GITHUB_PUSH_WEBHOOK_SECRET` | .env, then process | `/api/github-push` answers 503 | Secret of the push webhook on the program repo | 7, 13 |
| `CHECKOUT_OWNER_UID`, `CHECKOUT_OWNER_GID`, `CHECKOUT_OWNER_HOME` | process | `1000`, `1000`, `/home/ubuntu` | Used only when the host process runs as root: host git and file operations in the program repo run as this user. The supported recipe does not run as root | 8 |

### The agent container: network and web tools

| Key | Read from | When nothing is set | Meaning | Choice |
|---|---|---|---|---|
| `CONTAINER_NETWORK` | process, then .env | `restricted` on Docker Engine on Linux; `open` on Docker Desktop (macOS, WSL) | What the agent container can reach. `restricted`: an internal Docker network; the credential proxy on the host and no outside host, git host or outside name. `open`: any host, with a warning at each start. Any other value stops the start. Read at start | 17 |
| `CONTAINER_NETWORK_NAME` | process | `nanoclaw-agents` | Name of the internal Docker network the host creates for `restricted`. Change it only if the name is taken. An existing network of that name that is not internal is refused | 17 |
| `AGENT_WEB_TOOLS` | process, then .env | Off | `1`, `true` or `on` gives the agent web search and web fetch. Off: the tools are removed, and the credential proxy refuses a request that would make the model provider contact an outside host (a web search or fetch tool, a remote MCP server, an image or document given as a URL, the managed agents API), a model request it cannot read as JSON, and every path except the model paths, the model list and the OAuth key exchange. Read at start | 17 |

**On the restricted network the container still reaches host services that listen on all interfaces**, on the network's gateway address. The webhook listener's code default is all interfaces: set `WEBHOOK_HOST=127.0.0.1`. The host logs a warning at each start while the network is restricted and `WEBHOOK_HOST` is not a loopback address. Not tested: an agent turn against a real provider on the restricted network (real containers completed a turn against a local stand-in on 2026-11-20); `restricted` on Docker Desktop; the proxy's refusals against a live provider. `npx tsx scripts/check-container-egress.ts` checks the network on the machine in use.

Two files are not in `.env`: `~/.config/nanoclaw/mount-allowlist.json` (which folders a container may mount) and `~/.config/nanoclaw/sender-allowlist.json` (which chat senders may trigger the agent; missing or invalid means nobody). `AGENTS.md`, "First start", steps 2 and 3, sets them up.

`LOG_LEVEL` (process) is not in the settings example. Leave it unset: at `debug` or `trace` the run logs hold full prompts ([`data-handling.md`](./data-handling.md)).

## Inbound mail: the contract

The host does not receive mail itself. A separate intake service does. `inbound/` holds one, a Cloudflare Email Worker; `AGENTS.md`, part 12, says what to tell the user about it. Any intake service must do the following for each inbound message:

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

To write your own service, read the handler in `src/channels/webhook.ts` (search for `Missing filename or subject`) and `src/cc-context.ts`, check the service's git author against `src/governance-protection.ts`, and use `inbound/` and its fixtures as the worked example. `src/channels/webhook-inbound-intake.test.ts` runs those fixtures through the real handler; a new service should pass the same checks.

## Webhooks from other services

Two more routes share the listener with the inbound mail webhook (`src/channels/webhook.ts`). Both are optional, and both exist only when `WEBHOOK_SECRET` is set, because the listener does not start without it. Each checks its own signature and does not use `WEBHOOK_SECRET`. A route with no secret set answers 503. Set them up after "First start" (`AGENTS.md`, part 14), when the host has a public HTTPS name. ASK before you create either one: each tells an outside service to send data to this host.

### Mail delivery events: `/resend/webhook`

What it does (`src/channels/resend-events.ts`): records each recipient's delivery outcome, and on a bounce, a complaint or a failure it writes a delivery-problem record and alerts the operator on the route set by `ADMIN_ALERT_ROUTE`. Without it, the bot does not learn that a sent mail bounced. The handler is written for the reference deployment's provider, Resend, which signs with Svix headers. Another provider needs a different handler.

1. In the provider's dashboard, add a webhook endpoint with the URL `https://<your-host>/resend/webhook`.
2. Subscribe it to four events: `email.delivered`, `email.bounced`, `email.complained`, `email.failed`. The handler acts on these only; any other event is logged and answered 200.
3. Copy the endpoint's signing secret (it starts with `whsec_`) into `.env` as `RESEND_WEBHOOK_SECRET=`. This key is read from the `.env` file only; the process environment is not read for it. Restart the host process.
4. Check: send a test event from the dashboard. It must show 200. A 401 means the secret does not match. The check is HMAC-SHA256 over `<svix-id>.<svix-timestamp>.<body>`, compared with the `svix-signature` header. The handler does not reject an old timestamp.
5. Check the alert path: a bounce event must produce an operator alert on each route you enabled (a Telegram message, a mail to `OPERATOR_CC_EMAIL`, or both). When the alert fails for a passing reason, the handler answers 500 so that the provider retries.

### Program repo pushes: `/api/github-push`

What it does (`src/channels/github-push-events.ts`): on each push to `main` of the program repo it refreshes the host's read mirror at once, writes an audit-log entry for each knowledge-base commit a person made directly, and alerts the admin when an author who is not an admin changes a protected governance file. Without it, direct commits get no audit entry and that tripwire does not run. The handler reads GitHub's push payload; another git host needs a different handler.

1. Choose a long random secret (for example `openssl rand -hex 32`). Put it in `.env` as `GITHUB_PUSH_WEBHOOK_SECRET=`, or export it in the process environment; the `.env` value wins. Restart the host process.
2. In the **program repo** on GitHub (not this repo): Settings, Webhooks, Add webhook.
   - Payload URL: `https://<your-host>/api/github-push`
   - Content type: `application/json`. The handler parses the raw body as JSON; the form-encoded type fails.
   - Secret: the same value.
   - Events: "Just the push event".
3. Check: GitHub sends a `ping` when you save. A 200 there shows that the signature matches (`X-Hub-Signature-256`, HMAC-SHA256 of the body). A 401 means the secret differs. Then push a commit to `main`: the delivery must show 200 and the log must show `GitHub push: read mirror refreshed`. Pushes to other branches are ignored. The mirror path is `PROGRAM_READ_MIRROR` (process environment); the code default is a fixed path from the reference deployment.
4. Before you rely on it, check three lists. Two come from settings: the bot authors, whose commits get no audit entry, are the bot's git author (`program-bot@<BOT_MAIL_DOMAIN>`) and `INTAKE_GIT_AUTHOR_EMAIL`; the admin identities are `ADMIN_AUTHOR_EMAILS`. The third is still in code: the path prefixes that count as knowledge base (`KB_INCLUDE_PREFIXES`, `KB_EXCLUDE_PREFIXES` in `src/channels/github-push-events.ts`), which follow the reference program's folder layout.
5. Tell the user: GitHub does not retry a failed delivery. When an operator alert cannot be delivered or an audit entry cannot be written, the handler answers 500 on purpose, so the failure shows in the webhook's "Recent Deliveries" list. Someone must look there and press "Redeliver". The audit entry is written once per commit, so a redelivery is safe.
