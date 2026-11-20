#!/usr/bin/env npx tsx
/**
 * Seed script to create the weekly quality-review and knowledge-builder
 * scheduled tasks. Run once on the VPS after deploying the auto-optimization
 * framework:
 *
 *   npx tsx scripts/seed-optimization-tasks.ts
 *
 * Safe to re-run — skips tasks that already exist.
 */

import { createTask, getTaskById } from '../src/db.js';
import { computeNextRun } from '../src/task-scheduler.js';
import type { ScheduledTask } from '../src/types.js';

const GROUP_FOLDER = 'program-email';
const CHAT_JID = 'webhook-email@program';

const tasks: Omit<ScheduledTask, 'last_run' | 'last_result'>[] = [
  {
    id: 'weekly-quality-review',
    group_folder: GROUP_FOLDER,
    chat_jid: CHAT_JID,
    prompt:
      'Run the quality-review skill. Read the eval report and this week\'s audit logs, then generate and commit QUALITY_REVIEW.md.',
    schedule_type: 'cron',
    schedule_value: '0 9 * * 5', // Friday 9 AM (Central, per TZ env)
    context_mode: 'isolated',
    next_run: null,
    status: 'active',
    created_at: new Date().toISOString(),
  },
  {
    id: 'weekly-knowledge-builder',
    group_folder: GROUP_FOLDER,
    chat_jid: CHAT_JID,
    prompt:
      'Run the knowledge-builder skill. Read this week\'s audit logs and eval data, then update docs/faq.md and discussions/PATTERNS.md and commit.',
    schedule_type: 'cron',
    schedule_value: '0 9 * * 3', // Wednesday 9 AM (Central, per TZ env)
    context_mode: 'isolated',
    next_run: null,
    status: 'active',
    created_at: new Date().toISOString(),
  },
];

for (const task of tasks) {
  const existing = getTaskById(task.id);
  if (existing) {
    console.log(`⏭  Task "${task.id}" already exists (status: ${existing.status}), skipping`);
    continue;
  }

  // Compute first next_run from the cron expression
  const nextRun = computeNextRun(task as ScheduledTask);
  task.next_run = nextRun;

  createTask(task);
  console.log(`✅ Created task "${task.id}" — next run: ${nextRun}`);
}

console.log('\nDone.');
