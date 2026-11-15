import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  resolveKbTriageApproverCc,
  snapshotKbConflictTriage,
} from './kb-triage-cc.js';

const ALLOWLIST = `
| Name | Email | Title | Access | Role / domain (gatekeeping) |
|------|-------|-------|--------|------------------------------|
| Avery Morgan | avery@example.edu | Faculty | read-write | Program Director - content; **gate approver: content** |
| Dana A. Ortiz | dortiz@example.edu | Staff | read-write | Structure: sequencing; **gate approver: structure** |
| Omar Lee Haddad | ohaddad@example.edu | Staff | read-write | Governance / decisions; **gate approver: governance (escalation)** |
| Paige E. Foster | pfoster1@example.edu | Operations | read-write | Operations |

## Gatekeeping routing (policy - convention now, not yet code-enforced)

| Source-of-truth change about... | Approver |
|---|---|
| Course content, CLOs, academic vision | **Avery** (content) |
| Sequencing, prep pathways, credits, program structure | **Dana** (structure) - Avery fallback while ramping |
| Program governance / high-level calls | **Omar** (escalation) - usually via Avery |
`;

const STRUCTURE_CONFLICT = `
## Spring 2031 sequence revised: Combined elective course + CRS 558 timing shift - [CONFLICTED - requires human review]

### Proposed entry (not committed)

### Spring 2031 sequence revised: Combined elective course + CRS 558 timing shift

- **Date:** 2026-06-01
- **Category:** Curriculum & Courses
- **Stakeholders:** Dana Ortiz (confirming), Vikram Bhatt, Caleb Park, Rohan Sen
- **Decision:** Two changes to Spring 2031 sequencing confirmed by Dana Ortiz with all affected faculty:
  1. Two elective topics combine into one course.
  2. CRS 558 shifts to a later start.
`;

const CONTENT_CONFLICT = `
## CRS 554 CLO rewrite - [CONFLICTED - requires human review]

### Proposed entry (not committed)

- **Category:** Curriculum & Courses
- **Decision:** CRS 554 CLOs and weekly course content are revised.
`;

const GOVERNANCE_CONFLICT = `
## Governance approval model - [CONFLICTED - requires human review]

### Proposed entry (not committed)

- **Category:** Program & Governance
- **Decision:** High-level program governance decisions require Associate Dean confirmation before publication.
`;

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-triage-cc-'));
  fs.mkdirSync(path.join(repo, 'discussions', 'kb-triage'), {
    recursive: true,
  });
  return repo;
}

function writeTriage(repo: string, name: string, text: string): void {
  fs.writeFileSync(path.join(repo, 'discussions', 'kb-triage', name), text);
}

describe('kb-triage approver CC resolution', () => {
  const repos: string[] = [];

  afterEach(() => {
    for (const repo of repos.splice(0)) {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('CCs the fallback when the sender is the structure approver', () => {
    const repo = makeRepo();
    repos.push(repo);
    const before = snapshotKbConflictTriage(repo);

    writeTriage(repo, '2026-06-01-conflicts.md', STRUCTURE_CONFLICT);

    expect(
      resolveKbTriageApproverCc({
        repoPath: repo,
        before,
        allowlistContent: ALLOWLIST,
        senderEmail: 'dortiz@example.edu',
      }),
    ).toBe('avery@example.edu');
  });

  it('CCs the structure approver when the sender is not the approver', () => {
    const repo = makeRepo();
    repos.push(repo);
    const before = snapshotKbConflictTriage(repo);

    writeTriage(repo, '2026-06-01-conflicts.md', STRUCTURE_CONFLICT);

    expect(
      resolveKbTriageApproverCc({
        repoPath: repo,
        before,
        allowlistContent: ALLOWLIST,
        senderEmail: 'pfoster1@example.edu',
      }),
    ).toBe('dortiz@example.edu');
  });

  it('uses only the newly appended conflict text when a daily triage file already exists', () => {
    const repo = makeRepo();
    repos.push(repo);
    writeTriage(repo, '2026-06-01-conflicts.md', CONTENT_CONFLICT);
    const before = snapshotKbConflictTriage(repo);

    fs.appendFileSync(
      path.join(repo, 'discussions', 'kb-triage', '2026-06-01-conflicts.md'),
      `\n\n---\n${STRUCTURE_CONFLICT}`,
    );

    expect(
      resolveKbTriageApproverCc({
        repoPath: repo,
        before,
        allowlistContent: ALLOWLIST,
        senderEmail: 'pfoster1@example.edu',
      }),
    ).toBe('dortiz@example.edu');
  });

  it('does not CC anyone when the run did not create or update a conflict triage file', () => {
    const repo = makeRepo();
    repos.push(repo);
    const before = snapshotKbConflictTriage(repo);

    fs.mkdirSync(path.join(repo, 'discussions'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'discussions', 'DECISIONS.md'), 'clean');

    expect(
      resolveKbTriageApproverCc({
        repoPath: repo,
        before,
        allowlistContent: ALLOWLIST,
        senderEmail: 'pfoster1@example.edu',
      }),
    ).toBeUndefined();
  });

  it('ignores behaviour-sensor response-error triage files', () => {
    const repo = makeRepo();
    repos.push(repo);
    const before = snapshotKbConflictTriage(repo);

    writeTriage(repo, '2026-06-01-response-error.md', GOVERNANCE_CONFLICT);

    expect(
      resolveKbTriageApproverCc({
        repoPath: repo,
        before,
        allowlistContent: ALLOWLIST,
        senderEmail: 'pfoster1@example.edu',
      }),
    ).toBeUndefined();
  });

  it('routes governance conflicts to the governance escalation approver', () => {
    const repo = makeRepo();
    repos.push(repo);
    const before = snapshotKbConflictTriage(repo);

    writeTriage(repo, '2026-06-01-conflicts.md', GOVERNANCE_CONFLICT);

    expect(
      resolveKbTriageApproverCc({
        repoPath: repo,
        before,
        allowlistContent: ALLOWLIST,
        senderEmail: 'pfoster1@example.edu',
      }),
    ).toBe('ohaddad@example.edu');
  });

  it('routes content conflicts to Avery', () => {
    const repo = makeRepo();
    repos.push(repo);
    const before = snapshotKbConflictTriage(repo);

    writeTriage(repo, '2026-06-01-conflicts.md', CONTENT_CONFLICT);

    expect(
      resolveKbTriageApproverCc({
        repoPath: repo,
        before,
        allowlistContent: ALLOWLIST,
        senderEmail: 'srivera@example.edu',
      }),
    ).toBe('avery@example.edu');
  });
});
