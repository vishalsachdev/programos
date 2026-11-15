#!/usr/bin/env python3
"""Neutralize a K-ai snapshot. Rules are ordered regexes from a private TSV
(pattern<TAB>replacement<TAB>flags). Usage: scrub.py <tree> <rules.tsv> [--report]"""
import os, re, sys
tree, rules_path = sys.argv[1], sys.argv[2]
rules = []
for ln in open(rules_path, encoding='utf8'):
    ln = ln.rstrip('\n')
    if not ln or ln.startswith('#'): continue
    parts = ln.split('\t')
    pat, rep = parts[0], parts[1] if len(parts) > 1 else ''
    fl = parts[2] if len(parts) > 2 else ''
    rules.append((re.compile(pat, re.I if 'i' in fl else 0), rep, 'c' in fl))
def case_like(src, rep):
    if src.isupper() and len(src) > 1: return rep.upper()
    if src[:1].isupper(): return rep[:1].upper() + rep[1:]
    return rep
SKIP_DIRS = {'node_modules', '.git', 'dist'}
changed = 0; hits = {}
for root, dirs, files in os.walk(tree, followlinks=False):
    dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
    for f in files:
        p = os.path.join(root, f)
        if f == 'package-lock.json': continue
        if os.path.islink(p): continue
        try: t = open(p, encoding='utf8').read()
        except (UnicodeDecodeError, OSError): continue
        o = t
        for rx, rep, keepcase in rules:
            if keepcase:
                t, n = rx.subn(lambda m: case_like(m.group(0), rep), t)
            else:
                t, n = rx.subn(rep, t)
            if n: hits[rx.pattern] = hits.get(rx.pattern, 0) + n
        if t != o:
            open(p, 'w', encoding='utf8').write(t); changed += 1
print('files changed:', changed)
if '--report' in sys.argv:
    for k, v in sorted(hits.items(), key=lambda x: -x[1]): print(v, k)
