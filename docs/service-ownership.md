# Service ownership: accounts, keys and handover

A running deployment holds a dozen secrets and depends on accounts at six or seven outside services. This page lists each one, says who should own it, where it is stored, how to rotate it and what breaks meanwhile. It also has a handover checklist for the day the builder or operator leaves.

It was written from the code and `config/instance.env.example` (2026-11-20), not from any live deployment. Where a step depends on a provider's screen, the page says so and does not repeat the provider's steps; those change. Rotation steps that name a setting match the code. **Recommendations are labelled as such.** Nothing here states any institution's policy; [`illinois/service-ownership.md`](./illinois/service-ownership.md) holds one university's open questions.

## The rule

**Every account and secret belongs to a role, held through a shared or service account. None belongs to a person's own account.** A person holds a role for a while and then hands it on. A personal account cannot be handed on: it is tied to one person's sign-in, recovery phone and employment.

Roles used below:

| Role | What it is |
|---|---|
| **Service owner** | The person accountable for the bot at the unit (the unit head or program director). Owns the decision to keep it running, and approves who holds the other roles. |
| **Operator** | Runs the host day to day: restarts, updates, rotation. At least two people hold this role at any time. |
| **Unit IT lead** | Owns the machine, the network name and the unit's accounts at central services. |
| **Unit service account** | A mailbox or login that belongs to the unit (for example a shared mailbox such as `program-admin@example.edu`), not to a person. It receives billing mail, recovery mail and security notices. Two or more people can read it. |
| **Repo organisation owner** | Owner of the git organisation that holds the knowledge-base repo and this code. |
| **Domain administrator** | Controls the DNS zone and the registrar account of the bot's mail domain. |

## What to fix first

1. **A model subscription tied to one person's own account is the weakest item on this page.** The bot then runs on that person's Claude login. It cannot be handed over, it is billed to or limited by that person, and it stops when they leave or the account is closed. Use an API key from an organisation workspace held by the unit service account, or a Foundry key on a subscription the unit owns. See [`model-providers.md`](./model-providers.md), and the first policy question in `AGENTS.md` for what each destination receives.
2. The intake worker's GitHub token (`inbound/README.md`) is a fine-grained personal access token by default. It belongs to a person's GitHub login. Use a GitHub App installation token, or a token of a dedicated machine user owned by the unit.
3. The Telegram bot is created by a Telegram account. Whether bot ownership can be moved to another account was **not verified** here: check the bot's settings in Telegram's BotFather before you rely on it.
4. Four places in the code handle a credential in a way that needs a fix (see "Findings" at the end).

## Where secrets live

| Place | What is in it | Notes |
|---|---|---|
| `.env` in the code folder on the host (`~/programos/.env` in the recipe) | Every PART 1 secret: model credentials, `WEBHOOK_SECRET`, `WEBCHAT_SECRET`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `TELEGRAM_BOT_TOKEN`, `GITHUB_PUSH_WEBHOOK_SECRET`, `ANTHROPIC_FOUNDRY_API_KEY` | `src/env.ts` reads it. Set it to `chmod 600` (`deployment.md`, step 3). The container never sees it: the project mount shadows `.env` with an empty file, and the container is given only the value `placeholder` for each model key (`src/container-runner.ts`). |
| The systemd `override.conf` and the host's environment | PART 2 settings: `PROGRAM_ORIGIN_URL` (a token if you chose the HTTPS form), and the optional `DELIVERY_STATE_SIGNING_KEY` | Not read from `.env`. A change needs `systemctl --user daemon-reload` and a restart. |
| The service user's `~/.ssh/` | The program repo deploy key (private half) | The host sets `HOME` to the checkout owner's home when it runs git, so that user's `~/.ssh/config` applies (`src/host-repo.ts`). |
| Cloudflare, as Worker secrets | The intake worker's `GITHUB_TOKEN` and `WEBHOOK_SECRET` | Set with `npx wrangler secret put`. Not in `wrangler.toml`. |
| Each provider's dashboard | The other half of every key and webhook secret, and the account itself | The provider can show or regenerate it. |
| The host's backups and disk snapshots | A copy of everything above | A backup of the machine holds `.env`. Give the backup the same owner and access as `.env`. |

A person's copy of a secret in a password manager, a chat message or a notes file is another place. The handover checklist asks for it to be found and removed.

## The inventory

"Stolen" says what someone who gets the value can do. "Owner" is a role, never a person.

### Model

| Credential | Stolen, it can | Stored | Owner |
|---|---|---|---|
| **Claude subscription token** (`CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_AUTH_TOKEN`) | Call the model as the subscription's owner and use up its quota. Whether it reaches more than that was not checked. If it is set, it wins over an API key for the agent (`src/credential-proxy.ts`). | `.env`; the subscription at the Claude account | **Weakest item.** Unit service account if the provider allows a subscription on one; otherwise replace it with an API key. |
| **Anthropic API key** (`ANTHROPIC_API_KEY`) | Spend money on the workspace and send any prompt to the model. The reply sensor also uses this key directly, from the host (`src/behaviour-sensor.ts`). | `.env`; the workspace at the provider | Unit service account, on a workspace the unit pays for. |
| **Foundry key** (`ANTHROPIC_FOUNDRY_API_KEY`) and the Azure resource | The same, through the unit's Azure subscription. | `.env`; the Azure portal | Unit IT lead, on a subscription the unit owns. The key's owner is the resource's owner, not whoever copied it. |

`ANTHROPIC_BASE_URL` and the deployment names are not secrets.

### Mail

| Credential | Stolen, it can | Stored | Owner |
|---|---|---|---|
| **Outbound mail API key** (`RESEND_API_KEY`, the reference deployment's provider) | Send mail from the bot's address and domain, to anyone. | `.env`; the provider account | Unit service account (billing and recovery mail go there). |
| **Mail events signing secret** (`RESEND_WEBHOOK_SECRET`) | Post fake bounce or complaint events, which write delivery-problem records and alert the operator. Not enough to send mail. | `.env`; the provider's webhook endpoint | Operator. |
| **The bot's mail domain**: the registrar account and the DNS zone (`BOT_MAIL_DOMAIN`) | Redirect the bot's inbound mail (MX records) and send as the domain (SPF and DKIM records). The most powerful item on this list after the model credential. | The registrar and the DNS host | Domain administrator, through an account in the unit's name with two or more administrators. |

### Inbound mail intake (`inbound/`, if used)

| Credential | Stolen, it can | Stored | Owner |
|---|---|---|---|
| **Cloudflare account** (Email Routing, the Worker, the KV buffer, the zone) | Read or reroute all inbound mail and change the worker. Replace the worker's secrets with its own values (provider behaviour: a Worker secret can be replaced but not read back; not verified here). | Cloudflare | Unit IT lead, on an account that is not one person's login; two or more members. |
| **Intake GitHub token** (`GITHUB_TOKEN` in the worker) | Write any file in the knowledge-base repo, not only the inbox folder (`inbound/README.md`, step 3). A forged intake commit is the way mail reaches the agent. | Cloudflare Worker secret | Repo organisation owner (a GitHub App, or a machine user). |
| **Shared webhook secret** (`WEBHOOK_SECRET`) | Post mail to the host's webhook as the intake worker. The listener then processes it; the allowlist still applies. | `.env` on the host, and the Worker secret of the same name | Operator. |

### Git

| Credential | Stolen, it can | Stored | Owner |
|---|---|---|---|
| **Program repo deploy key** (private half) | Read and write the knowledge-base repo, and only that repo (`deployment.md`, step 4). The host pushes with it. | `~/.ssh/program_repo` on the host; the public half at the git host | Repo organisation owner registers it; Operator holds the file. Never a person's own SSH key. |
| **HTTPS origin token**, if you used the HTTPS form of `PROGRAM_ORIGIN_URL` | The same, through that token. Prefer the deploy key. The token ends up in the host repository's `.git/config` and in `override.conf` (finding 1). | `override.conf`, the host repo's config | Repo organisation owner (a machine user). |
| **Push webhook secret** (`GITHUB_PUSH_WEBHOOK_SECRET`) | Post fake push events: refresh the read mirror and write audit entries. | `.env` or the process environment; the program repo's webhook settings | Operator. |
| **The git organisation**: the program repo and this code | Everything: change the repo, the webhooks, the deploy keys, the protected files. | The git host | Repo organisation owner, at least two owners. |
| **Admin git identities** (`ADMIN_AUTHOR_EMAILS`) | Not a secret. These addresses are the only authors allowed to change protected governance files (`config/instance.env.example`). | `.env` | Service owner decides who is on the list. Each address is a person's commit identity: remove a leaver's address (rotation table). |

### Channels

| Credential | Stolen, it can | Stored | Owner |
|---|---|---|---|
| **Telegram bot token** (`TELEGRAM_BOT_TOKEN`) | Act as the bot: send as it, read what it receives, change its settings through the bot API. The host also uses it for operator alerts. | `.env`; the bot's page at Telegram | Operator; the Telegram account that created the bot is the weak point (see above). |
| **Telegram admin chat** (`TELEGRAM_ADMIN_CHAT_ID`) and **operator mailbox** (`OPERATOR_CC_EMAIL`) | Not secrets. They are where operator alerts go, and often one person's chat and inbox. | `.env` | Point them at a shared chat and a mailbox that two or more people read. |
| **Web chat secret** (`WEBCHAT_SECRET`) | Use the web chat endpoint as any person. It does not check who is asking (`deployment.md`, "Before real users"). | `.env`; wherever the web client keeps it | Operator. |

### The host

| Item | Stolen, it can | Stored | Owner |
|---|---|---|---|
| **The machine and its cloud or hosting account** | Everything above (the secrets are on its disk), and the stored mail. | The hosting provider | Unit IT lead, on an account in the unit's name. |
| **Login access**: SSH keys in `~/.ssh/authorized_keys` of the service user, and any administrator accounts | The same. A member of the `docker` group can become root on the machine (`deployment.md`, step 1). | On the host | Operator and Unit IT lead. One key per person, none shared. |
| **The public name's DNS record and the TLS certificate** | Point the bot's name elsewhere. The certificate is obtained and renewed by the reverse proxy (`deployment.md`, step 7); there is no secret to hold beyond the DNS account. | The DNS host | Domain administrator. |
| **`DELIVERY_STATE_SIGNING_KEY`** (optional) | Forge the saved state of a reply in delivery. If unset, the code signs with the first of `WEBHOOK_SECRET`, `TELEGRAM_BOT_TOKEN` and `RESEND_API_KEY` that is set (`src/delivery-state.ts`; finding 4). | Process environment only | Operator. |

## Rotation

Settings in `.env` that the host reads **once at start** need a restart: `systemctl --user restart nanoclaw` (`deployment.md`, step 8). A change to `override.conf` also needs `systemctl --user daemon-reload` first. A clean stop can wait up to 440 seconds for git (`TimeoutStopSec=450`).

A restart interrupts replies in progress and drops the listener for the time it takes. Mail is not lost in that time if the intake worker is in use: it parks a failed delivery in its buffer and retries (`inbound/README.md`, "The commit succeeds and the POST fails").

General order, for any secret: (1) make the new value at the provider and keep the old one working if the provider allows; (2) change it on the host; (3) restart; (4) send one test message and read the log; (5) revoke the old value. Rotate when no important reply is in flight.

"Cadence" is **a recommendation**, not a rule from the code: every 12 months for provider keys, and on the day of any handover for everything the leaver could read. A secret that was ever pasted into a chat, a ticket or a shared document counts as leaked: rotate it at once.

| Credential | Steps (what to change) | Restart? | What breaks meanwhile | Cadence (recommended) |
|---|---|---|---|---|
| Subscription token or API key (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`) | Make the new token or key; replace the line in `.env`; restart; revoke the old one. Leave the unused lines out of `.env` entirely (`config/instance.env.example`). | **Yes.** The proxy reads the key once at start (`startCredentialProxy`). | No model replies during the restart. If you revoke before restarting, every turn fails until the restart. | 12 months; at once on a handover. |
| Foundry key (`ANTHROPIC_FOUNDRY_API_KEY`) | Regenerate or add a key in the Azure portal; replace the line in `.env`; restart; delete the old key. | **Yes.** The provider settings are read once per process (`getModelProviderConfig`). | A 401 counts as a failure: three in a row (`MODEL_FAILOVER_THRESHOLD`) set the provider aside for 30 minutes and send an operator alert (`model-providers.md`, section 5). With a backup, runs go to it. | 12 months. |
| Outbound mail API key (`RESEND_API_KEY`) | Create a new key; replace the line in `.env`; restart; delete the old key. | **Yes**, to be sure. The send path reads `.env` on each send (`src/outbound-email.ts`), but the webhook channel reads the key's presence once at start. | Nothing, if the old key stays valid until after the restart. Mail is not sent while the key is missing or wrong, and the bot reports the failure. | 12 months. |
| Mail events secret (`RESEND_WEBHOOK_SECRET`) | In the provider, create the endpoint's new signing secret; put it in `.env`; restart. | **Yes** (read once; `.env` only). | The handler answers 401 to every event until both sides match, so bounce alerts stop. Whether the provider keeps both secrets valid for a while was not verified. | 12 months. |
| `WEBHOOK_SECRET` | Choose a long random value (`openssl rand -hex 32`). Set it in `.env` and restart, then `npx wrangler secret put WEBHOOK_SECRET` in `inbound/`. | **Yes** (read once; `src/channels/webhook.ts`). | Until both sides match, the worker's POSTs get 401. The worker keeps the payload and retries (12 attempts, about 35 hours; `inbound/README.md`), so mail is delayed, not lost. If `DELIVERY_STATE_SIGNING_KEY` is unset, this value is also the signing key of saved delivery state: a reply caught part-way through delivery fails its check (finding 4). Rotate when the queue is idle. | 12 months; on handover. |
| Intake GitHub token (`GITHUB_TOKEN`, worker) | Create the new token with the same scope (one repo, Contents: read and write); `npx wrangler secret put GITHUB_TOKEN`; revoke the old one. | No host restart. The worker should use the new secret on its next run (Cloudflare behaviour; not verified). | A failed commit parks the message in the worker's buffer for retry. A token that expires without notice causes the same; note its expiry date in the table below. | Before its expiry date; 12 months. |
| Push webhook secret (`GITHUB_PUSH_WEBHOOK_SECRET`) | New random value in `.env` (or the process environment; the `.env` value wins), restart; then the same value in the program repo's webhook settings at the git host. | **Yes.** | GitHub does not retry a failed delivery. A push between the two changes gets no audit entry until someone presses "Redeliver" in the webhook's Recent Deliveries (`setup-reference.md`, "Program repo pushes"). | 12 months. |
| Telegram bot token (`TELEGRAM_BOT_TOKEN`) | Revoke and re-issue the token in BotFather; replace the line in `.env`; restart. | **Yes.** | The old token stops working when it is revoked. Until the restart the bot receives nothing on Telegram, and operator alerts on the Telegram route fail (use `ADMIN_ALERT_ROUTE=telegram,email` so alerts still arrive). | 12 months; on handover. |
| Web chat secret (`WEBCHAT_SECRET`) | New value in `.env`; restart; give the new value to every client of the endpoint. | **Yes** (read at start; `src/channels/web-chat.ts`). | Clients with the old value get 401. | 12 months. |
| Program repo deploy key | `ssh-keygen -t ed25519 -N "" -C programos-host -f ~/.ssh/program_repo_new`; add the new public key to the repo with write access; point `IdentityFile` in `~/.ssh/config` at it (or move the file over the old name); run `npx tsx scripts/check-host-git-trust.ts --network` with the PART 2 settings exported; then delete the old deploy key at the git host and the old file. | **No.** Each host git command is a new process that reads that user's `~/.ssh/config`. | Nothing while both keys are registered. A failed push is reported to the operator. | 12 months; on handover of the Operator role. |
| HTTPS origin token | New token at the git host; change `PROGRAM_ORIGIN_URL` in `override.conf`; `daemon-reload`; restart. The host rewrites the remote URL in its own repository at the next sync (`ensureOriginRemote`). Revoke the old token. | **Yes.** | Fetches and pushes fail until the host has the new value. | 12 months. Better: move to the deploy key. |
| `DELIVERY_STATE_SIGNING_KEY` | New random value in `override.conf`; `daemon-reload`; restart. | **Yes.** | Saved delivery state signed with the old value fails its check. Set it once and do not rotate it unless it leaks. | Only on a leak. |
| `ADMIN_AUTHOR_EMAILS`, `OPERATOR_CC_EMAIL`, `TELEGRAM_ADMIN_CHAT_ID`, `INTAKE_GIT_AUTHOR_EMAIL` | Edit the line in `.env`; restart. Not secrets, but each names a person or an account that can leave. | **Yes** (read at start, or when the module loads for the identity settings; `src/instance-identity.ts`, `src/channels/webhook.ts`). | A removed admin address can no longer change protected files; add the replacement first. | On each change of people. |
| Cloudflare, git organisation, registrar, hosting, model and mail provider accounts | Change the account password, rotate its API tokens, check its members and its two-factor methods, and put the recovery mailbox and phone on the unit service account. This is done at each provider; the page cannot give the steps. | No. | Depends on the token: a Cloudflare API token that Wrangler uses stops working when revoked. | 12 months for tokens; check members each quarter. |

## Handover checklist

For the day the builder or the operator leaves, or is away for long. Do the first part before they go, if you can.

### Transfer

- [ ] Each account in the inventory is owned by the unit service account or a role with two or more holders. List who the holders are by role in the table below.
- [ ] The git organisation has a second owner. The deploy key, the webhooks and the intake token are registered by an organisation account, not the leaver's.
- [ ] The Cloudflare account, the registrar account and the hosting account have a second administrator, and their recovery mail and phone are the unit's.
- [ ] The model subscription or key is on the unit's account (see "What to fix first").
- [ ] The incoming holder has logged in as themselves on the host, read the logs, restarted the service, and run the rotation of one low-risk secret from this page.
- [ ] `OPERATOR_CC_EMAIL`, `TELEGRAM_ADMIN_CHAT_ID` and `ADMIN_AUTHOR_EMAILS` name the new people, and a test alert arrives on each route (`AGENTS.md`, "First start", step 8).
- [ ] The decisions record (`setup-decisions.md`) and the filled table below are in the program repo or the unit's own records, and say where the secrets are kept.

### Rotate the same day

Assume the leaver saw everything in `.env`, in `override.conf` and in the provider dashboards they could open.

- [ ] Every secret in the rotation table that is in `.env`, `override.conf` or a Worker secret. Start with the model credential, then the mail key, `WEBHOOK_SECRET` (on both sides), the Telegram token, the push webhook secret and the web chat secret.
- [ ] The deploy key, and the intake GitHub token.
- [ ] The leaver's SSH key removed from the host's `authorized_keys`, and their user removed from the `docker` group and any administrator group.
- [ ] The leaver removed from the git organisation, the Cloudflare account, the provider accounts, the Azure subscription and the hosting account. If they created the Telegram bot, move or replace the bot.
- [ ] The leaver's address removed from `ADMIN_AUTHOR_EMAILS` and from the allowlist rows that name them as approver (`AGENTS.md`, choice 11).

### Confirm nothing still depends on their personal accounts

- [ ] At each provider, list the keys, tokens and members. For every entry, check who created it. A token created by the leaver's login stops working when that login is closed: replace it.
- [ ] The scheduled jobs and units of the service user (`systemctl --user list-units`, `crontab -l`) and the git author on recent bot commits show no personal address.
- [ ] Restart the service cold (stop, wait, start) and send one plain question on each enabled channel. Then do one routed approval, if email is on.
- [ ] Search the unit's shared folders, chat and tickets for pasted secrets, and rotate any you find.
- [ ] Ask the leaver to list every place they hold a copy (password manager, notes, laptop), and have each deleted.
- [ ] Wait one billing cycle and check that every provider's invoice is paid from the unit's account, not the leaver's card.

## Minimum for a pilot

**This is a recommendation.** A pilot can run on less, but not on less than this:

1. The model credential is an API key or a Foundry key on an account the unit owns. If the pilot must start on a person's own subscription, write that in `setup-decisions.md` with the date it will be replaced. It is the first thing to go wrong.
2. Two people hold the Operator role and can each log in to the host.
3. `.env` is mode `0600`, and nothing in it was pasted into a chat or ticket.
4. The deploy key is its own key (not a person's key) and is registered by the git organisation, which has two owners.
5. Operator alerts go to a chat and a mailbox that two people read, and a test alert has arrived on each route.
6. The table below is filled in and stored with the unit's records.
7. One rotation (any low-risk secret) and one cold restart were done by someone other than the builder.

## Fill in for your deployment

One row per credential you use. Keep this table with the unit's records, not in a public repo, if the "owner role" column names a mailbox. Store no secret here, only where it is kept. "Expires" is for tokens that carry a date.

| Credential | Owner role | Held by (unit account or role-holders) | Where stored | Expires | Last rotated |
|---|---|---|---|---|---|
| Model credential | | | `.env` | | |
| Foundry key (if used) | | | `.env` | | |
| Outbound mail API key | | | `.env` | | |
| Mail events secret | | | `.env` | | |
| `WEBHOOK_SECRET` | | | `.env`, Worker secret | | |
| Intake GitHub token | | | Worker secret | | |
| Cloudflare account | | | Cloudflare | | |
| Mail domain (registrar, DNS) | | | | | |
| Deploy key | | | `~/.ssh/` on host, git host | | |
| Push webhook secret | | | `.env`, git host | | |
| Git organisation | | | | | |
| Telegram bot token | | | `.env`, BotFather | | |
| Web chat secret | | | `.env` | | |
| Host and hosting account | | | | | |
| Host login keys | | | `authorized_keys` | | |
| Public name (DNS) | | | | | |

## Findings

Four places where the code or the documented setup handles a credential in a way that needs a fix. They are not fixed on this page. Each has an issue.

1. **An HTTPS token in `PROGRAM_ORIGIN_URL` is written to the host repository's `.git/config` and passed on a command line** (issue 53). The config file is created mode 0644 in a folder the recipe makes 0755. Use the deploy key until it is fixed.
2. **`.env` has no mode check, and only one recipe says `chmod 600`** (issue 54). The agent-guided path in `AGENTS.md` does not, and the setup scripts write the file with the default mode. Run `chmod 600 .env` yourself.
3. **`WEBHOOK_SECRET` and `WEBCHAT_SECRET` are compared with `!==`** (issue 55). The other secrets use a constant-time comparison. Low severity; keep the listener behind the reverse proxy.
4. **The delivery-state signing key reuses a channel secret, is read on every call and is not a documented setting** (issue 56). Rotating that secret invalidates saved delivery state. Set `DELIVERY_STATE_SIGNING_KEY` once if you want the two decoupled; this was not tested.

Checked in the code, and fine: the container gets `placeholder` values for model keys and never a real one; `.env` is shadowed from the container; git's error text hides a token in a URL; secrets are not written to the log by the paths read for this page. The last item is a reading of the log calls in the credential, channel and git code, not a log review of a running host.

## Not verified

- Any live deployment, provider account or dashboard. The provider side of each rotation (screens, token lifetimes, whether two secrets can be valid together) comes from general knowledge of those services and was not checked.
- Whether Telegram bot ownership can be transferred.
- What a Claude subscription token can reach beyond model calls.
- What the host does with a saved delivery state that fails its signature check, beyond the code returning `invalid`.
- Cadences. They are recommendations.
