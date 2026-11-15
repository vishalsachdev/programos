/**
 * Defensive classification of agent output text.
 *
 * The agent-runner now labels errored SDK `result` messages as status:'error'
 * (see container/agent-runner/src/index.ts), so the host's primary signal is the
 * status field. This is a belt-and-suspenders content check for the case where an
 * API-error envelope still arrives inside a "success" result — we must never
 * transmit such a string to a stakeholder, and it must trigger a retry rather
 * than be recorded as the agent's reply.
 */

/**
 * True when `text` looks like a raw API/transport error envelope rather than a
 * genuine agent reply. Intentionally narrow: it matches the leading error
 * shapes the Claude CLI/SDK emit (`API Error: <3-digit status>` and JSON
 * `{"type":"error",...}` / `"error":{"type":...}`) so ordinary prose that merely
 * mentions the word "error" is not suppressed.
 */
export function looksLikeApiError(text: string): boolean {
  if (!text) return false;
  const head = text.trimStart().slice(0, 400);
  // "API Error: 500 {...}" — the literal shape of a provider error.
  if (/^API Error:\s*\d{3}\b/i.test(head)) return true;
  // Raw JSON error envelope at the start of the message.
  if (/^\{[\s\S]*"type"\s*:\s*"(api_)?error"/.test(head)) return true;
  if (/^\{[\s\S]*"error"\s*:\s*\{\s*"type"\s*:/.test(head)) return true;
  return false;
}
