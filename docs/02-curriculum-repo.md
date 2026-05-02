# 02 — Curriculum repository

The curriculum repository is the **source of truth for bot operations** — every decision the agent captures, every audit-log entry, every learned skill — and the **default source of truth for program content** (curriculum, policies, allowlists). It lives outside this codebase, in its own repo, and gets mounted read-write into every agent container.

**Important qualifier added in `docs/10-content-sources.md`**: many adopters keep their *content* (syllabi, policy docs, partner agreements) in an external store like Box or SharePoint where the team already edits, and mount it read-only into the agent alongside the curriculum repo. In that pattern the curriculum repo remains authoritative for what the bot has *done* (decisions, audit, skills), while the external mount is authoritative for what the docs *say* today. Pick the pattern intentionally — see `docs/10-content-sources.md`.

## Why it's separate

- The agent operates *on* it, but it's not part of the bot. Faculty and staff edit it directly when they want to.
- It outlives any single bot deployment. You can rewrite the bot in a different framework and the curriculum repo keeps working.
- Privacy posture is different. The bot code can be open source; the curriculum repo usually can't be (it contains stakeholder names, strategy, internal decisions).

## Required structure

```
your-curriculum-repo/
├── program/
│   ├── CURRICULUM.md            # source of truth: program structure
│   ├── EMAIL_ALLOWLIST.md       # markdown table of authorized senders
│   ├── courses/                 # one file per course
│   │   ├── COURSE_101.md
│   │   ├── COURSE_201.md
│   │   └── ...
│   └── policies/                # admissions, grading, accommodations, etc.
├── discussions/
│   ├── DECISIONS.md             # append-only decision log
│   ├── ACTION_ITEMS.md          # open action items
│   ├── OPEN_QUESTIONS.md        # unresolved questions
│   └── audit-log/
│       ├── email/               # inbound + outbound .md files
│       ├── telegram/
│       ├── teams/
│       ├── teams-webhook/
│       ├── webchat/
│       └── copilot-studio/
├── skills/                      # agent-readable skills; agent proposes new ones via PR
│   └── README.md
└── README.md                    # for human readers
```

See [`../examples/curriculum-repo/SKELETON.md`](../examples/curriculum-repo/SKELETON.md) for a copy-pasteable starter.

## EMAIL_ALLOWLIST.md format

The filename is **load-bearing** — channel code reads this exact path. Format:

```markdown
# Email Allowlist

| Email                     | Name              | Role             | Decision authority |
|---------------------------|-------------------|------------------|--------------------|
| chair@yourorg.example     | <NAME>            | Department chair | yes                |
| advisor@yourorg.example   | <NAME>            | Academic advisor | no                 |
```

- The `Decision authority` column drives the question-vs-status-update routing in [`04-agent-modes.md`](./04-agent-modes.md).
- The agent reads this file at the start of every email-channel run. To add or remove someone, edit the markdown — no redeploy.

## DECISIONS.md, ACTION_ITEMS.md, OPEN_QUESTIONS.md

The agent appends to these in status-update mode. Format suggestion (not required, but the agent prompts assume something close to this):

```markdown
## YYYY-MM-DD — <decision title>

**Source:** email from <sender>, audit-log/email/<timestamp>-in.md
**Context:** <2–3 sentences>
**Decision:** <the decision>
**Owner:** <who's responsible>
**Effective:** <when>
```

## Audit log

One file per inbound, one per outbound. Naming: `<ISO-timestamp>-in.md` and `<ISO-timestamp>-out.md` inside `audit-log/<channel>/`. See [`05-audit-logging.md`](./05-audit-logging.md) for the file body schema.

## Mount point

Inside agent containers, the curriculum repo is mounted at `/workspace/extra/<repo-name>` by default. The agent prompts reference this path. If you change it, change both NanoClaw's container-runner config and the prompts.
