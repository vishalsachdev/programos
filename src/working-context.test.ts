import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RegisteredGroup } from './types.js';
import {
  buildWorkingContextSection,
  ensureWorkingContextStore,
  filterRecentEntries,
  getWorkingContextDir,
  isValidUserKey,
  loadWorkingContext,
  loadWorkingContextAsync,
  prepareWorkingContext,
  resolveAdminUserKey,
  pruneStaleEntries,
  resolveWorkingContextUser,
  WorkingContextEntry,
} from './working-context.js';
import { handoffExample, parseHandoff } from './handoff.js';

// The canonical example as it renders at this suite's fixed NOW.
const EXAMPLE = handoffExample(
  new Date('2026-07-17T12:00:00.000Z'),
  'America/Chicago',
);

const NOW = new Date('2026-07-17T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * DAY_MS).toISOString();
}

function makeGroup(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'program-telegram',
    folder: 'program-telegram',
    trigger: '@Coordinator',
    added_at: '2026-01-01T00:00:00.000Z',
    isMain: true,
    ...overrides,
  } as RegisteredGroup;
}

let baseDir: string;

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-test-'));
});

afterEach(() => {
  fs.rmSync(baseDir, { recursive: true, force: true });
  delete process.env.WORKING_CONTEXT_ADMIN_KEY;
  delete process.env.WORKING_CONTEXT_WINDOW_DAYS;
});

function writeStore(userKey: string, entries: unknown): void {
  const dir = getWorkingContextDir(baseDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${userKey}.json`),
    JSON.stringify(entries, null, 2),
  );
}

describe('resolveWorkingContextUser (privacy gate)', () => {
  it('returns the admin key for the main group', () => {
    expect(resolveWorkingContextUser(makeGroup())).toBe('avery');
  });

  it('honors WORKING_CONTEXT_ADMIN_KEY override', () => {
    process.env.WORKING_CONTEXT_ADMIN_KEY = 'admin-2';
    expect(resolveWorkingContextUser(makeGroup())).toBe('admin-2');
  });

  it('falls back to default on an invalid override', () => {
    process.env.WORKING_CONTEXT_ADMIN_KEY = '../escape';
    expect(resolveWorkingContextUser(makeGroup())).toBe('avery');
  });

  it('returns null for every non-main group (students blocked)', () => {
    expect(resolveWorkingContextUser(makeGroup({ isMain: false }))).toBeNull();
    expect(
      resolveWorkingContextUser(makeGroup({ isMain: undefined })),
    ).toBeNull();
  });
});

describe('isValidUserKey', () => {
  it('accepts simple keys and rejects traversal/specials', () => {
    expect(isValidUserKey('avery')).toBe(true);
    expect(isValidUserKey('user_42-a')).toBe(true);
    expect(isValidUserKey('../etc')).toBe(false);
    expect(isValidUserKey('a/b')).toBe(false);
    expect(isValidUserKey('')).toBe(false);
  });
});

describe('write → read roundtrip', () => {
  it('reads back entries the agent wrote to the store file', () => {
    const entries: WorkingContextEntry[] = [
      {
        ts: daysAgo(1),
        type: 'position',
        text: 'Leaning toward option B for Applied Topics',
        refs: ['program/curriculum.md'],
      },
      { ts: daysAgo(2), type: 'style', text: '"ping" means "still working?"' },
    ];
    writeStore('avery', entries);
    const loaded = loadWorkingContext('avery', baseDir);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].text).toContain('option B');
    expect(loaded[1].type).toBe('style');
  });

  it('tolerates a missing file', () => {
    expect(loadWorkingContext('avery', baseDir)).toEqual([]);
  });

  it('tolerates corrupt JSON and non-array shapes', () => {
    const dir = getWorkingContextDir(baseDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'avery.json'), '{not json');
    expect(loadWorkingContext('avery', baseDir)).toEqual([]);
    fs.writeFileSync(path.join(dir, 'avery.json'), '{"a": 1}');
    expect(loadWorkingContext('avery', baseDir)).toEqual([]);
  });

  it('drops invalid entries but keeps valid ones', () => {
    writeStore('avery', [
      { ts: daysAgo(1), type: 'thread', text: 'valid' },
      { ts: 'not-a-date', type: 'thread', text: 'bad ts' },
      { ts: daysAgo(1), type: 'fact', text: 'bad type' },
      { ts: daysAgo(1), type: 'thread', text: '' },
      'not an object',
    ]);
    const loaded = loadWorkingContext('avery', baseDir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].text).toBe('valid');
  });

  it('rejects path-traversal user keys', () => {
    expect(() => loadWorkingContext('../evil', baseDir)).toThrow(/Invalid/);
  });
});

describe('decay filtering', () => {
  it('excludes entries older than the window and sorts newest first', () => {
    const entries: WorkingContextEntry[] = [
      { ts: daysAgo(20), type: 'position', text: 'stale lean' },
      { ts: daysAgo(3), type: 'thread', text: 'mid thread' },
      { ts: daysAgo(1), type: 'reasoning', text: 'fresh reasoning' },
    ];
    const recent = filterRecentEntries(entries, NOW, 14 * DAY_MS);
    expect(recent.map((e) => e.text)).toEqual([
      'fresh reasoning',
      'mid thread',
    ]);
  });

  it('keeps future-dated entries (clock skew) rather than dropping them', () => {
    const recent = filterRecentEntries(
      [{ ts: daysAgo(-1), type: 'thread', text: 'future' }],
      NOW,
      14 * DAY_MS,
    );
    expect(recent).toHaveLength(1);
  });

  it('honors WORKING_CONTEXT_WINDOW_DAYS in the rendered section', () => {
    process.env.WORKING_CONTEXT_WINDOW_DAYS = '7';
    writeStore('avery', [
      { ts: daysAgo(10), type: 'thread', text: 'ten days old' },
      { ts: daysAgo(2), type: 'thread', text: 'two days old' },
    ]);
    const section = buildWorkingContextSection('avery', baseDir, NOW);
    expect(section).toContain('two days old');
    expect(section).not.toContain('ten days old');
    expect(section).toContain('window_days="7"');
  });
});

describe('pruneStaleEntries', () => {
  it('moves out-of-window entries to the archive file', () => {
    writeStore('avery', [
      { ts: daysAgo(30), type: 'position', text: 'ancient' },
      { ts: daysAgo(1), type: 'thread', text: 'fresh' },
    ]);
    pruneStaleEntries('avery', baseDir, NOW, 14 * DAY_MS);

    const kept = loadWorkingContext('avery', baseDir);
    expect(kept.map((e) => e.text)).toEqual(['fresh']);

    const archive = JSON.parse(
      fs.readFileSync(
        path.join(getWorkingContextDir(baseDir), 'avery.archive.json'),
        'utf-8',
      ),
    );
    expect(archive.map((e: WorkingContextEntry) => e.text)).toEqual([
      'ancient',
    ]);
  });

  it('appends to an existing archive', () => {
    writeStore('avery', [{ ts: daysAgo(40), type: 'thread', text: 'older' }]);
    pruneStaleEntries('avery', baseDir, NOW, 14 * DAY_MS);
    writeStore('avery', [{ ts: daysAgo(30), type: 'thread', text: 'old' }]);
    pruneStaleEntries('avery', baseDir, NOW, 14 * DAY_MS);

    const archive = JSON.parse(
      fs.readFileSync(
        path.join(getWorkingContextDir(baseDir), 'avery.archive.json'),
        'utf-8',
      ),
    );
    expect(archive.map((e: WorkingContextEntry) => e.text)).toEqual([
      'older',
      'old',
    ]);
  });

  it('is a no-op when everything is in-window', () => {
    writeStore('avery', [{ ts: daysAgo(1), type: 'thread', text: 'fresh' }]);
    pruneStaleEntries('avery', baseDir, NOW, 14 * DAY_MS);
    expect(
      fs.existsSync(
        path.join(getWorkingContextDir(baseDir), 'avery.archive.json'),
      ),
    ).toBe(false);
    expect(loadWorkingContext('avery', baseDir)).toHaveLength(1);
  });
});

describe('buildWorkingContextSection (tentative labeling)', () => {
  it('labels the block tentative, dates entries, and states KB precedence', () => {
    writeStore('avery', [
      {
        ts: '2026-07-15T09:00:00.000Z',
        type: 'position',
        text: 'Leaning toward option B for the practicum',
      },
    ]);
    const section = buildWorkingContextSection('avery', baseDir, NOW);
    expect(section).toContain('tentative="true"');
    expect(section).toContain('TENTATIVE');
    expect(section).toContain('may be stale');
    expect(section).toContain('the KB always wins');
    expect(section).toContain('[2026-07-15] (position)');
    expect(section).toContain('Leaning toward option B');
  });

  it('includes maintenance instructions and the container file path', () => {
    const section = buildWorkingContextSection('avery', baseDir, NOW);
    expect(section).toContain('/workspace/working-context/avery.json');
    expect(section).toContain('NEVER record KB facts');
    expect(section).toContain('graduate it to DECISIONS.md');
    expect(section).toContain('(no active working notes)');
  });

  it('renders refs alongside entries', () => {
    writeStore('avery', [
      {
        ts: daysAgo(1),
        type: 'thread',
        text: 'Following up on STEM designation',
        refs: ['discussions/DECISIONS.md'],
      },
    ]);
    const section = buildWorkingContextSection('avery', baseDir, NOW);
    expect(section).toContain('(refs: discussions/DECISIONS.md)');
  });

  it('caps the number of injected entries', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      ts: daysAgo(1),
      type: 'thread' as const,
      text: `entry number ${i}`,
    }));
    writeStore('avery', many);
    const section = buildWorkingContextSection('avery', baseDir, NOW);
    const count = (section.match(/^- \[/gm) || []).length;
    expect(count).toBeLessThanOrEqual(40);
  });
});

describe('prepareWorkingContext (session-start read path)', () => {
  it('returns null for non-main groups and creates nothing', () => {
    expect(
      prepareWorkingContext(makeGroup({ isMain: false }), baseDir, NOW),
    ).toBeNull();
    expect(fs.existsSync(getWorkingContextDir(baseDir))).toBe(false);
  });

  it('creates the store, prunes stale entries, and returns the section', () => {
    writeStore('avery', [
      { ts: daysAgo(30), type: 'position', text: 'stale position' },
      { ts: daysAgo(2), type: 'thread', text: 'live thread' },
    ]);
    const result = prepareWorkingContext(makeGroup(), baseDir, NOW);
    expect(result).not.toBeNull();
    expect(result!.userKey).toBe('avery');
    expect(result!.section).toContain('live thread');
    expect(result!.section).not.toContain('stale position');
    // Prune actually rewrote the store
    expect(loadWorkingContext('avery', baseDir)).toHaveLength(1);
  });

  it('bootstraps an empty store file for the mount', () => {
    const result = prepareWorkingContext(makeGroup(), baseDir, NOW);
    expect(result).not.toBeNull();
    const file = path.join(getWorkingContextDir(baseDir), 'avery.json');
    expect(fs.readFileSync(file, 'utf-8').trim()).toBe('[]');
  });
});

describe('ensureWorkingContextStore', () => {
  it('is idempotent and never clobbers existing entries', () => {
    writeStore('avery', [{ ts: daysAgo(1), type: 'thread', text: 'keep me' }]);
    ensureWorkingContextStore('avery', baseDir);
    expect(loadWorkingContext('avery', baseDir)).toHaveLength(1);
  });
});

describe('handoff entries survive loading', () => {
  // Before this fix VALID_TYPES omitted 'handoff', so every persisted handoff
  // was silently dropped on read and the digest register could never report
  // one — the feature was inert three layers deep.
  // Shaped exactly as Coordinator writes them in the live store: NO `text` field,
  // structured fields instead. A test that invents `text` passes while real
  // data is still dropped — that is how this bug survived review.
  const HANDOFF = {
    ts: '2026-07-25',
    type: 'handoff',
    to: 'pfoster1@example.edu',
    artifact: 'docs/kb-audit.md',
    expected: 'itemized corrections',
    ping_after: '2026-08-01',
    resolved: false,
    gotcha: 'bulk doc return breaks DECISIONS.md chronology',
  };

  it('loadWorkingContext keeps handoff entries', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-handoff-'));
    try {
      fs.mkdirSync(path.join(dir, 'working-context'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'working-context', 'avery.json'),
        JSON.stringify([
          HANDOFF,
          { ts: '2026-07-25', type: 'thread', text: 't' },
        ]),
      );
      const loaded = loadWorkingContext('avery', dir);
      expect(loaded.map((e) => e.type).sort()).toEqual(['handoff', 'thread']);
      // Extra structured fields survive the isEntry filter untouched.
      const h = loaded.find((e) => e.type === 'handoff') as unknown as Record<
        string,
        unknown
      >;
      expect(h.to).toBe('pfoster1@example.edu');
      expect(h.gotcha).toContain('chronology');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loadWorkingContextAsync matches the sync loader', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-handoff-async-'));
    try {
      fs.mkdirSync(path.join(dir, 'working-context'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'working-context', 'avery.json'),
        JSON.stringify([HANDOFF]),
      );
      const loaded = await loadWorkingContextAsync('avery', dir);
      expect(loaded).toHaveLength(1);
      expect(loaded[0].type).toBe('handoff');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loadWorkingContextAsync returns [] for a missing file and a bad key', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-handoff-miss-'));
    try {
      expect(await loadWorkingContextAsync('avery', dir)).toEqual([]);
      // Invalid key must NOT throw — it would abort the whole exceptions report.
      expect(await loadWorkingContextAsync('bad/key', dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handoffs are excluded from the injected prompt section', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-handoff-inject-'));
    try {
      fs.mkdirSync(path.join(dir, 'working-context'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'working-context', 'avery.json'),
        JSON.stringify([
          { ...HANDOFF, ts: new Date().toISOString().slice(0, 10) },
          {
            ts: new Date().toISOString().slice(0, 10),
            type: 'thread',
            text: 'visible thread note',
          },
        ]),
      );
      const section = buildWorkingContextSection('avery', dir);
      expect(section).toContain('visible thread note');
      expect(section).not.toContain('pfoster1@example.edu');
      expect(section).not.toContain('(handoff)');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveAdminUserKey', () => {
  const KEY = 'WORKING_CONTEXT_ADMIN_KEY';
  const original = process.env[KEY];
  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  it('defaults to avery when unset', () => {
    delete process.env[KEY];
    expect(resolveAdminUserKey()).toBe('avery');
  });

  it('honours a valid configured key', () => {
    process.env[KEY] = 'someadmin';
    expect(resolveAdminUserKey()).toBe('someadmin');
  });

  it('falls back rather than throwing on an invalid key', () => {
    process.env[KEY] = 'bad/key';
    expect(resolveAdminUserKey()).toBe('avery');
  });
});

describe('loader → digest integration (the gap #24 and its review both missed)', () => {
  it('a realistically-shaped handoff survives loading AND reaches the register', async () => {
    // Byte-shape taken from the live store: no `text`, structured fields only.
    // Unit tests on either side of this seam both passed while the real path
    // reported nothing — only the seam itself catches that.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-seam-'));
    try {
      fs.mkdirSync(path.join(dir, 'working-context'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'working-context', 'avery.json'),
        JSON.stringify([
          {
            ts: '2026-07-25',
            type: 'handoff',
            to: 'pfoster1@example.edu',
            artifact: 'docs/kb-audit.md',
            expected: 'itemized corrections',
            ping_after: '2026-08-01',
            resolved: false,
            gotcha: 'bulk doc return breaks DECISIONS.md chronology',
            refs: [],
          },
        ]),
      );
      const entries = await loadWorkingContextAsync('avery', dir);
      expect(entries).toHaveLength(1);

      const { collectPendingHandoffs } = await import('./exceptions-report.js');
      const r = collectPendingHandoffs(
        entries,
        'America/Chicago',
        new Date('2026-07-28T17:00:00Z'),
      );
      // ping_after is future, but the gotcha makes it pending.
      expect(r.pending).toHaveLength(1);
      expect(r.pending[0].to).toBe('pfoster1@example.edu');
      expect(r.pastPingAfter).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('handoff decay exemption (codex round 2 P1)', () => {
  const OLD_UNRESOLVED = {
    ts: daysAgo(40),
    type: 'handoff',
    to: 'pfoster1@example.edu',
    artifact: 'docs/kb-audit.md',
    expected: 'corrections',
    ping_after: '2026-06-20',
    resolved: false,
  };

  it('keeps an unresolved handoff far past the decay window', () => {
    // ts is when it was SENT; it stays actionable until a reply arrives. Plain
    // ts-decay would archive exactly the long-overdue items the register exists
    // to surface — the worst possible thing to silently delete.
    writeStore('avery', [
      OLD_UNRESOLVED,
      { ts: daysAgo(40), type: 'thread', text: 'ancient note' },
    ]);
    pruneStaleEntries('avery', baseDir, NOW, 14 * DAY_MS);

    const kept = loadWorkingContext('avery', baseDir);
    expect(kept).toHaveLength(1);
    expect(kept[0].type).toBe('handoff');
  });

  it('lets a RESOLVED handoff decay normally — it is history', () => {
    writeStore('avery', [{ ...OLD_UNRESOLVED, resolved: true }]);
    pruneStaleEntries('avery', baseDir, NOW, 14 * DAY_MS);
    expect(loadWorkingContext('avery', baseDir)).toHaveLength(0);
  });

  it('still archives the stale notes it should', () => {
    writeStore('avery', [
      OLD_UNRESOLVED,
      { ts: daysAgo(40), type: 'position', text: 'stale lean' },
    ]);
    pruneStaleEntries('avery', baseDir, NOW, 14 * DAY_MS);
    const archive = JSON.parse(
      fs.readFileSync(
        path.join(getWorkingContextDir(baseDir), 'avery.archive.json'),
        'utf-8',
      ),
    );
    expect(archive).toHaveLength(1);
    expect(archive[0].text).toBe('stale lean');
  });
});

describe('maintenance instructions stay copy-pasteable (codex round 2 P2)', () => {
  it('every JSON example in the injected section parses', () => {
    // A malformed example is not cosmetic: the agent copies it, JSON.parse
    // then fails on the whole file, and ALL working context disappears.
    const section = buildWorkingContextSection('avery', baseDir, NOW);
    const objects = section.match(/\{"[^\n]*\}/g) ?? [];
    expect(objects.length).toBeGreaterThan(0);
    for (const o of objects) {
      expect(() => JSON.parse(o) as unknown).not.toThrow();
    }
  });

  it('the handoff example is embedded verbatim from the canonical constant and loads', () => {
    // The example is JSON.stringify(EXAMPLE) — derived, not
    // hand-written, so it cannot drift from the schema or go stale.
    const section = buildWorkingContextSection('avery', baseDir, NOW);
    expect(section).toContain(JSON.stringify(EXAMPLE));
    writeStore('avery', [EXAMPLE]);
    expect(loadWorkingContext('avery', baseDir)).toHaveLength(1);
  });
});

describe('partial handoffs are rejected on read (codex round 3 P2)', () => {
  const FULL = {
    ts: daysAgo(1),
    type: 'handoff',
    to: 'pfoster1@example.edu',
    artifact: 'docs/kb-audit.md',
    expected: 'corrections',
    ping_after: '2026-08-01',
    resolved: false,
  };

  it('accepts a complete handoff', () => {
    writeStore('avery', [FULL]);
    expect(loadWorkingContext('avery', baseDir)).toHaveLength(1);
  });

  it.each([
    ['missing artifact', { artifact: undefined }],
    ['missing expected', { expected: undefined }],
    ['missing ping_after', { ping_after: undefined }],
    ['unparseable ping_after', { ping_after: 'next week' }],
    ['non-boolean resolved', { resolved: 'no' }],
    ['empty to', { to: '   ' }],
  ])('rejects a handoff with %s', (_label, override) => {
    // A partial handoff would otherwise load, be decay-exempt forever, be
    // rejected by the register, and be hidden from injection — immortal and
    // invisible at once.
    writeStore('avery', [{ ...FULL, ...override }]);
    expect(loadWorkingContext('avery', baseDir)).toHaveLength(0);
  });

  it('a rejected handoff cannot become an immortal invisible entry', () => {
    writeStore('avery', [
      { ...FULL, ts: daysAgo(90), artifact: undefined },
      { ts: daysAgo(90), type: 'thread', text: 'ordinary stale note' },
    ]);
    pruneStaleEntries('avery', baseDir, NOW, 14 * DAY_MS);
    expect(loadWorkingContext('avery', baseDir)).toHaveLength(0);
  });
});

describe('handoff field formats (codex round 4)', () => {
  const FULL = {
    ts: daysAgo(1),
    type: 'handoff',
    to: 'pfoster1@example.edu',
    artifact: 'docs/kb-audit.md',
    expected: 'corrections',
    ping_after: '2026-08-01',
    resolved: false,
  };

  it.each([
    ['US-style slashes', '08/10/2026'],
    ['ISO timestamp', '2026-08-01T00:00:00Z'],
    ['prose', 'next week'],
    ['short year', '26-08-01'],
  ])('rejects ping_after in %s form', (_l, ping_after) => {
    // The register compares ping_after lexically against today's YYYY-MM-DD,
    // so "08/10/2026" sorts below every 2026-.. date and reads as permanently
    // overdue; a timestamp slips a day. Only the exact format is safe.
    writeStore('avery', [{ ...FULL, ping_after }]);
    expect(loadWorkingContext('avery', baseDir)).toHaveLength(0);
  });

  it('accepts an exact YYYY-MM-DD ping_after', () => {
    writeStore('avery', [FULL]);
    expect(loadWorkingContext('avery', baseDir)).toHaveLength(1);
  });

  it('rejects an impossible date that matches the shape', () => {
    writeStore('avery', [{ ...FULL, ping_after: '2026-13-45' }]);
    expect(loadWorkingContext('avery', baseDir)).toHaveLength(0);
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
  ])(
    'keeps a handoff with a %s gotcha but treats the gotcha as absent',
    async (_l, gotcha) => {
      // Presence of a gotcha surfaces the handoff BEFORE ping_after, so a
      // blank one must not count as one — but the handoff itself is still
      // valid and must not be lost. parseHandoff normalizes blank → absent:
      // no false alarm AND no dropped handoff.
      writeStore('avery', [{ ...FULL, gotcha }]);
      const loaded = loadWorkingContext('avery', baseDir);
      expect(loaded).toHaveLength(1);

      const { collectPendingHandoffs } = await import('./exceptions-report.js');
      const r = collectPendingHandoffs(
        loaded,
        'America/Chicago',
        new Date('2026-07-26T17:00:00Z'), // before FULL.ping_after
      );
      expect(r.pending).toHaveLength(0);
    },
  );

  it('accepts a real gotcha', () => {
    writeStore('avery', [{ ...FULL, gotcha: 'returns the whole doc at once' }]);
    expect(loadWorkingContext('avery', baseDir)).toHaveLength(1);
  });
});

describe('calendar-invalid ping dates (codex round 5)', () => {
  const FULL = {
    ts: daysAgo(1),
    type: 'handoff',
    to: 'a@example.edu',
    artifact: 'doc.md',
    expected: 'reply',
    resolved: false,
  };

  it.each(['2026-02-30', '2026-04-31', '2026-13-01', '2026-00-10'])(
    'rejects the impossible date %s',
    (ping_after) => {
      // JS rolls 2026-02-30 forward to March 2, so Date.parse succeeds and the
      // shape check passes — while the digest keeps comparing the ORIGINAL
      // string and alerts on the wrong day.
      writeStore('avery', [{ ...FULL, ping_after }]);
      expect(loadWorkingContext('avery', baseDir)).toHaveLength(0);
    },
  );

  it('accepts a real leap day', () => {
    writeStore('avery', [{ ...FULL, ping_after: '2028-02-29' }]);
    expect(loadWorkingContext('avery', baseDir)).toHaveLength(1);
  });

  it('rejects Feb 29 in a non-leap year', () => {
    writeStore('avery', [{ ...FULL, ping_after: '2026-02-29' }]);
    expect(loadWorkingContext('avery', baseDir)).toHaveLength(0);
  });
});

describe('the handoff example carries no placeholder gotcha (codex round 5)', () => {
  it('copying the example verbatim does not raise a false alarm', async () => {
    // A populated `gotcha` in a copyable example is a standing false positive:
    // presence of a gotcha surfaces the handoff BEFORE ping_after, every week.
    expect(EXAMPLE).not.toHaveProperty('gotcha');

    // And copied as-is it is a valid, non-surfacing handoff.
    const { collectPendingHandoffs } = await import('./exceptions-report.js');
    const r = collectPendingHandoffs(
      [EXAMPLE] as never,
      'America/Chicago',
      NOW, // the example's ping_after is derived as NOW+7d, so NOW is before it
    );
    expect(r.pending).toHaveLength(0);
  });
});

describe('parseHandoff is the single owner of handoff validity', () => {
  it('accepts the canonical example (the two can never drift)', () => {
    const h = parseHandoff(EXAMPLE);
    expect(h).not.toBeNull();
    expect(h!.gotcha).toBeUndefined();
  });

  it('normalizes a blank gotcha to absent instead of keeping or rejecting it', () => {
    const h = parseHandoff({ ...EXAMPLE, gotcha: '   ' });
    expect(h).not.toBeNull();
    expect(h!.gotcha).toBeUndefined();
  });

  it('loader and register agree by construction: what one accepts, the other reports', () => {
    // The disagreement class: an entry valid to one
    // consumer and invalid to another. Both now call parseHandoff, so any
    // entry that loads is reportable and vice versa.
    const mangled = [
      { ...EXAMPLE, ping_after: '08/10/2026' },
      { ...EXAMPLE, artifact: '' },
      { ...EXAMPLE, resolved: 'no' },
      EXAMPLE,
    ];
    for (const m of mangled) {
      const accepted = parseHandoff(m) !== null;
      writeStore('avery', [m]);
      const loaded = loadWorkingContext('avery', baseDir).length > 0;
      expect(loaded).toBe(accepted);
    }
  });
});

describe('codex round 6 regressions', () => {
  it('the example never expires: its ping_after tracks the section clock', () => {
    // Hardcoded dates would eventually sit in the past, making a verbatim
    // copy immediately overdue — a standing false alarm from the day the
    // example's date passes.
    const laterNow = new Date('2031-03-05T12:00:00.000Z');
    const section = buildWorkingContextSection('avery', baseDir, laterNow);
    expect(section).toContain('"ping_after":"2031-03-12"');
    expect(section).toContain('"ts":"2031-03-05"');
  });

  it('a handoff with junk refs loads AND registers — no consumer disagrees', async () => {
    // refs are unvalidated decoration. The shared refs pre-check must not
    // apply to handoffs: parseHandoff accepts this, so the loader must too,
    // or a tracked handoff silently disappears from the digest.
    const withJunkRefs = { ...EXAMPLE, refs: [null, 42, 'ok'] };
    expect(parseHandoff(withJunkRefs)).not.toBeNull();

    writeStore('avery', [withJunkRefs]);
    const loaded = loadWorkingContext('avery', baseDir);
    expect(loaded).toHaveLength(1);

    const { collectPendingHandoffs } = await import('./exceptions-report.js');
    const r = collectPendingHandoffs(
      loaded,
      'America/Chicago',
      new Date('2031-01-01T12:00:00.000Z'), // far past ping_after
    );
    expect(r.pending).toHaveLength(1);
    expect(r.pastPingAfter).toHaveLength(1);
  });
});

describe('example dates render in the digest timezone (codex round 7)', () => {
  it('an evening Central session dates the example today, not UTC-tomorrow', () => {
    // 2026-07-28T02:00Z is 21:00 on 07-27 in Chicago. UTC rendering would
    // stamp 07-28/08-04; the digest compares in Chicago, so a Monday-due
    // handoff stamped a day late misses that Monday's digest and alerts a
    // week later.
    const eveningCT = new Date('2026-07-28T02:00:00.000Z');
    const ex = handoffExample(eveningCT, 'America/Chicago');
    expect(ex.ts).toBe('2026-07-27');
    expect(ex.ping_after).toBe('2026-08-03');
  });

  it('the rendered section and the register share a clock', async () => {
    // The example copied verbatim at time T must first surface in the digest
    // run exactly 7 days after T — not 6, not 8 — in the digest's own zone.
    const t = new Date('2026-07-28T02:00:00.000Z'); // 07-27 CT
    const ex = handoffExample(t, 'America/Chicago');
    const { collectPendingHandoffs } = await import('./exceptions-report.js');
    const before = collectPendingHandoffs(
      [ex] as never,
      'America/Chicago',
      new Date('2026-08-03T04:00:00.000Z'), // 23:00 on 08-02 CT, day 6
    );
    expect(before.pastPingAfter).toHaveLength(0);
    const onDay = collectPendingHandoffs(
      [ex] as never,
      'America/Chicago',
      new Date('2026-08-03T18:00:00.000Z'), // 08-03 CT, day 7
    );
    expect(onDay.pastPingAfter).toHaveLength(1);
  });
});

describe('example due date is 7 calendar days across DST (codex round 8)', () => {
  it('spring-forward week still yields day 7, not day 8', () => {
    // 2026-03-02T05:30Z = 23:30 CST on 03-01. DST starts 03-08: +168 absolute
    // hours lands on 03-09 (8 local days); calendar arithmetic must say 03-08.
    const ex = handoffExample(
      new Date('2026-03-02T05:30:00.000Z'),
      'America/Chicago',
    );
    expect(ex.ts).toBe('2026-03-01');
    expect(ex.ping_after).toBe('2026-03-08');
  });

  it('fall-back week still yields day 7, not day 6', () => {
    // 2026-11-01 is the fall-back date; start the night before it.
    const ex = handoffExample(
      new Date('2026-10-27T05:30:00.000Z'), // 00:30 CDT on 10-27
      'America/Chicago',
    );
    expect(ex.ts).toBe('2026-10-27');
    expect(ex.ping_after).toBe('2026-11-03');
  });
});
