/**
 * Test fixture: a local bare "origin", the agent-writable checkout cloned
 * from it, and the settings that point the host at both. Real git, no
 * network. Used by the host-repo tests and the adversarial suite.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { vi } from 'vitest';

export const AGENT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Agent',
  GIT_AUTHOR_EMAIL: 'agent@example.org',
  GIT_COMMITTER_NAME: 'Agent',
  GIT_COMMITTER_EMAIL: 'agent@example.org',
  GIT_TERMINAL_PROMPT: '0',
};

/** Run git the way the agent or a person would: with the repo's own config. */
export function git(cwd: string, args: string[], env: object = {}): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: '/nonexistent', ...AGENT_ENV, ...env },
  });
}

export interface KbFixture {
  root: string;
  origin: string;
  checkout: string;
  host: string;
  mirror: string;
  /** A second bare repo that must never receive anything. */
  decoy: string;
  /** A file that must never be created. */
  canary: string;
  /** A script that appends its arguments to the canary. */
  canaryScript: string;
  /** Commit a file in the checkout, as the agent. */
  agentCommit(file: string, content: string, message?: string): string;
  /** Push a commit to the origin from a separate clone, as a person. */
  personCommit(file: string, content: string, email?: string): string;
  originLog(format?: string): string[];
  originFile(file: string): string | null;
  canaryLines(): string[];
  decoyRefs(): string;
  cleanup(): void;
}

export function makeKbFixture(): KbFixture {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'kb-fixture-')),
  );
  const origin = path.join(root, 'origin.git');
  const checkout = path.join(root, 'checkout');
  const host = path.join(root, 'host');
  const mirror = path.join(root, 'mirror.git');
  const decoy = path.join(root, 'decoy.git');
  const person = path.join(root, 'person');
  const canary = path.join(root, 'canary');
  const canaryScript = path.join(root, 'canary.sh');

  git(root, ['init', '-q', '--bare', '--template=', origin]);
  git(origin, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(root, ['init', '-q', '--bare', '--template=', decoy]);
  git(root, ['init', '-q', '--template=', person]);
  git(person, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(person, ['remote', 'add', 'origin', origin]);
  fs.mkdirSync(path.join(person, 'program'));
  fs.writeFileSync(path.join(person, 'program', 'curriculum.md'), 'v1\n');
  fs.writeFileSync(path.join(person, 'README.md'), 'kb\n');
  fs.mkdirSync(path.join(person, 'discussions', 'kb-triage'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(person, 'discussions', 'kb-triage', 'README.md'),
    'triage\n',
  );
  git(person, ['add', '-A']);
  git(person, ['commit', '-q', '-m', 'seed'], {
    GIT_AUTHOR_EMAIL: 'avery@example.edu',
  });
  git(person, ['push', '-q', 'origin', 'main']);
  git(root, ['clone', '-q', '--template=', origin, checkout]);
  // The agent's identity, as a real checkout has it.
  git(checkout, ['config', 'user.name', 'Agent']);
  git(checkout, ['config', 'user.email', 'agent@example.org']);
  fs.writeFileSync(
    canaryScript,
    `#!/bin/sh\necho "$0 $*" >> '${canary}'\nexit 0\n`,
    { mode: 0o755 },
  );

  vi.stubEnv('PROGRAM_REPO', checkout);
  vi.stubEnv('PROGRAM_HOST_REPO', host);
  vi.stubEnv('PROGRAM_READ_MIRROR', mirror);
  vi.stubEnv('PROGRAM_ORIGIN_URL', origin);
  vi.stubEnv(
    'PROGRAM_ORIGIN_PATTERN',
    `^${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
  );

  return {
    root,
    origin,
    checkout,
    host,
    mirror,
    decoy,
    canary,
    canaryScript,
    agentCommit(file, content, message = `agent: ${file}`) {
      const target = path.join(checkout, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      git(checkout, ['add', '--', file]);
      git(checkout, ['commit', '-q', '--no-verify', '-m', message]);
      return git(checkout, ['rev-parse', 'HEAD']).trim();
    },
    personCommit(file, content, email = 'avery@example.edu') {
      git(person, ['pull', '-q', '--rebase', 'origin', 'main']);
      const target = path.join(person, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      git(person, ['add', '--', file]);
      git(person, ['commit', '-q', '-m', `person: ${file}`], {
        GIT_AUTHOR_EMAIL: email,
      });
      git(person, ['push', '-q', 'origin', 'main']);
      return git(person, ['rev-parse', 'HEAD']).trim();
    },
    originLog(format = '%s') {
      return git(origin, ['log', `--format=${format}`, 'main'])
        .split('\n')
        .filter(Boolean);
    },
    originFile(file) {
      try {
        return git(origin, ['show', `main:${file}`]);
      } catch {
        return null;
      }
    },
    canaryLines() {
      return fs.existsSync(canary)
        ? fs.readFileSync(canary, 'utf8').split('\n').filter(Boolean)
        : [];
    },
    decoyRefs() {
      return git(decoy, ['for-each-ref']);
    },
    cleanup() {
      vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
