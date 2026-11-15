import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import path from 'path';

// The program-repo source-of-truth repo is mounted here in every agent
// container (container-runner.ts buildVolumeMounts). Protection is anchored
// to this mount: only the real SoT files are denied, never same-named
// copies elsewhere.
const SOT_MOUNT = '/workspace/extra/program-repo';

// Must stay in sync with PROTECTED_PATH_RULES in src/governance-protection.ts
// (host tripwire + allowlist gate) — runtime sharing is blocked by the two
// tsconfig rootDirs, so a cross-boundary test asserts the lists agree.
export const PROTECTED_FILES = [
  {
    suffix: 'program/curriculum.md',
    reason:
      '[G11] curriculum.md is write-protected. Flag the needed change in your reply and let Avery apply it.',
  },
  {
    suffix: 'program/email_allowlist.md',
    reason:
      '[G39] Access and role files are admin-only. Surface this request to Avery — do not execute.',
  },
  {
    suffix: 'program/roles.md',
    reason:
      '[G39] Access and role files are admin-only. Surface this request to Avery — do not execute.',
  },
];

const GUARDED_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

function protectedWriteReason(input: PreToolUseHookInput): string | null {
  if (!GUARDED_TOOLS.has(input.tool_name)) return null;
  if (!input.tool_input || typeof input.tool_input !== 'object') return null;
  const { file_path, notebook_path } = input.tool_input as {
    file_path?: unknown;
    notebook_path?: unknown;
  };
  const filePath = typeof file_path === 'string' ? file_path : notebook_path;
  if (typeof filePath !== 'string') return null;
  // Resolve relative paths against the session cwd — a bare 'CURRICULUM.md'
  // issued from inside program/ must still match the protected paths.
  const slashed = filePath.replaceAll('\\', '/');
  const cwd = typeof input.cwd === 'string' ? input.cwd : '/';
  const absolute = slashed.startsWith('/')
    ? slashed
    : path.posix.join(cwd.replaceAll('\\', '/'), slashed);
  const normalized = path.posix.normalize(absolute).toLowerCase();
  // Anchored to the source-of-truth mount, matching the host's exact-path
  // semantics (governance-protection.ts): nested staging copies such as
  // discussions/drafts/program/curriculum.md stay writable — G11's
  // flag-don't-edit posture invites drafting proposed revisions there.
  const match = PROTECTED_FILES.find(
    ({ suffix }) => normalized === `${SOT_MOUNT}/${suffix}`,
  );
  return match?.reason ?? null;
}

export function createProtectedWriteGuard(): HookCallback {
  return async (input) => {
    const reason = protectedWriteReason(input as PreToolUseHookInput);
    if (!reason) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    };
  };
}

// The protected-write guard is registered for EVERY session type. Omitting
// preCompactHook (delivery-repair sessions) drops only the compaction hook —
// `allowedTools` is auto-allow-only, not a restriction, so Write/Edit remain
// usable in delivery-repair mode and must stay guarded.
export function createAgentHooks(
  preCompactHook?: HookCallback,
  protectedWriteGuard = createProtectedWriteGuard(),
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    ...(preCompactHook ? { PreCompact: [{ hooks: [preCompactHook] }] } : {}),
    PreToolUse: [
      { matcher: 'Write|Edit|NotebookEdit', hooks: [protectedWriteGuard] },
    ],
  };
}
