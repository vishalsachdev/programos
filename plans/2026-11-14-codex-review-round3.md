# Codex review, round 3: findings and dispositions

Date: 2026-11-14. Reviewer: Codex (read-only, whole tree, at the round 2 commit). Verdict: no-ship, 8 findings. Each finding was checked against the code.

| # | Sev | Finding | Checked | Disposition |
|---|-----|---------|---------|-------------|
| 1 | P1 | The allowlist template said rows under "Retired access" are inactive. The email check and the Telegram check still accept them | True. Only the approval parser stops at that marker | Template corrected: delete the row and the handle; the note holds prose only. Stated in `AGENTS.md`. Parser difference reported upstream |
| 2 | P2 | A source comment and a prompt line kept dates from the source deployment; the root `CLAUDE.md` kept the old model | True | Comment date made synthetic; prompt date removed; root `CLAUDE.md` rewritten. Its older log entry was already public and stays |
| 3 | P2 | Email needs a separate intake service that is not in this repo, and the docs did not say so | True (the handler needs a committed file and a custom payload) | `AGENTS.md` has a new "Inbound mail" section with the contract. `ARCHITECTURE.md` corrected. A neutral adapter is future work |
| 4 | P2 | The setup order left out group registration and the mount allowlist location | True | `AGENTS.md` has a new "First start" section |
| 5 | P2 | Operator alerts go to Telegram; an email-only setup loses them | True | Documented in `AGENTS.md`, the settings example and the README. Reported upstream |
| 6 | P2 | The decision format in the template had no status or date field, so two readers ignored the entries | True | Template format corrected to the fields the readers use |
| 7 | P2 | The credential proxy drops a path prefix in the endpoint URL | True | Documented as a limit in `AGENTS.md` and the settings example. Reported upstream |
| 8 | P2 | Root `CLAUDE.md` still said "spec, not code" | True | Rewritten |

## Checks after the fixes

Typecheck clean. 101 test files, 1,761 tests, all pass.

## Round 4 (same thread, at the round 3 commit)

Verdict: no-ship, 4 findings, all confirmed. Round 4 confirmed that the round 3 fixes for the decision format, the source dates and the root instructions held, and found no new privacy item.

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| 1 | P1 | The corrected retirement note contained a literal example username inside the Telegram section, and the parser read it as an authorized account | Note moved under its own heading with no username text. The real parsers were run on the template again: exactly one Telegram account, three addresses, three rows |
| 2 | P2 | The inbound mail section left out the original-message evidence for routed approvals and the fixed intake git author | Added to `AGENTS.md`, with the two code sites |
| 3 | P2 | "First start" left out checkout ownership and credentials for the two writers | Added to `AGENTS.md` |
| 4 | P2 | The spec said the audit log holds each message in full; chat entries are cut at 2,000 characters | `SPEC.md` corrected |

## Round 5 (same thread, at the round 4 commit)

Verdict: no-ship, 1 finding, confirmed. All four round 4 fixes held; no regression and no privacy finding.

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| 1 | P2 | The spec and rules G19 and G52 promised sender caps on each channel; only the email handler applies them | `SPEC.md`, `ARCHITECTURE.md`, `docs/12-governance.md` and `AGENTS.md` now say email only. Reported upstream |

## Round 6 (same thread)

Verdict: no-ship, 3 findings, all confirmed. The round 5 fix held; no regression and no privacy finding.

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| 1 | P2 | Web chat has no allowlist of people; the safety text implied each channel has one | `README.md`, `SPEC.md` and `AGENTS.md` now say web chat accepts any caller with the shared secret |
| 2 | P2 | Scheduled Telegram messages and direct operator notices are sent with no outbound audit entry; the docs said each send is logged | `README.md`, `docs/12-governance.md` (G23) and `AGENTS.md` name the two exceptions. Reported upstream |
| 3 | P3 | `AGENTS.md` named a function that does not exist | Corrected to the real name |

## Round 7 (same thread; a sweep of universal claims)

Asked for: each remaining "every / all / never / only" claim in the adopter-facing documents that the code holds on some paths only. Verdict: no-ship, 13 findings (10 P2, 3 P3), all in documents, none in new code. Spot-checked against the code and accepted as a class.

Disposition for all 13: each claim is now scoped to the paths where the code holds it, and `SPEC.md` has a new section 7, "Where the guarantees stop", with one row per rule. Topics covered: model credentials in OAuth mode; the delivery gate; audit coverage and fields; append-only wording; gate-result logging; durable sends; protected files; commits in question mode and by read-only senders; recipient and body-address rules; copied-mail and thread-audience fallbacks; transport and reply format per channel; in-memory counters; the scope of the reply sensor. The underlying code gaps were added to the note for the source deployment.

## Round 8 (same thread, after the docs reorganization)

Verdict: no-ship, 5 findings, all confirmed.

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| 1 | P1 | Source code: the Telegram handler keeps one reply destination, the latest chat to write. With two chats, a reply for one can go to the other. The spec had just promised the opposite | Promise removed. Limit stated in `SPEC.md` section 11, `AGENTS.md` and `docs/deployment.md`: use Telegram with one chat only. Reported to the source as a priority item |
| 2 | P2 | The older-delivery exception was listed under the recipient rule; it belongs to the body-address check | Moved in `SPEC.md` and the governance doc |
| 3 | P2 | Round 7 edits understated the gate: scheduled and direct chat sends do pass it | Gate coverage and audit coverage are now described separately |
| 4 | P2 | The deployment checklist did not fit each channel choice | Checks are now per enabled channel |
| 5 | P3 | Two sections numbered 7; stale mentions of the old doc numbers | Limits section is now 11; mentions corrected |

## Round 9: clean

Verdict: ship. No actionable findings. Codex confirmed the round 8 fixes and each row of `SPEC.md` section 11.

Final checks by the maintainer at the same commit: typecheck clean; 101 test files, 1,761 tests pass; secret scan clean; private-term scan clean in code, prompts, skills and templates.

The review gate is passed. A push to the public repo still needs the owner's yes.

## Round 10 (narrow: the export tool and the CI file, added after round 9)

Verdict: no-ship for the tool, 7 findings (3 P1, 4 P2), all confirmed in the code. No finding on the CI file. The format pass was confirmed as format only.

| # | Finding | Disposition |
|---|---------|-------------|
| 1 | Delete and rename entries could leave the temp tree | Each entry is validated; unsafe entries stop the run |
| 2 | Symlinks could redirect reads and writes | A symlink left in the snapshot stops the run; the scrubber skips links; apply never writes through one |
| 3 | `--apply` could delete local files that were never exported | Apply now works from git's tracked files and needs a clean tree |
| 4 | The patch could add an owned path | Owned paths are checked again after the patch and at write time |
| 5 | The scan skipped file names, the lockfile and unreadable files | It now reads names and all bytes of each file |
| 6 | The "outside this repo" check accepted the repo root | Paths are resolved first; the root is refused |
| 7 | A change of the executable bit was missed | The comparison includes it |

The tool now has unit tests for these rules (`scripts/upstream-sync/test_export.py`, run in CI). A compiled Python cache file had been committed locally by mistake in the previous commit; it is removed and ignored. After the fixes, a run against the recorded source version still reproduces the exported paths with no difference.

## Round 11 (narrow: the export tool)

Verdict: no-ship, 4 findings (2 P1, 2 P2), all confirmed.

| # | Finding | Disposition |
|---|---------|-------------|
| 1 | A parent folder that is a symlink could still redirect a write, and a folder was created before the check | The whole plan is checked before the first change; a symlinked parent is refused, also when it points inside the repo |
| 2 | A new exported path could overwrite a local file that git does not track | Refused in the plan check |
| 3 | The scan missed accented names in UTF-8 text | Text is read as UTF-8 and byte by byte, with Unicode normalization |
| 4 | An owned path could be reached through a different letter case | Owned paths are matched without regard to case |

The plan check and the scan are now separate functions with their own tests (22 tests in total).

## Round 12: clean

Verdict: ship for the export tool. No actionable findings. All 22 tool tests pass. The review gate is passed for the whole tree.
