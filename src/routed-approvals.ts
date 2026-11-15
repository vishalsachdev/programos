/**
 * Routed approvals (G42 Tier 2 email-group relay, G30 named exception; registry
 * v9.10).
 *
 * When Coordinator tells a sender an item is waiting on an approver, the email agent
 * writes an entry under `## Routed Approvals` in OPEN_QUESTIONS.md. The agent
 * only writes that record. The HOST reads it from the pushed KB, checks it
 * against what it already trusts, and only the host sends anything:
 *
 * - the approver comes from the sender's allowlist row (G39), never from the
 *   entry, which is only compared;
 * - the sender and the inbound text come from the host's own intake copy of
 *   the email (`routed_approval_evidence`), keyed by the entry's raw path;
 * - every quote must appear, word for word, in that inbound text.
 *
 * Any failed check holds the relay and tells Avery why: hold by
 * default. At most two relays per entry (initial + one day-3
 * reminder); after that only Avery is reminded, on Telegram, every 3 days.
 */
import crypto from 'crypto';

import { isAgentPrincipalRow } from './channels/webhook-allowlist.js';
import {
  getRoutedApproval,
  getRoutedApprovalEvidence,
  insertRoutedApproval,
  listOpenRoutedApprovals,
  listRoutedApprovalsWithPendingNotice,
  listRoutedApprovalsWithUnrecordedRelay,
  pruneRoutedApprovalEvidence,
  putRoutedApprovalEvidence,
  updateRoutedApproval,
  type RoutedApprovalEvidence,
  type RoutedApprovalNotice,
  type RoutedApprovalRow,
} from './db.js';
import { inboundEmailAddressesInText } from './email-addresses.js';
import { logger } from './logger.js';
import type {
  OutboundEmail,
  OutboundEmailResult,
  SendOutboundEmailOptions,
} from './outbound-email.js';

export const ROUTED_APPROVALS_HEADING = '## Routed Approvals';
export const OPEN_QUESTIONS_PATH = 'discussions/OPEN_QUESTIONS.md';
export const ROUTED_REMINDER_MS = 3 * 86_400_000;
export const MAX_ROUTED_RELAYS = 2;
export const MIN_QUOTE_WORDS = 3;
export const MAX_QUOTE_CHARS = 8000;
export const EVIDENCE_RETENTION_MS = 30 * 86_400_000;
export const MAX_EVIDENCE_TEXT_CHARS = 256 * 1024;
export const SCAN_INTERVAL_MS = 60 * 60 * 1000;
export const ROUTED_SOURCE_GROUP = 'routed-approval';
const OPERATOR_EMAIL = 'avery@example.edu';
const TELEGRAM_TEXT_LIMIT = 3800;

// --- Entry parsing -----------------------------------------------------------

export interface RoutedAffect {
  file: string;
  section: string;
  title: string;
}

export interface RoutedEntry {
  /** The raw-email path, or `noraw:<hash>` for an entry that names none. */
  key: string;
  title: string;
  open: boolean;
  sender?: string;
  approver?: string;
  rawPath?: string;
  quotes: string[];
  affects: RoutedAffect[];
  added?: string;
  /** `✅ Closed YYYY-MM-DD` date, when the entry carries one. */
  closedOn?: string;
}

export function normalizeRawPath(value: string): string {
  return value
    .trim()
    .replace(/^`+|`+$/g, '')
    .replace(/^\.\//, '');
}

/** Lines of the `## Routed Approvals` section, or null when the heading is absent. */
function routedSectionLines(md: string): string[] | null {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === ROUTED_APPROVALS_HEADING);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end);
}

function unquote(value: string): string {
  return value
    .trim()
    .replace(/^>\s*/, '')
    .replace(/^["“'‘]+|["”'’]+$/g, '')
    .trim();
}

function field(line: string, name: string): string | undefined {
  const match = line.match(new RegExp(`\\b${name}:\\s*([^;)\\s]+)`, 'i'));
  return match ? match[1].replace(/^`+|`+$/g, '') : undefined;
}

export function hasRoutedApprovalsSection(md: string): boolean {
  return routedSectionLines(md) !== null;
}

export function parseRoutedApprovals(md: string): RoutedEntry[] {
  const lines = routedSectionLines(md);
  if (!lines) return [];
  const entries: RoutedEntry[] = [];
  let current: { entry: RoutedEntry; text: string[] } | null = null;
  const finish = () => {
    if (!current) return;
    // Closure comes only from the entry's own status: the checkbox, or a
    // `✅ Closed` annotation outside the bold title and outside any quoted
    // `Sender's words` line (a sender may write those words themselves).
    const status = current.text
      .filter((l, i) => i === 0 || !/^\s+- Sender[’']s words:/i.test(l))
      .map((l, i) => (i === 0 ? l.replace(/\*\*.+?\*\*/, '') : l))
      .join('\n');
    const closed = status.match(/✅\s*Closed\s+(\d{4}-\d{2}-\d{2})?/);
    if (closed) {
      current.entry.open = false;
      if (closed[1]) current.entry.closedOn = closed[1];
    }
    entries.push(current.entry);
    current = null;
  };

  let fenced = false;
  for (const line of lines) {
    // A format example in a code block is documentation, never an entry.
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      finish();
      continue;
    }
    if (fenced) continue;
    const top = line.match(/^- \[([ xX])\]\s+(.*)$/);
    if (top) {
      finish();
      const rest = top[2];
      const title = (rest.match(/\*\*(.+?)\*\*/)?.[1] ?? rest).trim();
      const rawField = field(rest, 'Raw');
      const rawPath = rawField ? normalizeRawPath(rawField) : undefined;
      const key =
        rawPath ??
        `noraw:${crypto
          .createHash('sha256')
          .update(rest.replace(/\(Added:[^)]*\)/g, '').trim())
          .digest('hex')
          .slice(0, 16)}`;
      current = {
        entry: {
          key,
          title,
          open: top[1] === ' ',
          sender: field(rest, 'Sender')?.toLowerCase(),
          approver: field(rest, 'Approver')?.toLowerCase(),
          rawPath,
          quotes: [],
          affects: [],
          added: rest.match(/\(Added:\s*(\d{4}-\d{2}-\d{2})\)/)?.[1],
        },
        text: [line],
      };
      continue;
    }
    if (!current) continue;
    if (!/^\s+\S/.test(line)) {
      // A blank or flush-left line ends the entry's sub-bullets.
      if (line.trim() === '') continue;
      finish();
      continue;
    }
    current.text.push(line);
    const words = line.match(/^\s+- Sender[’']s words:\s*(.+)$/i);
    if (words) {
      const quote = unquote(words[1]);
      if (quote) current.entry.quotes.push(quote);
      continue;
    }
    const affects = line.match(
      /^\s+- Affects:\s*`?([^\s`§]+)`?\s*§\s*(.+?)\s*[—–-]+\s*\*\*(.+?)\*\*/i,
    );
    if (affects) {
      current.entry.affects.push({
        file: affects[1].trim(),
        section: affects[2].trim(),
        title: affects[3].trim(),
      });
    }
  }
  finish();
  return entries;
}

// --- Approver lookup (G39: the sender's allowlist row is authoritative) -----

export interface AllowlistRow {
  name: string;
  email: string;
  access: string;
  role: string;
  agent: boolean;
}

/** Active allowlist rows (the `Retired access` block is excluded). */
export function parseAllowlistRows(markdown: string): AllowlistRow[] {
  const active = markdown.split(/>\s*\*\*Retired access/i, 1)[0];
  const rows: AllowlistRow[] = [];
  for (const line of active.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 5) continue;
    const email = cells[1].toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) continue;
    rows.push({
      name: cells[0].replace(/\*\*/g, '').trim(),
      email,
      access: cells[3],
      role: cells.slice(4).join(' | '),
      agent: isAgentPrincipalRow(cells),
    });
  }
  return rows;
}

export interface Person {
  name: string;
  email: string;
}

export type ApproverResolution =
  | {
      ok: true;
      approver: Person;
      sender: Person;
      basis: 'row-route' | 'no-route' | 'addressed-to-avery';
    }
  | { ok: false; reason: string; sender?: Person };

const ROUTE_RE =
  /\broutes?\s+(?:to|through|via)\s+(?:\*\*)?([A-Z][^()*|]{1,60}?)\s*\(([a-z0-9._-]+)\)/gi;

/**
 * The approver for `senderEmail`: the single route named in the sender's row
 * (`route(s) to/through <Name> (<netid>)`), or Avery when the row names none.
 * The entry's own Approver field is accepted only when it equals that route or
 * Avery (an item the sender addressed to him). Everything else fails closed.
 */
export function resolveRouteApprover(
  allowlistMarkdown: string,
  senderEmail: string,
  entryApprover: string | undefined,
): ApproverResolution {
  const rows = parseAllowlistRows(allowlistMarkdown);
  const sender = senderEmail.toLowerCase().trim();
  const senderRows = rows.filter((r) => r.email === sender);
  if (senderRows.length !== 1) {
    return {
      ok: false,
      reason:
        senderRows.length === 0
          ? `the sender ${sender} has no row on the allowlist`
          : `the sender ${sender} has ${senderRows.length} allowlist rows`,
    };
  }
  const senderRow = senderRows[0];
  const senderPerson = { name: senderRow.name, email: senderRow.email };
  if (senderRow.agent) {
    return {
      ok: false,
      reason: 'the sender is an agent principal',
      sender: senderPerson,
    };
  }
  const operatorRows = rows.filter((r) => r.email === OPERATOR_EMAIL);
  if (operatorRows.length !== 1) {
    return {
      ok: false,
      reason: 'the allowlist has no single row for Avery',
      sender: senderPerson,
    };
  }
  const avery = { name: operatorRows[0].name, email: operatorRows[0].email };

  const netids = [
    ...new Set(
      [...senderRow.role.matchAll(ROUTE_RE)].map((m) => m[2].toLowerCase()),
    ),
  ];
  if (netids.length > 1) {
    return {
      ok: false,
      reason: `the sender's allowlist row names more than one route (${netids.join(', ')})`,
      sender: senderPerson,
    };
  }
  let route: Person = avery;
  let basis: 'row-route' | 'no-route' = 'no-route';
  if (netids.length === 1) {
    const matches = rows.filter(
      (r) => r.email === `${netids[0]}@example.edu` && !r.agent,
    );
    if (matches.length !== 1) {
      return {
        ok: false,
        reason: `the route ${netids[0]} in the sender's allowlist row has no single allowlist row`,
        sender: senderPerson,
      };
    }
    route = { name: matches[0].name, email: matches[0].email };
    basis = 'row-route';
  }

  const named = entryApprover?.toLowerCase().trim();
  if (!named) {
    return {
      ok: false,
      reason: 'the entry names no approver',
      sender: senderPerson,
    };
  }
  const matchesPerson = (p: Person) =>
    named === p.email || named === p.email.split('@')[0];
  if (matchesPerson(route)) {
    return { ok: true, approver: route, sender: senderPerson, basis };
  }
  if (matchesPerson(avery)) {
    return {
      ok: true,
      approver: avery,
      sender: senderPerson,
      basis: 'addressed-to-avery',
    };
  }
  return {
    ok: false,
    reason: `the entry names ${named}, but the sender's allowlist row routes to ${route.email}`,
    sender: senderPerson,
  };
}

// --- Quote check ---------------------------------------------------------------

/**
 * Access or role changes (allowlist rows, Coordinator access, read-only/read-write,
 * permissions, approver roles) are Avery's alone (G39), and a G42 Tier 2
 * relay never carries them. An entry whose quotes contain one relays only
 * to Avery; addressed to anyone else, it is held. Broad on purpose: a false
 * match costs a hold, a miss sends an access request to the wrong person.
 */
export const ACCESS_CHANGE_WORDS_RE =
  /\b(?:allow ?list(?:ed|s)?|read ?write|read ?only|permissions?|roles?|gate approver|admin(?:istrator)? (?:rights|access)|co ?ordinator access|access (?:to|for) co ?ordinator|(?:add|added|adding|remove|removed|removing|grant|granted|revoke|revoked|give|given)(?: \S+){0,10} (?:to|from|on) co ?ordinator)\b/;

/**
 * Tested on the same words-only form the quote check compares (quoteWords),
 * so a punctuation variant the quote check accepts ("Co–ordinator", "Co.ordinator",
 * "read‑write") cannot slip past it.
 */
export function isAccessChange(quote: string): boolean {
  return ACCESS_CHANGE_WORDS_RE.test(quoteWords(quote).join(' '));
}

/**
 * Comparison words only: NFKC (the same normalization the G59 body gate uses
 * for detection), lowercase, letters and digits. Punctuation and spacing are
 * ignored because the archived Markdown loses characters the .eml keeps
 * (for example, Windows-1252 dashes).
 */
export function quoteWords(text: string): string[] {
  return (
    text
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

export function quoteFoundIn(quote: string, texts: string[]): boolean {
  const words = quoteWords(quote);
  if (words.length < MIN_QUOTE_WORDS) return false;
  const needle = ` ${words.join(' ')} `;
  return texts.some((t) => ` ${quoteWords(t).join(' ')} `.includes(needle));
}

// --- Messages ------------------------------------------------------------------

function firstName(name: string): string {
  return name.split(/\s+/)[0] || name;
}

function centralDate(ms: number): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(ms));
}

export function cleanSubject(subject: string | undefined): string {
  const bare = (subject || '').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').trim();
  return (bare || 'your message to Coordinator').slice(0, 200);
}

/** The relay body: a fixed host template plus the verified quotes, nothing agent-written. */
export function buildRelayEmail(args: {
  approver: Person;
  sender: Person;
  subject: string | undefined;
  quotes: string[];
  receivedAt: number;
  relayNumber: number;
  firstRelayAt?: number;
}): { subject: string; body: string } {
  const subject = cleanSubject(args.subject);
  const quoted = args.quotes.map((q) => `"${q}"`).join('\n\n');
  const intro =
    args.relayNumber === 1
      ? `${args.sender.name} (${args.sender.email}) sent Coordinator an update on ${centralDate(args.receivedAt)} that needs your approval before it goes into the Program knowledge base. Their words:`
      : `A reminder: on ${centralDate(args.firstRelayAt ?? args.receivedAt)} Coordinator sent you this update from ${args.sender.name} (${args.sender.email}), and it is still waiting for your approval. Their words:`;
  return {
    subject:
      args.relayNumber === 1
        ? `For your approval: ${subject}`
        : `Reminder, for your approval: ${subject}`,
    body: [
      `Hi ${firstName(args.approver.name)},`,
      intro,
      quoted,
      `Coordinator recorded this under Routed Approvals in discussions/OPEN_QUESTIONS.md. Reply to this email with your decision and Coordinator will record it. ${firstName(args.sender.name)} is copied.`,
      `Coordinator`,
    ].join('\n\n'),
  };
}

export function buildOwnerNotice(
  kind: RoutedApprovalNotice,
  row: RoutedApprovalRow,
  now: number,
): string {
  const days = Math.floor((now - row.createdAt) / 86_400_000);
  const head = {
    created: 'Coordinator routed approval (G42)',
    reminder: `Coordinator routed approval still open after ${days} days`,
    removed:
      'Coordinator routed approval entry was removed without being closed',
    'relay-failed': 'Coordinator routed approval relay failed',
    held: 'Coordinator routed approval held',
  }[kind];
  const lines = [
    head,
    `Entry: ${row.title}`,
    `From: ${row.senderName ? `${row.senderName} <${row.sender}>` : row.sender || '(unknown)'}`,
    `Approver: ${row.approverEmail ? `${row.approverName ?? ''} <${row.approverEmail}>`.trim() : '(not resolved)'}`,
  ];
  if (row.subject) lines.push(`Subject: ${cleanSubject(row.subject)}`);
  if (row.status === 'held') {
    lines.push(
      row.relayCount >= 1
        ? `HELD, no further relay: ${row.holdReason ?? 'a check failed'}. The first email went to the approver on ${centralDate(row.lastRelayAt ?? row.createdAt)}. Decide the rest in OPEN_QUESTIONS.md under Routed Approvals.`
        : `HELD, nothing was sent: ${row.holdReason ?? 'a check failed'}. Decide it in OPEN_QUESTIONS.md under Routed Approvals.`,
    );
  } else if (row.status === 'notice-only') {
    lines.push(
      'No relay: the sender is the approver. Close the entry when it is decided.',
    );
  } else if (row.status === 'relay-failed') {
    const reason = row.holdReason ?? 'see the log';
    lines.push(
      /outcome unknown/.test(reason)
        ? `The relay email's outcome is unknown: ${reason}.`
        : row.relayCount >= 1
          ? `The reminder email failed: ${reason}. The first email went to the approver on ${centralDate(row.lastRelayAt ?? row.createdAt)}.`
          : `The relay email failed: ${reason}. The approver has not been told.`,
    );
  } else if (row.status === 'relayed') {
    lines.push(
      row.relayCount === 0
        ? 'The relay to the approver is queued (sender copied).'
        : `Relays sent to the approver: ${row.relayCount} of ${MAX_ROUTED_RELAYS} (sender copied).`,
    );
  } else if (row.status === 'closed') {
    lines.push('The entry is closed.');
  }
  return lines.join('\n');
}

// --- Other surfaces ----------------------------------------------------------

export interface MaskedActionItems {
  markdown: string;
  skipped: Array<{ section: string; title: string; entry: string }>;
}

/**
 * Monday reminder skip: an open ACTION_ITEMS item named in an open routed
 * entry's `Affects:` line is not counted for its owner. The item is matched
 * by its owner section and its bold title; `- [ ]` becomes `- [~]` in the
 * returned copy, which the counters do not count. The KB file is untouched.
 */
export function maskRoutedActionItems(
  actionItemsMd: string,
  openQuestionsMd: string | null,
): MaskedActionItems {
  if (!openQuestionsMd) return { markdown: actionItemsMd, skipped: [] };
  const targets = parseRoutedApprovals(openQuestionsMd)
    .filter((e) => e.open)
    .flatMap((e) =>
      e.affects
        .filter((a) => /(^|\/)ACTION_ITEMS\.md$/i.test(a.file))
        .map((a) => ({ ...a, entry: e.title })),
    );
  if (targets.length === 0) return { markdown: actionItemsMd, skipped: [] };

  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const lines = actionItemsMd.split('\n');
  const skipped: MaskedActionItems['skipped'] = [];
  let section = '';
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(/^## (.+)$/);
    if (heading) {
      section = norm(heading[1]);
      continue;
    }
    if (!/^\s*- \[ \]/.test(lines[i])) continue;
    const title = lines[i].match(/\*\*(.+?)\*\*/)?.[1];
    if (!title) continue;
    const hit = targets.find(
      (t) => norm(t.section) === section && norm(t.title) === norm(title),
    );
    if (!hit) continue;
    lines[i] = lines[i].replace('- [ ]', '- [~]');
    skipped.push({ section: hit.section, title: hit.title, entry: hit.entry });
  }
  return { markdown: lines.join('\n'), skipped };
}

export interface RoutedApprovalSummary {
  open: Array<{
    title: string;
    sender?: string;
    approver?: string;
    added?: string;
  }>;
  openedInWindow: number;
  closedInWindow: number;
}

/** Weekly exceptions digest (G30 still counts routed approvals). */
export function summarizeRoutedApprovals(
  openQuestionsMd: string,
  sinceDate: string,
): RoutedApprovalSummary {
  const entries = parseRoutedApprovals(openQuestionsMd);
  return {
    open: entries
      .filter((e) => e.open)
      .map((e) => ({
        title: e.title,
        sender: e.sender,
        approver: e.approver,
        added: e.added,
      })),
    openedInWindow: entries.filter((e) => e.added && e.added >= sinceDate)
      .length,
    closedInWindow: entries.filter(
      (e) => e.closedOn !== undefined && e.closedOn >= sinceDate,
    ).length,
  };
}

// --- Service ---------------------------------------------------------------------

export interface RoutedApprovalStore {
  putEvidence(e: RoutedApprovalEvidence): void;
  getEvidence(rawPath: string): RoutedApprovalEvidence | undefined;
  pruneEvidence(beforeMs: number): number;
  get(key: string): RoutedApprovalRow | undefined;
  insert(row: RoutedApprovalRow): boolean;
  update(key: string, patch: Partial<Omit<RoutedApprovalRow, 'key'>>): void;
  listOpen(): RoutedApprovalRow[];
  listPendingNotices(): RoutedApprovalRow[];
  listUnrecordedRelays(): RoutedApprovalRow[];
}

// Each call looks its db.js function up at call time, so a test that mocks
// db.js partially can still import any module that creates the service.
export const dbRoutedApprovalStore: RoutedApprovalStore = {
  putEvidence: (e) => putRoutedApprovalEvidence(e),
  getEvidence: (rawPath) => getRoutedApprovalEvidence(rawPath),
  pruneEvidence: (beforeMs) => pruneRoutedApprovalEvidence(beforeMs),
  get: (key) => getRoutedApproval(key),
  insert: (row) => insertRoutedApproval(row),
  update: (key, patch) => updateRoutedApproval(key, patch),
  listOpen: () => listOpenRoutedApprovals(),
  listPendingNotices: () => listRoutedApprovalsWithPendingNotice(),
  listUnrecordedRelays: () => listRoutedApprovalsWithUnrecordedRelay(),
};

export type OwnerPingResult =
  | 'sent'
  | 'unconfigured'
  | 'failed-permanent'
  | 'failed-transient';

export type RelayPeek =
  | { state: 'none' }
  | { state: 'pending' }
  | { state: 'done'; result: OutboundEmailResult };

export interface RoutedApprovalDeps {
  store: RoutedApprovalStore;
  /** OPEN_QUESTIONS.md at the read mirror's tip (pushed, so committed). */
  readOpenQuestions(): Promise<string | null>;
  /** The admin-verified allowlist pin. */
  readAllowlist(): Promise<string | null>;
  sendEmail(
    email: OutboundEmail,
    opts: SendOutboundEmailOptions,
  ): Promise<OutboundEmailResult>;
  /** Where a relay's delivery id stands in the outbox, without waiting on it. */
  peekRelay(deliveryId: string): RelayPeek;
  /** Cancel a relay still queued or retrying; false if in flight or done. */
  cancelRelay(deliveryId: string, reason: string): boolean;
  /**
   * Fetch the read mirror. Called only by the hourly fallback scan: a push
   * already force-refreshed it, and the fetch is synchronous.
   */
  refreshMirror?(): Promise<unknown>;
  /** Telegram to Avery (G30 named exception). */
  pingOwner(text: string): Promise<OwnerPingResult>;
  /** `[ROUTED APPROVAL]` audit entry (G42: names the parent question). */
  audit(event: {
    action: string;
    key: string;
    title: string;
    detail: string;
  }): void;
  now?: () => number;
  /** How long a scan waits on a fresh relay before moving on (default 15 s). */
  relayWaitMs?: number;
}

export function relayDeliveryId(key: string, relayNumber: number): string {
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  return `routed-approval:${hash.slice(0, 24)}:relay-${relayNumber}`;
}

/**
 * G42 cap: relays go out in order, at most MAX_ROUTED_RELAYS per entry
 * (initial + one reminder). Anything else is refused, never re-sent.
 */
export function relayRefusal(
  row: Pick<RoutedApprovalRow, 'relayCount' | 'approverEmail' | 'approverName'>,
  relayNumber: number,
): string | undefined {
  if (relayNumber > MAX_ROUTED_RELAYS) {
    return `relay ${relayNumber} refused: the cap is ${MAX_ROUTED_RELAYS} relays per entry`;
  }
  if (relayNumber !== row.relayCount + 1) {
    return `relay ${relayNumber} refused: ${row.relayCount} already sent`;
  }
  if (!row.approverEmail || !row.approverName) {
    return `relay ${relayNumber} refused: no resolved approver`;
  }
  return undefined;
}

type Evaluation =
  | {
      ok: true;
      approver: Person;
      sender: Person;
      evidence: RoutedApprovalEvidence;
    }
  | { ok: false; reason: string; sender?: Person; approver?: Person };

/**
 * State lives in SQLite, never in memory, so every step survives a restart:
 *
 * - a relay is "wanted" while the row is `relayed` and fewer than
 *   MAX_ROUTED_RELAYS are confirmed; each scan asks the outbox where that
 *   relay's fixed delivery id stands and only submits it when the outbox
 *   has never seen it (an interrupted send is resumed, a retrying one is
 *   left alone, a finished one is recorded);
 * - a Telegram notice owed to Avery is `pendingNotice` on the row, cleared
 *   only when a delivered message carried it.
 */
export function createRoutedApprovalService(deps: RoutedApprovalDeps) {
  const now = deps.now ?? (() => Date.now());
  const relayWaitMs = deps.relayWaitMs ?? 15_000;
  const store = deps.store;
  let running: Promise<void> | null = null;
  let again = false;
  let refreshNext = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  function evaluate(entry: RoutedEntry, allowlist: string | null): Evaluation {
    if (!entry.rawPath) {
      return { ok: false, reason: 'the entry names no raw email (Raw:)' };
    }
    const evidence = store.getEvidence(entry.rawPath);
    if (!evidence) {
      return {
        ok: false,
        reason: `the host has no intake record for ${entry.rawPath}`,
      };
    }
    if (!entry.sender || entry.sender !== evidence.sender.toLowerCase()) {
      return {
        ok: false,
        reason: `the entry names sender ${entry.sender ?? '(none)'}, but ${entry.rawPath} came from ${evidence.sender}`,
      };
    }
    if (!allowlist) {
      return { ok: false, reason: 'the allowlist could not be read' };
    }
    const resolved = resolveRouteApprover(
      allowlist,
      evidence.sender,
      entry.approver,
    );
    if (!resolved.ok) {
      return { ok: false, reason: resolved.reason, sender: resolved.sender };
    }
    const failure = (reason: string): Evaluation => ({
      ok: false,
      reason,
      sender: resolved.sender,
      approver: resolved.approver,
    });
    if (entry.quotes.length === 0) {
      return failure("the entry has no Sender's words line");
    }
    if (entry.quotes.join('').length > MAX_QUOTE_CHARS) {
      return failure(
        `the quotes are longer than ${MAX_QUOTE_CHARS} characters`,
      );
    }
    const missing = entry.quotes.find((q) => !quoteFoundIn(q, evidence.texts));
    if (missing !== undefined) {
      return failure(
        quoteWords(missing).length < MIN_QUOTE_WORDS
          ? `a quote is shorter than ${MIN_QUOTE_WORDS} words: "${missing.slice(0, 80)}"`
          : `a quote is not in the sender's email: "${missing.slice(0, 80)}"`,
      );
    }
    const access = entry.quotes.find((q) => isAccessChange(q));
    if (access !== undefined && resolved.approver.email !== OPERATOR_EMAIL) {
      return failure(
        `the sender's words include an access or role change, which only Avery decides (G39): "${access.slice(0, 80)}"`,
      );
    }
    return {
      ok: true,
      approver: resolved.approver,
      sender: resolved.sender,
      evidence,
    };
  }

  function createRow(entry: RoutedEntry, allowlist: string | null): void {
    const verdict = evaluate(entry, allowlist);
    const evidence = verdict.ok
      ? verdict.evidence
      : entry.rawPath
        ? store.getEvidence(entry.rawPath)
        : undefined;
    const selfApproval =
      verdict.ok && verdict.approver.email === verdict.sender.email;
    const row: RoutedApprovalRow = {
      key: entry.key,
      title: entry.title.slice(0, 300),
      sender: verdict.sender?.email ?? evidence?.sender ?? entry.sender ?? '',
      senderName: verdict.sender?.name,
      approverEmail: verdict.ok
        ? verdict.approver.email
        : verdict.approver?.email,
      approverName: verdict.ok ? verdict.approver.name : verdict.approver?.name,
      subject: evidence?.subject,
      quotes: verdict.ok ? entry.quotes : [],
      // An address in a quote is body evidence only if the very same address
      // is in the inbound mail: the quote check compares words, which
      // ignores the punctuation that distinguishes two addresses.
      trustedAddresses: verdict.ok
        ? (() => {
            const inbound = new Set(
              verdict.evidence.texts.flatMap((x) =>
                inboundEmailAddressesInText(x),
              ),
            );
            return [
              ...new Set(
                entry.quotes.flatMap((q) => inboundEmailAddressesInText(q)),
              ),
            ].filter((a) => inbound.has(a));
          })()
        : [],
      receivedAt: evidence?.receivedAt,
      status: !verdict.ok ? 'held' : selfApproval ? 'notice-only' : 'relayed',
      ...(verdict.ok ? {} : { holdReason: verdict.reason }),
      createdAt: now(),
      relayCount: 0,
      relaySubmitted: 0,
      pendingNotice: 'created',
    };
    if (!store.insert(row)) return;
    deps.audit({
      action: row.status === 'held' ? 'held' : 'recorded',
      key: row.key,
      title: row.title,
      detail:
        row.status === 'held'
          ? (row.holdReason ?? '')
          : `sender ${row.sender}, approver ${row.approverEmail}`,
    });
  }

  /**
   * Record a relay's result once. Called from a scan's outbox peek and from
   * a late-resolving send, so it re-reads the row: an already recorded relay
   * is skipped, a confirmed send is always kept as history, and a failure
   * (including a cancellation) changes the status only of a row still
   * waiting to relay.
   */
  function recordRelayOutcome(
    key: string,
    relayNumber: number,
    result: OutboundEmailResult,
  ): void {
    const row = store.get(key);
    if (!row || row.relayCount >= relayNumber) return;
    if (result.status === 'sent') {
      store.update(row.key, { relayCount: relayNumber, lastRelayAt: now() });
      deps.audit({
        action: `relay ${relayNumber} sent`,
        key: row.key,
        title: row.title,
        detail: `To ${row.approverEmail}, CC ${row.sender}, Resend ${result.resendId}`,
      });
      return;
    }
    if (result.retryable) return; // the outbox is still retrying this id
    if (row.status !== 'relayed') return;
    const reason =
      relayNumber === 1 ? result.reason : `reminder relay: ${result.reason}`;
    store.update(row.key, {
      status: 'relay-failed',
      holdReason: reason,
      // A pending creation notice already reports the current status.
      ...(row.pendingNotice === 'created'
        ? {}
        : { pendingNotice: 'relay-failed' as const }),
    });
    deps.audit({
      action: `relay ${relayNumber} failed`,
      key: row.key,
      title: row.title,
      detail: `To ${row.approverEmail}, CC ${row.sender}: ${result.reason}`,
    });
  }

  /**
   * The route may have changed since the entry was recorded: every relay,
   * including one already queued or retrying, goes only to the approver the
   * current allowlist names. A changed route cancels what is queued and
   * holds the entry. (An allowlist change is a push, and every push starts a
   * scan.) True when the route still holds, or cannot be checked yet.
   */
  function routeStillValid(
    row: RoutedApprovalRow,
    relayNumber: number,
    allowlist: string | null,
  ): boolean {
    if (!allowlist) return true;
    const route = resolveRouteApprover(
      allowlist,
      row.sender,
      row.approverEmail,
    );
    if (route.ok && route.approver.email === row.approverEmail) return true;
    cancelOutstandingRelays(row, 'the approval route changed');
    store.update(row.key, {
      status: 'held',
      holdReason: `the approval route changed since the entry was recorded (${route.ok ? `now ${route.approver.email}` : route.reason})`,
      ...(row.pendingNotice === 'created'
        ? {}
        : { pendingNotice: 'held' as const }),
    });
    deps.audit({
      action: `relay ${relayNumber} held`,
      key: row.key,
      title: row.title,
      detail: 'the approval route changed',
    });
    return false;
  }

  async function advanceRelay(
    row: RoutedApprovalRow,
    allowlist: string | null,
  ): Promise<void> {
    if (row.status !== 'relayed') return;
    const relayNumber = row.relayCount + 1;
    if (relayNumber > MAX_ROUTED_RELAYS) return;
    const deliveryId = relayDeliveryId(row.key, relayNumber);
    // A finished send is recorded before anything else, so a hold below
    // never hides a relay that already went.
    const peek = deps.peekRelay(deliveryId);
    if (peek.state === 'done') {
      recordRelayOutcome(row.key, relayNumber, peek.result);
      return;
    }
    if (!routeStillValid(row, relayNumber, allowlist)) return;
    if (peek.state === 'pending') return;
    if (row.relaySubmitted >= relayNumber) {
      // Handed to the outbox, outcome never recorded, and the outbox row is
      // gone (retention). It may have been sent: never send it again.
      recordRelayOutcome(row.key, relayNumber, {
        status: 'failed',
        reason:
          'outcome unknown: the outbox record expired before it was recorded; check Resend before resending',
        retryable: false,
      });
      return;
    }
    const due =
      relayNumber === 1 || now() - row.createdAt >= ROUTED_REMINDER_MS;
    if (!due) return;
    if (!allowlist) return; // cannot confirm the route; the next scan retries
    const refusal = relayRefusal(row, relayNumber);
    const { approverEmail, approverName } = row;
    if (refusal || !approverEmail || !approverName) {
      const reason = refusal ?? 'no resolved approver';
      logger.error({ key: row.key, relayNumber }, `Routed approval: ${reason}`);
      return;
    }
    const message = buildRelayEmail({
      approver: { name: approverName, email: approverEmail },
      sender: { name: row.senderName ?? row.sender, email: row.sender },
      subject: row.subject,
      quotes: row.quotes,
      receivedAt: row.receivedAt ?? row.createdAt,
      relayNumber,
      firstRelayAt: row.lastRelayAt,
    });
    const sending = deps.sendEmail(
      {
        to: approverEmail,
        cc: row.sender,
        subject: message.subject,
        body: message.body,
      },
      {
        sourceGroup: ROUTED_SOURCE_GROUP,
        forceBotReplyTo: true,
        deliveryId,
        trustedBodyAddresses: row.trustedAddresses,
      },
    );
    // The outbox inserts its row synchronously inside the call above, so
    // from here on a missing outbox row means it expired, not "never sent".
    store.update(row.key, { relaySubmitted: relayNumber });
    const settled = sending.then(
      (result) => {
        if (result.status === 'failed' && result.retryable) {
          deps.audit({
            action: `relay ${relayNumber} retrying`,
            key: row.key,
            title: row.title,
            detail: `To ${approverEmail}: ${result.reason}; the outbox retries it`,
          });
        }
        recordRelayOutcome(row.key, relayNumber, result);
      },
      (err) => {
        // A call that failed before the outbox row existed was never sent.
        if (deps.peekRelay(deliveryId).state === 'none') {
          store.update(row.key, { relaySubmitted: relayNumber - 1 });
        }
        logger.error({ err, key: row.key, relayNumber }, 'Relay send failed');
      },
    );
    // Wait a little, so the usual case reports the result in this scan's
    // notice, but never for a relay queued behind other mail: the scan must
    // stay free to cancel it when a push closes the entry.
    await Promise.race([
      settled,
      new Promise((resolve) => setTimeout(resolve, relayWaitMs).unref?.()),
    ]);
  }

  /**
   * Relays handed to the outbox but not recorded, on rows that no longer
   * relay (held, closed, removed, failed): a confirmed send is kept as
   * history; a terminal failure, or a record the outbox has dropped, settles
   * the row so it is not polled again. Rows still relaying are left to
   * advanceRelay, which owns their outcome.
   */
  function reconcileLateSends(): void {
    for (const row of store.listUnrecordedRelays()) {
      if (row.status === 'relayed') continue;
      const n = row.relayCount + 1;
      const peek = deps.peekRelay(relayDeliveryId(row.key, n));
      if (peek.state === 'pending') continue;
      if (peek.state === 'done' && peek.result.status === 'sent') {
        recordRelayOutcome(row.key, n, peek.result);
        continue;
      }
      store.update(row.key, { relaySubmitted: row.relayCount });
    }
  }

  /** A decided entry must not have a relay still waiting in the outbox. */
  function cancelOutstandingRelays(row: RoutedApprovalRow, why: string) {
    for (let n = row.relayCount + 1; n <= MAX_ROUTED_RELAYS; n++) {
      if (deps.cancelRelay(relayDeliveryId(row.key, n), `cancelled: ${why}`)) {
        deps.audit({
          action: `relay ${n} cancelled`,
          key: row.key,
          title: row.title,
          detail: why,
        });
      }
    }
  }

  /** Owe Avery a reminder every 3 days once the approver phase is over. */
  function planOwnerReminder(row: RoutedApprovalRow): void {
    if (row.pendingNotice || row.ownerNotifiedAt === undefined) return;
    if (row.status === 'relayed' && row.relayCount < MAX_ROUTED_RELAYS) {
      return; // the day-3 approver reminder comes before any owner reminder
    }
    const since = Math.max(
      row.lastOwnerPingAt ?? row.createdAt,
      row.lastRelayAt ?? 0,
    );
    if (now() - since >= ROUTED_REMINDER_MS) {
      store.update(row.key, { pendingNotice: 'reminder' });
    }
  }

  async function flushNotices(): Promise<void> {
    const owed = store.listPendingNotices();
    if (owed.length === 0) return;
    // One Telegram message per scan, so a burst of bad entries cannot become
    // a burst of pings. Notices that do not fit stay owed for the next scan.
    const t = now();
    const included: RoutedApprovalRow[] = [];
    let text = '';
    for (const row of owed) {
      const notice = buildOwnerNotice(row.pendingNotice!, row, t);
      const next = text ? `${text}\n\n---\n\n${notice}` : notice;
      if (included.length > 0 && next.length > TELEGRAM_TEXT_LIMIT) break;
      text = next.slice(0, TELEGRAM_TEXT_LIMIT);
      included.push(row);
    }
    if (included.length < owed.length) {
      text += `\n\n(${owed.length - included.length} more routed-approval notices follow in the next scan)`;
    }
    const result = await deps.pingOwner(text);
    if (result !== 'sent') {
      logger.error(
        { result, count: owed.length },
        'Routed approval: owner notice not delivered; the next scan retries it',
      );
      return;
    }
    for (const sent of included) {
      // The row may have changed while Telegram was sending (a late relay
      // result). Clear the notice only if the delivered text still describes
      // it; otherwise owe a follow-up about the new state.
      const current = store.get(sent.key);
      if (!current) continue;
      const unchanged =
        current.pendingNotice === sent.pendingNotice &&
        current.status === sent.status &&
        current.holdReason === sent.holdReason;
      const followUp: RoutedApprovalNotice | undefined =
        current.pendingNotice !== sent.pendingNotice
          ? current.pendingNotice
          : unchanged
            ? undefined
            : current.status === 'relay-failed'
              ? 'relay-failed'
              : current.status === 'held'
                ? 'held'
                : current.status === 'removed'
                  ? 'removed'
                  : undefined;
      store.update(sent.key, {
        pendingNotice: followUp,
        lastOwnerPingAt: t,
        ...(sent.pendingNotice === 'created' ? { ownerNotifiedAt: t } : {}),
      });
    }
  }

  /**
   * `reconcileOnly` (startup, before the outbox replays queued mail): apply
   * closures and removals, cancel their queued relays, record late sends,
   * record new entries; submit no relay and send no notice.
   */
  async function scanOnce(
    refresh: boolean,
    reconcileOnly = false,
  ): Promise<void> {
    if (refresh) {
      try {
        await deps.refreshMirror?.();
      } catch (err) {
        logger.warn({ err }, 'Routed approval scan: mirror refresh failed');
      }
    }
    const t = now();
    store.pruneEvidence(t - EVIDENCE_RETENTION_MS);
    const md = await deps.readOpenQuestions();
    const allowlist = await deps.readAllowlist();
    const seenOpen = new Set<string>();
    reconcileLateSends();
    if (md === null) {
      logger.warn('Routed approval scan: OPEN_QUESTIONS.md unavailable');
    } else {
      const sectionPresent = hasRoutedApprovalsSection(md);
      // One entry per raw email. Should two share a key, the first one is the
      // record and the email stays open while any of them is open.
      const byKey = new Map<string, RoutedEntry>();
      for (const e of parseRoutedApprovals(md)) {
        const first = byKey.get(e.key);
        if (!first) byKey.set(e.key, e);
        else if (e.open) first.open = true;
      }
      for (const e of byKey.values()) if (e.open) seenOpen.add(e.key);
      for (const entry of byKey.values()) {
        try {
          const row = store.get(entry.key);
          if (!row) {
            if (entry.open) createRow(entry, allowlist);
          } else if (
            !entry.open &&
            row.status !== 'closed' &&
            row.status !== 'removed'
          ) {
            store.update(row.key, { status: 'closed', closedAt: t });
            cancelOutstandingRelays(row, 'the entry was closed');
            deps.audit({
              action: 'closed',
              key: row.key,
              title: row.title,
              detail: `open ${Math.floor((t - row.createdAt) / 86_400_000)} days`,
            });
          }
        } catch (err) {
          logger.error({ err, key: entry.key }, 'Routed approval entry failed');
        }
      }
      if (sectionPresent) {
        for (const row of store.listOpen()) {
          if (byKey.has(row.key)) continue;
          store.update(row.key, {
            status: 'removed',
            closedAt: t,
            pendingNotice: 'removed',
          });
          cancelOutstandingRelays(row, 'the entry was removed');
          deps.audit({
            action: 'removed',
            key: row.key,
            title: row.title,
            detail: 'the entry is gone from OPEN_QUESTIONS.md without a close',
          });
        }
      }
    }

    if (reconcileOnly) {
      // Before the outbox replays: a queued relay must not reach an approver
      // whose route changed while the process was down.
      for (const row of store.listOpen()) {
        if (row.status !== 'relayed') continue;
        try {
          routeStillValid(row, row.relayCount + 1, allowlist);
        } catch (err) {
          logger.error({ err, key: row.key }, 'Routed approval step failed');
        }
      }
      return;
    }
    for (const row of store.listOpen()) {
      try {
        // A relay goes only for an entry this scan read as open: an
        // unreadable file or a missing section defers it, never sends it.
        if (seenOpen.has(row.key)) await advanceRelay(row, allowlist);
        planOwnerReminder(store.get(row.key) ?? row);
      } catch (err) {
        logger.error({ err, key: row.key }, 'Routed approval step failed');
      }
    }
    await flushNotices();
  }

  function scanSoon(opts: { refresh?: boolean } = {}): Promise<void> {
    if (opts.refresh) refreshNext = true;
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        const refresh = refreshNext;
        refreshNext = false;
        try {
          await scanOnce(refresh);
        } catch (err) {
          logger.error({ err }, 'Routed approval scan failed');
        }
      } while (again);
    })().finally(() => {
      running = null;
    });
    return running;
  }

  return {
    /**
     * Before the outbox replays queued mail after a restart: catch up on
     * closures and route changes made while the process was down and cancel
     * their relays. Awaited in full (no shorter cap: a cap that ends first
     * would let the outbox replay before the check). It is bounded by the
     * mirror fetch's own 30 s timeout; if the fetch fails it checks against
     * the last fetched copy.
     */
    async reconcileBeforeReplay(): Promise<void> {
      if (running) await running;
      await scanOnce(true, true).catch((err) =>
        logger.error({ err }, 'Routed approval startup reconcile failed'),
      );
    },
    /** Intake: the host's own copy of an inbound email. Never throws. */
    recordEvidence(e: RoutedApprovalEvidence): void {
      try {
        store.putEvidence({
          ...e,
          rawPath: normalizeRawPath(e.rawPath),
          sender: e.sender.toLowerCase().trim(),
          // Capped so intake stays cheap on a huge email; a quote beyond
          // the cap fails the check and is held, which is the safe side.
          texts: e.texts
            .filter((x) => x.trim() !== '')
            .map((x) => x.slice(0, MAX_EVIDENCE_TEXT_CHARS)),
        });
      } catch (err) {
        logger.error(
          { err, rawPath: e.rawPath },
          'Routed approval: intake evidence not stored',
        );
      }
    },
    scanSoon,
    start(intervalMs = SCAN_INTERVAL_MS): void {
      if (timer) return;
      // The hourly fallback fetches first: it exists for a missed push.
      timer = setInterval(() => void scanSoon({ refresh: true }), intervalMs);
      timer.unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

export type RoutedApprovalService = ReturnType<
  typeof createRoutedApprovalService
>;
