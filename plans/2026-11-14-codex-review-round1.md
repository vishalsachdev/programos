# Codex gate review, round 1: findings and dispositions

Created: 2026-11-14 | Last Updated: 2026-11-14
Reviewed: commit `b15dbf2` on local branch `clonable-repo`. Verdict from the reviewer: NO-SHIP (13 findings).
Each finding was checked against the code before a disposition was set.

| # | Finding (short) | Checked | Disposition |
|---|---|---|---|
| 1 | `UPSTREAM.md` names the reference deployment and a source commit; `scripts/init.sh` names this repo's URL | True | **Kept.** Naming the reference deployment is intended (the README must say the code is a close copy of it). The commit ID identifies nothing private. `scripts/init.sh` predates this work and points at this public repo. Vishal may ask to drop the commit ID. |
| 2 | Runtime code holds a roster alias table, mailboxes and account IDs | True, but all values are synthetic placeholders | **Downgraded to an adopter task.** Not a privacy leak. These are hard-coded identity sites an adopter must change. Listed for `AGENTS.md`. Reported upstream so the data moves into the program repo. |
| 3 | A log message kept a dated incident reference | True (`src/delivery-gate.ts`) | **Fixed.** |
| 4 | Example mount allowlist grants read-write to broad home folders | True (an upstream example file) | **Fixed.** One placeholder root. |
| 5 | Missing chat sender allowlist defaults to allow-all | True; upstream behaviour, and the reference deployment runs it | **Adopter task.** Not changed, to stay a close copy. `AGENTS.md` must tell adopters to create the allowlist before enabling a chat channel. Reported upstream. |
| 6 | Default assistant name is the upstream default, while the prompts say "Coordinator" | True | **Adopter task.** `ASSISTANT_NAME` becomes a required line in `config/instance.env.example`. |
| 7 | Outreach and routed approvals assume one operator mailbox and one mail domain | True | **Adopter task**, and a real limit: a unit must edit these sites today. Listed for `AGENTS.md`; reported upstream as a candidate setting. |
| 8 | Access-closed reply is tied to one institution domain with no setting | True | **Adopter task**, same as 7. |
| 9 | Prompts and scripts point at missing upstream files; `npm run auth` is dead | True | **Fixed in part.** Dead script removed; 10 stale upstream skills removed. `groups/main/CLAUDE.md` still holds upstream text; kept because the reference deployment runs it, flagged for the `AGENTS.md` step. |
| 10 | A skill installs a credential tool the code does not use | True | **Fixed.** Skill removed. |
| 11 | `scripts/deploy.sh` hard-resets a fixed host path | True | **Kept as a labelled example** (Vishal, 2026-11-14). Header warning added; `AGENTS.md` tells the agent to read and change it and to ask before running. |
| 12 | Snapshot scripts act on fixed hosts and push | True | **Kept as a labelled example**, same as 11. Tests cover these scripts. |
| 13 | Webhook listens on all interfaces by default | True; `WEBHOOK_HOST` is a setting | **Adopter task.** `config/instance.env.example` sets loopback; `AGENTS.md` explains the reverse proxy. Code default not changed. |

Found clean by the reviewer: no binaries or encoded payloads; no live keys or tokens; signature checks and proxy token checks enforced.

After the fixes: typecheck clean, 1,761 of 1,761 tests pass.

Done after round 1: `AGENTS.md`, `config/instance.env.example` and a draft `docs/12-governance.md` now carry findings 2, 5, 6, 7, 8 and 13. Round 2 runs as a fresh review on the personal Codex account (round 1 ran on the Edu account, which was not required: the tree holds no student data).
