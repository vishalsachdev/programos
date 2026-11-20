#!/usr/bin/env python3
"""Export a neutral copy of the source deployment into this repo.

Usage:
  export.py <source-repo> <commit> <private-inputs-dir> [--apply]

Without --apply it builds the export in a temp folder and prints how it
differs from this repo. With --apply it also copies the result over the
exported paths here. It never commits and never pushes.

The private inputs folder stays OUTSIDE this repo. It holds:
  delete.txt        paths to remove from the snapshot, one per line
  renames.tsv       old<TAB>new, applied after the deletes
  rules.tsv         ordered replacement rules for scrub.py
  postfix.py        optional file-scoped corrections (run with the tree path)
  hand-edits.patch  optional; edits no rule can express (git apply)
  deny.txt          terms that must not appear in the result
  deny-allow.txt    optional; exact strings accepted as harmless (for
                    example a common word that contains a denied term)

Steps: snapshot (git archive, no history) -> deletes -> renames -> drop
paths this repo owns -> refuse symlinks -> rules -> postfix -> hand-edits
patch -> deny scan -> compare. Run the typecheck, the tests and a secret
scan afterwards.

Safety rules: list entries must stay inside the temp tree; a symlink left in
the snapshot stops the run; --apply touches only files git tracks here, needs
a clean working tree, and never writes an owned path or through a symlink;
the deny scan reads file names and all file bytes and stops --apply on a hit.
"""
import filecmp, os, shutil, stat, subprocess, sys, tempfile, unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))

# Paths this repo owns. An export never writes or deletes them.
OWNED = [
    'README.md', 'AGENTS.md', 'CLAUDE.md', 'SPEC.md', 'ARCHITECTURE.md',
    'UPSTREAM.md', 'NOTICE', 'LICENSE', '.gitignore', '.git',
    'docs/09-illinois-quickstart.md', 'docs/12-governance.md',
    'docs/deployment.md', 'docs/data-handling.md', 'docs/model-providers.md',
    'docs/dependency-audit.md', '.gitleaksignore',
    'docs/service-ownership.md',
    'docs/illinois', 'docs/start-here.md', 'docs/setup-reference.md',
    'docs/design', 'config', 'templates', 'plans',
    'site', 'scripts/upstream-sync', '.github/workflows/ci.yml', 'inbound',
    '.github/ISSUE_TEMPLATE', '.github/PULL_REQUEST_TEMPLATE.md',
    'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md',
    'node_modules', 'dist',
]


def owned(rel):
    # casefold: on a case-insensitive disk 'readme.md' is the owned README.md
    r = rel.casefold()
    return any(r == o.casefold() or r.startswith(o.casefold() + '/') for o in OWNED)


def scan_text(rel, data):
    """All the ways a term could be present: the name, the bytes read as
    UTF-8 (so accented names match) and as latin-1 (so no byte is skipped)."""
    parts = [rel, data.decode('utf-8', errors='ignore'), data.decode('latin-1')]
    return '\n'.join(unicodedata.normalize('NFC', p).casefold() for p in parts)


def deny_scan(tmp, rels, terms, allow):
    """Return {rel: number of terms found}."""
    terms = [unicodedata.normalize('NFC', t).casefold() for t in terms]
    allow = [unicodedata.normalize('NFC', a).casefold() for a in allow]
    found = {}
    for rel in sorted(rels):
        text = scan_text(rel, open(os.path.join(tmp, rel), 'rb').read())
        for a in allow:
            text = text.replace(a, '')
        n = sum(1 for t in terms if t in text)
        if n:
            found[rel] = n
    return found


def plan_apply(repo, added, changed, removed, tracked):
    """Check the whole plan before any change. Return a list of problems."""
    problems = []
    tracked_cf = {t.casefold() for t in tracked}
    for f in added + changed + removed:
        if owned(f):
            problems.append(f'owned path: {f}')
            continue
        parts = f.split('/')
        if os.path.isabs(f) or '..' in parts or not f:
            problems.append(f'unsafe path: {f}')
            continue
        cur = repo
        for part in parts[:-1]:
            cur = os.path.join(cur, part)
            if os.path.islink(cur):
                problems.append(f'a parent folder is a symlink: {f}')
                break
            if os.path.lexists(cur) and not os.path.isdir(cur):
                problems.append(f'a parent is not a folder: {f}')
                break
        else:
            t = os.path.join(repo, f)
            if os.path.islink(t):
                problems.append(f'destination is a symlink: {f}')
            elif os.path.isdir(t):
                problems.append(f'a folder is in the way: {f}')
            elif os.path.lexists(t) and f.casefold() not in tracked_cf:
                problems.append(f'would overwrite a local file git does not track: {f}')
    return problems


def inside(root, rel):
    """Absolute path for a list entry, or exit if it leaves the tree."""
    if not rel or os.path.isabs(rel) or '..' in rel.replace('\\', '/').split('/'):
        sys.exit(f'unsafe path in private inputs: {rel!r}')
    full = os.path.join(root, rel)
    parent = os.path.realpath(os.path.dirname(full))
    rootr = os.path.realpath(root)
    if parent != rootr and not parent.startswith(rootr + os.sep):
        sys.exit(f'path leaves the tree: {rel!r}')
    if os.path.normpath(full) == os.path.normpath(root):
        sys.exit(f'path is the tree root: {rel!r}')
    return full


def remove(path):
    if os.path.islink(path) or os.path.isfile(path):
        os.remove(path)
    elif os.path.isdir(path):
        shutil.rmtree(path)


def files(root):
    out = set()
    for d, dirs, fs in os.walk(root, followlinks=False):
        dirs[:] = [x for x in dirs if x not in ('.git', 'node_modules', 'dist')]
        for name in list(dirs):
            if os.path.islink(os.path.join(d, name)):
                out.add(os.path.relpath(os.path.join(d, name), root))
        for f in fs:
            out.add(os.path.relpath(os.path.join(d, f), root))
    return out


def same(a, b):
    if os.path.islink(a) or os.path.islink(b):
        return False
    xa = os.stat(a).st_mode & stat.S_IXUSR
    xb = os.stat(b).st_mode & stat.S_IXUSR
    return xa == xb and filecmp.cmp(a, b, shallow=False)


def git(*args):
    return subprocess.run(['git', '-C', REPO, *args], capture_output=True, text=True, check=True).stdout


def main():
    if len(sys.argv) < 4:
        sys.exit(__doc__)
    src, commit, inputs = sys.argv[1:4]
    apply = '--apply' in sys.argv
    need = lambda n: os.path.join(inputs, n)
    inp, repo = os.path.realpath(inputs), os.path.realpath(REPO)
    if inp == repo or inp.startswith(repo + os.sep):
        sys.exit('the private inputs folder must be outside this repo')
    for n in ('delete.txt', 'rules.tsv', 'deny.txt'):
        if not os.path.exists(need(n)):
            sys.exit(f'missing private input: {n}')

    tracked = [f for f in git('ls-files', '-z').split('\0') if f and not owned(f)]
    if apply:
        dirty = [l for l in git('status', '--porcelain').splitlines() if l.strip()]
        if dirty:
            sys.exit('working tree is not clean; commit or stash first, then run --apply')

    tmp = tempfile.mkdtemp(prefix='upstream-export-')
    arch = subprocess.Popen(['git', '-C', src, 'archive', commit], stdout=subprocess.PIPE)
    subprocess.run(['tar', '-x', '-C', tmp], stdin=arch.stdout, check=True)
    if arch.wait() != 0:
        sys.exit('git archive failed')

    for line in open(need('delete.txt'), encoding='utf8'):
        p = line.strip()
        if not p or p.startswith('#'):
            continue
        remove(inside(tmp, p))

    if os.path.exists(need('renames.tsv')):
        for line in open(need('renames.tsv'), encoding='utf8'):
            if '\t' not in line:
                continue
            old, new = line.rstrip('\n').split('\t')[:2]
            o, n = inside(tmp, old), inside(tmp, new)
            if os.path.lexists(o):
                os.makedirs(os.path.dirname(n), exist_ok=True)
                n = inside(tmp, new)
                if os.path.lexists(n):
                    sys.exit(f'rename target exists: {new}')
                os.rename(o, n)

    for rel in sorted(files(tmp)):
        if owned(rel):
            remove(os.path.join(tmp, rel))
    links = [rel for rel in sorted(files(tmp)) if os.path.islink(os.path.join(tmp, rel))]
    if links:
        sys.exit('symlinks in the snapshot; add them to delete.txt or handle by hand: ' + ', '.join(links[:10]))

    subprocess.run([sys.executable, os.path.join(HERE, 'scrub.py'), tmp, need('rules.tsv')], check=True)
    if os.path.exists(need('postfix.py')):
        subprocess.run([sys.executable, need('postfix.py'), tmp], check=True)

    if os.path.exists(need('hand-edits.patch')) and os.path.getsize(need('hand-edits.patch')):
        r = subprocess.run(['git', 'apply', '--whitespace=nowarn', os.path.realpath(need('hand-edits.patch'))], cwd=tmp)
        if r.returncode != 0:
            sys.exit(f'hand-edits.patch did not apply; resolve by hand in {tmp}')

    new = files(tmp)
    bad = sorted(f for f in new if owned(f) or os.path.islink(os.path.join(tmp, f)))
    if bad:
        sys.exit('the result holds owned paths or symlinks (from postfix or the patch): ' + ', '.join(bad[:10]))

    terms = [t.strip() for t in open(need('deny.txt'), encoding='utf8') if t.strip()]
    if not terms:
        sys.exit('deny.txt is empty; the scan would pass on anything')
    allow = []
    if os.path.exists(need('deny-allow.txt')):
        allow = [t.strip() for t in open(need('deny-allow.txt'), encoding='utf8') if t.strip()]
    found = deny_scan(tmp, new, terms, allow)
    for rel, n in found.items():
        print(f'DENY: {rel} ({n} terms)')
    hits = len(found)
    print(f'deny scan: {hits} files with hits, {len(terms)} terms checked, {len(new)} files read')

    cur = set(tracked)
    added, removed = sorted(new - cur), sorted(cur - new)
    changed = sorted(f for f in new & cur if not os.path.lexists(os.path.join(REPO, f)) or not same(os.path.join(tmp, f), os.path.join(REPO, f)))
    print(f'compared with the tracked files here: {len(added)} new, {len(removed)} gone, {len(changed)} changed')
    for tag, lst in (('new', added), ('gone', removed), ('changed', changed)):
        for f in lst[:40]:
            print(f'  {tag}: {f}')

    if not apply:
        print(f'not applied. The export is in {tmp}')
        return
    if hits:
        sys.exit('deny scan found private terms; nothing was applied')
    problems = plan_apply(REPO, added, changed, removed, tracked)
    if problems:
        sys.exit('nothing was applied:\n  ' + '\n  '.join(problems[:40]))
    for f in removed:
        t = os.path.join(REPO, f)
        if os.path.lexists(t):
            os.remove(t)
    for f in added + changed:
        t = os.path.join(REPO, f)
        os.makedirs(os.path.dirname(t), exist_ok=True)
        if os.path.lexists(t):
            os.remove(t)
        shutil.copy2(os.path.join(tmp, f), t)
    print('applied. Next: update UPSTREAM.md, run typecheck, tests and a secret scan, review the diff, commit.')


if __name__ == '__main__':
    main()
