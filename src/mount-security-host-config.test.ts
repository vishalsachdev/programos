/**
 * The host's own settings folder (the allowlists, the delivery-state key)
 * is never handed to a container as an additional mount, whatever the mount
 * allowlist says.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let home: string;

async function load() {
  vi.resetModules();
  vi.stubEnv('HOME', home);
  const config = await import('./config.js');
  const security = await import('./mount-security.js');
  return { config, security };
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mount-home-')));
  fs.mkdirSync(path.join(home, '.config', 'nanoclaw'), { recursive: true });
  fs.mkdirSync(path.join(home, 'projects', 'notes'), { recursive: true });
  // An allowlist as permissive as an operator could write it.
  fs.writeFileSync(
    path.join(home, '.config', 'nanoclaw', 'mount-allowlist.json'),
    JSON.stringify({
      allowedRoots: [{ path: home, allowReadWrite: true }, { path: '/' }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    }),
  );
  fs.writeFileSync(
    path.join(home, '.config', 'nanoclaw', 'delivery-state.key'),
    'c'.repeat(64),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('additional mounts and the host settings folder', () => {
  it('refuses the folder, a file in it, and every folder above it', async () => {
    const { config, security } = await load();
    expect(config.DELIVERY_STATE_KEY_PATH).toBe(
      path.join(home, '.config', 'nanoclaw', 'delivery-state.key'),
    );
    for (const hostPath of [
      path.join(home, '.config', 'nanoclaw'),
      config.DELIVERY_STATE_KEY_PATH,
      path.join(home, '.config'),
      home,
    ]) {
      const result = security.validateMount({ hostPath }, true);
      expect(result.allowed, hostPath).toBe(false);
      expect(result.reason, hostPath).toMatch(/settings folder/);
    }
  });

  it('refuses a link that leads there', async () => {
    const { security } = await load();
    const link = path.join(home, 'projects', 'settings');
    fs.symlinkSync(path.join(home, '.config', 'nanoclaw'), link);
    expect(security.validateMount({ hostPath: link }, true).allowed).toBe(
      false,
    );
  });

  it('still allows a folder beside it', async () => {
    const { security } = await load();
    const result = security.validateMount(
      { hostPath: path.join(home, 'projects', 'notes') },
      true,
    );
    expect(result.allowed).toBe(true);
  });
});
