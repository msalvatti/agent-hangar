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
  /** A command the model wrote must not be able to read the PAT or the API key. */
  it('removes both credentials', () => {
    const child = createChildEnv(parentEnv);
    for (const key of SCRUBBED_KEYS) {
      expect(child).not.toHaveProperty(key);
    }
    expect(Object.values(child)).not.toContain(GITHUB_CANARY);
    expect(Object.values(child)).not.toContain(OPENAI_CANARY);
  });

  /** Commands need PATH and HOME; an unset variable must not become an empty string. */
  it('keeps the rest of the environment and drops unset variables', () => {
    const child = createChildEnv(parentEnv);
    expect(child.PATH).toBe('/usr/bin:/bin');
    expect(child.HOME).toBe('/home/agent');
    expect(child.LANG).toBe('C.UTF-8');
    expect(child).not.toHaveProperty('EMPTY');
  });

  /** Without this a git command that needs credentials blocks until the tool timeout. */
  it('disables git terminal prompts', () => {
    expect(createChildEnv(parentEnv).GIT_TERMINAL_PROMPT).toBe('0');
  });

  /** The helper is the only channel through which git ever sees the token. */
  it.each([
    ['falls back to the image helper when unset', {}, DEFAULT_ASKPASS],
    ['falls back to the image helper when empty', { GIT_ASKPASS: '' }, DEFAULT_ASKPASS],
    [
      'keeps a helper the image configured',
      { GIT_ASKPASS: '/custom/askpass.sh' },
      '/custom/askpass.sh',
    ],
  ])('%s', (_name, overrides, expected) => {
    expect(createChildEnv({ ...parentEnv, ...overrides }).GIT_ASKPASS).toBe(expected);
  });

  /** The helper falls back to GITHUB_TOKEN when the variable is absent, so it must not be empty. */
  it('advertises the token file only when one was written', () => {
    expect(createChildEnv(parentEnv, { tokenFile: '/tmp/ah/git-token' }).AH_GIT_TOKEN_FILE).toBe(
      '/tmp/ah/git-token',
    );
    expect(createChildEnv(parentEnv, { tokenFile: null })).not.toHaveProperty('AH_GIT_TOKEN_FILE');
    expect(createChildEnv(parentEnv, {})).not.toHaveProperty('AH_GIT_TOKEN_FILE');
  });
});

describe('materializeGitToken', () => {
  /** Group- or world-readable would defeat moving the token out of the environment. */
  it('writes the token to an owner-only file inside an owner-only directory', async () => {
    const nested = path.join(directory, 'runtime');
    const file = await materializeGitToken(parentEnv, nested);
    expect(file).toBe(path.join(nested, 'git-token'));
    await expect(readFile(file!, 'utf8')).resolves.toBe(GITHUB_CANARY);
    expect((await stat(file!)).mode & 0o777).toBe(0o600);
    expect((await stat(nested)).mode & 0o777).toBe(0o700);
  });

  /** A missing PAT is an ordinary state: the turn simply cannot push. */
  it.each([
    ['no token is configured', undefined],
    ['the token is empty', ''],
  ])('writes nothing when %s', async (_name, token) => {
    await expect(
      materializeGitToken({ ...parentEnv, GITHUB_TOKEN: token }, directory),
    ).resolves.toBeNull();
  });
});

describe('removeGitToken', () => {
  /** Cleanup runs in a `finally`, so it must be safe on every path out of a turn. */
  it('removes the file and tolerates a turn that never wrote one', async () => {
    const file = await materializeGitToken(parentEnv, directory);
    await removeGitToken(file);
    await expect(stat(file!)).rejects.toThrow();
    await expect(removeGitToken(null)).resolves.toBeUndefined();
    await expect(removeGitToken(file)).resolves.toBeUndefined();
  });
});
