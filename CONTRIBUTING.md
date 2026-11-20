# Contributing to ProgramOS

Fixes, adapters and doc corrections are welcome. This page says how the repo takes a change. It is short because one rule decides most questions: **the code is the source of truth.**

## Two kinds of files

**Exported code.** `src/`, `container/`, `groups/`, `setup/`, `scripts/` (outside `scripts/upstream-sync/`), `package.json`, `setup.sh` and most other files are an export from the reference deployment. `UPSTREAM.md` records the version. The next export writes these paths again from the source.

**Owned files.** The paths in `OWNED` in [`scripts/upstream-sync/export.py`](./scripts/upstream-sync/export.py) belong to this repo: `README.md`, `AGENTS.md`, `SPEC.md`, `ARCHITECTURE.md`, `docs/12-governance.md`, `docs/deployment.md`, `docs/design/`, `config/`, `templates/`, `site/`, `scripts/upstream-sync/`, `.github/` templates and CI, and this file. An export never writes or deletes them. That list in the code is the exact one.

## The patch-file rule

A change to exported code is lost at the next export unless it is recorded. This repo records all such changes in one file, `scripts/upstream-sync/repo-changes-2026-11-20.patch`. You never edit that file by hand. The rule is one command:

1. Make the change and get the checks green.
2. Run `python3 scripts/upstream-sync/repo_patch.py` and commit the patch file it rewrites, in the same pull request.

The command writes the difference between the last export and your working tree, on exported paths only. It needs the full git history (a shallow clone: `git fetch --unshallow`). Do not add a patch file of your own.

CI runs `python3 scripts/upstream-sync/repo_patch.py --check` and fails when the patch file does not reproduce the exported code in the pull request. When `main` has moved and the patch file conflicts, merge `main`, keep either side of that one file, and run the command again.

After each export the maintainer reapplies the patch files ([`scripts/upstream-sync/README.md`](./scripts/upstream-sync/README.md)). The source repo is private; you do not need access to it, and you must not copy from it.

A change to owned files only needs no patch.

## Checks to run

```
npm ci
npm run format:check
npx tsc --noEmit
npx vitest run
python3 -B -m unittest discover scripts/upstream-sync
python3 scripts/upstream-sync/repo_patch.py --check
```

CI runs the same six, the tests of `inbound/` and a secret scan. The baseline is 1,761 passing tests. One timing test in `src/channels/webhook-ingest-context.test.ts` can fail on a busy machine; run it alone before you treat it as real. Do not skip, delete or weaken a test to get green. Placeholders live in code and tests together, so a renamed placeholder needs both.

## Docs

- A doc covers what the code cannot say: the contract, the reasons, the decisions and what the host needs. Do not add a doc that restates code.
- Where a doc and the code differ, fix the doc, or open a "Template or docs fix" issue.
- List every new doc in the README docs table.
- Facts on the public page (`site/public/index.html`) repeat `README.md` or `SPEC.md`. Change the page in the same commit.
- `docs/design/` holds ideas that are not implemented. Each file says so in its first lines.
- The prompts and code cite numbered rules (G6, G39 and so on). To change a rule, follow the change protocol in `docs/12-governance.md`; do not edit a rule in one prompt only.

## Keep it neutral and private

- No real names, mail addresses, mail content, tokens or keys in code, tests, fixtures, issues or pull requests. Use the placeholders that `AGENTS.md` lists (`Avery Morgan`, `example.edu`, `example.org`).
- Keep text free of any one funder or institution. One institution's recipe goes in its own file, as `docs/09-illinois-quickstart.md` does.

## Pull requests

- Open an issue first for anything larger than a fix, so the approach is agreed before you write it. Use the "Feature or adapter proposal" form.
- Keep a pull request to one topic and a small diff. Fill in the pull request template.
- The maintainer merges. Changes that touch a guarantee in `SPEC.md` section 11 get a second review.

## Security problems

Do not open a public issue. See [`SECURITY.md`](./SECURITY.md).

## Conduct

This project follows the [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

## Licence

Contributions are accepted under the repo's MIT licence ([`LICENSE`](./LICENSE)).
