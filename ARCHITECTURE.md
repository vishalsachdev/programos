# Architecture

How the parts of ProgramOS fit, and who owns each.

## The picture

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Team channels                               │
│             Email          Telegram         (Web chat)               │
└────────────────┬──────────────┬───────────────┬──────────────────────┘
                 ▼              ▼               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Channel handlers (src/channels/)                                    │
│  • check the sender: signature, allowlist, caps (email)              │
│  • read the filed inbound copy; build the message                    │
└──────────────────────────────────────────┬───────────────────────────┘
                                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Host orchestration (src/, from the NanoClaw framework)              │
│  • router, per-group queue, SQLite store                             │
│  • scheduler and reminders        • routed approvals                 │
│  • credential proxy (holds the model credentials)                    │
└──────────────────────────────────────────┬───────────────────────────┘
                                           │ starts one container per turn
                                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Agent in a Docker container (container/)                            │
│  • instructions: groups/global/CLAUDE.md + groups/<channel>/CLAUDE.md│
│  • skills: entry gate, conflict check, outreach, self-evaluation     │
│  • sees only mounted folders; set to reach the model via the proxy   │
└──────────────────────────────────────────┬───────────────────────────┘
                     reads and writes      │      returns a reply
                                           ▼
┌───────────────────────────────┐   ┌──────────────────────────────────┐
│  Program repo (yours)         │   │  Delivery gate and outbox (host) │
│  • program/curriculum.md      │   │  • reply block required          │
│  • program/EMAIL_ALLOWLIST.md │   │  • scaffolding refused           │
│  • program/kb-governance.md   │   │  • recipients from allowlist     │
│  • discussions/DECISIONS.md   │   │  • durable send, retries (email) │
│  • discussions/ACTION_ITEMS.md│   └───────────────┬──────────────────┘
│  • discussions/OPEN_QUESTIONS │                   ▼
│  • discussions/audit-log/  ◄──┼── audit log writer (host), reply sensor
└───────────────────────────────┘
```

## Who owns what

| Layer | Owner | Change it when |
|-------|-------|----------------|
| Router, queue, container runner, store, credential proxy | The framework, as exported | Rarely. A change here makes each later export harder to take. |
| Channel handlers, delivery gate, audit log, scheduler, approvals | This repo, as exported from the reference deployment | When your project needs different behavior. Keep the governance rule numbers. |
| Identity values (bot name, operator, mail domains, group names) | You | Always. `AGENTS.md` lists every site. |
| Agent instructions (`groups/`) and skills (`container/skills/`) | You, starting from the tested text | To fit your project's vocabulary and policy |
| Program repo | You | Always. It is your record. |
| Governance rules | You, through the change protocol | When a rule's failure cannot happen in your setting, or a new failure appears |

## Why the code is a close copy

The earlier version of this repo was a spec with no code. Each new team had to rebuild the adapter with a coding agent, and each rebuild fell behind the reference deployment within months. So this repo now carries the reference deployment's code, with its content removed and nothing else redesigned.

The cost of that choice is visible: some values that should be settings are written in the code. The gain is that every mechanism here has run in production, and a new export from the reference deployment can replace the code without a rewrite.

## One turn, step by step

1. A message arrives. The channel handler checks the signature, the allowlist and, for email, the sender's cap (Telegram and web chat have no cap). A sender who fails never reaches the model.
2. For email, a separate intake service (not in this repo; see `AGENTS.md`, "Inbound mail") has already committed a copy of the message to the program repo. The host reads that copy and writes the inbound audit entry.
3. The host starts a container with the program repo mounted and the channel's instructions.
4. The agent chooses the mode. In question mode it reads and cites. In status-update mode it runs the entry gate and the conflict check, then commits one change at a time.
5. The agent returns a reply inside a reply block, with a self-evaluation.
6. The delivery gate checks the reply. If it passes, the outbox sends it and records the result. If it fails, nothing is sent and the operator is told.
7. The host writes the outbound audit entry and the gate result. The reply sensor checks the reply against the ground-truth files and files a report if it finds a problem.

## What the host enforces and what the agent is asked to do

| Enforced by host code | Asked of the agent, with a logged gate | Written practice |
|---|---|---|
| Who may reach the model | Entry gate before adding an item | How to word a decision entry |
| Sender caps | Conflict check before a write | When to cross-reference |
| Where recipient addresses may come from | Self-evaluation on each reply | Tone and format |
| The delivery gate | | |
| The audit log | | |
| Protected files | | |
| Role and access changes (admin only) | | |

The left column is enforced by code, so weakening a prompt does not remove it. It is not complete on every channel or path: `SPEC.md` section 11 lists where each item stops (for example, the protected-file guard does not inspect shell commands).

## Audit log

One file per day in `discussions/audit-log/`, for all channels, written and committed by the host. It carries accepted inbound messages, replies and delivery problems; `SPEC.md` section 6 lists what is not logged. Knowledge-base changes are committed separately from audit-log commits, so a reviewer can read decisions without log noise.

## What you build

For a new project you do not write channel handlers or an audit module. You:

- answer the policy and ownership questions in `AGENTS.md`,
- replace the placeholders,
- create your program repo, allowlist and governance file,
- adapt the instructions and skills to your vocabulary,
- stand up a host with Docker, a mail address and a reverse proxy.
