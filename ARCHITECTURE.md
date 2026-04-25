# Architecture

How ProgramClaw sits on top of NanoClaw, and what's adopter-supplied vs framework-supplied.

## High-level picture

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Stakeholder channels                         │
│   Email   Telegram   Teams (BF)   Teams (Webhook)   Web   Copilot    │
└────┬─────────┬────────────┬──────────────┬───────────┬──────────┬────┘
     │         │            │              │           │          │
     │         │            │              │           │          │
     ▼         ▼            ▼              ▼           ▼          ▼
┌──────────────────────────────────────────────────────────────────────┐
│   src/channels/*.ts  ── handler per channel (ADOPTER-SUPPLIED)       │
│   • auth (HMAC / JWT / bot token / API key)                          │
│   • allowlist / allowed-users filter                                 │
│   • build NanoClaw Message + JID                                     │
│   • format reply per channel                                         │
└──────────────────────────────────────────┬───────────────────────────┘
                                           │
                                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│   NanoClaw framework (UPSTREAM — DO NOT MODIFY)                      │
│   • channel registry / router                                        │
│   • group queue / concurrency                                        │
│   • container runner (Docker)                                        │
│   • SQLite (messages, sessions, groups)                              │
└──────────────────────────────────────────┬───────────────────────────┘
                                           │  spawns
                                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│   Claude Code agent in Docker container                              │
│   • prompt = groups/<channel>/CLAUDE.md (ADOPTER-SUPPLIED)           │
│   • workspace = curriculum repo, mounted at /workspace/extra/<name>  │
│   • mode = question (read-only) | status-update (workspace-write)    │
└──────────────────────────────────────────┬───────────────────────────┘
                                           │  reads/writes
                                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│   Curriculum repository (ADOPTER-OWNED, separate repo)               │
│   • program/CURRICULUM.md           — source of truth                │
│   • program/EMAIL_ALLOWLIST.md      — authorized senders             │
│   • discussions/DECISIONS.md        — append-only decision log       │
│   • discussions/ACTION_ITEMS.md     — open actions                   │
│   • discussions/OPEN_QUESTIONS.md   — unresolved questions           │
│   • discussions/audit-log/          — full message history           │
└──────────────────────────────────────────────────────────────────────┘
```

## Responsibility split

| Layer | Owner | Touch when |
|-------|-------|------------|
| Container runtime, channel registry, message router, queue, SQLite | NanoClaw upstream | Never (rebase from upstream instead) |
| Channel handlers (`src/channels/*.ts`) | Adopter | Adding/changing a channel |
| Agent prompts (`groups/<channel>/CLAUDE.md`) | Adopter | Changing agent behavior, persona, citation style |
| Audit log (`src/audit-log.ts`) | Adopter | Changing what gets logged or where |
| Curriculum repo structure | Adopter | Always (this is your program) |

## Why this split

NanoClaw is small enough to read end-to-end in an afternoon (its README brags ~17% of context). The temptation is to fork and modify everywhere. Don't. Almost every program-coordinator behavior you want is achievable in three places:

1. **The channel handler** — for input filtering and reply formatting.
2. **The per-channel `CLAUDE.md`** — for agent behavior and decision rules.
3. **The audit-log writer** — for the persistent trail.

Treat NanoClaw itself as a black-box framework. When upstream releases a new version, you should be able to rebase in minutes, not days.

## Two operational modes — concretely

The single most important decision per message is **question vs status-update**. The decision tree:

```
Inbound message arrives
        │
        ▼
Is the channel one where the sender has decision authority? (e.g., faculty email, not student web chat)
   ├── No  ─── always Question mode
   └── Yes
        │
        ▼
Does the message contain explicit signal? (subject prefix "[DECISION]", command "/decide", etc.)
   ├── Yes ─── Status-update mode
   └── No
        │
        ▼
Does the body contain decision-shaped language? ("we decided", "going forward", "as of X we will")
   ├── Yes ─── Status-update mode
   └── No  ─── Question mode
```

The agent runs the same Claude Code container in both modes; only the sandbox flag and the agent prompt differ.

## Audit log — concretely

Every inbound: `discussions/audit-log/<channel>/<ISO-timestamp>-in.md`.
Every outbound: `discussions/audit-log/<channel>/<ISO-timestamp>-out.md`.

Files are committed in batch at the end of each container run, attributed to the bot's git identity. Status-update runs commit decision/action/question changes separately from audit-log commits, so accreditation reviewers can see decisions cleanly without log noise.

## What you actually build

For a brand-new ProgramClaw on a brand-new NanoClaw fork, expect roughly:

- **6 channel handlers** (~150 lines each) in `src/channels/`
- **6 agent prompts** in `groups/<channel>/CLAUDE.md`
- **1 audit-log module** (~80 lines) in `src/audit-log.ts`
- **2 small NanoClaw hooks** in `src/index.ts` and `src/container-runner.ts` (audit logging + container chown patch)
- **Curriculum repo** in a separate repository

Total: roughly 1,000–1,500 lines of code on top of NanoClaw, plus the curriculum repo content. The reference deployment fits in this envelope.
