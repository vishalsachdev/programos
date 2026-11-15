# CLAUDE.md — ProgramOS maintainer notes

Notes for Claude (and future maintainers) working on this repo. Adopter-facing docs live in `README.md`, `SPEC.md`, and `docs/`.

## Scope of this repo

ProgramOS is a **clonable implementation** (since 2026-11-14; before that it was a spec only). Adopters clone this repo and their coding agent follows `AGENTS.md`. The code in `src/`, `container/`, `groups/`, `setup/` and `scripts/` is an export from the reference deployment; `UPSTREAM.md` records the version. Do not hand-edit exported code here: fix it at the source and re-export, or record the edit so the next export repeats it. Files owned by this repo: `AGENTS.md`, `README.md`, `SPEC.md`, `ARCHITECTURE.md`, `config/`, `templates/`, `docs/12-governance.md`, `plans/`.

Keep edits funder-agnostic and institution-agnostic. Anything Illinois-specific lives in `docs/09-illinois-quickstart.md`.

## Editing conventions

- **The code is the source of truth** (Vishal, 2026-11-14). A doc here covers only what the code cannot say: contract, reasons, decisions, host needs. Do not add a doc that restates code.
- `docs/design/` holds ideas that are not implemented; each file says so in its first lines.
- Every doc is listed in the README docs table.
- The live per-channel prompts are in `groups/`.

## Session Log

### 2026-06-02
- Completed: Re-synced the spec against the current `nanoclaw-msbai` reference impl (verified against actual channel code, not just commits). docs/03: email "reject silently" → verified two-tier policy (silent drop for unknown/external; courteous deduped reply for same-institution senders; audit-log either way); Telegram "use IDs" → IDs-vs-handles tradeoff documenting the `@handle`-in-allowlist approach; added fail-safe-on-allowlist-reload rule. docs/05: log blocked/dropped inbound (`mode: dropped`); rebase-on-push-reject for concurrent writers. SPEC.md §3 wording. (Public site `agentlab.illinihunt.org/programos` was also updated + its Cloudflare deploy fixed — see AgentLab repo.)
- Next: Deliberately left out of core spec (MSBAi-specific): per-course `courses/<code>/sync/` mirror layout, "detect Box update → ping admin" nicety. Generalize into `docs/design/content-sources.md` (was docs/10) only if a second adopter needs them.
