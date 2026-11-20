"""Every setting key in config/instance.env.example is named in the setup docs.

AGENTS.md is what an adopter's coding agent reads. A key that is added to the
settings example and not named in AGENTS.md or docs/setup-reference.md is a
setup option the agent cannot explain. Add the key to one of those two files
(AGENTS.md part 5 when it is a choice the person makes), or, for a key that is
deliberately not documented there, to UNDOCUMENTED with the reason.
"""
import os
import re
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
EXAMPLE = os.path.join(REPO, 'config', 'instance.env.example')
DOCS = ['AGENTS.md', os.path.join('docs', 'setup-reference.md')]

# Keys in the settings example that the setup docs leave out on purpose.
# Keep this short. Each entry needs a reason.
UNDOCUMENTED = {
    # 'EXAMPLE_KEY': 'why the setup docs do not name it',
}

# A setting line: optional "# ", then KEY=, at the start of the line.
KEY_LINE = re.compile(r'^(?:#\s?)?([A-Z][A-Z0-9_]*)=')


def example_keys(text):
    keys = set()
    for line in text.splitlines():
        m = KEY_LINE.match(line)
        if m:
            keys.add(m.group(1))
    return keys


def named_in(text, key):
    """The key as a whole word, so FOO does not match FOO_BAR."""
    return re.search(r'(?<![A-Z0-9_])' + re.escape(key) + r'(?![A-Z0-9_])', text) is not None


def read(rel):
    with open(os.path.join(REPO, rel), encoding='utf-8') as f:
        return f.read()


class SetupDocsCoverSettings(unittest.TestCase):
    def setUp(self):
        with open(EXAMPLE, encoding='utf-8') as f:
            self.keys = example_keys(f.read())
        self.docs = '\n'.join(read(d) for d in DOCS)

    def test_the_example_is_parsed(self):
        # Guards the parser: a change of format must not make the check empty.
        self.assertGreater(len(self.keys), 40)
        for key in ('ASSISTANT_NAME', 'MODEL_PROVIDERS', 'PROGRAM_REPO',
                    'ADMIN_ALERT_ROUTE', 'BEHAVIOUR_SENSOR_DISABLED'):
            self.assertIn(key, self.keys)

    def test_every_key_is_named_in_the_setup_docs(self):
        missing = sorted(
            k for k in self.keys
            if k not in UNDOCUMENTED and not named_in(self.docs, k)
        )
        self.assertEqual(
            missing, [],
            'Setting keys in config/instance.env.example that neither AGENTS.md '
            'nor docs/setup-reference.md names. Add each to AGENTS.md part 5 '
            '(if the person chooses it) and to the table in '
            'docs/setup-reference.md: ' + ', '.join(missing),
        )

    def test_the_allowlist_holds_only_real_keys_that_are_still_undocumented(self):
        for key, reason in UNDOCUMENTED.items():
            self.assertIn(key, self.keys, f'{key} is not in the settings example')
            self.assertTrue(reason.strip(), f'{key} needs a reason')
            self.assertFalse(
                named_in(self.docs, key),
                f'{key} is documented now; remove it from UNDOCUMENTED',
            )

    def test_whole_word_match(self):
        self.assertTrue(named_in('set `SENSOR_MODEL` here', 'SENSOR_MODEL'))
        self.assertFalse(named_in('set `FOUNDRY_SENSOR_MODEL_X`', 'SENSOR_MODEL'))
        self.assertFalse(named_in('WEBHOOK_SECRETS', 'WEBHOOK_SECRET'))

    def test_agents_md_keeps_the_guided_parts(self):
        agents = read('AGENTS.md')
        for heading in ('How to work with this person', 'Three ways to start',
                        'Every choice you will be asked to make',
                        'MVP exit checklist'):
            self.assertIn(heading, agents)


if __name__ == '__main__':
    unittest.main()
