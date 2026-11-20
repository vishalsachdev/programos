## What changed and why


## Issue

<!-- "Closes #N" or "Part of #N". Write "none" if there is no issue. -->

## Exported code

<!-- Exported code is everything not listed in OWNED in scripts/upstream-sync/export.py
     (src/, container/, groups/, setup/, most of scripts/, package.json and others). -->

- [ ] This PR changes no exported code
- [ ] This PR changes exported code, and the same change is recorded as a `*.patch` file under `scripts/upstream-sync/` that applies to a clean checkout of `main` (`git apply --check`)

## Checks

- [ ] `npm run format:check`
- [ ] `npx tsc --noEmit`
- [ ] `npx vitest run` (state the count of passing tests; none skipped, deleted or weakened)
- [ ] `python3 -B -m unittest discover scripts/upstream-sync`

## Docs

- [ ] Docs that state the changed behaviour are updated, and no doc restates code
- [ ] A new doc is listed in the README docs table
- [ ] A fact that is also on the public page (`site/public/index.html`) is changed there in this PR
- [ ] Not needed for this change

## Privacy

- [ ] No real names, addresses, mail content or secrets in the diff, the tests, the fixtures or this description
