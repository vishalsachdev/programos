#!/usr/bin/env python3
"""Regenerate or check the consolidated patch of this repo's changes to
exported code.

Usage:
  repo_patch.py           write the patch from the working tree
  repo_patch.py --check   exit 1 unless the patch reproduces the working tree

The patch is the difference, on exported paths only (everything not in OWNED
in export.py), between the export baseline and the working tree. The baseline
is the commit BASELINE with the patches in BEFORE applied in order.

"Working tree" means the files git tracks plus new files that are not
ignored. Contents and the executable bit are compared.

After a new export, commit the raw export alone, set BASELINE to that commit,
and see README.md in this folder.
"""
import os, subprocess, sys, tempfile

import export

HERE = export.HERE
REPO = export.REPO

BASELINE = '999346c'
BEFORE = ['prompt-audit-2026-11-15.patch']
PATCH = 'repo-changes-2026-11-20.patch'

# Fixed settings, so the output does not depend on the user's git config.
GIT = ['git', '-c', 'core.autocrlf=false', '-c', 'core.fileMode=true',
       '-c', 'core.quotePath=true', '-c', 'diff.renames=false',
       '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false',
       '-c', 'user.name=repo-patch', '-c', 'user.email=repo-patch@example.org',
       '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null']


def git(cwd, *args, stdin=None, check=True):
    r = subprocess.run(GIT + list(args), cwd=cwd, input=stdin,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and r.returncode != 0:
        sys.exit('git %s failed in %s:\n%s' % (
            ' '.join(args), cwd, r.stderr.decode(errors='replace')))
    return r


def drop_owned(tmp):
    """Remove every owned path from the index and the files of repo `tmp`."""
    names = git(tmp, 'ls-files', '-z').stdout.split(b'\0')
    gone = [n for n in names if n and export.owned(n.decode())]
    if gone:
        git(tmp, 'rm', '-q', '--cached', '--pathspec-from-file=-',
            '--pathspec-file-nul', stdin=b'\0'.join(gone))
        for n in gone:
            os.remove(os.path.join(tmp.encode(), n))


def build_baseline(tmp):
    """Make `tmp` a git repo whose one commit is the baseline's exported paths."""
    if git(REPO, 'cat-file', '-e', BASELINE + '^{commit}', check=False).returncode:
        sys.exit('The baseline commit %s is not in this clone. Fetch the full '
                 'history (git fetch --unshallow) and run again.' % BASELINE)
    tar = git(REPO, 'archive', '--format=tar', BASELINE).stdout
    subprocess.run(['tar', '-x', '-C', tmp], input=tar, check=True)
    git(tmp, 'init', '-q')
    git(tmp, 'add', '-A', '-f')
    for name in BEFORE:
        git(tmp, 'apply', '--index', os.path.join(HERE, name))
    drop_owned(tmp)
    git(tmp, 'commit', '-q', '--allow-empty', '-m', 'baseline')


def working_tree_tree(tmp):
    """Replace the index of `tmp` by the working tree's exported paths (the
    files of `tmp` are not touched). Return the tree id."""
    names = git(REPO, 'ls-files', '-z', '-c', '-o', '--exclude-standard').stdout
    git(tmp, 'read-tree', '--empty')
    lines = []
    for raw in sorted(set(n for n in names.split(b'\0') if n)):
        rel = raw.decode()
        full = os.path.join(REPO, rel)
        if export.owned(rel) or not os.path.lexists(full):
            continue  # owned, or deleted in the working tree
        if os.path.islink(full):
            sys.exit('Symlink in an exported path: %s' % rel)
        blob = git(tmp, 'hash-object', '-w', '--no-filters', full).stdout.decode().strip()
        mode = '100755' if os.access(full, os.X_OK) else '100644'
        lines.append(('%s %s\t' % (mode, blob)).encode() + raw)
    git(tmp, 'update-index', '-z', '--index-info', stdin=b'\0'.join(lines) + b'\0')
    return git(tmp, 'write-tree').stdout.decode().strip()


def main(argv):
    if argv not in ([], ['--check']):
        sys.exit(__doc__)
    patch_path = os.path.join(HERE, PATCH)
    cmd = 'python3 scripts/upstream-sync/repo_patch.py'
    with tempfile.TemporaryDirectory() as tmp:
        build_baseline(tmp)
        if argv == ['--check']:
            r = git(tmp, 'apply', '--index', patch_path, check=False)
            if r.returncode != 0:
                print('FAIL: %s does not apply to the baseline:\n%s\nRun: %s'
                      % (PATCH, r.stderr.decode(errors='replace'), cmd))
                return 1
            patched = git(tmp, 'write-tree').stdout.decode().strip()
            want = working_tree_tree(tmp)
            if patched != want:
                diff = git(tmp, 'diff', '--name-status', patched, want).stdout.decode()
                print('FAIL: baseline + %s differs from the exported paths of '
                      'the working tree in:\n%sRun: %s' % (PATCH, diff, cmd))
                return 1
            print('OK: baseline %s + %s + %s reproduces the exported paths.'
                  % (BASELINE, ' + '.join(BEFORE), PATCH))
            return 0
        want = working_tree_tree(tmp)
        out = git(tmp, 'diff', '--binary', '--full-index', 'HEAD', want).stdout
        with open(patch_path, 'wb') as f:
            f.write(out)
        n = out.count(b'\ndiff --git ') + out.startswith(b'diff --git ')
        print('Wrote %s (%d files).' % (os.path.relpath(patch_path, REPO), n))
        return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
