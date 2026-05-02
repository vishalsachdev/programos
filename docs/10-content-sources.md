# 10 — Content sources beyond the curriculum repo

Most academic units already keep their content somewhere — Box, SharePoint, a network share, a faculty member's Google Drive. ProgramOS lets you mount that content into the agent container as a **read-only extra source** while keeping the curriculum repo as the system of record for everything the bot *does* (decisions, audit log, skills).

This doc covers three patterns for relating an external content store to ProgramOS, the recommended default, and the design components that make the recommended pattern work.

## The three patterns

| Pattern | Where the team edits content | Source of truth for *content* | Source of truth for *bot ops* (decisions, audit, skills) | When to pick |
|---|---|---|---|---|
| **A. Git-only** | Curriculum repo (web UI / PRs) | Git | Git | Greenfield unit with no legacy content store. Cleanest, but most teams won't migrate from where they already work. |
| **B. Coexist + bot-as-frontend** *(recommended default)* | The team's existing store (Box, SharePoint, etc.) | The external store | Git | Most academic units. Zero behavior change for the team — they keep editing where they already work and ask the bot through Telegram/email/web. |
| **C. Mirror** | The team's existing store | Git (synced from the store on a cron) | Git | High-audit units (NSF deliverables, accreditation, IRB review of past document versions). You want a tamper-evident snapshot of *every* doc at every point in time, not just the ones the bot happened to cite. |

## Recommended default: B (coexist + bot-as-frontend)

The bot becomes the asking surface. Users don't need to know whether a fact lives in Box or git — they just ask. Behind the scenes the agent reads from both stores per a precedence rule, labels every claim with its source, and snapshots cited content into the audit log so the historical record stays answerable even if the source file changes later.

This pattern requires four design components. They are non-negotiable for production — skipping any one of them breaks the audit story.

### 1. Two read sources, one write surface

| Read | Write |
|---|---|
| Curriculum repo (`/workspace/extra/<curriculum-repo>`) — git, includes the bot's own captured decisions, audit log, skills | Curriculum repo only |
| Extra content mount (`/workspace/extra/<source-name>`) — read-only mount of the team's external store | — |

The bot never writes to the external store. The team never has to worry the bot will overwrite their docs.

### 2. Precedence rule (encoded in every per-channel prompt)

- **Operational facts** — what was decided, who is the owner, what is current allowlist policy → **curriculum repo wins.** `discussions/DECISIONS.md` outranks any external doc that contradicts it. Reason: decisions are immutable history; external docs may not have caught up.
- **Content facts** — what does the syllabus say, what is the policy text, what's in section 4 of the partnership agreement → **external store wins** (it's the live editing surface).
- **Conflict on the same fact** — surface the disagreement in the reply. *Don't* silently pick one. Example: "`DECISIONS.md` dated 2026-04-12 records that the prereq for BADM 550 was changed to BADM 350; the syllabus in Box still says BADM 320. Which is current?"

### 3. Snapshot-with-cite (the audit fix)

When the bot cites a file from an extra mount, the audit-log entry for that turn MUST embed:

- the cited excerpt verbatim (not just the file path),
- the sha256 of the file at read time,
- the read timestamp.

Why: the file may be edited the next day. Without snapshot-with-cite, "what did the bot tell the dean on Mar 15, and what was it looking at?" is unanswerable. With it, the answer survives any number of edits to the source file.

For curriculum-repo citations, the git commit SHA already pins the file content — no snapshot needed; the audit entry just records the SHA.

### 4. Source labeling in every reply

Every claim must be labeled with its source so users and auditors can trace it. Citation format:

- Curriculum repo: `[curriculum:program/policies/admissions.md]` or for decisions, `[git:discussions/DECISIONS.md#2026-04-12-transfer-credit]`
- Extra mount: `[<source-name>:<path>, read <ISO timestamp>]`, e.g. `[box:syllabi/BADM550-S26.pdf, read 2026-05-02T14:31Z]`

The read timestamp on extra-mount citations is load-bearing — it tells the reader "this is what the file said when the bot read it; it may have changed since."

**Web chat exception.** The web chat channel is a public surface — internal storage details (curriculum-repo paths, Box folder names) should not appear in user-visible replies. On web chat, the source-label requirement applies to the **audit-log entry** (so internal reviewers can still trace every claim) but not to the public reply text. The web chat agent prompt enforces this; see `examples/groups/webchat/CLAUDE.md`. All other channels show source labels in both the reply and the audit log.

### Curated mounts, not whole drives

Whatever you mount is visible to the agent and indexable. Mount **one curated subfolder per bot**, not the whole external store. For Box, this means a single Box folder per unit, owned by a service identity, populated with only the files the bot is allowed to cite. Don't mount someone's full `~/Library/CloudStorage/Box-Box` and hope the prompt keeps the agent in bounds.

## When pattern C is worth the cost

Pick **C (mirror)** instead of B when:

- An external auditor or accreditor will ask "what did the syllabus look like on date X?" for files the bot may not have cited that day.
- Compliance requires that *every* version of every doc is preserved tamper-evidently, not just the ones referenced in audit-log snapshots.
- You need to diff doc versions across time for analysis ("how did our admissions policy change over two years?").

The cost of C: a sync daemon (`rclone` with the Box backend, or a small Box SDK script under cron) commits any changes from the external store into the curriculum repo as a `box-sync@<unit>.bot` identity. You inherit conflict handling, large-binary git bloat, and minutes of sync lag. The bot then reads from git only, never from a live external mount.

If you adopt C, the precedence rule simplifies (everything is in git) but you lose the "edit live in the store and the bot sees it instantly" property. Most units don't need that loss.

## Worked example: Box on Tier 1 (laptop)

The fastest concrete setup, useful for most UIUC units.

### Prerequisites

- Box Drive installed on the laptop. On macOS this mounts under `~/Library/CloudStorage/Box-Box/`.
- A Box folder for this bot, e.g. `Box/<unit>/bot-content/`. Populate it only with files the bot is allowed to cite. Keep the curated set small at first (a dozen policies + the current syllabi).
- ProgramOS deployed at Tier 1 ([`08-deployment-tiers.md`](./08-deployment-tiers.md)).

### Mount it

In your NanoClaw container-runner config, add a read-only bind mount alongside the curriculum repo:

```
-v "/Users/<u>/Library/CloudStorage/Box-Box/<unit>/bot-content:/workspace/extra/box:ro"
-v "/Users/<u>/code/<unit>-curriculum:/workspace/extra/<unit>-curriculum:rw"
```

The agent will see `/workspace/extra/box/` as a read-only directory. Box Drive streams files on demand — first-read of a large file may be slow.

### Tell the agent it exists

Update each `groups/<channel>/CLAUDE.md` (templates in `examples/groups/`) — they already include the precedence and source-labeling rules from §B. Add one line to the Workspace section:

```markdown
- `/workspace/extra/box/` — read-only Box mount. Live team-edited content. Cite as `[box:<path>, read <timestamp>]`.
```

### Tier 2 (VPS) and Tier 3 (Cloud)

Box Drive doesn't run headless. Two options:

- **`rclone mount` with the Box backend.** Set up [rclone](https://rclone.org/box/) with Box OAuth, mount the curated folder at `/srv/box-mount/<unit>` on the VPS, then bind-mount that path into the container the same way as Tier 1.
- **Box SDK sync under cron.** A small Python or Node script using [`box-python-sdk`](https://github.com/box/box-python-sdk) (service-account authenticated) syncs the curated folder to local disk every N minutes. Bind-mount the synced directory.

Either way, the agent prompt and citation rules don't change. Only the mount source changes.

### A note on credentials

Box Drive uses the *user's* credentials (whoever logged into the Box Drive client). For Tier 1 that's the laptop owner. For Tier 2/3 the bot needs a **service account** in Box (or an enterprise app with read scope on the curated folder). Don't reuse a personal Box account on a shared VPS.

## Bot-proposed mount additions

Once the bot is running, stakeholders will ask about content the bot can't see — a SharePoint site that wasn't mounted at launch, a new Box folder a partner started using, a shared drive someone forgot to add. The bot can't add a mount itself: that's a host-side change to the container-runner config, deliberately outside the agent's reach (security model — see [`08-deployment-tiers.md`](./08-deployment-tiers.md)).

What the bot CAN do is **propose** the addition through the same agent-proposes / human-approves mechanism that backs the learning loop ([`07-learning-loop.md`](./07-learning-loop.md)):

- The agent detects the gap ("user asked about the FY27 partnership documents three times this week; I have no source containing them") and, in status-update mode, opens a PR against the curriculum repo's `MOUNTS.md` proposing the new mount: source name, host path, container target path, suggested service identity, and the audit-log entries that motivated the proposal.
- A human reviewer evaluates the proposal — is this the right folder, who owns it, what's the privacy posture — and either merges or rejects.
- On merge, the human (or a deploy script) makes the host-side change: install/configure the sync (Box Drive, rclone, etc.), update the container-runner bind mounts, restart the container.
- The bot picks up the new mount on next invocation and starts citing it per the standard precedence + source-labeling rules.

What stays out of scope:

- The bot does **not** install software, configure OAuth, or modify the container-runner config. Those are host actions a human takes.
- The bot does **not** auto-merge its own mount-addition PRs. Same rule as skills.
- The proposal is a recommendation backed by audit-log evidence; the human still owns the privacy and curation decision (which subfolder, which credentials, what's safe to expose).

In effect: the bot can detect *that* a content gap exists and propose *what* to mount; a human decides *whether* and *how*. Same trust model as everything else in this spec.

## What this is NOT

- It is not a sync layer. The bot doesn't write back to Box. If a decision needs to land in a Box document, a human edits the Box doc.
- It is not a full-text search index. If the bot needs to search across hundreds of Box files quickly, layer an FTS5 index on top of a periodic snapshot of the mount (same pattern as the audit-log search in [`07-learning-loop.md`](./07-learning-loop.md)). The mount itself is for reading specific files the agent has decided to cite.
- It is not a substitute for the curriculum repo. The curriculum repo holds what the team has agreed on, what the bot has captured, and what the audit log records. The external mount holds work-in-progress content. They serve different jobs.
