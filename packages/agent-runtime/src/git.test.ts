/**
 * Unit tests for the git runner.
 *
 * Layer: unit.
 * Goal: a successful command yields its output, a failing one yields its code rather than an
 * exception, a binary that will not start and a command that never exits are both reported instead
 * of hanging, output past the byte cap is dropped rather than accumulated, and `gitOrThrow` turns
 * a non-zero exit into a `GitError` carrying a capped stderr.
 * Mocks: real `git` against a temporary directory, plus a scripted spawn for the paths a real
 * process cannot be made to take.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createGitRunner,
  DEFAULT_GIT_TIMEOUT_MS,
  GitError,
  gitOrThrow,
  MAX_GIT_OUTPUT_BYTES,
} from './git.js';
import type { SpawnFunction } from './spawn.js';
import { makeTempDir, removeTempDir } from './testing/temp-dir.js';

let cwd: string;

/** Environment for the real git invocations; git needs nothing beyond a PATH here. */
const env: Record<string, string> = { PATH: process.env.PATH ?? '' };

/**
 * A spawn double whose child behaves as the script says.
 *
 * @param script - `error` emits a start failure; `hang` never closes on its own; `stdout` is
 *   written to the child's standard output before it closes; otherwise the child closes
 *   immediately with `exitCode`.
 * @returns A spawn function and the signals its child received.
 */
function scriptedSpawn(script: {
  error?: Error;
  hang?: boolean;
  exitCode?: number;
  stdout?: readonly string[];
}): {
  spawn: SpawnFunction;
  kills: (NodeJS.Signals | number | undefined)[];
} {
  const kills: (NodeJS.Signals | number | undefined)[] = [];
  const spawn: SpawnFunction = () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      // A start failure never reaches the point where pipes exist.
      stdout: script.error === undefined ? new PassThrough() : null,
      stderr: script.error === undefined ? new PassThrough() : null,
      kill(signal?: NodeJS.Signals | number) {
        kills.push(signal);
        child.emit('close', null);
        return true;
      },
    });
    setImmediate(() => {
      if (script.error !== undefined) {
        child.emit('error', script.error);
        return;
      }
      if (script.hang === true) {
        return;
      }
      for (const chunk of script.stdout ?? []) {
        child.stdout?.write(chunk);
      }
      // A further turn of the loop, so the stream has delivered everything before the close.
      setImmediate(() => {
        child.emit('close', script.exitCode ?? 0);
      });
    });
    return child;
  };
  return { spawn, kills };
}

beforeEach(async () => {
  cwd = await makeTempDir('git');
});

afterEach(async () => {
  await removeTempDir(cwd);
});

describe('createGitRunner', () => {
  it('reports the output of a successful command', async () => {
    // The runner is how every other module talks to git.
    const result = await createGitRunner().run(['--version'], { cwd, env });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^git version /);
  });

  it('reports a non-zero exit as data rather than throwing', async () => {
    // Callers such as `list_dir` branch on the code; an exception would be in the way.
    const result = await createGitRunner().run(['rev-parse', '--is-inside-work-tree'], {
      cwd,
      env,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('not a git repository');
  });

  it('reports a binary that will not start', async () => {
    // Without git on the PATH the turn should fail with a message, not an unhandled rejection.
    const { spawn } = scriptedSpawn({ error: new Error('spawn git ENOENT') });
    await expect(createGitRunner(spawn).run(['status'], { cwd, env })).resolves.toStrictEqual({
      code: null,
      stdout: '',
      stderr: 'failed to start git: spawn git ENOENT',
    });
  });

  it('kills a command that outlives its timeout', async () => {
    // A hung clone must not pin the turn until its wall-clock limit.
    const { spawn, kills } = scriptedSpawn({ hang: true });
    const result = await createGitRunner(spawn).run(['clone', 'x'], { cwd, env, timeoutMs: 5 });
    expect(kills).toStrictEqual(['SIGKILL']);
    expect(result.code).toBeNull();
  });

  it('stops keeping output once a command passes the byte cap', async () => {
    // `list_dir` runs `ls-files` in a directory the model chose, over a checkout whose size the
    // repository decides: without the cap the whole listing is accumulated in the runtime's heap.
    const chunk = 'x'.repeat(1024 * 1024);
    const chunks = Array.from({ length: 9 }, () => chunk);
    const { spawn } = scriptedSpawn({ stdout: chunks });
    const result = await createGitRunner(spawn).run(['ls-files'], { cwd, env });
    expect(chunks.join('').length).toBeGreaterThan(MAX_GIT_OUTPUT_BYTES);
    expect(result.stdout.length).toBe(MAX_GIT_OUTPUT_BYTES);
  });

  it('keeps output that stays within the byte cap', async () => {
    // The cap must be invisible to every legitimate command, which is all of them.
    const { spawn } = scriptedSpawn({ stdout: ['a\0b\0'] });
    const result = await createGitRunner(spawn).run(['ls-files', '-z'], { cwd, env });
    expect(result.stdout).toBe('a\0b\0');
  });

  it('bounds a command that names no timeout', () => {
    // The default has to cover a full-depth clone over a slow link and still be finite.
    expect(DEFAULT_GIT_TIMEOUT_MS).toBe(600_000);
  });
});

describe('gitOrThrow', () => {
  it('returns the trimmed output of a successful command', async () => {
    // Callers use the output directly as a sha or a branch name.
    await expect(gitOrThrow(createGitRunner(), ['--version'], { cwd, env })).resolves.toMatch(
      /^git version \S/,
    );
  });

  it('throws a GitError naming the subcommand and the first line of stderr', async () => {
    // Preparation maps this straight to a failed turn, so the message has to be readable.
    const promise = gitOrThrow(createGitRunner(), ['rev-parse', 'HEAD'], { cwd, env });
    await expect(promise).rejects.toBeInstanceOf(GitError);
    await expect(promise).rejects.toThrow('git rev-parse failed: fatal:');
  });

  it('carries the exit code and a capped stderr on the error', async () => {
    // A runaway command must not be able to push an unbounded string into an event.
    const { spawn } = scriptedSpawn({ exitCode: 128 });
    const error = await gitOrThrow(createGitRunner(spawn), ['fetch'], { cwd, env }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).code).toBe(128);
    expect((error as GitError).stderr.length).toBeLessThanOrEqual(500);
  });
});
