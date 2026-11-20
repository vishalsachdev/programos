"""Tests for the safety rules of export.py. Run: python3 -m unittest discover scripts/upstream-sync"""
import os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import export  # noqa: E402


class InsideTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.root, 'a'))

    def test_plain_path_is_accepted(self):
        self.assertEqual(export.inside(self.root, 'a/b.txt'), os.path.join(self.root, 'a/b.txt'))

    def test_unsafe_entries_stop_the_run(self):
        for bad in ('../x', 'a/../../x', '/etc/hosts', '', 'a/..'):
            with self.assertRaises(SystemExit, msg=bad):
                export.inside(self.root, bad)

    def test_symlinked_parent_that_leaves_the_tree_is_refused(self):
        outside = tempfile.mkdtemp()
        os.symlink(outside, os.path.join(self.root, 'link'))
        with self.assertRaises(SystemExit):
            export.inside(self.root, 'link/x.txt')


class OwnedTest(unittest.TestCase):
    def test_owned_paths(self):
        for p in ('README.md', 'templates/program-repo/CLAUDE.md', 'docs/design/x.md', 'scripts/upstream-sync/export.py',
                  'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md',
                  '.github/ISSUE_TEMPLATE/config.yml', '.github/PULL_REQUEST_TEMPLATE.md',
                  'docs/data-handling.md', 'docs/illinois/data-handling.md', 'docs/illinois/hosting.md',
                  'docs/illinois/model-foundry.md', 'docs/model-providers.md', 'docs/dependency-audit.md', '.gitleaksignore',
                  'docs/service-ownership.md', 'docs/illinois/service-ownership.md',
                  'docs/general/README.md', 'docs/cloud-vm.md', 'docs/costs.md',
                  'docs/illinois/README.md', 'docs/illinois/email-quickstart.md',
                  'docs/teams-alerts.md', 'docs/illinois/teams-alerts.md',
                  'inbound/src/index.ts', 'inbound/package.json'):
            self.assertTrue(export.owned(p), p)

    def test_exported_paths(self):
        for p in ('src/index.ts', 'docs/reminder-registry.md', 'scripts/deploy.sh', 'README.md.bak',
                  'docs/data-handling.md.bak', 'docs/illinois-notes.md', 'inbound.md',
                  'docs/dependency-audit.md.bak', '.gitleaksignore.bak', 'docs/service-ownership.md.bak',
                  'docs/09-illinois-quickstart.md', 'docs/costs.md.bak', 'docs/general-notes.md',
                  'docs/teams-alerts.md.bak'):
            self.assertFalse(export.owned(p), p)


class OwnedCaseTest(unittest.TestCase):
    def test_case_alias_of_an_owned_path_is_owned(self):
        for p in ('readme.md', 'Agents.MD', 'TEMPLATES/x.md', 'Docs/Design/y.md'):
            self.assertTrue(export.owned(p), p)


class DenyScanTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()

    def put(self, rel, data):
        p = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'wb') as fh:
            fh.write(data)

    def scan(self, terms, allow=()):
        return export.deny_scan(self.root, export.files(self.root), list(terms), list(allow))

    def test_finds_term_in_content_name_binary_and_lockfile(self):
        self.put('a.txt', b'hello Secretname')
        self.put('dir/secretname.md', b'nothing')
        self.put('bin.dat', b'\xff\xfe secretname \x00')
        self.put('package-lock.json', b'{"x": "SECRETNAME"}')
        self.put('clean.txt', b'nothing here')
        self.assertEqual(set(self.scan(['secretname'])), {'a.txt', 'dir/secretname.md', 'bin.dat', 'package-lock.json'})

    def test_finds_accented_name_in_utf8_and_in_mixed_bytes(self):
        self.put('u.txt', 'Hola José'.encode('utf-8'))
        self.put('mixed.txt', b'\xff\xfe ' + 'JOSÉ'.encode('utf-8'))
        self.put('nfd.txt', 'Jose\u0301'.encode('utf-8'))
        self.assertEqual(set(self.scan(['José'])), {'u.txt', 'mixed.txt', 'nfd.txt'})

    def test_allow_list_removes_only_the_listed_string(self):
        self.put('a.txt', b'dev walkers')
        self.put('b.txt', b'Ms Alker wrote')
        self.assertEqual(set(self.scan(['alker'], ['walkers'])), {'b.txt'})


class PlanApplyTest(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.repo, 'src'))
        os.makedirs(os.path.join(self.repo, 'config'))
        open(os.path.join(self.repo, 'src', 'a.ts'), 'w').close()

    def plan(self, added=(), changed=(), removed=(), tracked=('src/a.ts',)):
        return export.plan_apply(self.repo, list(added), list(changed), list(removed), list(tracked))

    def test_normal_plan_has_no_problems(self):
        self.assertEqual(self.plan(added=['src/new.ts', 'newdir/x.ts'], changed=['src/a.ts']), [])

    def test_owned_path_and_its_case_alias_are_refused(self):
        self.assertEqual(len(self.plan(added=['README.md', 'readme.md', 'config/x'])), 3)

    def test_parent_symlink_is_refused_even_when_it_points_inside_the_repo(self):
        os.makedirs(os.path.join(self.repo, 'data'))
        os.symlink(os.path.join(self.repo, 'config'), os.path.join(self.repo, 'data', 'alias'))
        got = self.plan(added=['data/alias/instance.env.example'])
        self.assertEqual(len(got), 1)
        self.assertIn('symlink', got[0])

    def test_parent_symlink_to_outside_is_refused_and_nothing_is_created(self):
        outside = tempfile.mkdtemp()
        os.symlink(outside, os.path.join(self.repo, 'out'))
        self.assertEqual(len(self.plan(added=['out/sub/x.ts'])), 1)
        self.assertEqual(os.listdir(outside), [])

    def test_untracked_local_file_is_not_overwritten(self):
        open(os.path.join(self.repo, '.env'), 'w').close()
        got = self.plan(added=['.env'])
        self.assertEqual(len(got), 1)
        self.assertIn('does not track', got[0])

    def test_destination_symlink_and_folder_in_the_way_are_refused(self):
        os.symlink(os.path.join(self.repo, 'src', 'a.ts'), os.path.join(self.repo, 'src', 'l.ts'))
        os.makedirs(os.path.join(self.repo, 'src', 'd'))
        self.assertEqual(len(self.plan(changed=['src/l.ts', 'src/d'], tracked=['src/a.ts', 'src/l.ts', 'src/d'])), 2)

    def test_unsafe_relative_path_is_refused(self):
        self.assertEqual(len(self.plan(added=['../x', 'src/../../y'])), 2)


class FilesAndSameTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()

    def write(self, rel, text='x', mode=0o644):
        p = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, 'w').write(text)
        os.chmod(p, mode)
        return p

    def test_files_lists_symlinks_and_does_not_follow_them(self):
        outside = tempfile.mkdtemp()
        open(os.path.join(outside, 'secret.txt'), 'w').write('s')
        self.write('a/one.txt')
        os.symlink(outside, os.path.join(self.root, 'dirlink'))
        os.symlink(os.path.join(outside, 'secret.txt'), os.path.join(self.root, 'filelink'))
        got = export.files(self.root)
        self.assertEqual(got, {'a/one.txt', 'dirlink', 'filelink'})

    def test_same_sees_executable_bit_and_content(self):
        a, b = self.write('a.sh'), self.write('b.sh')
        self.assertTrue(export.same(a, b))
        os.chmod(b, 0o755)
        self.assertFalse(export.same(a, b))
        c = self.write('c.sh', 'y')
        self.assertFalse(export.same(a, c))

    def test_same_never_trusts_a_symlink(self):
        a = self.write('a.txt')
        os.symlink(a, os.path.join(self.root, 'l.txt'))
        self.assertFalse(export.same(a, os.path.join(self.root, 'l.txt')))

    def test_remove_unlinks_a_symlink_without_touching_its_target(self):
        outside = tempfile.mkdtemp()
        target = os.path.join(outside, 'keep.txt')
        open(target, 'w').write('k')
        link = os.path.join(self.root, 'dirlink')
        os.symlink(outside, link)
        export.remove(link)
        self.assertFalse(os.path.lexists(link))
        self.assertTrue(os.path.exists(target))


class ScrubTest(unittest.TestCase):
    def test_scrub_replaces_text_and_skips_symlinks(self):
        tree, outside = tempfile.mkdtemp(), tempfile.mkdtemp()
        open(os.path.join(tree, 'a.txt'), 'w').write('hello Oldname')
        target = os.path.join(outside, 't.txt')
        open(target, 'w').write('Oldname')
        os.symlink(target, os.path.join(tree, 'link.txt'))
        rules = os.path.join(outside, 'rules.tsv')
        open(rules, 'w').write('Oldname\tNewname\t\n')
        subprocess.run([sys.executable, os.path.join(HERE, 'scrub.py'), tree, rules], check=True, capture_output=True)
        self.assertEqual(open(os.path.join(tree, 'a.txt')).read(), 'hello Newname')
        self.assertEqual(open(target).read(), 'Oldname')


class InputsGuardTest(unittest.TestCase):
    def test_inputs_inside_the_repo_are_refused(self):
        for inputs in (export.REPO, os.path.join(export.REPO, 'scripts')):
            r = subprocess.run([sys.executable, os.path.join(HERE, 'export.py'), export.REPO, 'HEAD', inputs], capture_output=True, text=True)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn('outside this repo', r.stderr + r.stdout)


if __name__ == '__main__':
    unittest.main()
