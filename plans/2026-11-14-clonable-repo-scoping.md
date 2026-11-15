# Plan: ProgramOS as one clonable repo (spec + code)

Created: 2026-11-14 | Last Updated: 2026-11-14
Status: **Step 1 done. Step 3 started 2026-11-14 in a private folder outside this repo** (Vishal confirmed control's four conditions). Nothing copied into this repo yet. Nothing pushed. No site or DNS change.

## Goal

Turn this repo from a spec into one repo a unit can clone and run, for any project
and for knowledge management. The code is a close copy of K-ai, the reference
deployment that runs in production, with all program content removed. The site for
`programos.illinihunt.org` builds from this repo.

## Decisions (Vishal, 2026-11-14)

1. **Name:** keep "ProgramOS" and widen its meaning.
2. **Repo:** one public, institution-neutral repo. The Illinois steps go in one document.
3. **Work in progress:** a local branch only. No push until the scans are clean and Vishal says yes.
4. **Principle:** assume the user's coding agent is capable. Do not over-customize. Share the code, workflows and skills that are tested in production. `AGENTS.md` guides the agent through adapting them, including which features to use.
5. **Base:** K-ai's code is the base. The pilot fork (built 2026-11-13) is a guide and a source of reusable parts, not the base.
6. **K-ai stays the source.** ProgramOS takes changes from it, through a repeatable step that removes program content each time.
7. **Reminders and routed approvals are important** and ship as they run in K-ai.
8. **Control's four copy conditions confirmed:** one new commit with no history; identity removed first, in a private folder; scan before anything is public; NanoClaw notice kept.
9. **Workers:** Codex, Cursor and Devin as needed, headless, no panes.
10. **Model provider:** Claude through an approved endpoint comes first for the first Illinois unit. OpenAI and Gemini runners stay as later options. Step 5 must find which approved endpoint offers Claude (for example Azure AI Foundry) and confirm the policy answer.
11. **Prose treatment:** (1) remove private details: names, incident dates and stories, server facts, session logs. (2) Keep every rule and its gate number; the public governance starter file defines each number in generic words. (3) Keep the academic examples and vocabulary as tested; `AGENTS.md` tells the user's agent to adapt them and names the two code areas that hold academic logic (the behaviour sensor and the ingestion check).
12. **Placeholder bot name:** "Coordinator" ("Co-ordinator" as the split form the tests need), until Vishal says otherwise.

What follows from these:

- Remove private content (required). Otherwise keep the code close to K-ai. No new feature-switch system, no large settings refactor, no pruning of modules.
- Each part is labelled "in production in K-ai since <date>" or "piloted, not yet in production".
- The pilot fork's approval-by-hash layer, pilot sender gate and consent text are **piloted only**. They are a later, separate, optional item. Approval-by-hash needs a single host writer and a read-only agent, so it cannot run beside K-ai's agent writes and routed approvals without a design decision.
- The governance starter file (step 4a) is **required**, because K-ai's model relies on written gates.

## Why K-ai and not the pilot fork (two read-only passes, main claims spot-checked)

The fork is K-ai at one commit plus 28 commits: 276 files changed, 8,161 lines added, 17,417 removed (measured). Those commits mix four kinds of work in the same commits and often the same hunks: content removal, feature lock-down, the new approval layer, and container hardening. Only 1 of 28 commits is pure content removal.

- **The lock-down is in code, not settings.** Agent requests to the host are cut to one type. The scheduler runs one fixed job and pauses all others at each start. Routed approvals lost their call sites. Telegram is send-only. The program mount is read-only.
- **Tests were replaced.** About 50 tests assert the locked state; about 90 K-ai behaviour tests were deleted (one file went from 33 tests to 1; checked).
- **Instructions were cut.** About 680 lines of agent prompts and about 800 lines of container skills became short stubs.
- **The fork is not clean.** Private gate numbers remain in 59 files (94 in K-ai; checked). A second pass counted 55 real-looking university addresses carried over unchanged, and owner or staff names in about 60 files (not recounted). The fork adds its own project name in about 180 files.
- **No rule list exists.** The content removal was search-and-replace plus hand edits, with nothing recorded.

## What K-ai contains (inventory taken on the fork; file layout is the same)

| Measure | Value |
|---|---|
| Tracked files (fork) | 432 |
| Lines in `src/` (fork) | 57,281 in 194 files, about half tests |
| Git history | over 1,200 commits with program content. **Never bring it over.** |
| `npm ci` findings (fork's record) | 26 (3 low, 10 moderate, 12 high, 1 critical), not reviewed |
| Secret-pattern scan of the fork's current files | 0 hits; positive control hit. Regex only. |
| Licence | NanoClaw MIT, "Copyright (c) 2026 Gavriel"; must travel with the code |

Parts: host orchestration (queue, container runner, credential proxy, IPC, database); channels (email webhook, Telegram, web chat); delivery gate and outbox; audit log; program-repo reader; scheduler and reminders; routed approvals; behaviour sensor and evaluation scripts; container agent runner and skills; setup wizard.

**Drop at copy time** (not related to a coordinator): upstream skills for X/Twitter, WhatsApp, Discord, Slack, Emacs, macOS status bar, Qodo and similar (in both skill folders); `repo-tokens/`; translated READMEs; marketing assets; upstream release workflows; all instance runbooks, handoffs, plans, articles and agent-inbox items.

## Proposed target layout

```
programos/
├── README.md                 reframed: any project + knowledge management; "clone and run"; proof from real use
├── AGENTS.md                 for a new user's coding agent: guided adaptation, stops at each user choice
├── CLAUDE.md                 maintainer notes, points to AGENTS.md
├── UPSTREAM.md               last K-ai commit exported, date
├── SPEC.md, ARCHITECTURE.md  the spec (kept at root; §2 and §5 stay load-bearing)
├── LICENSE                   MIT (Vishal)
├── NOTICE                    NanoClaw MIT notice, kept with the code
├── docs/
│   ├── 01-…11-*.md           existing numbered spec docs (no renumbering)
│   ├── 12-governance.md      new: each mechanism with the failure it prevents; the change protocol
│   ├── 13-…                  further docs appended (Azure tier, setup without an agent)
│   ├── data/proof.json       the one source of every published usage number, with "as of" date and query ID
│   └── framework/            upstream NanoClaw reference docs
├── package.json, tsconfig.json, eslint, prettier, vitest   code at root so `npm ci && npm test` works on clone
├── src/                      host, same structure as K-ai
├── container/                agent runner image and container skills (neutral text)
├── groups/                   agent prompts per channel (neutral text)
├── setup/                    setup wizard
├── scripts/
│   ├── upstream-sync/        the export: delete list + replacement rules + script (no private values)
│   ├── sync_site_facts.py    fails if any README/site number differs from docs/data/proof.json
│   └── deploy_site.sh        stages site/ only, then wrangler (canvas-mcp pattern)
├── config/
│   └── instance.env.example  the settings a unit fills in, written new
├── templates/
│   └── program-repo/         empty program repo skeleton, with governance.md starter
├── site/                     the only folder deployed to programos.illinihunt.org
├── plans/                    plans like this one (never deployed)
└── .github/workflows/ci.yml  typecheck, lint, test, and the scrub check
```

`examples/` folds into `templates/` and `groups/`. `scripts/init.sh` is replaced by `setup/`.

## Step 3: the export (after Vishal says yes)

The first copy and every later sync are the same tool.

1. **Private working copy.** Export K-ai with `git archive` into a private folder outside this repo. No `.git`, no history.
2. **Delete list.** Start from the fork's list of 62 deleted files; add the "drop at copy time" list.
3. **Replacement rules, written down.** Names, addresses, course and program terms, host paths, hostnames, ports, gate numbers. Addresses become `example.edu` / `example.org` (RFC 2606). The rules file is public and neutral on its right-hand side; the private words it matches stay in a **private deny-list outside this repo**, passed by path.
4. **Reuse from the fork:** about 72 files whose only change is a rename, and its synthetic fixtures. First test that they build and pass on K-ai (unverified).
5. **Hand-neutralize about 35 to 40 files:** agent prompts, container skills, docs, identity values in config. These are kept as overlay files that the export applies.
6. **Checks:** deny-list scan with a planted positive control; a real secret scanner (for example gitleaks); `npm ci`, typecheck, lint, the full test suite; review of the `npm audit` findings. A K-ai path that no rule covers **stops the run**.
7. **One snapshot commit** on the local branch. `UPSTREAM.md` records the K-ai commit. Codex review until a round returns nothing.

ProgramOS-only files (spec, `AGENTS.md`, `templates/`, `site/`, `docs/`) are never overwritten by an export.

Each later sync: export the new K-ai commit, run the same rules, read what changed in the overlay files' sources, update overlays, run the checks, commit.

Workers: headless Devin for the mechanical parts (delete list, replacement rules, fixture rewrite, scan script); Codex for review. I check every Devin change before it is committed.

## Step 3 progress log (private folder; nothing in this repo yet)

- 2026-11-14: K-ai base commit confirmed equal to its remote head. Untouched snapshot: 1,761 tests pass, typecheck clean.
- Delete list applied: 460 files to 300. Lesson: the fork's delete list also removed three channel prompt files and one renamed source file; those were restored.
- Replacement rules written (about 200, in a private file) and applied. After fixes for code-and-fixture links the rules broke (course-prefix patterns, bot-name patterns, encoded strings, a colour word that is also a first name): typecheck clean, 1,761 of 1,761 tests pass, no test skipped, assertion count unchanged (3,232).
- A second sweep found about 30 more real people that the first list missed, in fixtures, identifiers and comments.
- Evaluation data built from real exchanges replaced with the fork's synthetic cases (same counts; related tests pass).
- In progress: removing private narrative from prompts, skills, docs and comments under the prose treatment above.
- Still to do: the upstream maintainer notes (dropped; this repo has its own), leftovers (a peer-agent product name, private commit hashes), deny-list scan with a planted control, a real secret scanner, `npm audit` review, layout assembly, one snapshot commit, Codex review.

## Step 4: rewrite the spec

For any project and for knowledge management, and to match the code that now ships with it.

## Step 4a: governance starter (required)

1. Read each of the 59 K-ai gates (privately) and sort them: enforced by code (document only); general practice any project needs (who may record a decision, what counts as a source, how a rule changes); program-specific (leave out).
2. Draft `templates/program-repo/governance.md`: short, generic, with the change protocol. An 18-gate KB template in a sibling private project is the model for length.
3. Add `docs/12-governance.md` and reference it in SPEC.md §2 or §5.
4. **Carry the why with the how.** For each mechanism: the rule, the failure it prevents, and what was learned in real use, in generic terms with no names.
5. Give gate numbers in code comments a public meaning: either the public starter file keeps stable IDs that the comments can cite, or the export rewrites the comments.
6. Write clean generic text. Copy no gate text as it is.

## Step 4b: AGENTS.md for a new user's coding agent

Its reader is the coding agent of a person who just cloned the repo. It says what exists, what must change for a new project (name, address, ports, program repo, allowlist), which features exist and what each needs, and where governance is explained. At each choice that is the user's, it stops and asks: who approves records, which address the bot sends from, where the data lives, which AI service unit mail may reach (policy first), the consent wording. It never guesses and never deploys. I test it by handing it to a fresh agent in a scratch clone.

## Step 4c: proof from real use (README and site)

- State plainly: the ProgramOS code is a close copy of the K-ai infrastructure. Say "tested in production with one program since <date>" exactly as true.
- **One source for every number:** `docs/data/proof.json`, each with value, "as of" date and query ID. `scripts/sync_site_facts.py` fails CI on a mismatch.
- **Queries are private:** read-only, aggregates only, no names, no message text. The public file holds only the query ID and date.
- Candidate figures (none measured): months in production; messages in and out; decisions, action items and open questions recorded; approvals; number of governance gates; tests and capability scenarios passing; review rounds; delivery failures caught by the delivery gate.
- **Vishal approves each number before it is public.** Some of this data also feeds a research paper.
- The site mirrors this content in the canvas-mcp site style. Creating the Pages project, the DNS record and each deploy needs Vishal's yes first.

## Later, separate items

- Approval-by-hash, pilot sender gate, consent text (from the pilot fork): optional mode, labelled "piloted".
- Container hardening fixes from the pilot fork: generic; candidates to go into K-ai itself.
- Step 5 Illinois path, step 6 setup without a coding agent and a trial unit, step 7 public page and news post.

## Model provider options (Vishal, 2026-11-14)

A unit may need a model service that its institution approves for sensitive data. Vishal named three to keep open: an OpenAI education plan, protected models through Azure AI Foundry, and Gemini. He said the OpenAI education plan and Gemini are approved for sensitive data at Illinois.

What the code does today (checked in K-ai at the base commit): the agent inside the container is built on the Claude Agent SDK. The host points it at a model endpoint through a credential proxy and one base-URL setting.

- **A Claude model behind a different endpoint** (for example through Azure AI Foundry, if the institution offers Claude there) is likely a settings change in the proxy. Unverified; check in step 5.
- **An OpenAI or Gemini model** means a different agent runner inside the container. That is new code, and "tested in production" would not cover the agent layer for that provider. The host (mail, queue, delivery gate, audit, approvals, scheduler) does not depend on the provider.

Plan: keep the provider boundary narrow and documented (the container agent runner plus the credential proxy), state which provider is tested in production, and treat each other provider as a separate, labelled adapter. Do not start an adapter until a unit needs it and the policy answer is known.

## Questions still open


2. **Engine sizes.** Full coordinator only, or also the intake-only pattern as a smaller mode?
3. **Inbound mail.** K-ai receives mail through a paid provider's webhook; the pilot used a Cloudflare Email Worker. Ship one, both, or wait for the Illinois mailbox path?
4. **Sync cadence.** Every K-ai release, monthly, or on demand?
5. **Doc 11** (committed 2026-08-02 by another agent) names one institution and one program throughout. Generalize it in step 4, or move it out?
6. **Production start date** for "tested in production since <date>".
7. **Which proof numbers may be public**, given the research-paper overlap? I bring measured candidates; Vishal approves each.
8. **Illinois Azure setup skills: point or copy?** Their source repo did not resolve for Vishal's GitHub account on 2026-11-14. They hold one lab's internal details, so they cannot be copied as they are. They do not cover the VM this bot needs. Recommendation: write a new generic `docs/` page for an Azure VM tier and link the skills only for a unit that already has access.

## Risks for the Azure path (step 5, not decided here)

- The host starts a Docker container for each turn. That needs a Docker host (an Azure VM or similar), not an App Service web app.
  - **Checked against the four Illinois Azure skills (2026-11-14):** they cover only App Service, Web App for Containers and Azure Container Apps. None mentions a VM or running Docker inside the workload (0 hits; the same search hit "App Service" in all four). The governance skill steers every app onto one shared plan. A VM is a new resource class that the lab's admins would need to approve.
- Model calls use a subscription token today. A unit needs an API key or a university-approved AI service. Policy comes first: may unit email reach that service?
- A university mailbox likely needs a new inbound adapter, which is new code.

## Review Focus

- New program content that arrives inside an existing K-ai file (a fixture, a prompt, a comment) with private words the deny-list does not know yet. Each sync needs a read of what changed, not only a scan.
- A real address or name inside a binary, a JSON fixture or a base64 blob, where a text scan cannot see it.
- Reused fork files that compile on K-ai but assert the fork's locked behaviour in tests.
- A replacement rule that changes a string a test or regex depends on, so a test still passes but checks nothing.
- Gate numbers in code comments that point at a registry the public cannot read.
- K-ai's remote state was not fetched; the base commit must be confirmed before step 3.

## Decision 13 (Vishal, 2026-11-14): the code is the source of truth

The older numbered docs restated behaviour, and several no longer matched the code. An adopter's coding agent can read the code. So a doc stays only if it says what the code cannot: the contract, the reasons for the rules, the decisions an adopter must make, and what the host needs.

- Removed: docs 01 to 06 and 08, `examples/`, `scripts/init.sh`. `SPEC.md`, `AGENTS.md`, `templates/program-repo/` and the new `docs/deployment.md` cover what was still true in them.
- Moved to `docs/design/` with a first-line status note: learning loop (was 07), content sources (was 10), multi-program mesh (was 11).
- Kept: doc 09 with a "not yet updated" note, for the university cloud step; doc 12 (governance).
- Rejected: rewriting each old doc to match the code (two descriptions of one behaviour drift apart again).
- Revisit if: adopters' agents ask the same question about the code more than once; then add a short page for that question only.
