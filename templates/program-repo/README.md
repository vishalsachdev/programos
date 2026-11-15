# Program repo skeleton

Copy this folder into a new, private git repository. It is the knowledge base that
your ProgramOS coordinator reads and writes. The file names and table formats here
are the ones the code in this version parses. Change the content; keep the names,
headings and table columns unless you also change the code.

| Path | Read by | Notes |
|---|---|---|
| `CLAUDE.md` | The agent; a host contract check | Must keep the heading `## KB Write Protocol` |
| `program/EMAIL_ALLOWLIST.md` | Host code (several modules) | Five columns, email in the second. Keep the section headings. |
| `program/curriculum.md` | The agent; the reply sensor | The facts that must not be wrong. The agent may not edit it. |
| `program/kb-governance.md` | People; cited by prompts | Your rules, the change protocol, the changelog |
| `discussions/DECISIONS.md`, `ACTION_ITEMS.md`, `OPEN_QUESTIONS.md` | The agent; host scans | Append-only practice for decisions |
| `discussions/audit-log/`, `discussions/raw/`, `discussions/kb-triage/` | Written by the host | Leave empty |
| `docs/faq.md` | The agent | Canonical answers, re-checked when a decision touches a topic |
| `reference/DEPENDENCY_GRAPH.md` | The agent | Which files must change together |
| `courses/` | The agent; the ingestion check | One file per course in the reference deployment. Use it for your own units of work, or leave it empty. |
