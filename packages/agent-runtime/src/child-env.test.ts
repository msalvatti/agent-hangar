/**
 * Unit tests for the child environment and the git token file.
 *
 * Layer: unit.
 * Goal: the credentials are gone from every child environment while the rest of the environment
 * survives, git is wired for non-interactive authentication, and the token reaches git only
 * through an owner-only file whose path is advertised to the askpass helper.
 * Mocks: none; a real temporary directory holds the token file so its mode can be inspected.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { GITHUB_CANARY, OPENAI_CANARY } from '@agent-hangar/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createChildEnv,
  DEFAULT_ASKPASS,
  materializeGitToken,
  removeGitToken,
  SCRUBBED_KEYS,
} from './child-env.js';
import { makeTempDir, removeTempDir } from './testing/temp-dir.js';

/** Environment of a runtime that has both credentials, as the worker injects them. */
const parentEnv = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/agent',
  LANG: 'C.UTF-8',
  GITHUB_TOKEN: GITHUB_CANARY,
  OPENAI_API_KEY: OPENAI_CANARY,
  EMPTY: undefined,
};

let directory: string;

beforeEach(async () => {
  directory = await makeTempDir('child-env');
});

afterEach(async () => {
  await removeTempDir(directory);
});

describe('createChildEnv', () => {
  it('removes both credentials', () => {
    // A command the model wrote must not be able to read the PAT or the API key.
    const child = createChildEnv(parentEnv);
    for (const key of SCRUBBED_KEYS) {
      expect(child).not.toHaveProperty(key);
    }
    expect(Object.values(child)).not.toContain(GITHUB_CANARY);
    expect(Object.values(child)).not.toContain(OPENAI_CANARY);
  });

  it('keeps the rest of the environment and drops unset variables', () => {
    // Commands need PATH and HOME; an unset variable must not become an empty string.
    const child = createChildEnv(parentEnv);
    expect(child.PATH).toBe('/usr/bin:/bin');
    expect(child.HOME).toBe('/home/agent');
    expect(child.LANG).toBe('C.UTF-8');
    expect(child).not.toHaveProperty('EMPTY');
  });

  it('carries the approved origin through to the helper', () => {
    // The helper runs as a child of git, which runs with this environment: a variable dropped here
    // would leave it with no origin to compare against, and it releases nothing without one.
    expect(
      createChildEnv({ ...parentEnv, AH_GIT_ALLOWED_ORIGIN: 'https://github.com' }),
    ).toMatchObject({ AH_GIT_ALLOWED_ORIGIN: 'https://github.com' });
  });

  it('disables git terminal prompts', () => {
    // Without this a git command that needs credentials blocks until the tool timeout.
    expect(createChildEnv(parentEnv).GIT_TERMINAL_PROMPT).toBe('0');
  });

  it.each([
    ['falls back to the image helper when unset', {}, DEFAULT_ASKPASS],
    ['falls back to the image helper when empty', { GIT_ASKPASS: '' }, DEFAULT_ASKPASS],
    [
      'keeps a helper the image configured',
      { GIT_ASKPASS: '/custom/askpass.sh' },
      '/custom/askpass.sh',
    ],
  ])('%s', (_name, overrides, expected) => {
    // The helper is the only channel through which git ever sees the token.
    expect(createChildEnv({ ...parentEnv, ...overrides }).GIT_ASKPASS).toBe(expected);
  });

  it('advertises the token file only when one was written', () => {
    // The helper falls back to GITHUB_TOKEN when the variable is absent, so it must not be empty.
    expect(createChildEnv(parentEnv, { tokenFile: '/tmp/ah/git-token' }).AH_GIT_TOKEN_FILE).toBe(
      '/tmp/ah/git-token',
    );
    expect(createChildEnv(parentEnv, { tokenFile: null })).not.toHaveProperty('AH_GIT_TOKEN_FILE');
    expect(createChildEnv(parentEnv, {})).not.toHaveProperty('AH_GIT_TOKEN_FILE');
  });
});

describe('materializeGitToken', () => {
  it('writes the token to an owner-only file inside an owner-only directory', async () => {
    // Group- or world-readable would defeat moving the token out of the environment.
    const nested = path.join(directory, 'runtime');
    const file = await materializeGitToken(parentEnv, nested);
    expect(file).toBe(path.join(nested, 'git-token'));
    await expect(readFile(file!, 'utf8')).resolves.toBe(GITHUB_CANARY);
    expect((await stat(file!)).mode & 0o777).toBe(0o600);
    expect((await stat(nested)).mode & 0o777).toBe(0o700);
  });

  it.each([
    ['no token is configured', undefined],
    ['the token is empty', ''],
  ])('writes nothing when %s', async (_name, token) => {
    // A missing PAT is an ordinary state: the turn simply cannot push.
    await expect(
      materializeGitToken({ ...parentEnv, GITHUB_TOKEN: token }, directory),
    ).resolves.toBeNull();
  });
});

describe('removeGitToken', () => {
  it('removes the file and tolerates a turn that never wrote one', async () => {
    // Cleanup runs in a `finally`, so it must be safe on every path out of a turn.
    const file = await materializeGitToken(parentEnv, directory);
    await removeGitToken(file);
    await expect(stat(file!)).rejects.toThrow();
    await expect(removeGitToken(null)).resolves.toBeUndefined();
    await expect(removeGitToken(file)).resolves.toBeUndefined();
  });
});
