/**
 * Unit tests for push detection.
 *
 * Layer: unit.
 * Goal: a push is recognised from the command line wherever it sits, and from git's own output
 * when the command hid it behind a script; a failed command and a command that merely looks like
 * a push are not; and the head is read back only from a real repository.
 * Mocks: none; real `git` against a temporary directory.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { looksLikeGitPush, resolveGitHead } from './git-events.js';
import { createGitRunner, gitOrThrow } from './git.js';
import { makeTempDir, removeTempDir } from './testing/temp-dir.js';

const env: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

/** Output git prints for a real push. */
const PUSH_OUTPUT = 'To https://github.com/acme/widgets.git\n   abc1234..def5678  main -> main\n';

let cwd: string;

beforeEach(async () => {
  cwd = await makeTempDir('git-events');
});

afterEach(async () => {
  await removeTempDir(cwd);
});

describe('looksLikeGitPush', () => {
  /** The host records where the work landed, so a missed push loses that link. */
  it.each([
    ['a bare push', 'git push'],
    ['a push with flags', 'git push -u origin feat/x'],
    ['a push after a directory change', 'cd packages/core && git push'],
    ['a push after a semicolon', 'echo done; git push origin HEAD'],
    ['a push with global git flags', 'git -c user.name=x push'],
    ['a push behind a valueless global flag', 'git --no-pager push'],
  ])('recognises %s', (_name, command) => {
    expect(looksLikeGitPush({ command, output: '', exitCode: 0 })).toBe(true);
  });

  /**
   * These succeed without a remote ever being contacted; reporting `git.pushed` would tell the host
   * that work landed when nothing left the container.
   */
  it.each([
    ['a subcommand that merely takes a ref named push', 'git branch push'],
    ['a configuration value that ends in push', 'git config alias.name push'],
    ['a path option whose value is push', 'git -C push status'],
    ['git with global flags and no subcommand at all', 'git --no-pager'],
  ])('does not recognise %s as a push', (_name, command) => {
    expect(looksLikeGitPush({ command, output: '', exitCode: 0 })).toBe(false);
  });

  /** A push from inside a script or a Makefile never appears on the command line. */
  it('recognises a push that only shows up in the output', () => {
    expect(looksLikeGitPush({ command: 'make release', output: PUSH_OUTPUT, exitCode: 0 })).toBe(
      true,
    );
  });

  /** "Everything up-to-date" still means the branch is where the remote has it. */
  it('recognises a push that had nothing to send', () => {
    expect(
      looksLikeGitPush({ command: 'git push', output: 'Everything up-to-date\n', exitCode: 0 }),
    ).toBe(true);
  });

  /** A false positive tells the host the branch moved when it did not. */
  it.each([
    ['a different command that starts the same way', 'git pushover', ''],
    ['a mention of push in an argument', 'echo "git push"', ''],
    ['output that names a remote without a ref update', 'make release', 'To https://x/y.git\n'],
  ])('does not recognise %s', (_name, command, output) => {
    expect(looksLikeGitPush({ command, output, exitCode: 0 })).toBe(false);
  });

  /** A rejected push leaves the remote exactly where it was. */
  it('does not recognise a push that failed', () => {
    expect(looksLikeGitPush({ command: 'git push', output: PUSH_OUTPUT, exitCode: 1 })).toBe(false);
  });

  /** A cancelled or timed-out command reports no exit code at all. */
  it('does not recognise a push that was killed', () => {
    expect(looksLikeGitPush({ command: 'git push', output: '', exitCode: null })).toBe(false);
  });
});

describe('resolveGitHead', () => {
  /** These two values are exactly what `git.pushed` carries. */
  it('reads the branch and commit of a repository', async () => {
    const git = createGitRunner();
    await gitOrThrow(git, ['init', '--initial-branch=main', '.'], { cwd, env });
    await gitOrThrow(
      git,
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.com',
        'commit',
        '--allow-empty',
        '-m',
        'seed',
      ],
      { cwd, env },
    );
    const head = await resolveGitHead(git, cwd, env);
    expect(head?.branch).toBe('main');
    expect(head?.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  /** The loop then simply emits no `git.pushed`, rather than failing the turn. */
  it('reports nothing for a directory that is not a repository', async () => {
    await expect(resolveGitHead(createGitRunner(), cwd, env)).resolves.toBeNull();
  });

  /** `rev-parse HEAD` fails on an unborn branch even though the directory is a repository. */
  it('reports nothing for a repository with no commits yet', async () => {
    await gitOrThrow(createGitRunner(), ['init', '--initial-branch=main', '.'], { cwd, env });
    await expect(resolveGitHead(createGitRunner(), cwd, env)).resolves.toBeNull();
  });
});
