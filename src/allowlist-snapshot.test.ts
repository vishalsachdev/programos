import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  _resetAllowlistSnapshotForTests,
  addressesMissingFromLastSnapshot,
  ALLOWLIST_SNAPSHOT_FILENAME,
  hydrateAllowlistSnapshots,
  writeAllowlistSnapshot,
} from './allowlist-snapshot.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'allowlist-snapshot-'));
}

describe('writeAllowlistSnapshot', () => {
  it('writes the pinned allowlist text from the reader into the IPC dir', () => {
    const dir = tmpDir();
    const wrote = writeAllowlistSnapshot(dir, {
      readFile: () => '| Name | Email |\n| Avery | avery@example.edu |\n',
    });
    expect(wrote).toBe(true);
    const text = fs.readFileSync(
      path.join(dir, ALLOWLIST_SNAPSHOT_FILENAME),
      'utf8',
    );
    expect(text).toContain('avery@example.edu');
  });

  it('removes a stale snapshot when the reader has no allowlist', () => {
    const dir = tmpDir();
    const file = path.join(dir, ALLOWLIST_SNAPSHOT_FILENAME);
    fs.writeFileSync(file, 'old');
    const wrote = writeAllowlistSnapshot(dir, { readFile: () => null });
    expect(wrote).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('reuses the last text for the same pinned SHA instead of re-reading the mirror', () => {
    let reads = 0;
    const source = {
      currentSha: 'abc123',
      readFile: () => {
        reads += 1;
        return '| Name | Email |\n| Sam | srivera@example.edu |\n';
      },
    };
    const a = tmpDir();
    const b = tmpDir();
    expect(writeAllowlistSnapshot(a, source)).toBe(true);
    expect(writeAllowlistSnapshot(b, source)).toBe(true);
    expect(reads).toBe(1);
    expect(
      fs.readFileSync(path.join(b, ALLOWLIST_SNAPSHOT_FILENAME), 'utf8'),
    ).toContain('srivera@example.edu');
    // A new SHA reads again.
    expect(
      writeAllowlistSnapshot(tmpDir(), { ...source, currentSha: 'def456' }),
    ).toBe(true);
    expect(reads).toBe(2);
  });

  it('reports sent addresses the last written snapshot did not contain', () => {
    _resetAllowlistSnapshotForTests();
    writeAllowlistSnapshot(tmpDir(), {
      currentSha: 'sha-1',
      readFile: () => '| Name | Email |\n| Sam | srivera@example.edu |\n',
    });
    expect(
      addressesMissingFromLastSnapshot([
        'srivera@example.edu',
        'newperson@example.edu',
      ]),
    ).toEqual(['newperson@example.edu']);
  });

  it('reports nothing when no snapshot has been written', () => {
    _resetAllowlistSnapshotForTests();
    expect(addressesMissingFromLastSnapshot(['x@example.edu'])).toEqual([]);
  });

  it('an older group snapshot still counts after another group advanced (per-group state)', () => {
    _resetAllowlistSnapshotForTests();
    const groupA = tmpDir();
    const groupB = tmpDir();
    writeAllowlistSnapshot(groupA, {
      currentSha: 'rev-A',
      readFile: () => '| Name | Email |\n| Sam | srivera@example.edu |\n',
    });
    writeAllowlistSnapshot(groupB, {
      currentSha: 'rev-B',
      readFile: () =>
        '| Name | Email |\n| Sam | srivera@example.edu |\n| New | newperson@example.edu |\n',
    });
    // Group A's container still judges from rev-A, so a send to the new
    // address must still produce a corrective note.
    expect(addressesMissingFromLastSnapshot(['newperson@example.edu'])).toEqual(
      ['newperson@example.edu'],
    );
  });

  it('when some group started without a snapshot, every sent address needs a confirming note', () => {
    _resetAllowlistSnapshotForTests();
    writeAllowlistSnapshot(tmpDir(), { readFile: () => null });
    expect(addressesMissingFromLastSnapshot(['srivera@example.edu'])).toEqual([
      'srivera@example.edu',
    ]);
  });

  it('hydrates last-written snapshots from disk after a restart', () => {
    _resetAllowlistSnapshotForTests();
    const root = tmpDir();
    const groupDir = path.join(root, 'program-telegram');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, ALLOWLIST_SNAPSHOT_FILENAME),
      '| Name | Email |\n| Sam | srivera@example.edu |\n',
    );
    _resetAllowlistSnapshotForTests();
    hydrateAllowlistSnapshots(root);
    expect(addressesMissingFromLastSnapshot(['new@example.edu'])).toEqual([
      'new@example.edu',
    ]);
    expect(addressesMissingFromLastSnapshot(['srivera@example.edu'])).toEqual(
      [],
    );
  });
});
