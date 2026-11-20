## What changed and why


## Issue

<!-- "Closes #N" or "Part of #N". Write "none" if there is no issue. -->

## Exported code

<!-- Exported code is everything not listed in OWNED in scripts/upstream-sync/export.py
     (src/, container/, groups/, setup/, most of scripts/, package.json and others). -->

- [ ] This PR changes no exported code
- [ ] This PR changes exported code, and I ran `python3 scripts/upstream-sync/repo_patch.py` and committed the regenerated `scripts/upstream-sync/repo-changes-2026-11-20.patch` (CI checks it)

## Checks

- [ ] `npm run format:check`
- [ ] `npx tsc --noEmit`
- [ ] `npx vitest run` (state the count of passing tests; none skipped, deleted or weakened)
- [ ] `python3 -B -m unittest discover scripts/upstream-sync`
- [ ] `python3 scripts/upstream-sync/repo_patch.py --check`

## Docs

- [ ] Docs that state the changed behaviour are updated, and no doc restates code
- [ ] A new doc is listed in the README docs table
- [ ] A new or changed setup option, setting, channel or safety limit is in `AGENTS.md` part 5 and in `docs/setup-reference.md`, in plain words
- [ ] A fact that is also on the public page (`site/public/index.html`) is changed there in this PR
- [ ] Not needed for this change

## Privacy

- [ ] No real names, addresses, mail content or secrets in the diff, the tests, the fixtures or this description
