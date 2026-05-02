# Curriculum repo — starter skeleton

Copy this layout into a new private repository, then fill in the blanks.

```
your-curriculum-repo/
├── README.md
├── program/
│   ├── CURRICULUM.md
│   ├── EMAIL_ALLOWLIST.md
│   ├── courses/
│   │   ├── COURSE_101.md
│   │   ├── COURSE_201.md
│   │   └── ...
│   └── policies/
│       ├── admissions.md
│       ├── grading.md
│       └── accommodations.md
├── discussions/
│   ├── DECISIONS.md
│   ├── ACTION_ITEMS.md
│   ├── OPEN_QUESTIONS.md
│   └── audit-log/
│       ├── email/
│       ├── telegram/
│       ├── teams/
│       ├── teams-webhook/
│       ├── webchat/
│       └── copilot-studio/
├── skills/
│   └── README.md
└── .gitignore
```

## File starters

### `program/CURRICULUM.md`

```markdown
# <PROGRAM> Curriculum

**Total credits:** XX
**Duration:** XX months
**Format:** <online | in-person | hybrid>

## Course list

| Code | Title | Credits | Term |
|------|-------|---------|------|
| 101  | ...   | ...     | ...  |

## Sequencing

<paragraph or diagram>

## Prerequisites

<paragraph>
```

### `program/EMAIL_ALLOWLIST.md`

```markdown
# Email Allowlist

| Email | Name | Role | Decision authority |
|-------|------|------|--------------------|
| chair@yourorg.example | <NAME> | Department chair | yes |
| advisor@yourorg.example | <NAME> | Academic advisor | no |
| coordinator@yourorg.example | <NAME> | Program coordinator | yes |
```

### `discussions/DECISIONS.md`

```markdown
# Program Decisions

Append-only log of decisions captured by <AGENT_NAME>. Newest at top.

---

<!-- Entries follow this format:

## YYYY-MM-DD — <decision title>

**Source:** <channel> from <sender>, audit-log/<channel>/<timestamp>-in.md
**Context:** <2–3 sentences>
**Decision:** <the decision>
**Owner:** <who's responsible>
**Effective:** <when>

-->
```

### `discussions/ACTION_ITEMS.md`

```markdown
# Open Action Items

<!-- Entries follow this format:

## <title>

- **Owner:** <name>
- **Due:** <date or "TBD">
- **Source:** audit-log/<channel>/<timestamp>-in.md
- **Status:** open

-->
```

### `discussions/OPEN_QUESTIONS.md`

```markdown
# Open Questions

<!-- Entries follow this format:

## <question>

- **Asked by:** <name>
- **Asked in:** audit-log/<channel>/<timestamp>-in.md
- **Status:** open

-->
```

### `.gitignore`

```
.DS_Store
*.swp
node_modules/
```

## After you create the repo

1. Make it private. It will contain stakeholder PII.
2. Add the bot's git identity as a collaborator with write access.
3. Configure the bot's git identity locally (matching the deploy key on the VPS):
   ```
   git config user.name "<AGENT_NAME>"
   git config user.email "<bot-email>"
   ```
4. Initial commit with the skeleton above.
5. Mount path inside containers will be `/workspace/extra/<repo-name>`. Pass this through your NanoClaw container-runner config.
