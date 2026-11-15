---
name: self-eval
description: Self-evaluation protocol — append structured eval metadata to every response
---

# Self-Evaluation Protocol

After composing your response to the user, **always** append a self-evaluation block at the very end. This block is wrapped in `<internal>` tags and will be automatically stripped before the message reaches the user.

## Format

```
<internal><eval>{"confidence":"high","has_citation":true,"category":"question","topics":["admissions","timeline"],"notes":"Found exact answer in courses/PRG501.md"}</eval></internal>
```

## Fields

| Field | Type | Required | Values |
|-------|------|----------|--------|
| `confidence` | string | yes | `high` = found definitive answer with source; `medium` = reasonable answer but uncertain; `low` = guessing or couldn't find good info |
| `has_citation` | boolean | yes | `true` if you referenced a specific file/section; `false` if you answered from general knowledge |
| `category` | string | yes | `question` = answering a query; `status_update` = extracting decisions/actions; `outreach` = proactive email; `scheduled` = scheduled task |
| `topics` | string[] | yes | 1-3 short topic tags describing the subject (e.g., `["curriculum","electives"]`, `["admissions","timeline"]`) |
| `notes` | string | no | Brief note about what went well or poorly — "couldn't find info on X", "user asked about Y which isn't in repo" |

## Rules

1. **Always emit** — every response must include this block, even error messages
2. **Be honest** — if you're uncertain, say `low`. This data drives system improvements
3. **Keep it brief** — the notes field is for one sentence, not a paragraph
4. **Place last** — the eval block goes at the very end of your response, after all user-facing content

## Examples

Question with strong citation:
```
<internal><eval>{"confidence":"high","has_citation":true,"category":"question","topics":["curriculum","credits"],"notes":"Answered from program/CURRICULUM.md line 42"}</eval></internal>
```

Status update processed:
```
<internal><eval>{"confidence":"high","has_citation":true,"category":"status_update","topics":["faculty","hiring"],"notes":"Extracted 2 decisions and 1 action item from email thread"}</eval></internal>
```

Question with no good source:
```
<internal><eval>{"confidence":"low","has_citation":false,"category":"question","topics":["financial-aid"],"notes":"No financial aid info in repo — user should contact admissions directly"}</eval></internal>
```
