# Data handling

This page says where a team's messages go when the bot runs, where they are stored, and what the code does and does not delete. It was traced from the code on 2026-11-19 and names the file for each claim. The code is the source of truth; if this page and the code differ, trust the code and report it.

It is not legal advice and it does not say what your institution allows. It tells you what to take to the people who decide that.

Two later changes are on `main` and have no row of their own in the table below yet: a second model provider (Claude on Microsoft Foundry; `MODEL_PROVIDERS`, [`model-providers.md`](./model-providers.md)) and an email route for operator alerts (`ADMIN_ALERT_ROUTE`; `AGENTS.md`, safety items). Every provider in `MODEL_PROVIDERS` receives what the agent path row lists. Operator alerts by email go through the outbound mail provider row.

## What goes where

"Program repo" is the knowledge-base repo. "Provider's terms" means the code sets no retention there; the contract you hold with that party does.

### Outside parties

| Party | What data reaches it | Where it is stored | How long | How to turn it off |
|---|---|---|---|---|
| **Model provider, agent path.** The agent in the container calls the host proxy, which forwards to the host of `ANTHROPIC_BASE_URL`, default `api.anthropic.com` (`src/credential-proxy.ts`, `src/container-runner.ts`). | Everything in the agent's session: the channel instructions in `groups/`; the prompt the host builds for each message (for email: file path, subject, From, To, CC, date, attachment previews; `src/channels/webhook.ts`); every file the agent reads, which can be any mail copy, the allowlist with names and addresses, any knowledge-base file and any Telegram upload; tool output; the replies it drafts. The proxy forwards each request body unchanged, up to 20 MB. | At the provider. | Provider's terms. | It cannot be off; this is the bot. You choose the destination with `ANTHROPIC_BASE_URL`. The proxy keeps only the host and port of that value (see `AGENTS.md`, safety items). |
| **Model provider, reply sensor.** The host calls the provider directly (not through the credential proxy) with `ANTHROPIC_API_KEY` or the Foundry key. It follows the agent's first provider: `MODEL_PROVIDERS` (or `anthropic`), and on `anthropic` the host in `ANTHROPIC_BASE_URL` when set, else `https://api.anthropic.com/v1/messages`. `SENSOR_PROVIDER` overrides the provider. The host logs the provider and host. Code: `resolveSensorTarget` in `src/behaviour-sensor.ts`. | One request per checked reply, holding: the full reply text; the first 4,000 characters of the message that was answered; the whole of `program/curriculum.md`; the Confirmed entries of `discussions/DECISIONS.md` that match the reply; `courses/<code>/sync/activity-roster.md` for each course code the reply names; the list of file paths the reply cites, each marked as existing or missing. In this code the sensor runs on chat replies (Telegram and web chat) only: email replies are logged by `logOutboundEmail`, which does not call it (`src/audit-log.ts`, `src/index.ts`). The call is skipped when the reply is empty, contains `lore: intentional`, or is classified as out of scope (an acknowledgement, tracking state, infrastructure talk), or when there is no usable key (or Foundry setting) for its provider, or no curriculum file. | At the provider. The verdict is written into the audit log; a FAIL also writes the full reply into `discussions/kb-triage/`. | Provider's terms. | Set `BEHAVIOUR_SENSOR_DISABLED=1` in the process environment. A line in `.env` does nothing for this key. |
| **Any internet host, from the container.** Only when `CONTAINER_NETWORK=open` (the default on Docker Desktop; on Docker Engine on Linux the default is `restricted`), or when `AGENT_WEB_TOOLS=1` lets web searches go out through the model provider. | Whatever the agent sends. The agent has `Bash` with permission prompts off (`container/agent-runner/src/index.ts`). A web search query or a fetched address is written by the model after it has read the mail. | At whichever host is reached. | Unknown. | `CONTAINER_NETWORK=restricted` and `AGENT_WEB_TOOLS` unset. See "The container's network". |
| **Outbound mail provider** (Resend, `https://api.resend.com/emails`; `src/outbound-email.ts`). | For each mail: sender name and address, To, CC, subject, the body as plain text, reply-to, and the threading headers. The code sends no attachments. | At the provider. | Provider's terms. | Without `RESEND_API_KEY` no mail is sent and each send is reported as a shortfall. There is no second mail provider in the code. |
| **The mail provider's events webhook** (`/resend/webhook`; `src/channels/resend-events.ts`). This is data coming back in. | For each delivered, bounced, complained or failed mail: the provider's mail ID, the recipients, the subject, and the bounce message. | First recipient and subject go to the host process log. Recipient, subject and outcome go to the SQLite table `email_delivery_recipients`. A problem also writes an audit-log entry and a Telegram alert with the recipient, subject and reason. | Table rows: 14 days (`src/email-delivery-check.ts`). Audit log: see "Retention and deletion". | Leave `RESEND_WEBHOOK_SECRET` unset; the route then answers 503. You lose bounce reports. |
| **Inbound mail intake service.** `inbound/` holds one (a Cloudflare Email Worker, never run against live services); you can also write your own. [`setup-reference.md`](./setup-reference.md), "Inbound mail: the contract", gives the contract. | Every message sent to the bot's address, in full, with attachments. Under the contract it commits a Markdown copy and the original `.eml` to the program repo and pushes them, and then calls the host. So it handles mail from every sender, and the host checks the allowlist only after the mail is already in the repo. | At the mail provider that runs the service, and in the program repo. | The service's own setting, and the provider's terms. The host does not remove a file when it drops the sender. | Do not enable email. For a blocked sender to leave no copy, the intake service must check the allowlist itself before it commits. |
| **Telegram** (`https://api.telegram.org`; `src/channels/telegram.ts`, `src/channels/webhook.ts`). | In: every message, photo and document in a chat the bot is in. The bot downloads files up to 20 MB. Out: the agent's replies, and operator alerts. A bounce alert holds the recipient's address, the subject and the reason. A gate-refusal alert names the channel and chat and the reason. | At Telegram. On the host: see the host rows below. | Telegram's terms. | Leave `TELEGRAM_BOT_TOKEN` unset. Operator alerts on the Telegram route are then not delivered; `ADMIN_ALERT_ROUTE=email` mails them to the operator instead. |
| **Web chat caller** (`/chat`; `src/channels/web-chat.ts`). | The caller's message goes to the agent path above. The reply goes back to the caller. No party is added, apart from your reverse proxy. | Host rows below. | Host rows below. | Leave `WEBCHAT_SECRET` unset. |
| **Git host of the program repo.** | Everything committed to the program repo. That includes: each inbound mail as Markdown and as `.eml` (default `discussions/raw/`); the text extracted from each PDF, Word or spreadsheet attachment, saved beside the mail as `<mail>-<attachment>.extracted.md` (images are skipped; `src/channels/webhook.ts`); the audit log; triage reports; the allowlist; decisions, action items and open questions. The audit log holds chat messages and replies (first 2,000 characters each), every sent mail in full with its recipients, and the address and subject of each mail dropped because the sender was not on the allowlist (`src/audit-log.ts`). The host commits and pushes the audit log about every five minutes. | At the git host, in every clone, and in the host's checkout and read mirror. | Until you delete the repo. See "Retention and deletion". | It cannot be off. You choose the git host and who has access. |
| **Remote control** (`/remote-control` in the main group's chat; `src/remote-control.ts`, `src/index.ts`). | The command starts `claude remote-control` on the host, outside the container, in the install folder, and posts a `claude.ai` link in the chat. That session does not go through the proxy and is not in the audit log. | At the model provider's service. | Provider's terms. | Do not send the command. To remove it, take the handler out of `src/index.ts`. |

### On the host

| Place | What data | How long | How to remove |
|---|---|---|---|
| SQLite store, `store/messages.db` (`src/db.ts`) | `messages`: the full text of every inbound message and reply on every channel, with sender. `outbound_email_outbox`: each mail's recipients, subject and body. `routed_approval_evidence`: text of the original inbound mail. `routed_approvals`, `scheduled_tasks` (full prompts), `delivery_notes`, `email_delivery_recipients`. The main group's container gets this folder read-write. | `messages`, `routed_approvals`, `scheduled_tasks`: no code deletes old rows. Outbox: 24 hours after a mail reaches its final state (`OUTBOUND_EMAIL_OUTBOX_RETENTION_MS`). Approval evidence: 30 days. Delivery notes: 7 days after use, 30 days if never used. Delivery tracking: 14 days. | Delete rows or the file by hand. |
| Run logs, `groups/<group>/logs/` (`src/container-runner.ts`) | One file per container run. Normally metadata only: times, exit code, prompt length, mounts. When a run fails, the container's output is added. With `LOG_LEVEL=debug` or `trace`, the full prompt is added. | 7 days. The host runs `scripts/cleanup-sessions.sh` at start and daily (`src/session-cleanup.ts`). | Keep `LOG_LEVEL` at its default. |
| Session files, `data/sessions/<group>/.claude/` | The agent's full transcripts: prompts, file contents it read, tool output, replies. | Transcripts and telemetry 7 days, debug logs and todo files 3 days. The active session is kept. Same script. | Same script; or delete the folder while the bot is stopped. |
| Transcript archive, `groups/<group>/conversations/` (`container/agent-runner/src/index.ts`) | A Markdown copy of the full conversation, written each time a long session is compacted. | No code deletes it. | By hand. |
| Telegram files, `data/telegram-uploads/<group>/` and `groups/<group>/attachments/` (`src/telegram-upload-store.ts`, `src/image.ts`) | Documents sent on Telegram, with extracted text; resized photos. | No code deletes them. | By hand. |
| Working context, `data/working-context/` (`src/working-context.ts`) | Short notes the agent keeps for each person between sessions. | Entries leave the live file after 14 days and are appended to an archive file beside it. No code deletes the archive. | By hand. |
| Program repo checkout and read mirror (`PROGRAM_REPO`; `PROGRAM_READ_MIRROR`, default `/srv/repos/program-repo-read.git`) | Two full copies of the program repo, with history. | As the repo. | See "Retention and deletion". |
| Host process log (stdout and stderr, kept by your process manager) | Sender, subject and recipients of mail as it is handled; rejected senders; the first 160 characters of a reply the gate refused (`src/index.ts`). | Your process manager's setting. The code sets none. | Configure log rotation. |
| Temporary `.eml` copies in the system temp folder (`src/channels/webhook.ts`) | One original mail while a request is handled. | Written with owner-only permissions and deleted at the end of the request. | Nothing to do. |
| State snapshots (`scripts/state-snapshot.mjs`, `scripts/state-snapshot-pull.sh`) | The `scheduled_tasks` and `registered_groups` tables, with the full text of every scheduled prompt. The pull script commits this as `ops/state-snapshot/db-state.json` **in the checkout of the code repo** and pushes it to that repo's remote. These are example scripts from the reference deployment; the host does not run them. | Until removed from that repo, and then still in its history. | Do not run them, or point them at a private repo. Do not put names or addresses in a scheduled prompt if the snapshot goes to a repo that is more widely readable than the program repo. |

## Who can read the audit log and the raw mail

The audit log, the mail copies, the `.eml` originals and the extracted attachments are ordinary files in the program repo. The code adds no access control of its own. Whoever can read the repo on the git host can read all of them, including every past version.

- **Make the program repo private.** The code does not check this. A public program repo publishes the team's mail.
- **Repo readers are a different group from allowlisted senders.** A person on the email allowlist can ask the bot questions; they cannot read the repo unless you add them on the git host. A repo collaborator can read every mail from every sender, whether or not that collaborator is on the allowlist. Review both lists.
- **Count the machine identities.** The intake service, the host and the container each hold a credential that can read or write the repo (`AGENTS.md`, "First start"). So does any CI job, site build or integration you attach on the git host.
- **Organization owners and git-host administrators** can usually read private repos. Ask your git host's administrator who that is.
- **The agent can read all of it.** The email group mounts the program repo read-write, so a question from any allowlisted sender is answered by an agent that can open any mail in `discussions/raw/` and any day of the audit log. The prompts tell it what to cite; nothing in the code keeps one sender's mail from an answer to another.
- **The agent can write it too.** `SPEC.md` section 6: "do not edit the log" is a rule, not a storage guarantee. Git history is the check.

## Retention and deletion

What the code deletes is in the host table above: run logs, session files, and four SQLite tables, each on a fixed schedule.

What the code never deletes:

- Anything in the program repo: mail copies, `.eml` originals, extracted attachments, the audit log, triage reports. There is no retention setting and no purge command.
- The `messages` table in SQLite, which holds every message and reply in full.
- Transcript archives, Telegram files, and working-context archives on the host.

**Git history keeps removed content.** Deleting a file from the program repo and committing removes it from the current version only. The content stays in the history, on the git host, in the host's checkout and read mirror, in the container's view of the checkout, and in every other clone. To remove it you must rewrite history, force-push, ask the git host to drop its cached copies, and re-clone every copy, including the read mirror on the bot's host. The repo has no tool for this. Decide your answer to "a person asks for their mail to be removed" before go-live, because it is a manual job that needs the repo admin.

Copies outside your control are not reached by any of this: the model provider, the mail provider, the intake service's provider and Telegram each keep data under their own terms. Read those terms, or the agreement your institution has signed, for the retention that applies.

A retention period for the audit log is a decision the code leaves to you. If your institution has a records schedule, ask its records office which one applies to this log; the answer may be a minimum as well as a maximum.

## The container's network

Two settings decide what the container can send out (`src/container-runtime.ts`, `src/web-tools.ts`).

`CONTAINER_NETWORK` has two values:

- `restricted`: the host puts the container on a Docker network created with `--internal`. The container reaches the host's credential proxy. It reaches no outside host, by name or by address, not the git host, and it gets no answer for outside DNS names. This is the default on Docker Engine on Linux, and was checked there with real containers on 2026-11-20 (Docker 29).
- `open`: the runtime's default network. The container can open a connection to any internet host. The agent has a shell and reads mail written by other people; a message that tricks it could make it send what it can read (the program repo, with the raw mail and the allowlist) to an outside address. The delivery gate and the audit log do not see this traffic. The host logs a warning at each start. This is the default on Docker Desktop (macOS, WSL), where `restricted` was not verified.

`AGENT_WEB_TOOLS` is off unless set to `1`. Off, the agent is not given web search or web fetch, and the credential proxy is the boundary for what the container can ask the model provider to do outside. The proxy reads every request the container sends (the container holds its run's proxy token and could write any request). It refuses a web search or web fetch tool at any depth of the request, a remote MCP server, an image or document given as a URL, and the provider's managed agents API. On a model path it refuses a body it cannot read as JSON; it refuses any body with a content encoding. A body it read is sent on re-serialised from what it checked. The same check runs on the Anthropic route and the Foundry route. On, a web search query goes to the model provider even when the network is restricted, and none of these checks run.

What that check does not cover: it refuses what is known to reach outside hosts, from the type definitions of the pinned SDK (`@anthropic-ai/sdk` 0.93.0); it is not an allowlist. A tool type the proxy does not know is forwarded, with one warning in the host log naming it. Other paths on the provider's host are forwarded with the host's credential and logged once each. None of it was run against a live provider.

What `restricted` does not block:

- Everything in the agent's session still goes to the model provider. That is the first row of the table above.
- **Host services that listen on all interfaces can be reached from the container** on the network's gateway address. The webhook listener's code default is all interfaces. Set `WEBHOOK_HOST=127.0.0.1`; the host logs a warning at each start while the network is restricted and that address is not loopback.
- The host runs git in the program repo checkout, and the agent can write that checkout's `.git/config` and hooks. A hook planted by a tricked agent would run on the host, as the checkout owner, with the host's network. Nothing in the code prevents this today.

Check your own host with `npx tsx scripts/check-container-egress.ts`. Also:

- Keep the allowlist short, because allowlisted mail is the main way text reaches the agent. Remember that the agent also reads mail that an allowlisted sender forwards, and attachments.

## What the allowlist does and does not protect

It does:

- Stop a sender who is not listed from getting an answer on email and Telegram. That sender's message is not handed to the agent.
- Limit email recipients to listed addresses, with the exceptions in `SPEC.md` section 11.
- Refuse every chat sender when the chat sender allowlist file is absent or invalid (`src/sender-allowlist.ts`; `AGENTS.md`, safety items).

It does not:

- Keep a blocked sender's mail out of the program repo. The intake service commits it before the host checks (see the table). The host then also writes the sender's address and subject to the audit log.
- Apply to web chat. Any caller with the shared secret is answered.
- Verify identity beyond what the mail headers and the intake service provide. Ask your mail administrator what sender checks (SPF, DKIM, DMARC) the intake path enforces.
- Limit what a listed sender may write about. A staff member can send mail that names a student, quotes a grade or attaches a roster. That text is then stored and sent on exactly as the table describes. The code has no filter for kinds of data.
- Limit who reads the record. That is repo access (above).
- Limit the agent's network (above).

## Decide before go-live

Take the table to the people who approve data use at your institution. Get an answer to each line, and write the answers in the program repo's governance file.

- [ ] Which classes of data may reach each outside party in the table. Until you have that answer in writing, treat the answer as "none beyond ordinary staff correspondence".
- [ ] Which model endpoint is approved, and whether the reply sensor's destination (it follows the agent's first provider unless `SENSOR_PROVIDER` says otherwise) is approved too.
- [ ] Which mail provider and intake service are approved, and what they retain.
- [ ] Whether Telegram is approved for operator alerts that carry addresses and subject lines.
- [ ] Who may read the program repo, who reviews that list, and how often.
- [ ] How long the audit log and the raw mail are kept, and who performs a removal.
- [ ] What senders are told about where their mail goes (`AGENTS.md`, ASK 5).
- [ ] Whether the agent gets web tools (`AGENT_WEB_TOOLS`) or an open network (`CONTAINER_NETWORK=open`). Both are off by default on Docker Engine on Linux.
- [ ] Whether state snapshots are used, and to which repo they go.

**A conservative default for a first pilot:**

- Staff senders only on the allowlist. No students, no public address.
- No student records. Tell the senders in writing not to send or forward mail that identifies a student, grades, accommodations, conduct or health matters, and not to attach rosters. This is a rule for people; the code cannot enforce it. Say what to do when it happens anyway: who is told, and who removes the mail.
- The reply sensor off (`BEHAVIOUR_SENSOR_DISABLED=1`) unless its destination is approved.
- Email and one Telegram admin chat. Web chat off. `/remote-control` not used.
- A private program repo whose readers are the pilot team and the operator.
- `LOG_LEVEL` at its default.
- The example snapshot scripts not run.
- `AGENT_WEB_TOOLS` unset and `CONTAINER_NETWORK=restricted` (the defaults on Docker Engine on Linux), with `scripts/check-container-egress.ts` passing on the host.

This default narrows what the pilot touches. It is not a finding that the pilot complies with any law or policy. For questions about student-record law (in the United States, FERPA), ask your registrar or your institution's privacy office and counsel; for vendor approval, ask your IT security or procurement office.

One institution's open questions are in [`illinois/data-handling.md`](./illinois/data-handling.md).
