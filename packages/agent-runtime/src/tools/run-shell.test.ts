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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
  it('runs a command in the workspace and reports its output and exit code', async () => {
    // The baseline every other behaviour builds on.
    const result = await runShell({ command: 'echo hi', cwd: null, timeoutMs: null }, context);
    expect(result).toMatchObject({
      output: 'hi\n',
      exitCode: 0,
      status: 'SUCCEEDED',
      command: 'echo hi',
    });
  });

  it('reports a non-zero exit as a failure with the code', async () => {
    // A failing build is information for the model, not a runtime error.
    const result = await runShell({ command: 'exit 3', cwd: null, timeoutMs: null }, context);
    expect(result).toMatchObject({ exitCode: 3, status: 'FAILED' });
  });

  it('interleaves stdout and stderr and streams both through the hook', async () => {
    // The transcript shows output as it arrives, in the order the command produced it.
    const streamed: [string, string][] = [];
    const result = await runShell(
      { command: 'echo a; echo b >&2; sleep 0.05; echo c', cwd: null, timeoutMs: null },
      context,
      { onOutput: (stream, text) => streamed.push([stream, text]) },
    );
    expect(result.output).toContain('a\n');
    expect(result.output).toContain('b\n');
    expect(streamed.map(([stream]) => stream)).toContain('stderr');
    expect(streamed.map(([, text]) => text).join('')).toBe(result.output);
  });

  it('runs in a subdirectory of the workspace when asked', async () => {
    // Repositories have layouts; the model needs to be able to work inside them.
    // `pwd` reports the directory with symbolic links resolved, which on macOS differs from the
    // path the temporary directory was created under.
    const result = await runShell({ command: 'pwd', cwd: 'sub', timeoutMs: null }, context);
    expect(result.output.trim()).toBe(await realpath(path.join(root, 'sub')));
  });

  it.each([
    ['a directory outside the workspace', '../elsewhere', 'escapes the workspace'],
    ['a directory that does not exist', 'missing', 'cwd does not exist'],
  ])('refuses %s', async (_name, cwd, expected) => {
    // The working directory is as much of an escape route as a file path.
    const result = await runShell({ command: 'pwd', cwd, timeoutMs: null }, context);
    expect(result.status).toBe('FAILED');
    expect(result.output).toContain(expected);
  });

  it('refuses a working directory that is a file', async () => {
    // `spawn` would fail obscurely; the model gets a clear message instead.
    await writeFile(path.join(root, 'file.txt'), 'x', 'utf8');
    const result = await runShell({ command: 'pwd', cwd: 'file.txt', timeoutMs: null }, context);
    expect(result.output).toBe('cwd is not a directory: file.txt');
  });

  it('kills a command and its children when the timeout fires', async () => {
    // A backgrounded child would otherwise outlive the turn inside the container.
    const started = Date.now();
    const result = await runShell(
      { command: 'sleep 30 & wait', cwd: null, timeoutMs: 200 },
      context,
    );
    expect(result.status).toBe('TIMED_OUT');
    expect(result.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('terminates the command when the turn is cancelled', async () => {
    // Cancellation reaches the runtime as SIGINT and has to stop the current tool.
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

  it('terminates a command whose cancellation arrived before it started', async () => {
    // A listener added to an already-aborted signal is never called.
    const controller = new AbortController();
    controller.abort();
    const result = await runShell({ command: 'sleep 30', cwd: null, timeoutMs: 10_000 }, context, {
      signal: controller.signal,
    });
    expect(result.status).toBe('FAILED');
    expect(result.output).toContain('[cancelled]');
  });

  it('caps the output, keeps counting it, and stops streaming once the budget is spent', async () => {
    // Buffering everything a command produces would exhaust the container long before the
    // per-command timeout could stop it, so past the budget the output is counted and dropped.
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

  it('gives the command an environment without either credential', async () => {
    // This is the guarantee that a command the model wrote cannot read the PAT or the API key.
    const result = await runShell(
      { command: 'echo "[${GITHUB_TOKEN:-}${OPENAI_API_KEY:-}]"', cwd: null, timeoutMs: null },
      context,
    );
    expect(result.output.trim()).toBe('[]');
  });

  it('points the command at the askpass helper and the token file instead', async () => {
    // Git still authenticates; it just never reads the token from the environment.
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

  it('reports a command that could not be started', async () => {
    // Without bash in the image every tool call would otherwise reject.
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

  it('settles a timeout on a child that reports no process id', async () => {
    // There is no process group to signal, and the run still has to finish rather than hang.
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

  it('escalates to a forceful kill when the command ignores the termination signal', async () => {
    // The grace period is two seconds, so this test genuinely waits for it: a command that traps
    // SIGTERM would otherwise keep the workspace busy after the turn was cancelled.
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
