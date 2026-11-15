---
name: knowledge-builder
description: Auto-FAQ and pattern library — builds institutional knowledge from conversation history
---

# Knowledge Builder

This skill runs as a scheduled task. It reads audit logs to extract recurring questions and their best answers, then maintains a FAQ and patterns library that agents check first on future questions.

## Workflow

### Step 1: Read Sources
1. Read the last 7 days of audit logs from `/workspace/extra/program-repo/discussions/audit-log/`. Files are named `YYYY-MM-DD.md`. Each entry is a markdown section with timestamp, channel, direction (inbound/outbound), sender, and message content, separated by `---` dividers.
2. Read the current FAQ from `/workspace/extra/program-repo/discussions/FAQ.md` (create if missing)
3. Read the current patterns library from `/workspace/extra/program-repo/discussions/PATTERNS.md` (create if missing)
4. Read the eval report from `/workspace/ipc/eval_report.md` (if available — may not exist on manual triggers)

**If no audit logs exist for the period**, output "No audit data available for knowledge extraction" and exit without making changes.

### Step 2: Extract Q&A Pairs
Scan inbound/outbound pairs in the audit logs. For each question-and-answer pair:
- Was the answer high-confidence with citations?
- Has a similar question been asked before (in the FAQ or in earlier logs)?
- Is this a topic likely to recur?

### Step 3: Update FAQ
Add new entries to `discussions/FAQ.md` using this format:

```markdown
## [Topic Category]

### Q: [Natural language question]
**A:** [Concise answer with file references]
*Source: [file path and section]*
*Last verified: YYYY-MM-DD*
```

Rules for FAQ updates:
- Only add entries from high-confidence answers with citations
- Merge similar questions into one entry with the best answer
- Update `Last verified` date if the same question was answered again
- Remove entries if the source file has changed significantly (flag for review instead)
- Keep the FAQ organized by topic category (Curriculum, Admissions, Courses, Faculty, etc.)

### Step 4: Update Patterns Library
Maintain `/workspace/extra/program-repo/discussions/PATTERNS.md` for complex multi-step workflows the agent has handled well:

```markdown
## [Pattern Name]

**When:** [Trigger condition — e.g., "Email contains meeting notes with decisions"]
**Steps:**
1. [What the agent did]
2. [What files were updated]
**Example:** [Brief reference to the audit log entry]
**Last used:** YYYY-MM-DD
```

### Step 5: Commit Changes
```bash
cd /workspace/extra/program-repo
git config user.name 'Coordinator'
git config user.email 'program-bot@example.org'
git add discussions/FAQ.md discussions/PATTERNS.md
git commit -m "knowledge-builder: update FAQ and patterns"
git push
```
- Output a brief summary of what was added/updated

## Rules

1. **Quality over quantity** — only add FAQ entries from verified, high-confidence answers
2. **Don't duplicate** — check existing FAQ entries before adding
3. **Keep it current** — update dates, remove stale entries
4. **Be concise** — FAQ answers should be 1-3 sentences, not paragraphs
5. **Cite sources** — every FAQ answer must reference a specific file
