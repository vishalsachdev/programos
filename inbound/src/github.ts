// One commit that adds the Markdown copy and the original `.eml`, through
// the GitHub git data API. One commit, not two, so the repo never holds a
// Markdown copy without its original.

import type { Settings } from './settings.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface CommitFile {
  path: string;
  bytes: Uint8Array;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

const encodePath = (path: string) =>
  path.split('/').map(encodeURIComponent).join('/');

class GithubError extends Error {
  constructor(
    readonly status: number,
    what: string,
  ) {
    super(`GitHub ${what} failed with HTTP ${status}`);
  }
}

async function call<T>(
  settings: Settings,
  fetchFn: FetchLike,
  what: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetchFn(
    `${settings.githubApiUrl}/repos/${settings.githubRepo}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${settings.githubToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'programos-inbound',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  // The response body is not put in the error: it can echo request content.
  if (!res.ok) throw new GithubError(res.status, what);
  return (await res.json()) as T;
}

/** How many times to rebuild the commit when the branch moved under us. */
const REF_RACE_TRIES = 4;

/**
 * Commit the files, authored by the configured intake identity.
 *
 * Safe to repeat: if the first file is already on the branch, a previous
 * attempt landed (file names carry a hash of the message), and nothing is
 * written.
 */
export async function commitFiles(
  settings: Settings,
  files: CommitFile[],
  message: string,
  when: Date,
  fetchFn: FetchLike,
): Promise<'committed' | 'already-present'> {
  const branch = encodeURIComponent(settings.githubBranch);
  try {
    await call(
      settings,
      fetchFn,
      'file check',
      'GET',
      `/contents/${encodePath(files[0].path)}?ref=${branch}`,
    );
    return 'already-present';
  } catch (err) {
    if (!(err instanceof GithubError) || err.status !== 404) throw err;
  }

  const blobs: { path: string; sha: string }[] = [];
  for (const file of files) {
    const blob = await call<{ sha: string }>(
      settings,
      fetchFn,
      'blob create',
      'POST',
      '/git/blobs',
      { content: base64(file.bytes), encoding: 'base64' },
    );
    blobs.push({ path: file.path, sha: blob.sha });
  }

  const identity = {
    name: settings.gitAuthorName,
    email: settings.gitAuthorEmail,
    date: when.toISOString(),
  };
  for (let attempt = 1; ; attempt++) {
    const ref = await call<{ object: { sha: string } }>(
      settings,
      fetchFn,
      'branch read',
      'GET',
      `/git/ref/heads/${branch}`,
    );
    const parent = await call<{ tree: { sha: string } }>(
      settings,
      fetchFn,
      'commit read',
      'GET',
      `/git/commits/${ref.object.sha}`,
    );
    const tree = await call<{ sha: string }>(
      settings,
      fetchFn,
      'tree create',
      'POST',
      '/git/trees',
      {
        base_tree: parent.tree.sha,
        tree: blobs.map((b) => ({
          path: b.path,
          mode: '100644',
          type: 'blob',
          sha: b.sha,
        })),
      },
    );
    const commit = await call<{ sha: string }>(
      settings,
      fetchFn,
      'commit create',
      'POST',
      '/git/commits',
      {
        message,
        tree: tree.sha,
        parents: [ref.object.sha],
        // The host checks the AUTHOR of the commit that first added the
        // `.eml`. The committer is set too, so the token owner's own
        // identity is not written into the knowledge base history.
        author: identity,
        committer: identity,
      },
    );
    try {
      await call(
        settings,
        fetchFn,
        'branch update',
        'PATCH',
        `/git/refs/heads/${branch}`,
        { sha: commit.sha, force: false },
      );
      return 'committed';
    } catch (err) {
      // 422: the branch moved (the agent or a person pushed). Rebuild on the
      // new tip. Never force.
      const moved = err instanceof GithubError && err.status === 422;
      if (!moved || attempt >= REF_RACE_TRIES) throw err;
    }
  }
}
