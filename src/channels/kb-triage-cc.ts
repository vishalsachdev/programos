import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { extractAddresses } from '../cc-context.js';

export interface KbConflictTriageSnapshot {
  files: Record<string, { hash: string; size: number; mtimeMs: number }>;
}

type GateDomain = 'content' | 'structure' | 'governance';

interface GateApprover {
  name: string;
  email: string;
}

interface ChangedTriageText {
  text: string;
  mtimeMs: number;
}

const TRIAGE_DIR = path.join('discussions', 'kb-triage');
const CONFLICT_FILE_RE = /^\d{4}-\d{2}-\d{2}-conflicts\.md$/;

/** First lowercased bare address in a string (canonical extractor lives in cc-context). */
function normalizeEmail(value: string | undefined): string | undefined {
  return extractAddresses(value)[0];
}

function hashBuffer(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Process-lifetime {size, mtimeMs} → hash memo. The conflicts directory only
 * grows over repo lifetime, and every inbound email snapshots ALL of it —
 * without this, each intake re-reads and re-hashes files that have not
 * changed in months. A same-size same-mtime file is treated as unchanged
 * (the git racily-clean heuristic); any stat change re-reads and re-hashes.
 */
const hashMemo = new Map<
  string,
  { size: number; mtimeMs: number; hash: string }
>();

function fileRecord(
  absPath: string,
): { hash: string; size: number; mtimeMs: number } | null {
  const stat = fs.statSync(absPath);
  if (!stat.isFile()) return null;
  const cached = hashMemo.get(absPath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached;
  }
  const record = {
    hash: hashBuffer(fs.readFileSync(absPath)),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
  hashMemo.set(absPath, record);
  return record;
}

function conflictTriageDir(repoPath: string): string {
  return path.join(repoPath, TRIAGE_DIR);
}

function listConflictFiles(repoPath: string): string[] {
  try {
    return fs
      .readdirSync(conflictTriageDir(repoPath))
      .filter((name) => CONFLICT_FILE_RE.test(name))
      .sort();
  } catch {
    return [];
  }
}

function relConflictPath(filename: string): string {
  return `discussions/kb-triage/${filename}`;
}

export function snapshotKbConflictTriage(
  repoPath: string,
): KbConflictTriageSnapshot {
  const files: KbConflictTriageSnapshot['files'] = {};

  for (const filename of listConflictFiles(repoPath)) {
    const absPath = path.join(conflictTriageDir(repoPath), filename);
    try {
      const record = fileRecord(absPath);
      if (record) files[relConflictPath(filename)] = record;
    } catch {
      // Best effort: a missing or unreadable triage file should not block mail.
    }
  }

  return { files };
}

function changedConflictTexts(
  repoPath: string,
  before: KbConflictTriageSnapshot,
): ChangedTriageText[] {
  const changes: ChangedTriageText[] = [];

  for (const filename of listConflictFiles(repoPath)) {
    const relPath = relConflictPath(filename);
    const absPath = path.join(conflictTriageDir(repoPath), filename);

    try {
      const previous = before.files[relPath];
      const stat = fs.statSync(absPath);
      if (!stat.isFile()) continue;
      // Same size + mtime as the intake snapshot → unchanged during the
      // turn; skip the read + hash entirely (most of the ever-growing
      // history directory takes this path on every reply).
      if (
        previous &&
        previous.size === stat.size &&
        previous.mtimeMs === stat.mtimeMs
      ) {
        continue;
      }
      const buffer = fs.readFileSync(absPath);
      const current = {
        hash: hashBuffer(buffer),
        size: buffer.length,
        mtimeMs: stat.mtimeMs,
      };
      if (previous?.hash === current.hash) continue;

      const text =
        previous && current.size > previous.size
          ? buffer.subarray(previous.size).toString('utf8')
          : buffer.toString('utf8');
      changes.push({ text, mtimeMs: current.mtimeMs });
    } catch {
      // Best effort. If the file vanishes during the check, ignore it.
    }
  }

  return changes.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

function cleanName(value: string): string {
  return value.replace(/\*\*/g, '').trim();
}

function parseGateApprovers(
  allowlistContent: string | null,
): Partial<Record<GateDomain, GateApprover>> {
  const approvers: Partial<Record<GateDomain, GateApprover>> = {};
  if (!allowlistContent) return approvers;

  for (const line of allowlistContent.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
    if (cells.length < 2) continue;

    const roleText = cells.join(' ');
    const domainMatch = roleText.match(
      /\*\*gate approver:\s*(content|structure|governance)\b/i,
    );
    const email = normalizeEmail(cells[1]);
    if (!domainMatch || !email) continue;

    const domain = domainMatch[1].toLowerCase() as GateDomain;
    approvers[domain] = {
      name: cleanName(cells[0]),
      email,
    };
  }

  return approvers;
}

function classifyTriageDomain(text: string): GateDomain {
  const lower = text.toLowerCase();

  if (
    /\*\*category:\*\*\s*program\s*&\s*governance/i.test(text) ||
    /\b(governance|associate dean|high-level|program-level|approval model)\b/.test(
      lower,
    )
  ) {
    return 'governance';
  }

  if (
    /\*\*category:\*\*\s*onboarding\s*&\s*prerequisites/i.test(text) ||
    /\b(sequenc(?:e|ing)|prep pathways?|preparatory|prerequisites?|credits?|program structure|timing shift|start date|course order|curriculum structure|delivery plan|semester|pot [ab])\b/.test(
      lower,
    ) ||
    /\bweeks?\s+\d+\b/.test(lower) ||
    /\b(spring|summer|fall)\s+20\d{2}\b/.test(lower)
  ) {
    return 'structure';
  }

  return 'content';
}

function fallbackApprover(
  domain: GateDomain,
  approvers: Partial<Record<GateDomain, GateApprover>>,
): GateApprover | undefined {
  if (domain === 'structure' || domain === 'governance') {
    return approvers.content;
  }
  return undefined;
}

function selectApproverCc(
  triageText: string,
  allowlistContent: string | null,
  senderEmail: string | undefined,
): string | undefined {
  const approvers = parseGateApprovers(allowlistContent);
  const domain = classifyTriageDomain(triageText);
  const sender = normalizeEmail(senderEmail);
  const primary = approvers[domain] ?? approvers.content;
  const selected =
    primary && sender === primary.email
      ? fallbackApprover(domain, approvers)
      : primary;

  if (!selected) return undefined;
  if (sender && selected.email === sender) return undefined;
  return selected.email;
}

export function resolveKbTriageApproverCc(opts: {
  repoPath: string;
  before: KbConflictTriageSnapshot;
  allowlistContent: string | null;
  senderEmail: string | undefined;
}): string | undefined {
  const changedText = changedConflictTexts(opts.repoPath, opts.before)
    .map((change) => change.text)
    .join('\n\n---\n');
  if (!changedText.trim()) return undefined;

  return selectApproverCc(changedText, opts.allowlistContent, opts.senderEmail);
}
