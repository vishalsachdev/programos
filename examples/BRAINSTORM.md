# {{UNIT_SLUG}} — ProgramOS brainstorm

> Hand this file to your coding agent (Claude Code, Cursor, Codex, etc.) along with read access to https://github.com/vishalsachdev/programos. The agent will interview you, fill in the program repo, and produce per-channel prompts.

## What you (the agent) should do

You are setting up a ProgramOS deployment for the `{{UNIT_SLUG}}` program. Your job has three phases. **Do not skip phase 1.** Treat the user's first answer as a starting point, not a finished spec.

### Phase 1 — Interview (do this before writing anything)

Ask the user the following, in order. Stop and wait for an answer between groups. Do not proceed until the answer is concrete enough to act on.

#### Group A — What is this program?

1. One sentence: what is `{{UNIT_SLUG}}`? (degree program / certificate / grant project / research initiative / faculty committee / other)
2. Who funds it? (internal budget / external grant — name the funder / mixed)
3. If grant-funded: what's the funder's reporting cadence and what artifacts do you owe them?
4. What's the lifecycle? (one-time project with end date / ongoing program / pilot)

#### Group B — Who talks to this bot?

5. Name each stakeholder type (faculty, advisors, program staff, external partners, vendors, students, etc.). For each: roughly how many people, what's their authority level (read-only / can request action / can approve action), and which channel(s) do they actually use today?
6. Who is the **named human** who will review skill PRs and audit-log anomalies? (No bot goes live without this.)

#### Group C — What channels and where will it run?

7. Where will the bot run **on day one**? Pick the lowest tier that works:
   - **Laptop (Tier 1)** — Docker on a personal machine, no public URL, no IT involvement. Channels limited to Telegram + email-via-IMAP-polling. Fastest start. (See ProgramOS `docs/08-deployment-tiers.md`.)
   - **VPS (Tier 2)** — small rented server with a public domain, supports webhook channels.
   - **Cloud (Tier 3)** — Azure Container Apps / AWS ECS / etc., institutionally provisioned.
8. Which channels are required at launch? (web chat, email, Telegram, Teams, Slack, other.) Cross-check against the chosen tier — web chat needs a public URL, Teams (Bot Framework) needs an M365 app registration.
9. For each channel: what authentication is realistic? (HMAC webhook secret / JWT / bot token / shared API key / IMAP credentials / institutional SSO)
10. For email specifically: who controls the inbound mailbox, and is webhook access realistic at this institution? If not, default to IMAP polling against a shared/forwarded mailbox. If the unit is at UIUC, see ProgramOS `docs/09-illinois-quickstart.md` for the @illinois.edu forwarding-rule recipe.

#### Group D — What does the program repo actually contain?

11. What is the program's **source of truth** today? (a SharePoint site, a Notion workspace, a private GitHub repo, a faculty member's laptop, nothing yet, **a Box folder** — common at UIUC)
12. Can it be migrated to a private git repo, and who owns it? If migration is unrealistic, see Q15 below — we have a pattern for that.
13. What documents are load-bearing? (program content, policies, FAQ, decision log, partner agreements, grant deliverables, accreditation docs)
14. What's the privacy posture — does it contain PII, FERPA-protected data, grant-confidential strategy, or just public-facing content?
15. **Content-source pattern.** Pick one (see ProgramOS `docs/10-content-sources.md`):
    - **A. Git-only** — migrate everything into the program repo; team edits in git going forward. Greenfield only.
    - **B. Coexist + bot-as-frontend** *(default)* — team keeps editing in Box / SharePoint / etc.; the bot reads from there *and* from git, and answers across both. Requires a curated subfolder, the precedence rule (operational facts → git, content facts → external store), snapshot-with-cite in the audit log, and source labeling on every reply.
    - **C. Mirror** — team keeps editing in Box; a sync daemon mirrors the curated folder into git on a cron. Use this when an auditor will ask "what did doc X say last March?" for files the bot may not have cited.
16. If you picked B or C: name the **single curated subfolder** to mount, and the **service identity** that owns it (not a personal account on Tier 2/3). For B on Tier 1 (laptop), the user's Box Drive credentials are fine.

#### Group E — What's the decision/audit story?

17. Today, when a decision gets made (e.g., "we're changing the prereq for course X"), where does it land? (email thread / meeting minutes / nowhere)
18. Who needs to be able to audit "what did the bot do, and why?" later — internal compliance, an accreditor, a funder, an IRB?
19. What's the consequence of the bot getting something wrong publicly? (low / reputational / legal / financial / compliance)

#### Group F — What does "the bot learns" mean here?

20. Are you OK with the agent **proposing** new skills via pull request that a human merges? (default: yes)
21. Is anyone explicitly asking for autonomous self-improvement? If yes, **flag it** — that goes in a research overlay, not the production system. (See ProgramOS `docs/07-learning-loop.md`.)

### Phase 2 — Fill in the repo

Once Phase 1 answers are in, do all of the following:

**This phase fills in the program repo only.** The NanoClaw fork (which contains channel handlers and `groups/<channel>/CLAUDE.md` system prompts) is a separate repo and gets adapted in a later step by a different agent invocation — see "Handoff" below.

In the program repo:

- Replace placeholders in `program/CONCEPT.md` with the actual program structure from Group D. Cite source docs.
- Populate `program/EMAIL_ALLOWLIST.md` from Group B answers. Mark decision authority truthfully.
- Create one file per significant policy in `program/policies/`.
- Create one file per significant content area (course / module / deliverable) in `program/courses/` (rename the directory if "courses" doesn't fit — e.g., `deliverables/` for a grant project, `working-groups/` for a committee).
- Seed `skills/` with 1–3 skills extracted from concrete recurring questions the user mentioned in Group B. Use the file format in ProgramOS `docs/07-learning-loop.md`.
- If Group D-Q15 chose pattern B or C (external content store mounted into the bot), add a `MOUNTS.md` at the repo root naming the curated subfolder, the host path, the mount target inside the container, and the service identity that owns it.
- Update the top-level `README.md` to describe this specific program (not the generic scaffold).

**Do NOT** create `groups/<channel>/CLAUDE.md` files in the program repo. Those live in the NanoClaw fork and are written in the handoff step below using `examples/groups/<channel>/CLAUDE.md` from the ProgramOS spec as the template.

### Phase 3 — Write the handoff file, verify, and report

Write `PROGRAMOS_SETUP.md` at the program repo root. This file is the **structured handoff** to the next agent (the one that adapts the NanoClaw fork). It MUST contain:

```markdown
# ProgramOS setup — {{UNIT_SLUG}}

## Identity
- Unit slug: <slug>
- Agent persona name: <name>
- JID prefix: <prefix>
- Program repo path on host: <absolute path>
- Mount target in container: /workspace/extra/<repo-name>

## Deployment tier (Group C, Q7)
- Tier: <1 / 2 / 3>
- Reason: <one sentence>

## Channels at launch (Group C, Q8)
- Telegram: <yes/no> — bot token in env, allowed user IDs: <list>
- Email: <none / IMAP / webhook> — provider: <name>
- Web chat: <yes/no>
- Teams: <none / Outgoing Webhook / Bot Framework>
- Other: <list>

## Content-source pattern (Group D, Q15–16)
- Pattern: <A git-only / B coexist+frontend / C mirror>
- Curated external mount (if B or C): <host path → container path>, owned by <identity>

## Stakeholders + decision authority (Group B)
- See program/EMAIL_ALLOWLIST.md for canonical list.
- Reviewer for skill PRs: <named human>

## Open questions / TODOs from brainstorm
- <list>
```

Then:

- Run `git status` and `git diff` in the program repo. Show the user what you're about to commit.
- Commit in coherent chunks (one commit per phase-2 step, not one giant commit). Commit `PROGRAMOS_SETUP.md` last with message `chore(setup): record brainstorm output for ProgramOS handoff`.
- Tell the user the next 3 concrete steps to go live:
  1. Make this repo private and add the bot's git identity as a collaborator.
  2. Fork NanoClaw (`gh repo fork qwibitai/nanoclaw --clone`), then in a fresh agent session say: "Read the ProgramOS SPEC.md, the docs/08-deployment-tiers.md, and the PROGRAMOS_SETUP.md at `<program-repo>/PROGRAMOS_SETUP.md`. Adapt this NanoClaw fork to that spec at the tier and channels named in PROGRAMOS_SETUP.md. Copy `groups/<channel>/CLAUDE.md` templates from the ProgramOS repo and customize per channel."
  3. Configure the channel tokens / webhooks per the chosen tier (see `docs/01-prerequisites.md`).

## Constraints (do not violate)

- **No autonomous self-modification.** You are filling in a fresh repo on behalf of a human; you are not writing skills the running bot will execute without review.
- **No PII in commits without confirmation.** If the user gives you names/emails for the allowlist, confirm before committing.
- **Don't invent program structure.** If Group D answers are vague, write `<TODO: source>` and ask the user — don't make up courses.
- **Channel choice is the user's, not yours.** If they say "just web and email", don't scaffold Telegram folders.
- **Stay scoped.** ProgramOS is a coordinator, not a content generator. Don't propose features outside the spec.

## When you are done

Print a short report:

```
Scaffolded: <list of paths>
Open questions: <list>
Next steps:
  1. <go-live step 1>
  2. <go-live step 2>
  3. <go-live step 3>
```
