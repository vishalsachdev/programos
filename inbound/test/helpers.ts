import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { InboundMessage } from '../src/intake.js';
import type { Env, KVStore } from '../src/settings.js';

export const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
);

export interface Contract {
  receivedAt: string;
  inboxDir: string;
  envelope: { from: string; to: string };
  gitAuthorName: string;
  gitAuthorEmail: string;
  cases: string[];
}

export const contract: Contract = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'contract.json'), 'utf-8'),
);

export function fixture(name: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));
}

/** In-memory stand-in for the KV namespace. `failPuts` makes writes throw. */
export class MemoryKV implements KVStore {
  readonly data = new Map<string, string | ArrayBuffer>();
  failPuts = false;

  get(key: string, type: 'text'): Promise<string | null>;
  get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>;
  async get(key: string, type: 'text' | 'arrayBuffer') {
    const value = this.data.get(key);
    if (value === undefined) return null;
    if (type === 'text') {
      return typeof value === 'string'
        ? value
        : new TextDecoder().decode(value);
    }
    return typeof value === 'string'
      ? (new TextEncoder().encode(value).buffer as ArrayBuffer)
      : value;
  }
  async put(key: string, value: string | ArrayBuffer): Promise<void> {
    if (this.failPuts) throw new Error('KV unavailable');
    this.data.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
  async list(options: { prefix: string }) {
    return {
      keys: [...this.data.keys()]
        .filter((name) => name.startsWith(options.prefix))
        .sort()
        .map((name) => ({ name })),
      list_complete: true,
    };
  }
  keys(prefix: string): string[] {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

export function testEnv(kv: MemoryKV, overrides: Partial<Env> = {}): Env {
  return {
    GITHUB_TOKEN: 'test-github-token',
    WEBHOOK_SECRET: 'test-webhook-secret',
    GITHUB_REPO: 'example-org/program-repo',
    HOST_WEBHOOK_URL: 'https://bot.example.org/',
    PENDING: kv,
    ...overrides,
  };
}

export function inboundMessage(raw: Uint8Array): InboundMessage & {
  rejected: string | null;
} {
  return {
    from: contract.envelope.from,
    to: contract.envelope.to,
    rawSize: raw.byteLength,
    raw: new Response(raw as BodyInit).body as ReadableStream<Uint8Array>,
    rejected: null,
    setReject(reason: string) {
      this.rejected = reason;
    },
  };
}

export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
  rawBody: string | undefined;
}

/**
 * Mocked network: a fake GitHub git data API and a fake host. No request
 * leaves the process. `github` and `host` can be replaced per test.
 */
export class FakeNet {
  readonly calls: Call[] = [];
  /** Paths that already exist on the branch. */
  readonly existing = new Set<string>();
  /** The commit bodies that reached "update ref". */
  readonly landed: any[] = [];
  private readonly commits = new Map<string, any>();
  private readonly trees = new Map<string, any>();
  private n = 0;
  githubDown = false;
  /** Number of "branch update" calls that answer 422 before one succeeds. */
  refRaces = 0;
  host: (call: Call) => Response | Promise<Response> = () =>
    Response.json({ ok: true, messageId: 'webhook-test' });

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const rawBody = typeof init?.body === 'string' ? init.body : undefined;
    const call: Call = {
      method: init?.method ?? 'GET',
      url,
      headers: { ...(init?.headers as Record<string, string>) },
      body: rawBody ? JSON.parse(rawBody) : undefined,
      rawBody,
    };
    this.calls.push(call);
    if (url.startsWith('https://api.github.com/')) return this.github(call);
    if (url.startsWith('https://bot.example.org')) return this.host(call);
    throw new Error(`unexpected request to ${url}`);
  };

  private github(call: Call): Response {
    if (this.githubDown) return new Response('down', { status: 503 });
    const route = call.url.replace(
      'https://api.github.com/repos/example-org/program-repo',
      '',
    );
    const id = () => `sha${++this.n}`;
    if (call.method === 'GET' && route.startsWith('/contents/')) {
      const p = decodeURIComponent(
        route.slice('/contents/'.length).split('?')[0],
      );
      return this.existing.has(p)
        ? Response.json({ path: p })
        : new Response('{}', { status: 404 });
    }
    if (call.method === 'POST' && route === '/git/blobs')
      return Response.json({ sha: id() });
    if (call.method === 'GET' && route === '/git/ref/heads/main')
      return Response.json({ object: { sha: 'tip' } });
    if (call.method === 'GET' && route === '/git/commits/tip')
      return Response.json({ tree: { sha: 'tiptree' } });
    if (call.method === 'POST' && route === '/git/trees') {
      const sha = id();
      this.trees.set(sha, call.body);
      return Response.json({ sha });
    }
    if (call.method === 'POST' && route === '/git/commits') {
      const sha = id();
      this.commits.set(sha, call.body);
      return Response.json({ sha });
    }
    if (call.method === 'PATCH' && route === '/git/refs/heads/main') {
      if (this.refRaces > 0) {
        this.refRaces -= 1;
        return new Response('{}', { status: 422 });
      }
      const commit = this.commits.get(call.body.sha);
      const tree = this.trees.get(commit.tree);
      for (const entry of tree.tree) this.existing.add(entry.path);
      this.landed.push({ ...commit, paths: tree.tree.map((e: any) => e.path) });
      return Response.json({ ref: 'refs/heads/main' });
    }
    return new Response(`no route ${call.method} ${route}`, { status: 500 });
  }

  hostCalls(): Call[] {
    return this.calls.filter((c) =>
      c.url.startsWith('https://bot.example.org'),
    );
  }
  blobCalls(): Call[] {
    return this.calls.filter((c) => c.url.endsWith('/git/blobs'));
  }
}
