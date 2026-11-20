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
| `ADMIN_ALERT_ROUTE` | .env | `telegram` | Where operator alerts go: `telegram`, `email`, `teams`, or several joined by commas (`telegram,email`, `email,teams`, ...) | 4 |
| `ADMIN_ALERT_TEAMS_WORKFLOW_URL` | .env only | None; the Teams route then sends nothing and the startup check names this key | **Secret.** The HTTP POST URL of a Teams Workflows webhook that anyone may trigger; the URL is the credential and is never logged. Must be `https://`. Not verified against a live Teams tenant: [`teams-alerts.md`](./teams-alerts.md) | 4 |
| `ADMIN_ALERT_TEST` | process | No test | `1` sends one test alert on each enabled route at startup. First start only; remove it after | 4 |
| `DEAD_LETTER_ALERT_JID` | .env or process | The operator's Telegram chat (`tg-avery@program`, a placeholder) | The chat id that receives dead-letter and delivery-shortfall alerts on the Telegram route | 4 |
| `OUTREACH_SUMMARY_JID` | .env or process | The same operator chat | The chat id that receives weekly outreach summaries. It does not follow `ADMIN_ALERT_ROUTE` | 4, 12 |
| `OUTBOUND_MAIL_PROVIDER` | .env or process | `resend` | Which service delivers the bot's mail: `resend` (HTTP API) or `smtp` (authenticated SMTP submission). Any other value stops the host at startup | 6 |
| `RESEND_API_KEY` | .env | With the `resend` provider: no mail is sent; each send is reported as a shortfall. Not used with `smtp` | The outbound mail provider's key | 6 |
| `RESEND_WEBHOOK_SECRET` | .env only | `/resend/webhook` answers 503; bounces are not reported. Not used with `smtp` | Signing secret of the provider's events webhook | 6, 13 |
| `SMTP_HOST` | .env or process | With `smtp`: the host does not start | The submission server's host name, with no scheme and no port | 6 |
| `SMTP_SECURITY` | .env or process | `starttls` | `starttls` (the session must be upgraded before the login) or `tls` (TLS from the first byte). No unencrypted mode exists; any other value stops the host at startup | 6 |
| `SMTP_PORT` | .env or process | `587` with `starttls`, `465` with `tls` | The submission port | 6 |
| `SMTP_USERNAME` | .env or process | With `smtp`: the host does not start | The login of the mailbox the bot sends as | 6 |
| `SMTP_PASSWORD` | .env only | With `smtp`: the host does not start | That mailbox's password or app password | 6 |
| `SMTP_ENVELOPE_FROM` | .env or process | The address in `SEND_FROM_EMAIL` | The SMTP envelope sender, where the receiving servers send bounces | 6 |
| `OUTBOUND_EMAIL_STAGGER_MS` | .env or process | `30000` | The wait between outgoing mails, in milliseconds (30000 to 60000) | 6 |
| `EMAIL_SENDER_DAILY_CAP` | process | `10` | Messages in 24 hours from an automated agent or a sender the allowlist cannot vouch for | 10 |
| `EMAIL_PERSON_SENDER_DAILY_CAP` | process | `30` | Messages in 24 hours from a person on the allowlist | 10 |
| `EMAIL_AUTH_MODE` | process | `flag` | What the sender-authentication verdict does. `flag`: it is written to the audit log and nothing else changes. `enforce`: allowlisted mail that is not `authenticated` is dropped. Any other value stops the host at startup. See "Sender authentication for inbound mail" | 19 |
| `EMAIL_AUTH_TRUSTED_AUTHSERV_IDS` | process | Empty: every verdict is `unknown` | Comma-separated names of the mail servers whose results the host counts (the name a server writes first in its `Authentication-Results` header). `enforce` with this empty stops the host at startup | 19 |
| `EMAIL_AUTH_UNKNOWN` | process | `block` | With `enforce` only: what happens to a message with the verdict `unknown`. `block` drops it; `allow` processes it | 19 |
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

### Retention

Each value is a whole number of days. `0`, or no line, keeps everything; that is the default for all eight, and with all eight at `0` the host starts no prune and deletes nothing here. Above `0` the host deletes what is older, once about a minute after it starts and then once a day (`src/retention.ts`). A negative number, a fraction, or text stops the host at startup with an error that names the key; the shortest window is one day. None of these keys touches the program repo or the audit log.

| Key | Read from | When nothing is set | What is deleted when set | What is kept whatever its age | Choice |
|---|---|---|---|---|---|
| `RETENTION_MESSAGES_DAYS` | process, then .env | `0`: keep forever | Rows of the SQLite `messages` table (full text of chat messages, mail prompts and replies) | A message not answered yet; in a chat that needs a trigger word, messages waiting for the next trigger; every message of a chat with no saved cursor and no bot reply; the newest bot reply of each chat | 14 |
| `RETENTION_ROUTED_APPROVALS_DAYS` | process, then .env | `0` | The content of routed approvals closed or removed that long ago: title, sender, approver, subject, quoted words. Cleared, not deleted | The row with its key, status and dates, so a reopened entry is not mailed to the approver again. An approval still open, or with an operator notice or a relay not yet recorded, is not touched | 14 |
| `RETENTION_TASKS_DAYS` | process, then .env | `0` | One-time scheduled tasks that have run, and the record of each task run | Active and paused tasks; the approved email-outreach task; the newest run record and its task. Never less than 7 days of run records, which the exceptions digest reads | 14 |
| `RETENTION_TRANSCRIPT_ARCHIVE_DAYS` | process, then .env | `0` | Files in `groups/<group>/conversations/` named `YYYY-MM-DD-<name>.md` (the transcript copies; the agent can no longer search the deleted ones) | Any other file there | 14 |
| `RETENTION_UPLOADS_DAYS` | process, then .env | `0` | Files in `data/telegram-uploads/<group>/`, and photos named `img-<number>-<code>.jpg` in `groups/<group>/attachments/` | A file named in a message not answered yet; any other file in `attachments/` | 14 |
| `RETENTION_WORKING_CONTEXT_ARCHIVE_DAYS` | process, then .env | `0` | Entries in `data/working-context/<key>.archive.json`, by the time written on the entry. Entries are archived after 14 days, so use a value above 14 | The live file `<key>.json` | 14 |
| `RETENTION_EVALS_DAYS` | process, then .env | `0` | Rows of `response_evals` in `store/evals.db` | Never less than 7 days, which the weekly quality report reads. The dashboard then shows a shorter history | 14 |
| `RETENTION_IPC_ERRORS_DAYS` | process, then .env | `0` | Files in `data/ipc/errors/` | Nothing | 14 |

`npx tsx scripts/retention-prune.ts` prints, for each key, how many rows or files the current values would delete, and deletes nothing. `--apply` deletes at once. Tested with files and a database made by the tests only; not run on a deployment with real data.

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
   `inbound_text`, `phase`, `attachment_count`, `attachment_state` and `auth`.
   `auth` is optional: it carries what trusted mail servers recorded about the
   sender ("Sender authentication for inbound mail", below). A service that
   does not send it gets the verdict `unknown` for every message.

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

## Sender authentication for inbound mail

**Never run against live mail.** The tests use synthetic messages. Which headers a real mail system writes is stated below only as far as its public documentation states it.

The email allowlist is matched on the address in the From header. A sender can write any From header, so the match does not show who sent the message. A mail server that receives a message can check it (SPF for the envelope sender, DKIM for a signing domain, DMARC for the From domain) and writes what it found in an `Authentication-Results` header. This code checks no signature itself. It reads those headers from servers you name and turns them into one verdict per message.

**What is read (the intake worker, `inbound/src/auth.ts`).** A header inside a message proves nothing by itself: the sender can add a header that names any server. Each server adds its headers above the ones it received. So:

1. The first `Authentication-Results` header of the message is read only when its server name (authserv-id) equals the worker's `PLATFORM_AUTHSERV_ID`, no other header carries that name, and it is the header the platform's own interface (`message.headers`) reports first. That is the header of the mail platform that runs the worker; every header the sender wrote is below it.
2. One more header is read: the first one below it whose server name is in `FORWARDER_AUTHSERV_IDS`. It is read only when the platform's own result shows that a server of a domain in `FORWARDER_DOMAINS` handed the message over: SPF passed for an envelope sender in such a domain. This is for a mailbox elsewhere that forwards to the bot's address: forwarding makes SPF fail for the original sender at the bot's domain, and can break the sender's DKIM signature, so the platform's result alone would call real forwarded mail unauthenticated. Without that proof a header naming the forwarder is ignored, because anyone can send a message straight to the bot's address with such a header in it.
3. A header that is read must hold exactly one DMARC result and at most one SPF result. A second one means text was added to the header (by a line at the top of the sender's own headers that continues the header above it, or by sender text that a server copied into a comment); the header is then dropped whole. So is a header with a comment that is still open at its end, or with the same property (`smtp.mailfrom`, `header.from`, ...) twice in one result. A dropped forwarder header keeps its place: no header below it is read in its stead.
4. Nothing else is read. No `ARC-*` header, no `Received-SPF`, no header without a server name.

The worker puts the result in the `auth` field of its payload and in one line of the Markdown copy (`X-Intake-Authentication:`). With the three worker settings empty, which is the default, nothing is read.

**The verdict (the host, `src/email-auth.ts`).** The host counts only results whose server name is in `EMAIL_AUTH_TRUSTED_AUTHSERV_IDS`.

| Verdict | When |
|---|---|
| `authenticated` | A counted server reports a DMARC pass for the From domain. A forwarder must name the From domain it checked, and it must be that domain exactly; the platform checks the From header of the message it hands over and may leave the domain out. SPF and DKIM results are recorded and not used: neither is about the From header unless DMARC ties it to it |
| `unauthenticated` | A counted server reported, and no DMARC pass covers the From domain. That includes: a sender whose domain publishes no DMARC record; a pass for another domain; a message with more than one From header, or more than one different address in From (display name included), or a character outside ASCII in the address; a From header two readers can take differently (a comma outside a quoted display name, a group, more than one address in angle brackets, a space or a comment next to `@`; the full list is in `inbound/README.md`); a message whose `from` is the envelope sender because no address could be read from the From header |
| `unknown` | No result from a counted server. This is every message until you set both sides, and every message from an intake service that sends no `auth` field |

The host takes the results from the payload, which it accepts only with `WEBHOOK_SECRET`, and does not read the committed original for them: the payload already carries the `from` that the allowlist is matched against, and only the mail platform knows the envelope sender. The list of servers the host believes is its own setting, not a field of the payload.

**What the verdict changes.**

- `EMAIL_AUTH_MODE=flag` (the default): nothing. Each message that passes the allowlist gets an audit entry, `[EMAIL AUTH] <verdict> — <reason>`; a dropped message from an address that is not on the allowlist carries the verdict in its entry. A forged message from a listed address is still processed.
- `EMAIL_AUTH_MODE=enforce`: mail from a listed address that is not `authenticated` is handled like mail from an address that is not listed. It does not reach the agent. No reply of any kind is sent, so the bot cannot be used to send mail to a forged address. The audit entry is `dropped (sender not authenticated)`. The courtesy reply to an unlisted colleague is also withheld unless that message is `authenticated`. `unknown` is dropped too, unless `EMAIL_AUTH_UNKNOWN=allow`. The host does not start in `enforce` with no trusted server named.

Run in `flag` first and read the `[EMAIL AUTH]` entries for real mail from each listed person. Change to `enforce` when they say `authenticated`. Routed approvals and status updates are what a forger would aim at, so `enforce` is the recommended setting once a trusted server is named and the entries are right. In `flag` an approval reply from a forged address is still accepted; requiring `authenticated` for approvals alone is issue 75.

**What it does not prove, and what was not checked.**

- A verdict is about a domain, not a person. Whoever the domain's mail system lets send as an address passes.
- Only a DMARC pass counts. Mail from a domain with no DMARC record is `unauthenticated` even when SPF and DKIM passed, and in `enforce` it is dropped. Check this for every listed person's domain while still in `flag`.
- The platform result rests on the platform putting its header first on every message. The one documented platform, Cloudflare Email Routing, states that it prepends an `Authentication-Results` header with the name `mx.cloudflare.net`, that it validates DMARC before it calls the worker, and that other such headers "may have been supplied by the sender and should not be trusted" ([email handler](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/)). Its documentation does not say whether it removes a header in the incoming message that already carries its name, whether the header is in `message.raw` (it names `message.headers`), or which properties (`header.d`, `header.from`) the header carries. The worker therefore compares the two: if the first header in the raw message is not the one `message.headers` reports first, or a second header carries the platform's name, nothing is read and the verdict is `unknown`. If the platform's interface itself were to report a sender-written header first, that header would be believed; no public statement rules this out, so look at one real message before you name the platform. It also states that mail failing both SPF and DKIM, or failing the sender domain's DMARC policy, is rejected ([postmaster](https://developers.cloudflare.com/email-service/reference/postmaster/)); whether that happens before the worker runs for every message is not stated.
- The forwarder result rests on two things nobody checked for any real mail system: that the forwarder removes a header carrying its own name from mail it receives (RFC 8601 section 5 asks for this), and that only its own servers pass SPF for the domains in `FORWARDER_DOMAINS`. A mail system shared by many organisations may fail the second. A person with an account at the forwarding organisation is not stopped: mail they send straight to the bot's address passes SPF for that domain, and a header they plant with the forwarder's name is then read. Name a forwarder only when you accept that.
- Text a sender puts in the subject or body can look like an audit entry or carry the `[EMAIL AUTH]` marker. The real entry is the one whose heading line says `sender authentication` or `dropped (sender not authenticated)`; do not search for the marker alone (issue 75).
- No ARC chain is validated. The platform's documentation says it supports ARC and does not say that it validates one or writes the result.

## Webhooks from other services

Two more routes share the listener with the inbound mail webhook (`src/channels/webhook.ts`). Both are optional, and both exist only when `WEBHOOK_SECRET` is set, because the listener does not start without it. Each checks its own signature and does not use `WEBHOOK_SECRET`. A route with no secret set answers 503. Set them up after "First start" (`AGENTS.md`, part 14), when the host has a public HTTPS name. ASK before you create either one: each tells an outside service to send data to this host.

### Outbound mail over SMTP (`OUTBOUND_MAIL_PROVIDER=smtp`)

The default provider needs DNS records on a domain you control, so it cannot send as an address on a domain someone else runs (an institution's mail domain, for example). The SMTP provider (`src/outbound-email-smtp.ts`) submits each mail to a server you name, logged in as a mailbox there. Whether that server lets a program log in this way is the mail administrators' decision; this repo does not know it.

Everything before the provider call is the same for both providers: the outbox, the retries and the dead letter, the wait between mails, the delivery gate, the recipient rules, the audit entry, operator alert mail, and the `Message-ID`, `In-Reply-To` and `References` headers.

Encryption is required. `SMTP_SECURITY` is `starttls` or `tls`; the login and the mail are never sent on an unencrypted connection, and certificate checks are never turned off. The host refuses to start when `OUTBOUND_MAIL_PROVIDER=smtp` and: `SMTP_SECURITY` is any other value; `SMTP_HOST`, `SMTP_USERNAME` or `SMTP_PASSWORD` is missing; the host, port or envelope sender is malformed; or `NODE_TLS_REJECT_UNAUTHORIZED=0` is in the process environment.

How the server's answers are treated:

| What happened | Result |
|---|---|
| The server accepted the mail for every recipient | Sent |
| The server accepted the mail for some recipients and refused others | Sent to those it accepted. The refused ones are reported to the operator as a delivery shortfall, written to the audit log as a delivery problem (`smtp.recipient_refused`), and noted for the agent. Not retried, even when the refusal was temporary: a second submission would give the others the mail twice |
| The server refused every recipient | Nothing sent. Retried when at least one refusal was temporary (a `4yz` code); otherwise a permanent failure |
| A `4yz` answer at any step (greeting, login, sender, the mail itself) | Retried: up to five attempts with a growing wait, then a dead letter and an alert, as for the default provider |
| A `5yz` answer at any step (a wrong password is `535`) | Permanent failure, reported |
| STARTTLS refused or not offered, a failed TLS handshake, a certificate that does not verify | Nothing sent, no login attempted. Retried unless the server answered with a `5yz` code |
| No answer before any mail content was written (name lookup failed, connection refused or dropped, timeout) | Retried |
| No answer after the mail content was written (timeout, connection cut) | **Outcome unknown.** Treated as a permanent failure and reported as a shortfall for every recipient; the mail may or may not have been delivered. Not retried, because SMTP has no idempotency key and a retry could deliver it twice. The operator decides whether to send again |

What you lose compared with the default provider:

- **No bounce or complaint reports.** There is no events webhook. A bounce comes back later as a mail to the sending mailbox (or to `SMTP_ENVELOPE_FROM`). The bot does not read it: if the intake service forwards it, the loop check drops it (`src/email-loop-detection.ts`), so it starts no work and gets no reply. Nobody is alerted. A person must read the sending mailbox for bounces. Issue 68 tracks processing them.
- **No "unconfirmed after 12 hours" report.** The delivery check (`src/email-delivery-check.ts`) depends on the events webhook, so SMTP sends are not registered with it.
- **No idempotency key.** See "outcome unknown" above. Each delivery keeps one `Message-ID` across retries, which lets many mail systems drop a duplicate; do not rely on it.
- The audit entry's `Resend ID` field holds `smtp-` and 32 hex characters (a hash of the delivery id), not an id the server gave.

Not tested: any real mail server. The tests run a local SMTP server inside the test process (`src/outbound-email-smtp.test.ts`). Whether a given server keeps the `Message-ID` the bot sets, which login methods it offers, and its sending limits are unknown until you try it. OAuth login (XOAUTH2) is not implemented: the server must accept a username and a password or app password. Sending through Microsoft Graph is not implemented either (issue 67).

To set up: get the server name, port, security mode and a mailbox login from the mail administrators; put the five settings in `.env`; set `SEND_FROM_EMAIL` to the mailbox's address and `BOT_MAIL_DOMAIN` to its domain; start the host; send one test mail to yourself and check the headers of what arrives; then read the sending mailbox for a bounce.

### Mail delivery events: `/resend/webhook`

With `OUTBOUND_MAIL_PROVIDER=smtp` this webhook is not used; skip this section.

What it does (`src/channels/resend-events.ts`): records each recipient's delivery outcome, and on a bounce, a complaint or a failure it writes a delivery-problem record and alerts the operator on the route set by `ADMIN_ALERT_ROUTE`. Without it, the bot does not learn that a sent mail bounced. The handler is written for the reference deployment's provider, Resend, which signs with Svix headers. Another provider needs a different handler.

1. In the provider's dashboard, add a webhook endpoint with the URL `https://<your-host>/resend/webhook`.
2. Subscribe it to four events: `email.delivered`, `email.bounced`, `email.complained`, `email.failed`. The handler acts on these only; any other event is logged and answered 200.
3. Copy the endpoint's signing secret (it starts with `whsec_`) into `.env` as `RESEND_WEBHOOK_SECRET=`. This key is read from the `.env` file only; the process environment is not read for it. Restart the host process.
4. Check: send a test event from the dashboard. It must show 200. A 401 means the secret does not match. The check is HMAC-SHA256 over `<svix-id>.<svix-timestamp>.<body>`, compared with the `svix-signature` header. The handler does not reject an old timestamp.
5. Check the alert path: a bounce event must produce an operator alert on each route you enabled (a Telegram message, a mail to `OPERATOR_CC_EMAIL`, or both). When the alert fails for a passing reason, the handler answers 500 so that the provider retries.

### Program repo pushes: `/api/github-push`

What it does (`src/channels/github-push-events.ts`): on each push to `main` of the program repo it refreshes the host's read mirror at once, writes an audit-log entry for each knowledge-base commit a person made directly, and alerts the admin when an author who is not an admin changes a protected governance file. Without it, direct commits get no audit entry and that tripwire does not run. The audit entries come from the list of commits in the push event, and GitHub shortens that list on a large push (the code treats a list of 20 or more as possibly shortened): commits left out of the list get no audit entry. On such a push the host also compares the whole range for the protected-file alert, with one gap: a protected file that a listed commit touches is left out of the range comparison, so a change to that same file by a commit GitHub left out of the list is checked by neither. After a large push, read `git log` for the range yourself, the protected files included. The handler reads GitHub's push payload; another git host needs a different handler.

1. Choose a long random secret (for example `openssl rand -hex 32`). Put it in `.env` as `GITHUB_PUSH_WEBHOOK_SECRET=`, or export it in the process environment; the `.env` value wins. Restart the host process.
2. In the **program repo** on GitHub (not this repo): Settings, Webhooks, Add webhook.
   - Payload URL: `https://<your-host>/api/github-push`
   - Content type: `application/json`. The handler parses the raw body as JSON; the form-encoded type fails.
   - Secret: the same value.
   - Events: "Just the push event".
3. Check: GitHub sends a `ping` when you save. A 200 there shows that the signature matches (`X-Hub-Signature-256`, HMAC-SHA256 of the body). A 401 means the secret differs. Then push a commit to `main`: the delivery must show 200 and the log must show `GitHub push: read mirror refreshed`. Pushes to other branches are ignored. The mirror path is `PROGRAM_READ_MIRROR` (process environment); the code default is a fixed path from the reference deployment.
4. Before you rely on it, check three lists. Two come from settings: the bot authors, whose commits get no audit entry, are the bot's git author (`program-bot@<BOT_MAIL_DOMAIN>`) and `INTAKE_GIT_AUTHOR_EMAIL`; the admin identities are `ADMIN_AUTHOR_EMAILS`. The third is still in code: the path prefixes that count as knowledge base (`KB_INCLUDE_PREFIXES`, `KB_EXCLUDE_PREFIXES` in `src/channels/github-push-events.ts`), which follow the reference program's folder layout.
5. Tell the user: GitHub does not retry a failed delivery. When an operator alert cannot be delivered or an audit entry cannot be written, the handler answers 500 on purpose, so the failure shows in the webhook's "Recent Deliveries" list. Someone must look there and press "Redeliver". The audit entry is written once per commit, so a redelivery is safe.
