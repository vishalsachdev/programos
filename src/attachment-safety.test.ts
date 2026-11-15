import { describe, it, expect, vi } from 'vitest';
import {
  isSafeAttachmentName,
  safeAttachmentName,
} from './attachment-safety.js';

describe('isSafeAttachmentName', () => {
  it('accepts plain filenames', () => {
    expect(isSafeAttachmentName('report.pdf')).toBe(true);
    expect(isSafeAttachmentName('photo.jpg')).toBe(true);
    expect(isSafeAttachmentName('a-b_c.123.txt')).toBe(true);
  });

  it('rejects traversal sentinels', () => {
    expect(isSafeAttachmentName('.')).toBe(false);
    expect(isSafeAttachmentName('..')).toBe(false);
  });

  it('rejects names with path separators', () => {
    expect(isSafeAttachmentName('../etc/passwd')).toBe(false);
    expect(isSafeAttachmentName('foo/bar.txt')).toBe(false);
    expect(isSafeAttachmentName('foo\\bar.txt')).toBe(false);
    expect(isSafeAttachmentName('/abs/path.txt')).toBe(false);
  });

  it('rejects empty / non-strings', () => {
    expect(isSafeAttachmentName('')).toBe(false);
    expect(isSafeAttachmentName(undefined as unknown as string)).toBe(false);
    expect(isSafeAttachmentName(null as unknown as string)).toBe(false);
  });

  it('rejects NUL byte', () => {
    expect(isSafeAttachmentName('foo\0.txt')).toBe(false);
  });
});

describe('safeAttachmentName', () => {
  it('returns input when safe', () => {
    expect(safeAttachmentName('report.pdf')).toBe('report.pdf');
  });

  it('returns fallback when unsafe', () => {
    const result = safeAttachmentName('../escape.txt');
    expect(result).toMatch(/^attachment-\d+$/);
  });

  it('returns fallback for undefined', () => {
    expect(safeAttachmentName(undefined)).toMatch(/^attachment-\d+$/);
  });

  it('uses custom prefix', () => {
    expect(safeAttachmentName('../bad', 'eml-attach')).toMatch(
      /^eml-attach-\d+$/,
    );
  });

  it('logs rejection only when unsafe', () => {
    const log = vi.fn();
    safeAttachmentName('safe.pdf', 'attachment', log);
    expect(log).not.toHaveBeenCalled();

    safeAttachmentName('../bad', 'attachment', log);
    expect(log).toHaveBeenCalledTimes(1);
  });
});
