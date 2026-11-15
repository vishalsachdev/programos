# Codex review, round 2: findings and dispositions

Date: 2026-11-14. Reviewer: Codex (read-only, whole tree). Verdict: no-ship, 11 findings. Each finding was checked against the code before a disposition was recorded.

| # | Finding | Checked | Disposition |
|---|---------|---------|-------------|
| 1 | The reply sensor calls the model provider's public API directly and does not use the approved endpoint setting | True (`callSensorModel` in `src/behaviour-sensor.ts`) | Upstream code. Reported upstream. The settings example keeps the sensor off; `AGENTS.md` states the two call paths |
| 2 | Inline comments in the settings example become part of the values | True (the reader does not strip them) | Fixed: comments are on their own lines |
| 3 | Some settings are read only from the process environment, so setting them in `.env` does nothing | True | Fixed: the example has two parts and `AGENTS.md` explains both |
| 4 | Governance doc overstated the protected-file guard | True (guard covers file-editing tools, not shell commands) | Doc corrected. Gap reported upstream |
| 5 | Setup skills from the framework describe steps that no longer match | True | Removed `.claude/skills`; `AGENTS.md` is the guide |
| 6 | `AGENTS.md` missed three identity sites | True | Added: accepted git origin, admin commit identities, one-person exception in the outreach roster |
| 7 | The starter program repo in `examples/` does not match the formats the code reads | True (allowlist needs five columns) | Added `templates/program-repo/`. The real parsers were run against its allowlist: 3 rows, 3 addresses, 1 chat handle |
| 8 | Mount example made the email group read-only, which blocks updates | True | Fixed |
| 9 | Two prompts and one skill disagree on how to record an unconfirmed spreadsheet fact | True | Upstream content. Reported upstream; listed under known gaps |
| 10 | A skill names a chat tool that is not registered | True | Upstream content. Reported upstream; listed under known gaps |
| 11 | Governance doc said every channel needs a reply block | True (email only) | Doc corrected |

## Found by the maintainer during this round

Test fixtures kept real organizational detail (titles, reporting lines, dated personnel notes) around synthetic names. The name scans cannot see this. Seventeen test and eval files were edited to use generic detail. No test was removed, skipped or loosened.

## Checks after the fixes

- Typecheck: clean.
- Tests: 101 files, 1,761 tests, all pass.
- Secret scan: no findings.
- Private-term scan: no findings in code, prompts, skills or templates.

## Still open

- Docs 01 to 11 predate the code and differ from it in places. The README table marks which ones match.
- The three upstream items (1, 9, 10) and the shell-command gap in the protected-file guard.
