# CLAUDE.md — ProgramOS maintainer notes

Notes for Claude (and future maintainers) working on this repo. Adopter-facing docs live in `README.md`, `SPEC.md`, and `docs/`.

## Scope of this repo

ProgramOS is a **clonable implementation** (since 2026-11-14; before that it was a spec only). Adopters clone this repo and their coding agent follows `AGENTS.md`. The code in `src/`, `container/`, `groups/`, `setup/` and `scripts/` is an export from the reference deployment; `UPSTREAM.md` records the version. Do not hand-edit exported code here without recording it: fix it at the source and re-export, or run `python3 scripts/upstream-sync/repo_patch.py` after the edit and commit the consolidated patch it rewrites (`scripts/upstream-sync/repo-changes-2026-11-20.patch`; never edited by hand, no other per-PR patch files). CI runs the same script with `--check`. The authoritative list of files this repo owns is `OWNED` in `scripts/upstream-sync/export.py`, including `scripts/upstream-sync/` itself; exports never overwrite those paths. `inbound/` (the mail intake worker) is owned: it was written here, has its own `package.json`, and is edited here.

Keep edits funder-agnostic and institution-agnostic. Illinois-specific setup guidance lives in `docs/09-illinois-quickstart.md`. The optional palette for the Illinois public site lives in `site/themes/illinois.css`.

## Editing conventions

- **The code is the source of truth** (Vishal, 2026-11-14). A doc here covers only what the code cannot say: contract, reasons, decisions, host needs. Do not add a doc that restates code.
- `docs/design/` holds ideas that are not implemented; each file says so in its first lines.
- Every doc is listed in the README docs table.
- The live per-channel prompts are in `groups/`.

## Site

`site/public/` is served at https://programos.illinihunt.org (Cloudflare Pages project `programos`). Deploy that site with `SITE_THEME=illinois ./site/deploy.sh`. Every fact on the page repeats `README.md` or `SPEC.md`. Change the page in the same commit.

## Current Focus

- [ ] Finalize `docs/12-governance.md` (sort the numbered rules; remove the "draft" status)

## Roadmap

- [x] Code export from the reference deployment, reviewed until clean
- [x] `AGENTS.md`, README, SPEC and ARCHITECTURE rewritten; code is the source of truth
- [x] CI: format, typecheck, tests, export tool tests, secret scan
- [x] Public site at programos.illinihunt.org
- [ ] Finalize `docs/12-governance.md`
- [ ] Rewrite `docs/09-illinois-quickstart.md` (campus mail and cloud path)
- [x] A neutral inbound mail intake service: `inbound/` (Cloudflare Email Worker; owned by this repo, not exported)
- [ ] Run `inbound/` against a live Cloudflare domain and mailbox (never done; `inbound/README.md`, "Not verified"). The host test for `inbound/` is exported code and is held in the consolidated patch
- [ ] Proof numbers on the site, each from a dated query, in one data file
- [ ] Foundry backup provider: live checks with a real key (`docs/model-providers.md`, section 6), then decide the provider order
- [ ] Take fixes from the source through `scripts/upstream-sync/` (wrong-chat Telegram reply, timing test, others in SPEC section 11)

## Session Log

### 2026-11-20
- Completed: merged PRs 25, 23, 19, 27, 28, 30, 29, 26, 31 into `main` (squash, in that order). Follow-up PR 38: one consolidated patch `scripts/upstream-sync/repo-changes-2026-11-20.patch` replaces the per-PR patches (PR 37's folded in too); `scripts/upstream-sync/repo_patch.py` regenerates it and CI runs it with `--check`; `docs/model-providers.md` is the neutral provider page, with a pointer under `docs/illinois/`. The `PROGRAM_ORIGIN_PATTERN` examples hold no backslash and no `%` (checked with `systemd-analyze verify` on systemd 255: `\.` drops the line, `\s` becomes a space); `src/documented-origin-patterns.test.ts` reads each example from the files and gives it to `isExpectedOrigin`. With PR 37 merged: 1,954 tests pass, plus 33 in `inbound/` and 22 for the export tool; AGENTS rule 3 states 1,954.
- Next: the HTTPS example pattern accepts a token of letters, digits and `_ . ~ : -` only; a token with another character needs its own class. PR 39 made the two timing tests deterministic; its per-PR patch is folded into the consolidated patch.

### 2026-11-19
- Completed (draft PR, not merged): model provider setting with Claude on Microsoft Foundry as a backup or primary (`MODEL_PROVIDERS`, `src/model-provider.ts`), a path prefix in `ANTHROPIC_BASE_URL` is now joined, `SENSOR_PROVIDER` for the reply sensor. The edits to exported code are recorded in `scripts/upstream-sync/repo-changes-2026-11-20.patch` (first in `model-provider-foundry-2026-11-19.patch`, since folded in). Tested against fake servers only.
- Next: the live checks in `docs/model-providers.md` section 6; the Azure host page that issue 10 asks for is not written.

### 2026-11-16
- Completed: pulled PR #5 (Illinois colors as an opt-in site theme, `e3a0113`); rebased the two local Codex fixwave commits on top and pushed them (`55ab09e`, `8950030`; CI green). Deployed the site with `SITE_THEME=illinois`; live `/theme.css` matches `site/themes/illinois.css`. Checked light and dark mode by headless Chrome screenshot at 1280px: navy and orange in both. Deleted the merged `site-illinois-colors` branch; `main` is the only remote branch.
- Next: finalize `docs/12-governance.md`; decide which proof numbers may be public; check the site at 375px and its lower sections with the Illinois theme (not checked); the timing test `src/channels/webhook-ingest-context.test.ts` can fail on a slow CI runner, and a rerun clears it. Older entries: `plans/session-archive.md`.
