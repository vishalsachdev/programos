// ───────────────────────────────────────────────────────────────────────
// Box update-notification detection (Phase 1 of Box→KB auto-sync).
//
// DORMANT FALLBACK: the primary Box→KB sync path is a separate scheduled
// sync job. This detector is kept deliberately as a fallback in case that
// job proves insufficient.
//
// Box emails program@ when a faculty member edits a watched course folder.
// We treat that as a coarse "go re-sync" doorbell and ping the admin on
// Telegram. We do NOT trust the email content — the actual sync reads from
// Box via authenticated API — so a spoofed notification at worst triggers
// one redundant (idempotent) sync sweep. Handled BEFORE the allowlist so
// these machine senders neither pollute the human allowlist nor get
// silently dropped. Sender domains + debounce are env-tunable so we can
// refine the matcher from a real notification without a redeploy.
// ───────────────────────────────────────────────────────────────────────
const BOX_NOTIFY_DOMAINS = (process.env.BOX_NOTIFY_SENDER_DOMAINS || 'box.com')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

export function senderDomain(from: string | undefined): string {
  if (!from) return '';
  const angle = from.match(/<([^>]+)>/);
  const addr = (angle ? angle[1] : from).trim().toLowerCase();
  const at = addr.lastIndexOf('@');
  return at >= 0 ? addr.slice(at + 1) : '';
}

export function isBoxNotification(from: string | undefined): boolean {
  const dom = senderDomain(from);
  if (!dom) return false;
  return BOX_NOTIFY_DOMAINS.some((d) => dom === d || dom.endsWith('.' + d));
}
