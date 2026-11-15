# Upstream sync

How this repo takes a new version of the code from the source deployment.

The source repo is private, because it holds one program's content. An export makes a neutral copy: a snapshot with no git history, with private paths deleted and names replaced by placeholders. The rules that do this name private things, so they stay in a private folder outside this repo. Only the tool is here.

## Run it

```
python3 scripts/upstream-sync/export.py <source-repo> <commit> <private-inputs-dir>
```

This builds the export in a temp folder and prints how it differs from this repo. Add `--apply` to copy the result over the exported paths. The tool never commits and never pushes. With `--apply` it stops if the private-term scan finds a hit.

Safety rules in the tool (tested in `test_export.py`):

- An entry in the private lists that is absolute, contains `..`, or leaves the temp tree stops the run.
- A symlink left in the snapshot stops the run.
- `--apply` needs a clean working tree. It compares against the files git tracks here, so it does not remove an untracked or ignored file such as `.env` or a database. If the new export holds a path where such a local file already is, the tool stops and you resolve it.
- The whole plan is checked before the first change. A destination whose parent folder is a symlink is refused, also when the link points inside this repo.
- Owned paths are matched without regard to letter case.
- It refuses to write an owned path, also when the patch tries to add one.
- The private-term scan reads each file name and all bytes of each file, the lockfile included. It reads text as UTF-8, so accented names match, and also byte by byte, so no file is skipped.

After `--apply`:

1. Update the version in `UPSTREAM.md`.
2. Run `npx tsc --noEmit` and `npx vitest run`. All tests must pass with none skipped.
3. Run a secret scan (`gitleaks detect --no-git -s .`).
4. Read the diff. New files need the closest look: a new file can carry names that no rule covers yet.
5. Commit as one snapshot commit. Get a second review before a push.

## What the tool does not touch

The `OWNED` list in `export.py` names the paths that belong to this repo (`AGENTS.md`, `SPEC.md`, `templates/`, `docs/12-governance.md` and others). An export never writes or deletes them.

## Limits

- The replacement rules cover names the maintainer knew about. A new name in the source needs a new rule and a new term in the deny list.
- A first name that is also a common word can pass the scan.
- Organizational detail around a placeholder name (a title, a date, a reporting line) is not a name, so no scan finds it. Read new fixtures and comments by eye.
- `hand-edits.patch` holds edits that no rule can express. When the source changes the same lines, the patch stops applying and must be redone by hand. The lasting fix is to make the same change in the source.

Checked on 2026-11-14: a run against the recorded source version reproduced the exported paths of this repo with no difference.
