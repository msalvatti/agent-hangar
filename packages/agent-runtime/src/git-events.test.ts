/**
 * Unit tests for push detection.
 *
 * Layer: unit.
 * Goal: a push is recognised from the command line wherever it sits, and from git's own output
 * when the command hid it behind a script; a failed command and a command that merely looks like
 * a push are not; and the head is read back only from a real repository.
 * Mocks: none; real `git` against a temporary directory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { looksLikeGitPush, resolveGitHead } from './git-events.js';
import { createGitRunner, gitOrThrow } from './git.js';
import type { GitRunner } from './git.js';
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
    // One space or several is the model's typing, not a different intent. Splitting on a single
    // whitespace character would leave an empty word where the run was and read that as the
    // subcommand.
    ['a push written with several spaces', 'git  push'],
    // Each of these consumes the word after it, so the subcommand is two words further on. Read as
    // valueless flags they would make the option's own value look like the subcommand.
    ['a push behind --config-env and its value', 'git --config-env http.proxy=PROXY push'],
    ['a push behind --exec-path and its value', 'git --exec-path /usr/lib/git-core push'],
    ['a push behind --git-dir and its value', 'git --git-dir /srv/repo/.git push'],
    ['a push behind --namespace and its value', 'git --namespace release push'],
    ['a push behind --work-tree and its value', 'git --work-tree /srv/repo push'],
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
    // The word after each of these is the option's value. Were it read as the subcommand, every
    // one of these would be reported as a push that never contacted a remote.
    ['a value of --config-env that happens to be push', 'git --config-env push status'],
    ['a value of --exec-path that happens to be push', 'git --exec-path push status'],
    ['a value of --git-dir that happens to be push', 'git --git-dir push status'],
    ['a value of --namespace that happens to be push', 'git --namespace push status'],
    ['a value of --work-tree that happens to be push', 'git --work-tree push status'],
    // No `git` in the line at all. The search for the subcommand starts from where `git` was
    // found, so a line that never mentions it must stop before the first word is read.
    ['a command named push that is not git', 'push origin main'],
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
    // The banner is the first thing on its line. Prose that quotes it mid-sentence is not git
    // reporting a push, and the ref update below would otherwise complete the impression.
    [
      'prose that mentions a remote mid-line',
      'make release',
      'nothing to send To https://x/y.git\n   abc..def  main -> main\n',
    ],
  ])('does not recognise %s', (_name, command, output) => {
    expect(looksLikeGitPush({ command, output, exitCode: 0 })).toBe(false);
  });

  /** A remote reached over plain http prints the same banner; the scheme's `s` is optional. */
  it('recognises a push to an http remote from its output', () => {
    expect(
      looksLikeGitPush({
        command: 'make release',
        output: 'To http://git.internal/acme/widgets.git\n   abc1234..def5678  main -> main\n',
        exitCode: 0,
      }),
    ).toBe(true);
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

  /**
   * Real git fails both commands together on every directory it dislikes, so it cannot produce a
   * run where one succeeded and the other did not. A stub can, and that pair is the whole point of
   * checking both codes: with only one of them consulted, a half-answered head would be reported
   * as fact — a branch with no commit behind it, or a commit with no branch name.
   */
  it.each([
    ['the branch could not be read', 1, 0],
    ['the commit could not be read', 0, 1],
  ])('reports nothing when %s', async (_name, branchCode, shaCode) => {
    const run = vi
      .fn<GitRunner['run']>()
      .mockResolvedValueOnce({ code: branchCode, stdout: 'main\n', stderr: '' })
      .mockResolvedValueOnce({ code: shaCode, stdout: `${'a'.repeat(40)}\n`, stderr: '' });
    await expect(resolveGitHead({ run }, cwd, env)).resolves.toBeNull();
  });

  /**
   * Both commands must run against the workspace, not against whatever directory the process
   * happens to be in. This repository is itself a git repository, so a second command that lost
   * its working directory still answers with a plausible forty-character sha — the reason this is
   * asserted on the call rather than inferred from the result.
   */
  it('asks git for both values in the workspace, with the child environment', async () => {
    const run = vi
      .fn<GitRunner['run']>()
      .mockResolvedValueOnce({ code: 0, stdout: 'feat/x\n', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: `${'b'.repeat(40)}\n`, stderr: '' });
    await expect(resolveGitHead({ run }, cwd, env)).resolves.toStrictEqual({
      branch: 'feat/x',
      sha: 'b'.repeat(40),
    });
    expect(run).toHaveBeenNthCalledWith(1, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, env });
    expect(run).toHaveBeenNthCalledWith(2, ['rev-parse', 'HEAD'], { cwd, env });
  });
});
