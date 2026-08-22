/**
 * Unit tests for the shell tool.
 *
 * Layer: unit.
 * Goal: commands run in the workspace with a scrubbed environment, their combined output is
 * streamed and then capped, a timeout takes the whole process group with it, a cancellation
 * terminates the command, and a working directory outside the workspace is refused.
 * Mocks: real `bash` against a temporary directory, plus a scripted spawn for a child that will
 * not start and one that reports no pid.
 */
import { EventEmitter } from 'node:events';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { GITHUB_CANARY, OPENAI_CANARY } from '@agent-hangar/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createChildEnv } from '../child-env.js';
import type { SpawnFunction } from '../spawn.js';
import { makeTempDir, removeTempDir } from '../testing/temp-dir.js';

import { runShell } from './run-shell.js';
import type { RunShellContext } from './run-shell.js';

let root: string;
let context: RunShellContext;

/** The runtime's own environment: both credentials present, as the worker injects them. */
const runtimeEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  GITHUB_TOKEN: GITHUB_CANARY,
  OPENAI_API_KEY: OPENAI_CANARY,
};

beforeEach(async () => {
  root = await makeTempDir('run-shell');
  await mkdir(path.join(root, 'sub'), { recursive: true });
  context = {
    workspaceRoot: root,
    env: createChildEnv(runtimeEnv, { tokenFile: '/tmp/ah-runtime/git-token' }),
    defaultTimeoutMs: 10_000,
    maxOutputBytes: 32_768,
  };
});

afterEach(async () => {
  await removeTempDir(root);
});

describe('runShell', () => {
  /** The baseline every other behaviour builds on. */
  it('runs a command in the workspace and reports its output and exit code', async () => {
    const result = await runShell({ command: 'echo hi', cwd: null, timeoutMs: null }, context);
    expect(result).toMatchObject({
      output: 'hi\n',
      exitCode: 0,
      status: 'SUCCEEDED',
      command: 'echo hi',
    });
  });

  /** A failing build is information for the model, not a runtime error. */
  it('reports a non-zero exit as a failure with the code', async () => {
    const result = await runShell({ command: 'exit 3', cwd: null, timeoutMs: null }, context);
    expect(result).toMatchObject({ exitCode: 3, status: 'FAILED' });
  });

  /** The transcript shows output as it arrives, in the order the command produced it. */
  it('interleaves stdout and stderr and streams both through the hook', async () => {
    const streamed: [string, string][] = [];
    const result = await runShell(
      { command: 'echo a; echo b >&2; sleep 0.05; echo c', cwd: null, timeoutMs: null },
      context,
      { onOutput: (stream, text) => streamed.push([stream, text]) },
    );
    expect(result.output).toContain('a\n');
    expect(result.output).toContain('b\n');
    // Both names, because the transcript separates the two and a stream that arrives unnamed is
    // rendered as the other one.
    expect(new Set(streamed.map(([stream]) => stream))).toStrictEqual(
      new Set(['stdout', 'stderr']),
    );
    expect(streamed.map(([, text]) => text).join('')).toBe(result.output);
  });

  /**
   * Repositories have layouts; the model needs to be able to work inside them. `pwd` reports the
   * directory with symbolic links resolved, which on macOS differs from the path the temporary
   * directory was created under.
   */
  it('runs in a subdirectory of the workspace when asked', async () => {
    const result = await runShell({ command: 'pwd', cwd: 'sub', timeoutMs: null }, context);
    expect(result.output.trim()).toBe(await realpath(path.join(root, 'sub')));
  });

  /** The working directory is as much of an escape route as a file path. */
  it.each([
    ['a directory outside the workspace', '../elsewhere', 'escapes the workspace'],
    ['a directory that does not exist', 'missing', 'cwd does not exist'],
  ])('refuses %s', async (_name, cwd, expected) => {
    const result = await runShell({ command: 'pwd', cwd, timeoutMs: null }, context);
    expect(result.status).toBe('FAILED');
    expect(result.output).toContain(expected);
  });

  /** `spawn` would fail obscurely; the model gets a clear message instead. */
  it('refuses a working directory that is a file', async () => {
    await writeFile(path.join(root, 'file.txt'), 'x', 'utf8');
    const result = await runShell({ command: 'pwd', cwd: 'file.txt', timeoutMs: null }, context);
    expect(result.output).toBe('cwd is not a directory: file.txt');
  });

  /** A backgrounded child would otherwise outlive the turn inside the container. */
  it('kills a command and its children when the timeout fires', async () => {
    const started = Date.now();
    const result = await runShell(
      { command: 'sleep 30 & wait', cwd: null, timeoutMs: 200 },
      context,
    );
    expect(result.status).toBe('TIMED_OUT');
    expect(result.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  /**
   * The timeout gets one signal and no second chance, so it has to be the one a command cannot
   * decline. Here the command declines SIGTERM and would then run to its own end: the run still
   * reports a timeout either way, because that was decided before the signal was sent, but the
   * exit code tells the two apart — a command that was killed reports none, and one that finished
   * on its own reports zero.
   */
  it('kills a command that refuses the polite signal', async () => {
    const result = await runShell(
      { command: 'trap "" TERM; sleep 6', cwd: null, timeoutMs: 200 },
      context,
    );
    expect(result).toMatchObject({ status: 'TIMED_OUT', exitCode: null });
  });

  /**
   * The container has no console. A command that reads standard input has to be told so at once;
   * handed a pipe nobody writes to or closes, it waits for the timeout instead and the turn loses
   * that budget to a command that was never going to finish.
   */
  it('gives the command no standard input to wait on', async () => {
    const result = await runShell({ command: 'cat', cwd: null, timeoutMs: 3000 }, context);
    expect(result).toMatchObject({ status: 'SUCCEEDED', exitCode: 0, output: '' });
  });

  /** Cancellation reaches the runtime as SIGINT and has to stop the current tool. */
  it('terminates the command when the turn is cancelled', async () => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 100);
    const result = await runShell({ command: 'sleep 30', cwd: null, timeoutMs: 10_000 }, context, {
      signal: controller.signal,
    });
    expect(result.status).toBe('FAILED');
    expect(result.output).toContain('[cancelled]');
  });

  /** A listener added to an already-aborted signal is never called. */
  it('terminates a command whose cancellation arrived before it started', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runShell({ command: 'sleep 30', cwd: null, timeoutMs: 10_000 }, context, {
      signal: controller.signal,
    });
    expect(result.status).toBe('FAILED');
    expect(result.output).toContain('[cancelled]');
  });

  /**
   * Buffering everything a command produces would exhaust the container long before the per-command
   * timeout could stop it, so past the budget the output is counted and dropped.
   */
  it('caps the output, keeps counting it, and stops streaming once the budget is spent', async () => {
    const streamed: string[] = [];
    const result = await runShell(
      { command: "head -c 2000000 /dev/zero | tr '\\0' a", cwd: null, timeoutMs: null },
      { ...context, maxOutputBytes: 1024 },
      { onOutput: (_stream, text) => streamed.push(text) },
    );
    expect(result.bytes).toBe(2_000_000);
    expect(result.output).toContain('[truncated: 2000000 bytes total]');
    expect(Buffer.byteLength(result.output)).toBeLessThan(200_000);
    expect(Buffer.byteLength(streamed.join(''))).toBeLessThan(200_000);
  });

  /**
   * A pipe hands over tens of kilobytes at a time. Checking the budget before appending the whole
   * chunk would let the one that crosses the line through in full, which on a small budget is the
   * difference between a kilobyte and everything the command produced.
   */
  it('never keeps or streams more than the budget, not even by one chunk', async () => {
    const budget = 1024;
    const streamed: string[] = [];
    const result = await runShell(
      { command: "head -c 500000 /dev/zero | tr '\\0' a", cwd: null, timeoutMs: null },
      { ...context, maxOutputBytes: budget },
      { onOutput: (_stream, text) => streamed.push(text) },
    );
    expect(Buffer.byteLength(streamed.join(''))).toBe(budget);
    expect(result.bytes).toBe(500_000);
    // Every chunk after the budget is spent must be dropped rather than streamed as nothing: an
    // empty output event still costs a write and a transcript line, and there are as many of them
    // as the command cares to produce.
    expect(streamed.filter((piece) => piece === '')).toStrictEqual([]);
  });

  /** This is the guarantee that a command the model wrote cannot read the PAT or the API key. */
  it('gives the command an environment without either credential', async () => {
    const result = await runShell(
      { command: 'echo "[${GITHUB_TOKEN:-}${OPENAI_API_KEY:-}]"', cwd: null, timeoutMs: null },
      context,
    );
    expect(result.output.trim()).toBe('[]');
  });

  /** Git still authenticates; it just never reads the token from the environment. */
  it('points the command at the askpass helper and the token file instead', async () => {
    const result = await runShell(
      {
        command: 'echo "$GIT_ASKPASS $AH_GIT_TOKEN_FILE $GIT_TERMINAL_PROMPT"',
        cwd: null,
        timeoutMs: null,
      },
      context,
    );
    expect(result.output.trim()).toBe('/opt/agent-runtime/askpass.sh /tmp/ah-runtime/git-token 0');
  });

  /** Without bash in the image every tool call would otherwise reject. */
  it('reports a command that could not be started', async () => {
    const spawn: SpawnFunction = () => {
      const child = Object.assign(new EventEmitter(), {
        pid: undefined,
        stdout: null,
        stderr: null,
        kill: () => true,
      });
      setImmediate(() => child.emit('error', new Error('spawn bash ENOENT')));
      return child;
    };
    const result = await runShell(
      { command: 'echo hi', cwd: null, timeoutMs: null },
      {
        ...context,
        spawn,
      },
    );
    expect(result).toMatchObject({
      status: 'FAILED',
      output: 'failed to start command: spawn bash ENOENT',
    });
  });

  /** There is no process group to signal, and the run still has to finish rather than hang. */
  it('settles a timeout on a child that reports no process id', async () => {
    const spawn: SpawnFunction = () => {
      const child = Object.assign(new EventEmitter(), {
        pid: undefined,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => true,
      });
      setTimeout(() => child.emit('close', null), 80);
      return child;
    };
    const result = await runShell(
      { command: 'sleep 30', cwd: null, timeoutMs: 10 },
      {
        ...context,
        spawn,
      },
    );
    expect(result).toMatchObject({ status: 'TIMED_OUT', exitCode: null });
  });

  /**
   * A pipe hands over whatever bytes have arrived, so a character can be split across two reads.
   * Decoded chunk by chunk each half becomes a replacement character, and what the model is shown
   * is not what the command printed — in a transcript of a repository that is not written in
   * English, that is most of it.
   */
  it('reassembles a multi-byte character split across two reads', async () => {
    const bytes = new TextEncoder().encode('café');
    const spawn: SpawnFunction = () => {
      const child = Object.assign(new EventEmitter(), {
        pid: undefined,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => true,
      });
      setImmediate(() => {
        child.stdout.write(Buffer.from(bytes.slice(0, 4)));
        child.stdout.write(Buffer.from(bytes.slice(4)));
        setImmediate(() => child.emit('close', 0));
      });
      return child;
    };

    const result = await runShell(
      { command: 'cat name.txt', cwd: null, timeoutMs: null },
      { ...context, spawn },
    );

    expect(result.output).toBe('café');
  });

  /**
   * A run arms two things it must give back: a timer that would kill the command, and a listener
   * that would do the same on cancellation. Left behind, the timer holds the event loop open and
   * fires at a process that has already gone, and the listener arms a *further* timer every time
   * the turn is cancelled afterwards. Counted rather than inferred, because neither leftover
   * changes the result of the run that created it — which is exactly why nothing noticed.
   *
   * @param settle - How the child ends: closing normally, or failing to start.
   */
  it.each([
    ['closes', 'close' as const],
    ['fails to start', 'error' as const],
  ])(
    'disarms the timeout and the cancellation listener when the command %s',
    async (_name, settle) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const controller = new AbortController();
        const spawn: SpawnFunction = () => {
          const child = Object.assign(new EventEmitter(), {
            pid: undefined,
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            kill: () => true,
          });
          setImmediate(() => {
            if (settle === 'close') {
              child.emit('close', 0);
            } else {
              child.emit('error', new Error('spawn bash ENOENT'));
            }
          });
          return child;
        };

        await runShell(
          { command: 'true', cwd: null, timeoutMs: 10_000 },
          { ...context, spawn },
          {
            signal: controller.signal,
          },
        );

        expect(vi.getTimerCount()).toBe(0);
        controller.abort();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  /**
   * The grace period is two seconds, so this test genuinely waits for it: a command that traps
   * SIGTERM would otherwise keep the workspace busy after the turn was cancelled.
   */
  it('escalates to a forceful kill when the command ignores the termination signal', async () => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 50);
    const result = await runShell(
      { command: 'trap "" TERM; while :; do sleep 0.2; done', cwd: null, timeoutMs: 15_000 },
      context,
      { signal: controller.signal },
    );
    expect(result).toMatchObject({ status: 'FAILED', exitCode: null });
    expect(result.output).toContain('[cancelled]');
  });
});
