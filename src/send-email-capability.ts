import { readEnvFile } from './env.js';

import { OutboundEmail } from './outbound-email.js';

/**
 * Approved-outreach plumbing for the weekly action-item nudge (R2).
 *
 * Design: NO send capability ever exists
 * inside a container. The approved scheduled run COMPOSES its email batch and
 * returns it as structured output; the HOST parses, validates (allowlist,
 * forced Reply-To, batch cap), and sends after the run (task-scheduler.ts →
 * outbound-email.ts). Every in-container grant scheme reviewed (task-shape
 * match, env token, per-send HMAC, group send-window, active-container
 * exclusivity) leaked through one of the group-shared writable surfaces:
 * the group IPC dir, group logs, or the per-group runner source cache.
 */

/**
 * The single host-approved outreach task id, set by the operator in the VPS
 * .env (EMAIL_OUTREACH_TASK_ID). Approval is keyed to this immutable id —
 * never to task shape (group/cron/prompt), which agents can write via IPC
 * and an injected prompt could imitate. Empty/unset = no outreach sends.
 */
export function approvedEmailOutreachTaskId(): string {
  // process.env first (tests, pm2 env overrides), then the repo .env — this
  // app never loads .env into process.env; keys are read via readEnvFile.
  return (
    process.env.EMAIL_OUTREACH_TASK_ID ||
    readEnvFile(['EMAIL_OUTREACH_TASK_ID']).EMAIL_OUTREACH_TASK_ID ||
    ''
  );
}

export function isApprovedEmailOutreachTask(taskId: string): boolean {
  const approved = approvedEmailOutreachTaskId();
  return approved !== '' && taskId === approved;
}

/**
 * Non-main groups may not create (id-squat), update, cancel, or resume the
 * approved outreach task — only the host (or main group) owns its lifecycle.
 * Pausing is deliberately allowed: it only ever reduces what the task can do.
 */
export function isProtectedTaskMutation(
  taskId: string | undefined,
  isMain: boolean,
): boolean {
  return (
    !isMain && typeof taskId === 'string' && isApprovedEmailOutreachTask(taskId)
  );
}

/** Upper bound on one outreach batch (≈ pilot allowlist + digest + slack). */
export const MAX_OUTREACH_BATCH = 25;

export interface OutreachBatch {
  emails: OutboundEmail[];
  summary: string;
}

/**
 * Extract a balanced JSON object from `text` starting at the `{` at `start`,
 * respecting string literals and escapes. Returns null when unbalanced.
 */
function balancedJsonSpan(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse the approved run's final output into an email batch. Accepts a bare
 * JSON object, one inside a ```json fence, or one surrounded by other text —
 * in particular the group's `<internal>…</internal>` narration/self-eval
 * convention. Rejecting a valid batch wrapped that way would cause a
 * no-send on a good compose. Returns null
 * (fail-loud at the caller) when the output doesn't contain a valid batch.
 */
export function parseOutreachBatch(result: string): OutreachBatch | null {
  const candidates: string[] = [result.trim()];
  const fence = result.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fence) candidates.unshift(fence[1].trim());
  // Narration/self-eval stripped: what remains is the batch when the agent
  // followed the group's <internal> output convention around bare JSON.
  const stripped = result.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
  if (stripped && stripped !== result.trim()) candidates.push(stripped);
  // Last resort: balanced-scan for an object that opens with an "emails" key
  // (never matches the <eval> self-assessment object, which has no such key).
  const emailsKey = /\{\s*"emails"\s*:/g;
  for (let m = emailsKey.exec(result); m; m = emailsKey.exec(result)) {
    const span = balancedJsonSpan(result, m.index);
    if (span) candidates.push(span);
  }

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj.emails)) continue;

    const emails: OutboundEmail[] = [];
    let valid = true;
    for (const entry of obj.emails) {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        typeof (entry as Record<string, unknown>).to !== 'string' ||
        typeof (entry as Record<string, unknown>).subject !== 'string' ||
        typeof (entry as Record<string, unknown>).body !== 'string'
      ) {
        valid = false;
        break;
      }
      const e = entry as Record<string, unknown>;
      emails.push({
        to: e.to as string,
        cc: typeof e.cc === 'string' ? (e.cc as string) : undefined,
        subject: e.subject as string,
        body: e.body as string,
      });
    }
    if (!valid) continue;

    return {
      emails,
      summary:
        typeof obj.summary === 'string' ? obj.summary : '(no summary provided)',
    };
  }
  return null;
}
