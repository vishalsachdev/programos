/**
 * A PROGRAM_HOST_REPO that is a symbolic link. The host works in the folder
 * the link leads to, so that folder is the one made private; a link that
 * leads into a folder a container can reach, or to a folder of another
 * user, stops the host.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetHostRepoStateForTests,
  ensureHostRepo,
  hostRepoPlacementProblem,
} from './host-repo.js';
import { logger } from './logger.js';
import { makeKbFixture, type KbFixture } from './test-support/kb-fixture.js';

let kb: KbFixture;
let logged: string[];
let link: string;

const mode = (target: string) => fs.statSync(target).mode & 0o777;

beforeEach(() => {
  _resetHostRepoStateForTests();
  kb = makeKbFixture();
  logged = [];
  for (const level of ['debug', 'info', 'warn', 'error', 'fatal'] as const)
    vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
      logged.push(JSON.stringify(args));
    });
  link = path.join(kb.root, 'host-link');
});

afterEach(() => {
  vi.restoreAllMocks();
  kb.cleanup();
});

/** A host repo as an earlier version left it, then reached through a link. */
function oldRepoBehindLink(): void {
  vi.stubEnv('PROGRAM_ORIGIN_URL', kb.origin);
  ensureHostRepo();
  fs.chmodSync(kb.host, 0o755);
  fs.chmodSync(path.join(kb.host, '.git', 'config'), 0o644);
  fs.symlinkSync(kb.host, link);
  vi.stubEnv('PROGRAM_HOST_REPO', link);
  _resetHostRepoStateForTests(); // a new process
}

describe('PROGRAM_HOST_REPO is a symbolic link', () => {
  it('to a folder of the host user outside every mount: accepted, and the folder it leads to is made private', () => {
    oldRepoBehindLink();
    expect(hostRepoPlacementProblem()).toBeNull();
    ensureHostRepo();
    expect(mode(kb.host)).toBe(0o700);
    expect(mode(path.join(kb.host, '.git', 'config'))).toBe(0o600);
    expect(logged.join('\n')).toMatch(/now private to its owner/);
    // The link itself is still a link.
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('below a linked folder: the same', () => {
    oldRepoBehindLink();
    const parentLink = path.join(kb.root, 'parent-link');
    fs.symlinkSync(kb.root, parentLink);
    vi.stubEnv('PROGRAM_HOST_REPO', path.join(parentLink, 'host'));
    _resetHostRepoStateForTests();
    expect(hostRepoPlacementProblem()).toBeNull();
    ensureHostRepo();
    expect(mode(kb.host)).toBe(0o700);
  });

  it('into the agent checkout: refused', () => {
    const inside = path.join(kb.checkout, 'hidden-host');
    fs.mkdirSync(inside);
    fs.symlinkSync(inside, link);
    vi.stubEnv('PROGRAM_HOST_REPO', link);
    expect(hostRepoPlacementProblem()).toMatch(/inside PROGRAM_REPO/);
    expect(() => ensureHostRepo()).toThrow(/host repo refused/);
    // To the checkout itself, and to a folder that contains it.
    fs.rmSync(link);
    fs.symlinkSync(kb.checkout, link);
    expect(hostRepoPlacementProblem()).toMatch(/inside PROGRAM_REPO/);
    fs.rmSync(link);
    fs.symlinkSync(kb.root, link);
    expect(hostRepoPlacementProblem()).toMatch(/or contains it/);
  });

  it('into the project folder, which the main container can read: refused', () => {
    const project = path.join(kb.root, 'project');
    fs.mkdirSync(path.join(project, 'store', 'host'), { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(project);
    fs.symlinkSync(path.join(project, 'store', 'host'), link);
    vi.stubEnv('PROGRAM_HOST_REPO', link);
    expect(hostRepoPlacementProblem()).toMatch(/inside the project folder/);
  });

  it('below a link into the checkout or the project folder, when the repo folder does not exist yet: refused, and nothing is created', () => {
    // The first start: the setting is "<link>/program-repo-host" and only
    // the link is there.
    fs.symlinkSync(kb.checkout, link);
    vi.stubEnv('PROGRAM_HOST_REPO', path.join(link, 'program-repo-host'));
    expect(hostRepoPlacementProblem()).toMatch(/inside PROGRAM_REPO/);
    expect(() => ensureHostRepo()).toThrow(/host repo refused/);
    expect(fs.existsSync(path.join(kb.checkout, 'program-repo-host'))).toBe(
      false,
    );

    const project = path.join(kb.root, 'project');
    fs.mkdirSync(path.join(project, 'store'), { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(project);
    fs.rmSync(link);
    fs.symlinkSync(path.join(project, 'store'), link);
    expect(hostRepoPlacementProblem()).toMatch(/inside the project folder/);
  });

  it('to something that is not a folder: refused', () => {
    const file = path.join(kb.root, 'a-file');
    fs.writeFileSync(file, 'x');
    fs.symlinkSync(file, link);
    vi.stubEnv('PROGRAM_HOST_REPO', link);
    expect(hostRepoPlacementProblem()).toMatch(/not a folder/);
  });

  it('to a folder of another user: refused, and nothing there is changed', () => {
    oldRepoBehindLink();
    const owner = fs.statSync(kb.host).uid;
    vi.spyOn(process, 'getuid').mockReturnValue(owner + 4321);
    expect(hostRepoPlacementProblem()).toMatch(/belongs to another user/);
    expect(() => ensureHostRepo()).toThrow(/host repo refused/);
    expect(mode(kb.host)).toBe(0o755);
  });

  it('a path with no link in it is judged as before', () => {
    expect(hostRepoPlacementProblem()).toBeNull();
    // Another user's folder that is NOT reached through a link: unchanged
    // behaviour, the ownership rule is for links only.
    vi.stubEnv('PROGRAM_ORIGIN_URL', kb.origin);
    ensureHostRepo();
    vi.stubEnv('PROGRAM_HOST_REPO', fs.realpathSync(kb.host));
    vi.spyOn(process, 'getuid').mockReturnValue(
      fs.statSync(kb.host).uid + 4321,
    );
    expect(hostRepoPlacementProblem()).toBeNull();
  });
});
