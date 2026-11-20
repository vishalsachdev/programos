# Upstream record

The code in this repo is a neutral copy of K-ai, the reference deployment. It has been
tested in production with one program since April 2026. K-ai is the source. ProgramOS takes changes from it through a
repeatable export that removes program content each time.

| Export | Date | K-ai commit | Notes |
|---|---|---|---|
| 1 | 2026-11-14 | `894e2075` | First export. 1,761 of 1,761 upstream tests pass after neutralizing. |

What an export does: take a snapshot with no git history; apply the delete list;
apply the replacement rules (private names, addresses, program terms, hosts); apply
the recorded hand edits; run a private-word scan with a planted control and a secret
scanner; run typecheck and the full test suite; commit one snapshot here.

The framework underneath K-ai is NanoClaw (MIT). See `NOTICE`.

Files that belong to ProgramOS and are never overwritten by an export: `README.md`,
`AGENTS.md`, `CLAUDE.md`, `SPEC.md`, `ARCHITECTURE.md`, `UPSTREAM.md`, `NOTICE`,
`LICENSE`, `docs/NN-*.md`, `docs/deployment.md`, `docs/design/`, `config/`, `templates/`, `site/`, `plans/`, `scripts/upstream-sync/`,
`.github/workflows/ci.yml`, `.github/ISSUE_TEMPLATE/`, `.github/PULL_REQUEST_TEMPLATE.md`, `CONTRIBUTING.md`, `SECURITY.md`,
`CODE_OF_CONDUCT.md`. The exact list is `OWNED` in
`scripts/upstream-sync/export.py`; the procedure is in `scripts/upstream-sync/README.md`.
