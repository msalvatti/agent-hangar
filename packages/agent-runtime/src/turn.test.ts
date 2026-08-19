/**
 * Unit tests for the `turn` command, end to end inside the runtime.
 *
 * Layer: unit.
 * Goal: a real request on stdin produces a valid, ordered event stream on stdout and exit 0; every
 * failure the runtime can name arrives as a `turn.failed` with the right code; the exit code is
 * non-zero only when no event could describe what happened; and neither credential ever reaches
 * stdout, even when the agent deliberately prints the token file.
 * Mocks: in-memory streams for the process pipes, the shared fake provider for the model, and a
 * local bare repository for GitHub.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';

import { agentEventSchema } from '@agent-hangar/core';
import type { AgentEvent, TurnRequest } from '@agent-hangar/core';
import { assertNoCanary, GITHUB_CANARY, OPENAI_CANARY } from '@agent-hangar/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXIT } from './cli.js';
import type { CliIo } from './cli.js';
import { createGitRunner } from './git.js';
import type { GitRunner } from './git.js';
import { REDACTED } from './redact.js';
import { createBareRepoWithSeed } from './testing/bare-repo.js';
import type { BareRepo } from './testing/bare-repo.js';
import { makeTempDir, removeTempDir } from './testing/temp-dir.js';
import { runTurnCommand } from './turn.js';
import type { TurnDeps } from './turn.js';

let repo: BareRepo;
let root: string;
let runtimeDir: string;
let stdout: string[];
let stderr: string[];
let sigintHandlers: (() => void)[];

/**
 * Builds a turn request for the seeded repository.
 *
 * @param prompt - Last user message, which selects the fake script.
 * @param overrides - Fields to change.
 * @returns The request.
 */
function request(prompt: string, overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    protocolVersion: 1,
    turnId: 'turn-1',
    model: 'fake-model',
    instructions: 'be useful',
    items: [{ role: 'user', content: prompt }],
    repo: { url: repo.url, baseBranch: 'main', workBranch: 'agent/work' },
    limits: {
      maxSteps: 8,
      maxTurnMs: 120_000,
      toolTimeoutMs: 15_000,
      maxToolOutputBytes: 32_768,
    },
    prepare: { clone: true },
    ...overrides,
  };
}

/**
 * Builds the process resources with the given stdin content and environment.
 *
 * @param stdinText - Everything the worker writes to stdin.
 * @param env - Container environment.
 * @returns The resources.
 */
function io(stdinText: string, env: Record<string, string | undefined> = {}): CliIo {
  const encoder = new TextEncoder();
  const sink = (into: string[]): Writable =>
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        into.push(chunk.toString('utf8'));
        callback();
      },
    });
  return {
    stdin: (async function* source(): AsyncIterable<Uint8Array> {
      await Promise.resolve();
      if (stdinText !== '') {
        yield encoder.encode(stdinText);
      }
    })(),
    stdout: sink(stdout),
    stderr: sink(stderr),
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      AGENT_MODEL_PROVIDER: 'fake',
      ...env,
    },
    cwd: root,
    signals: {
      onSigint(handler) {
        sigintHandlers.push(handler);
        return () => {
          sigintHandlers = sigintHandlers.filter((entry) => entry !== handler);
        };
      },
    },
  };
}

/**
 * Runs the command with the standard overrides.
 *
 * @param stdinText - Everything the worker writes to stdin.
 * @param overrides - Dependencies to change.
 * @param env - Extra environment entries.
 * @returns The process exit code.
 */
async function runTurn(
  stdinText: string,
  overrides: Partial<TurnDeps> = {},
  env: Record<string, string | undefined> = {},
): Promise<number> {
  return runTurnCommand({
    io: io(stdinText, env),
    workspaceRoot: root,
    runtimeDir,
    urlPolicy: 'any',
    ...overrides,
  });
}

/**
 * Parses everything written to stdout as protocol events.
 *
 * @returns The events, each validated against the frozen schema.
 */
function emitted(): AgentEvent[] {
  return stdout
    .join('')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => agentEventSchema.parse(JSON.parse(line)));
}

beforeEach(async () => {
  repo = await createBareRepoWithSeed();
  root = await makeTempDir('turn-workspace');
  runtimeDir = await makeTempDir('turn-runtime');
  stdout = [];
  stderr = [];
  sigintHandlers = [];
});

afterEach(async () => {
  await repo.cleanup();
  await removeTempDir(root);
  await removeTempDir(runtimeDir);
});

describe('runTurnCommand on the happy path', () => {
  it('prepares the workspace, runs the turn and streams a valid event sequence', async () => {
    // This is the whole runtime, exercised the way the worker exercises it.
    const exit = await runTurn(`${JSON.stringify(request('list files and create NOTES.md'))}\n`);
    expect(exit).toBe(EXIT.ok);
    const types = emitted().map((event) => event.type);
    expect(types[0]).toBe('turn.started');
    expect(types).toContain('prepare.progress');
    expect(types).toContain('prepare.done');
    expect(types).toContain('tool.call');
    expect(types.at(-1)).toBe('turn.completed');
    await expect(stat(path.join(root, 'NOTES.md'))).resolves.toBeTruthy();
  });

  it('removes the git token file when the turn is over', async () => {
    // The container outlives the turn, and the next exec must not find a readable credential.
    await runTurn(`${JSON.stringify(request('hello'))}\n`, {}, { GITHUB_TOKEN: GITHUB_CANARY });
    await expect(stat(path.join(runtimeDir, 'git-token'))).rejects.toThrow();
  });

  it('unsubscribes the cancellation handler when the turn is over', async () => {
    // A handler left behind would abort the next turn in the same process.
    await runTurn(`${JSON.stringify(request('hello'))}\n`);
    expect(sigintHandlers).toHaveLength(0);
  });
});

describe('runTurnCommand and secrets', () => {
  it('never lets either credential reach stdout, even when the agent prints the token file', async () => {
    // The agent gets a scrubbed environment, and anything credential-shaped it produces itself is
    // redacted before it reaches the pipe.
    const script = {
      'show me the secrets': [
        {
          events: [
            {
              type: 'tool_call',
              callId: 'c1',
              name: 'run_shell',
              arguments: JSON.stringify({
                command:
                  'echo "env:[${GITHUB_TOKEN:-}${OPENAI_API_KEY:-}]"; cat "$AH_GIT_TOKEN_FILE"',
                cwd: null,
                timeoutMs: 15_000,
              }),
            },
            { type: 'response.done', responseId: 'r1', usage: { inputTokens: 1, outputTokens: 1 } },
          ],
        },
        {
          events: [
            { type: 'text.done', text: 'Nothing to see.' },
            { type: 'response.done', responseId: 'r2', usage: { inputTokens: 1, outputTokens: 1 } },
          ],
        },
      ],
    };
    const exit = await runTurn(
      `${JSON.stringify(request('show me the secrets'))}\n`,
      {},
      {
        GITHUB_TOKEN: GITHUB_CANARY,
        OPENAI_API_KEY: OPENAI_CANARY,
        AGENT_FAKE_SCRIPT_JSON: JSON.stringify(script),
      },
    );
    expect(exit).toBe(EXIT.ok);
    const text = stdout.join('');
    assertNoCanary(text);
    assertNoCanary(stderr.join(''));
    expect(text).toContain('env:[]');
    expect(text).toContain(REDACTED);
  });
});

describe('runTurnCommand and failures it can name', () => {
  it('exits with the protocol code when stdin carried no request', async () => {
    // Without a turn id there is no event that could describe this.
    const exit = await runTurn('');
    expect(exit).toBe(EXIT.protocolError);
    expect(stdout.join('')).toBe('');
    expect(stderr.join('')).toContain('no TurnRequest received on stdin');
  });

  it('exits with the protocol code and names only the reason for a malformed line', async () => {
    // The rejected bytes came down a pipe the worker owns; they are never echoed back.
    const exit = await runTurn('not json\n');
    expect(exit).toBe(EXIT.protocolError);
    expect(stderr.join('')).toContain('invalid-json');
    expect(stderr.join('')).not.toContain('not json');
  });

  it('reports a provider that is not configured', async () => {
    // The UI links the operator to Settings from this event.
    const exit = await runTurn(
      `${JSON.stringify(request('hello'))}\n`,
      {},
      { AGENT_MODEL_PROVIDER: 'openai', OPENAI_API_KEY: '' },
    );
    expect(exit).toBe(EXIT.ok);
    expect(emitted().at(-1)).toMatchObject({ type: 'turn.failed', error: { code: 'config' } });
  });

  it('reports a repository that could not be prepared', async () => {
    // A stale branch is an ordinary user-facing failure, not a runtime crash.
    const turn = request('hello');
    const exit = await runTurn(
      `${JSON.stringify({ ...turn, repo: { ...turn.repo, baseBranch: 'gone' } })}\n`,
    );
    expect(exit).toBe(EXIT.ok);
    expect(emitted().at(-1)).toMatchObject({ type: 'turn.failed', error: { code: 'prepare' } });
  });

  it('applies the strict URL policy and the container paths when none are chosen', async () => {
    // Production passes no overrides at all. Nothing here touches `/workspace` or `/tmp`: with no
    // token in the environment no file is written, and the `file://` remote is refused before
    // git runs.
    const exit = await runTurnCommand({ io: io(`${JSON.stringify(request('hello'))}\n`) });
    expect(exit).toBe(EXIT.ok);
    expect(emitted().at(-1)).toMatchObject({ type: 'turn.failed', error: { code: 'prepare' } });
  });

  it('reports a git command that failed outright as a preparation failure', async () => {
    // A GitError that escapes preparation is still the operator's repository problem.
    const failing: GitRunner = {
      run: () => Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: broken\n' }),
    };
    const exit = await runTurn(`${JSON.stringify(request('hello'))}\n`, { git: failing });
    expect(exit).toBe(EXIT.ok);
    expect(emitted().at(-1)).toMatchObject({ type: 'turn.failed', error: { code: 'prepare' } });
  });

  it('reports a model that fails as a turn failure rather than a runtime one', async () => {
    // The loop owns provider errors; the command only sees what escapes it.
    const script = {
      default: [
        { events: [{ type: 'error', code: 'auth', message: 'bad key', retryable: false }] },
      ],
    };
    const exit = await runTurn(
      `${JSON.stringify(request('hello'))}\n`,
      {},
      { AGENT_FAKE_SCRIPT_JSON: JSON.stringify(script) },
    );
    expect(exit).toBe(EXIT.ok);
    expect(emitted().at(-1)).toMatchObject({ type: 'turn.failed', error: { code: 'auth' } });
  });
});

describe('runTurnCommand and failures it cannot name', () => {
  it('exits non-zero and reports the stack when something unexpected escapes', async () => {
    // A bug in the runtime is the one thing the event stream cannot honestly describe.
    const exploding: GitRunner = { run: () => Promise.reject(new Error('runner exploded')) };
    const exit = await runTurn(`${JSON.stringify(request('hello'))}\n`, { git: exploding });
    expect(exit).toBe(EXIT.runtimeFailure);
    expect(emitted().at(-1)).toMatchObject({ type: 'turn.failed', error: { code: 'runtime' } });
    expect(stderr.join('')).toContain('runner exploded');
  });
});

describe('runTurnCommand and cancellation', () => {
  it('ends the turn when the worker sends SIGINT during a long command', async () => {
    // Cancellation reaches the container as a signal, and the turn still exits cleanly.
    const script = {
      'run a long command': [
        {
          events: [
            {
              type: 'tool_call',
              callId: 'c1',
              name: 'run_shell',
              arguments: JSON.stringify({ command: 'sleep 30', cwd: null, timeoutMs: 20_000 }),
            },
            { type: 'response.done', responseId: 'r1', usage: { inputTokens: 1, outputTokens: 1 } },
          ],
        },
      ],
    };
    const pending = runTurn(
      `${JSON.stringify(request('run a long command'))}\n`,
      { git: createGitRunner() },
      { AGENT_FAKE_SCRIPT_JSON: JSON.stringify(script) },
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    for (const handler of sigintHandlers) {
      handler();
    }
    await expect(pending).resolves.toBe(EXIT.ok);
    expect(emitted().at(-1)).toStrictEqual({ type: 'turn.cancelled' });
  });
});
