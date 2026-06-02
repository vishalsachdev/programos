# CLAUDE.md — ProgramOS maintainer notes

Notes for Claude (and future maintainers) working on this repo. Adopter-facing docs live in `README.md`, `SPEC.md`, and `docs/`.

## Scope of this repo

ProgramOS is a **spec, not code.** It describes how to turn a NanoClaw deployment into an academic program coordinator. Adopters fork NanoClaw and apply this spec; they do not fork this repo.

Keep edits funder-agnostic and institution-agnostic. Anything Illinois-specific lives in `docs/09-illinois-quickstart.md`. Anything NSF-specific should NOT land in the core spec — overlay it elsewhere.

## Editing conventions

- Numbered docs (`docs/NN-name.md`) form the canonical reading order. Insert new docs at the next available number; do not renumber.
- README "What's in this repo" table must list every doc in the same order as the numbered files.
- SPEC.md §2 (Components) and §5 (Program repo contract) are load-bearing — every architectural concept the spec depends on must be referenced in one of those two sections.
- Per-channel agent prompts in `examples/groups/` are templates for adopters. Keep them under ~60 lines each; long-form guidance belongs in `docs/`.

## Session Log

### 2026-06-02
- Completed: Re-synced the spec against the current `nanoclaw-msbai` reference impl (verified against actual channel code, not just commits). docs/03: email "reject silently" → verified two-tier policy (silent drop for unknown/external; courteous deduped reply for same-institution senders; audit-log either way); Telegram "use IDs" → IDs-vs-handles tradeoff documenting the `@handle`-in-allowlist approach; added fail-safe-on-allowlist-reload rule. docs/05: log blocked/dropped inbound (`mode: dropped`); rebase-on-push-reject for concurrent writers. SPEC.md §3 wording. (Public site `agentlab.illinihunt.org/programos` was also updated + its Cloudflare deploy fixed — see AgentLab repo.)
- Next: Deliberately left out of core spec (MSBAi-specific): per-course `courses/<code>/sync/` mirror layout, "detect Box update → ping admin" nicety. Generalize into docs/10 only if a second adopter needs them.
