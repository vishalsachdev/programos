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
