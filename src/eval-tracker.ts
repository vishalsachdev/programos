/**
 * Eval Tracker — Auto-Optimization Framework
 *
 * Parses structured self-evaluation metadata from agent responses
 * (embedded in <internal><eval>...</eval></internal> blocks) and stores
 * them in SQLite for trend analysis and quality review.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { channelFromJid } from './channel-utils.js';
import { STORE_DIR } from './config.js';
import { logger } from './logger.js';
import { assertSafeDbPath } from './host-fs-safety.js';

export interface ResponseEval {
  chat_jid: string;
  channel: string;
  timestamp: string;
  confidence: 'high' | 'medium' | 'low';
  has_citation: boolean;
  category: 'question' | 'status_update' | 'outreach' | 'scheduled';
  topics: string[];
  response_length: number;
  eval_notes: string | null;
}

/** Validated eval fields extracted from agent output. All required fields present. */
export interface ValidatedEval {
  confidence: 'high' | 'medium' | 'low';
  has_citation: boolean;
  category: 'question' | 'status_update' | 'outreach' | 'scheduled';
  topics: string[];
  eval_notes: string | null;
}

const VALID_CONFIDENCE = new Set(['high', 'medium', 'low']);
const VALID_CATEGORY = new Set([
  'question',
  'status_update',
  'outreach',
  'scheduled',
]);

const MAX_TOPICS = 5;
const MAX_TOPIC_LENGTH = 50;
const MAX_NOTES_LENGTH = 500;

let db: Database.Database;

/** One schema definition for prod and test DBs — a column change lands in both. */
function createEvalSchema(target: Database.Database): void {
  target.exec(`
    CREATE TABLE IF NOT EXISTS response_evals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      channel TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      confidence TEXT NOT NULL,
      has_citation INTEGER NOT NULL,
      category TEXT NOT NULL,
      topics TEXT NOT NULL,
      response_length INTEGER NOT NULL,
      eval_notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_eval_timestamp ON response_evals(timestamp);
    CREATE INDEX IF NOT EXISTS idx_eval_channel ON response_evals(channel);
    CREATE INDEX IF NOT EXISTS idx_eval_confidence ON response_evals(confidence);
  `);
}

function getDb(): Database.Database {
  if (db) return db;

  const dbPath = path.join(STORE_DIR, 'evals.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  assertSafeDbPath(dbPath); // store/ is writable for the main group
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  createEvalSchema(db);

  return db;
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestEvalDb(): void {
  db = new Database(':memory:');
  createEvalSchema(db);
}

/**
 * Extract eval JSON from raw agent output.
 * Agents embed: <internal><eval>{"confidence":"high",...}</eval></internal>
 * Requires the <internal> wrapper to avoid false matches from quoted code examples.
 * Extracts the LAST match to avoid picking up quoted examples earlier in the response.
 * Returns null if no eval block found or required fields are invalid.
 */
export function extractEval(rawText: string): ValidatedEval | null {
  // Find all matches and use the last one (the agent's actual eval, not a quoted example)
  const regex = /<internal>\s*<eval>([\s\S]*?)<\/eval>\s*<\/internal>/g;
  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(rawText)) !== null) {
    lastMatch = m;
  }
  if (!lastMatch) return null;

  try {
    const parsed = JSON.parse(lastMatch[1].trim());
    const confidence = VALID_CONFIDENCE.has(parsed.confidence)
      ? (parsed.confidence as ValidatedEval['confidence'])
      : 'medium';
    const category = VALID_CATEGORY.has(parsed.category)
      ? (parsed.category as ValidatedEval['category'])
      : 'question';

    // Strict boolean parse: only true/false booleans count, not truthy strings
    const has_citation = parsed.has_citation === true;

    // Normalize and bound topics
    const rawTopics = Array.isArray(parsed.topics) ? parsed.topics : [];
    const topics = rawTopics
      .filter(
        (t: unknown): t is string => typeof t === 'string' && t.length > 0,
      )
      .slice(0, MAX_TOPICS)
      .map((t: string) => t.slice(0, MAX_TOPIC_LENGTH));

    // Truncate notes
    const notes =
      typeof parsed.notes === 'string' && parsed.notes.length > 0
        ? parsed.notes.slice(0, MAX_NOTES_LENGTH)
        : null;

    return {
      confidence,
      has_citation,
      category,
      topics,
      eval_notes: notes,
    };
  } catch (err) {
    logger.warn(
      { err, raw: lastMatch[1].slice(0, 200) },
      'Failed to parse eval block',
    );
    return null;
  }
}

/**
 * Record a response evaluation.
 * Called from the streaming output callback in index.ts.
 */
export function recordEval(
  chatJid: string,
  rawText: string,
  cleanTextLength: number,
): void {
  const evalData = extractEval(rawText);
  if (!evalData) return;

  try {
    const database = getDb();
    database
      .prepare(
        `INSERT INTO response_evals (chat_jid, channel, timestamp, confidence, has_citation, category, topics, response_length, eval_notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        chatJid,
        channelFromJid(chatJid),
        new Date().toISOString(),
        evalData.confidence,
        evalData.has_citation ? 1 : 0,
        evalData.category,
        JSON.stringify(evalData.topics),
        cleanTextLength,
        evalData.eval_notes,
      );
    logger.debug(
      {
        chatJid,
        confidence: evalData.confidence,
        category: evalData.category,
      },
      'Eval recorded',
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to record eval');
  }
}

// --- Query functions for quality review ---

export interface EvalSummary {
  total: number;
  by_confidence: Record<string, number>;
  by_category: Record<string, number>;
  by_channel: Record<string, number>;
  citation_rate: number;
  avg_response_length: number;
  low_confidence_entries: Array<{
    timestamp: string;
    channel: string;
    category: string;
    eval_notes: string | null;
  }>;
  top_topics: Array<{ topic: string; count: number }>;
}

/**
 * Get eval summary for a date range (ISO strings).
 */
export function getEvalSummary(since: string, until?: string): EvalSummary {
  const database = getDb();
  const untilDate = until || new Date().toISOString();

  const rows = database
    .prepare(
      `SELECT * FROM response_evals WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp`,
    )
    .all(since, untilDate) as Array<{
    id: number;
    chat_jid: string;
    channel: string;
    timestamp: string;
    confidence: string;
    has_citation: number;
    category: string;
    topics: string;
    response_length: number;
    eval_notes: string | null;
  }>;

  const summary: EvalSummary = {
    total: rows.length,
    by_confidence: {},
    by_category: {},
    by_channel: {},
    citation_rate: 0,
    avg_response_length: 0,
    low_confidence_entries: [],
    top_topics: [],
  };

  if (rows.length === 0) return summary;

  let citationCount = 0;
  let totalLength = 0;
  const topicCounts: Record<string, number> = {};

  for (const row of rows) {
    // Confidence
    summary.by_confidence[row.confidence] =
      (summary.by_confidence[row.confidence] || 0) + 1;

    // Category
    summary.by_category[row.category] =
      (summary.by_category[row.category] || 0) + 1;

    // Channel
    summary.by_channel[row.channel] =
      (summary.by_channel[row.channel] || 0) + 1;

    // Citations
    if (row.has_citation) citationCount++;

    // Length
    totalLength += row.response_length;

    // Topics
    try {
      const topics: string[] = JSON.parse(row.topics);
      for (const t of topics) {
        topicCounts[t] = (topicCounts[t] || 0) + 1;
      }
    } catch {
      /* ignore */
    }

    // Low confidence
    if (row.confidence === 'low') {
      summary.low_confidence_entries.push({
        timestamp: row.timestamp,
        channel: row.channel,
        category: row.category,
        eval_notes: row.eval_notes,
      });
    }
  }

  summary.citation_rate = citationCount / rows.length;
  summary.avg_response_length = Math.round(totalLength / rows.length);
  summary.top_topics = Object.entries(topicCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([topic, count]) => ({ topic, count }));

  return summary;
}

/**
 * Export eval data as markdown for the quality review agent.
 */
export function exportEvalReport(since: string, until?: string): string {
  const summary = getEvalSummary(since, until);

  const lines: string[] = [
    `# Quality Review Data`,
    ``,
    `**Period:** ${since.split('T')[0]} to ${(until || new Date().toISOString()).split('T')[0]}`,
    `**Total responses evaluated:** ${summary.total}`,
    ``,
    `## Confidence Distribution`,
    ...Object.entries(summary.by_confidence).map(
      ([k, v]) => `- ${k}: ${v} (${Math.round((v / summary.total) * 100)}%)`,
    ),
    ``,
    `## Category Breakdown`,
    ...Object.entries(summary.by_category).map(([k, v]) => `- ${k}: ${v}`),
    ``,
    `## Channel Distribution`,
    ...Object.entries(summary.by_channel).map(([k, v]) => `- ${k}: ${v}`),
    ``,
    `## Key Metrics`,
    `- Citation rate: ${Math.round(summary.citation_rate * 100)}%`,
    `- Average response length: ${summary.avg_response_length} chars`,
    ``,
    `## Top Topics`,
    ...summary.top_topics.map(
      ({ topic, count }) => `- ${topic}: ${count} mentions`,
    ),
    ``,
  ];

  if (summary.low_confidence_entries.length > 0) {
    lines.push(
      `## Low Confidence Responses (needs attention)`,
      ...summary.low_confidence_entries.map(
        (e) =>
          `- ${e.timestamp.split('T')[0]} [${e.channel}/${e.category}]: ${e.eval_notes || 'no notes'}`,
      ),
      ``,
    );
  }

  return lines.join('\n');
}
