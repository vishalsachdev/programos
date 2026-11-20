# ProgramOS: Canonical Spec

> This is the contract the code in this repo implements. If you adapt the code, keep to this contract. If you build your own implementation, this is what it must do. Where the code and this file disagree, treat it as a bug and report it.

## 1. Goal

A **coordinator for a project or program team** that:

1. Receives messages from an allowlisted team over email, and optionally Telegram or web chat.
2. Runs an AI agent in a container for each message, with the team's knowledge-base repository (the "program repo") mounted.
3. Works in one mode per message: **Question** (find, cite, reply), **Status update** (extract decisions, action items and open questions; commit; summarize), or **Scheduled outreach** (a host-scheduled task such as a weekly reminder).
4. Checks the agent's replies and outbound mail at a delivery gate on the host before they are sent.
5. Writes accepted inbound messages, replies and delivery problems to an audit trail inside the program repo.
6. Works under numbered governance rules that say who may change what. Some are enforced by host code; others are instructions to the agent.

Section 11 lists where these guarantees stop in the current code. Read it before you rely on any of them.

The same contract serves an academic program, a research project, a grant team or an administrative unit. The examples in the shipped prompts come from an academic program.

## 2. Components

| Component | Where | Notes |
|-----------|-------|-------|
| Container runtime, channel registry, message router, group queue, SQLite store | `src/` (from the NanoClaw framework) | Change only when you must |
| Channel handlers: email webhook, Telegram, web chat | `src/channels/` | Each validates the sender, builds the message, and formats the reply |
| Credential proxy and model providers | `src/credential-proxy.ts`, `src/model-provider.ts` | The host's own credentials stay out of the container; the host injects them. In OAuth mode the container receives a temporary key from the exchange. Routing through the proxy is a setting, not a network block. `MODEL_PROVIDERS` orders the providers (`anthropic`, `foundry`; default `anthropic` only). The proxy routes each run to its provider and counts failures; after three in a row, new runs use the next provider for 30 minutes. Foundry: [`docs/illinois/model-foundry.md`](./docs/illinois/model-foundry.md) |
| Delivery gate and outbox | `src/delivery-gate.ts`, `src/outbound-email*.ts`, `src/delivery-*.ts` | Agent replies and outbound mail pass the gate. Email has a durable outbox with retries; direct chat sends do not |
| Audit log writer | `src/audit-log.ts` | Host-side; the agent does not write the log |
| Operator alerts | `src/admin-alert.ts` | One function for every operator alert. The route is a setting: Telegram (default), email to the operator's address, or both |
| Scheduler and reminders | `src/task-scheduler.ts`, [`docs/reminder-registry.md`](./docs/reminder-registry.md) | Scheduled outreach, with a registry of every job |
| Routed approvals | `src/routed-approvals.ts` | A request that needs an approver is recorded by the agent and relayed by the host |
| Sender controls | `src/channels/webhook-allowlist.ts`, `src/channels/sender-quota.ts`, `src/sender-allowlist.ts` | Allowlist, per-sender caps, a separate tier for automated agents |
| Reply sensor and evaluation | `src/behaviour-sensor.ts`, `scripts/eval-*.{mjs,ts}`, [`docs/evaluation-protocol.md`](./docs/evaluation-protocol.md) | Checks replies against ground-truth files; replay and scoring tools |
| Agent runner | `container/agent-runner/` | Runs the agent inside the container, with write guards |
| Agent skills | `container/skills/` | Knowledge-base entry gate, conflict check, outreach, quality review, self-evaluation |
| Agent instructions | `groups/global/CLAUDE.md` (shared playbook) and `groups/<channel>/CLAUDE.md` | The agent's rules for each channel |
| Governance rules | [`docs/12-governance.md`](./docs/12-governance.md); the program repo's `program/kb-governance.md` | Numbered rules cited by code, prompts and tests |
| Program repository | A separate repo that you own, mounted at `/workspace/extra/<repo-name>` | The source of truth |
| Allowlist | `program/EMAIL_ALLOWLIST.md` inside the program repo | Not in this codebase |
| Extra content mounts | Optional read-only mounts for outside content stores | Patterns: [`docs/design/content-sources.md`](./docs/design/content-sources.md) |
| Program repo skeleton | [`templates/program-repo/`](./templates/program-repo/) | File names and table formats this code parses |
| Adopter guide and settings | [`AGENTS.md`](./AGENTS.md), [`config/instance.env.example`](./config/instance.env.example) | What to change for your project |
| Upstream record | [`UPSTREAM.md`](./UPSTREAM.md) | Which version of the reference deployment this code was exported from |

Design notes in [`docs/design/`](./docs/design/) describe ideas that are **not in the code**: an audit-log search index, skills proposed by pull request, and a mesh of several coordinators. Teams channels and mail polling are also not in the code.

## 3. Channel contract

A channel handler MUST do the following. Where this code does it on some channels only, the line says so.

- Accept inbound traffic. Email and web chat use a path under the single shared HTTP server (default port `3003`); bind it to loopback and put a reverse proxy in front. Telegram polls and needs no inbound route.
- Validate authenticity (signature or shared secret for webhooks, bot token for Telegram, bearer secret for web chat).
- Apply input filters before dispatch. For email: the allowlist in the program repo. For Telegram: allowed handles. A sender who is not allowed never reaches the model. Web chat has no allowlist of people: it accepts any caller who holds the shared secret.
- Apply sender caps (turns per time window), with a lower cap for automated agents. In this code only the email handler applies caps; Telegram and web chat do not.
- Build a message with a channel-specific identifier and hand it to the orchestrator.
- Pass the reply through the shared **delivery gate** before sending. The gate extracts the intended reply block, refuses known agent scaffolding (session narration, prompt or tool markup), and accounts for delivery completeness: every intended recipient either receives the send, or the shortfall is reported loudly. A reply the gate refuses MUST NOT be sent. Refusals go to the operator. For email the reply block is required; chat accepts plain text. Knowledge-base gate results are reported by the agent and recorded by the host; the host does not verify that the gate ran.
- For email, take recipient addresses only from the allowlist or from the inbound message, never from model output alone. Web chat replies go to the session they came from. A Telegram reply goes to the chat that wrote most recently, which may not be the chat that asked (see section 11).
- Trigger audit-log writes for accepted inbound messages and replies, and for delivery events (bounces, complaints) from the outbound provider.

Email-specific rules in the reference implementation: a blocked sender from the same institution gets one courtesy reply (tracked in memory, so a restart resets it); mail where the bot is only copied is filed as context with no reply; a reply to a direct request keeps the thread's audience, allowlisted addresses only. The last two need the original mail with verified headers. Without it the host may send an acknowledgement, and the reply goes to the sender alone.

## 4. Agent operating modes

Each container run works in one mode.

### Question mode (default)
- **Trigger**: any inbound that is not a status update.
- **Behavior**: search the program repo, answer with file-path citations, reply. No change to program facts. The agent may commit a new open question or an approval request.

### Status-update mode
- **Trigger**: the message carries decisions, status or new information from a sender whose allowlist row permits writes. A read-only sender's update is not recorded as fact; it is recorded as a request and routed to an approver. The access tier is applied on email by agent instruction; Telegram checks the handle only.
- **Behavior**: extract decisions, action items and open questions. Run the entry gate and the conflict check before each write. Commit one logical change at a time. Reply with a summary of what was recorded.
- **Limits**: the agent's file-editing tools are blocked on protected files, and the host checks git authorship as a second line. Shell commands are not inspected. Role and access changes are never made because a message asked.

### Scheduled outreach
- **Trigger**: a host-scheduled task listed in the reminder registry.
- **Behavior**: for the weekly action-item outreach, the host computes the audience from the allowlist and the open items. The agent composes; the host sends through the delivery gate.
- **Who may schedule**: an agent can schedule a task for its own channel group; the admin channel can schedule for any group. Every job MUST be listed in the reminder registry, and no schedule goes live without the operator's agreement.

### Routed approvals
When a sender asks for something that needs another person's approval, the agent records the request in the open-questions file. The host checks the record against what it already trusts (the approver from the sender's allowlist row, the quoted text from its own copy of the inbound mail) and sends the relay. A failed check holds the relay and tells the operator.

## 5. Program repository contract

The program repo is a separate git repository that you own. It MUST contain:

| Path | Purpose |
|------|---------|
| `CLAUDE.md` (in the program repo) | The agent's rules for this knowledge base. MUST contain the heading `## KB Write Protocol`; a host contract check looks for it. |
| `program/curriculum.md` | The core source of truth for the program or project (structure, scope, the facts that must not be wrong). The filename comes from the reference deployment. The agent may not edit it. |
| `program/EMAIL_ALLOWLIST.md` | Markdown table of authorized senders, their roles, access tier and approver. **The filename is load-bearing**: channel code reads this exact path. |
| `program/kb-governance.md` | The governance rules for this team: the numbered rules, the change protocol, a changelog. Start from [`docs/12-governance.md`](./docs/12-governance.md). |
| `discussions/DECISIONS.md` | Append-only log of decisions, written in status-update mode |
| `discussions/ACTION_ITEMS.md` | Open action items, with owners |
| `discussions/OPEN_QUESTIONS.md` | Unresolved questions, each with an added-date; also holds routed approval records |
| `docs/faq.md` | Canonical answers; re-checked when a decision touches a topic |
| `reference/DEPENDENCY_GRAPH.md` | Which files must change together when a source-of-truth file changes |
| `discussions/raw/` | The host's copy of each inbound message |
| `discussions/kb-triage/` | Sensor reports and items held for human review |
| `discussions/audit-log/` | The audit trail (§6) |
| `skills/` | Optional. Skills the team wants the agent to follow. |

Optional: `sync/` for generated snapshots of outside systems (never hand-edited), and other `program/` files your project needs. Two optional `program/` files are read by name when they exist: `program/course_names.md` (the reply sensor adds its course codes to those in `curriculum.md`; the ingestion cross-check searches it) and `program/target_profile.md` (the ingestion cross-check searches it). Both are plain prose with no required format. The template does not ship them, and the code skips a missing one.

The allowlist table has five columns with the email address in the second; approval routing and outreach ignore shorter rows. [`templates/program-repo/`](./templates/program-repo/) is a skeleton with the names and formats this code reads.

## 6. Audit log contract

The host writes one file per day, `discussions/audit-log/YYYY-MM-DD.md`, for all channels. Entries are appended; the reply sensor later updates its own annotation line in place. The file sits in the program repo, which the agent can write, so "do not edit the log" is a rule, not a storage guarantee.

- Inbound entries: channel, sender, timestamp, the message.
- Outbound entries: channel, recipients, timestamp, the reply. The fields differ by record type; read `src/audit-log.ts` for the exact lines.
- Delivery problems (bounces, complaints).

Chat entries (Telegram, web chat) keep the first 2,000 characters of each message and mark the rest as truncated. Email is kept in full: the inbound copy is its own file in the program repo, and outbound email has a separate full record.

Operator alerts sent by email (`ADMIN_ALERT_ROUTE` includes `email`) are logged as outbound email entries with the source `admin-alert`. An alert that was not mailed, because its route failed or because it concerned an alert mail, has no entry; it is in the host log.

Not in the log in the current code: Telegram messages from a handle that is not allowed, messages dropped by the chat sender filter, remote-control commands, scheduled and direct chat sends, operator notices on Telegram, and web chat's automatic timeout reply.

The audit log is what survives when a container is destroyed, and it is what a reviewer reads.

The log and the mail copies are files in the program repo: anyone who can read that repo can read them, the code never deletes them, and git history keeps what a later commit removes. [`docs/data-handling.md`](./docs/data-handling.md) covers access, retention, and every outside service that message text reaches.

## 6.5. Governance

The coordinator reads mail and writes to a shared record, so its rules must hold when the model is wrong. Rules live in three places: code on the host (the agent cannot skip these), gates the agent must run with a machine log of each run, and written practice in the prompts and the program repo.

- Each rule has a number (for example `G39`: role and access changes are admin-only). Code comments, prompts and tests cite the number.
- [`docs/12-governance.md`](./docs/12-governance.md) defines each number and the failure it prevents.
- A rule changes only through the change protocol: proposed in the program repo, approved by a person with authority, changed in every place that carries it, versioned, tested.
- An implementation MAY add stricter approval, such as binding a human approval to a hash of the exact reviewed file. One pilot built this; it is not part of this code.

## 6.6. Learning loop (design only)

[`docs/design/learning-loop.md`](./docs/design/learning-loop.md) describes two mechanisms that are **not in the code**: skills proposed by pull request, and a search index over the audit log. Autonomous self-modification of prompts, channel handlers or runtime code is out of scope.

## 7. Agent instructions

`groups/global/CLAUDE.md` is the shared playbook: working directory, knowledge-base writes, commit rules, guardrails, outbound authorization, self-evaluation. Each `groups/<channel>/CLAUDE.md` adds what is specific to that channel. These files MUST:

- Name the channel and the bot.
- Reference the program repo path.
- Define the modes for that channel.
- For email, require the reply to be wrapped so the delivery gate can find it.
- State what the agent may not claim (for example, that it sent mail; the host sends).

A test (`src/channel-claude-sync.test.ts`) checks that the required phrases are present. Change the test with the prompts.

## 8. Customization checklist for the adopter

[`AGENTS.md`](./AGENTS.md) is the working guide. In short, before going live:

- [ ] Answer the policy question: which AI service may this team's mail reach.
- [ ] Replace the bot's name, the program name, the operator, the mail domains.
- [ ] Create the program repo, the allowlist and the governance file.
- [ ] Fill in `.env` from [`config/instance.env.example`](./config/instance.env.example).
- [ ] Create the chat sender allowlist before enabling a chat channel. Without the file, no chat sender can trigger the agent.
- [ ] Bind the listener to loopback; put a reverse proxy in front.
- [ ] List every scheduled job in the reminder registry.
- [ ] Adapt the academic examples, or turn the reply sensor off and say so.

## 9. Out of scope (intentionally)

- Channels for the general public or for students (a different threat model).
- Generating new content. The agent reads and cites the record; it does not invent.
- Autonomous skill creation or self-modification of runtime code.
- Grade or learning-system integration.
- Serving several programs from one instance.

Leaving out student-facing channels does not keep student information out of the record: staff mail that mentions a student is stored and sent on like any other mail, and the code has no filter for kinds of data. [`docs/data-handling.md`](./docs/data-handling.md) says where it goes and gives a conservative default for a first pilot.

## 10. Reference implementation

The code in this repo is exported from K-ai, a deployment that serves one online master's program. It has been tested in production with one program since April 2026. Its source is private because it holds the program's content. K-ai runs email and Telegram; it retired its web chat, Teams and Copilot handlers after stakeholders did not use them. The web chat code is still present here; the Teams and Copilot code is not. [`UPSTREAM.md`](./UPSTREAM.md) records the exported version.

## 11. Where the guarantees stop

The code is the source of truth. This list names the known places where a rule above holds on some paths only. Each was checked against the code on 2026-11-14 and reported to the source deployment.

| Rule | Holds for | Does not hold for |
|---|---|---|
| Person allowlist | Email, Telegram | Web chat (shared secret only) |
| Sender caps | Email, within one running process | Telegram, web chat; counters reset on restart |
| Delivery gate | Agent replies, outbound mail, scheduled and direct chat sends, delivery-failure alerts, operator alerts sent by email | Notices the host sends straight to the Telegram API (`pingAdminViaTelegram`); web chat's timeout reply |
| Operator alert delivery | Telegram with a bot token and admin chat ID (the default route); email to the operator's address when `ADMIN_ALERT_ROUTE` includes `email` | An alert about a failed or bounced alert mail is never mailed again: with the email route alone it is logged and dropped. Alert mail uses the same provider as all other mail, so a provider outage also stops the alerts about it. The email route was tested with the provider stubbed, not against a live one. (Row added 2026-11-19; this code is this repo's own, not from the source deployment) |
| Telegram reply destination | One chat in use at a time | Two or more chats: the host keeps one reply destination, the latest chat to write. A reply prepared for one chat can be sent to another. Use Telegram for the admin's single chat only until the source fixes this |
| Durable send with retry | Email outbox (operator alert mail included); ordinary replies | Scheduled and direct chat sends |
| Audit entry | Accepted inbound messages, replies, mail delivery events, operator alerts sent by email | The paths listed in section 6 |
| Recipient from allowlist or inbound mail | Normal email | The courtesy reply to a blocked colleague; the operator address added to mail for a peer agent; operator alert mail, which goes to the configured operator address only, whether or not it is on the allowlist |
| Address check in body text | Email | Chat; saved email deliveries from an older format |
| Protected files | The agent's file-editing tools; git authorship check | Shell commands in the container |
| Model traffic through the proxy | The agent, by setting | The reply sensor (calls its provider directly from the host: `SENSOR_PROVIDER`, else the first entry of `MODEL_PROVIDERS`, with `ANTHROPIC_BASE_URL` on Anthropic; it does not fail over); remote control (a process on the host) |
| Model provider failover | New agent runs, after three failures in a row on the current provider; the change is logged and alerted | The turn that hit the failure (it fails and is retried); the reply sensor; state across a restart (in memory); a per-turn provider field in the audit log (none); a session resumed on the other provider (untested); any live Foundry endpoint (tested with fake servers only) |
| Gate results logged | What the agent reports | Proof that the gate ran |

