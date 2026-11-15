import { describe, expect, it } from 'vitest';

import {
  createAgentHooks,
  createProtectedWriteGuard,
  PROTECTED_FILES,
} from '../container/agent-runner/src/protected-write-guard.js';
import { PROTECTED_PATH_RULES } from '../src/governance-protection.js';

describe('protected write SDK guard', () => {
  it('container guard and host governance protect the same path set', () => {
    // The two layers cannot share a module (separate tsconfig rootDirs);
    // a file added to one but not the other silently degrades enforcement
    // to detect-only (or protect-only) for that path.
    const guardPaths = PROTECTED_FILES.map(({ suffix }) => suffix).sort();
    const hostPaths = [...PROTECTED_PATH_RULES.keys()].sort();
    expect(guardPaths).toEqual(hostPaths);
  });

  it('registers the write guard alongside the existing compaction hook', () => {
    const compact = async () => ({});
    const writeGuard = createProtectedWriteGuard();

    expect(createAgentHooks(compact, writeGuard)).toEqual({
      PreCompact: [{ hooks: [compact] }],
      PreToolUse: [
        { matcher: 'Write|Edit|NotebookEdit', hooks: [writeGuard] },
      ],
    });
  });

  it('registers the write guard even without a compaction hook (delivery-repair)', () => {
    const writeGuard = createProtectedWriteGuard();

    expect(createAgentHooks(undefined, writeGuard)).toEqual({
      PreToolUse: [
        { matcher: 'Write|Edit|NotebookEdit', hooks: [writeGuard] },
      ],
    });
  });

  it('denies a bare relative filename resolved against the session cwd', async () => {
    const guard = createProtectedWriteGuard();

    const result = await guard(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        cwd: '/workspace/extra/program-repo/program',
        tool_input: { file_path: 'CURRICULUM.md' },
      } as never,
      'tool-use-id',
      { signal: new AbortController().signal },
    );

    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('[G11]'),
      },
    });
  });

  it('denies NotebookEdit against a protected path via notebook_path', async () => {
    const guard = createProtectedWriteGuard();

    const result = await guard(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'NotebookEdit',
        tool_input: {
          notebook_path: '/workspace/extra/program-repo/program/CURRICULUM.md',
        },
      } as never,
      'tool-use-id',
      { signal: new AbortController().signal },
    );

    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('[G11]'),
      },
    });
  });

  it.each([
    ['Write', '/workspace/extra/program-repo/program/CURRICULUM.md', '[G11]'],
    ['Write', 'program/./CURRICULUM.md', '[G11]'],
    ['Edit', 'program/tmp/../EMAIL_ALLOWLIST.md', '[G39]'],
    ['Edit', 'program/EMAIL_ALLOWLIST.md', '[G39]'],
    ['Write', '/workspace/extra/program-repo/program/roles.md', '[G39]'],
  ])('denies %s before it changes %s', async (toolName, filePath, rule) => {
    const guard = createProtectedWriteGuard();

    const result = await guard(
      {
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
        cwd: '/workspace/extra/program-repo',
        tool_input: { file_path: filePath },
      } as never,
      'tool-use-id',
      { signal: new AbortController().signal },
    );

    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining(rule),
      },
    });
  });

  it.each([
    ['Read', 'program/CURRICULUM.md'],
    ['Write', 'courses/elc-550/syllabus.md'],
    ['Edit', 'program/CURRICULUM.md.backup'],
    // Nested staging copies outside the SoT paths stay writable — G11's
    // flag-don't-edit posture invites drafting proposed revisions there.
    ['Write', 'discussions/drafts/program/curriculum.md'],
    ['Write', '/workspace/group/program/CURRICULUM.md'],
    ['Write', undefined],
  ])('allows %s for an unprotected target', async (toolName, filePath) => {
    const guard = createProtectedWriteGuard();

    const result = await guard(
      {
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
        cwd: '/workspace/extra/program-repo',
        tool_input: { file_path: filePath },
      } as never,
      'tool-use-id',
      { signal: new AbortController().signal },
    );

    expect(result).toEqual({});
  });
});
