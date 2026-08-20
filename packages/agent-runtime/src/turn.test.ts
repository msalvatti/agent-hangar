/**
 * Unit tests for the `turn` command, end to end inside the runtime.
 *
 * Layer: unit.
 * Goal: a real request on stdin produces a valid, ordered event stream on stdout and exit 0; every
 * failure the runtime can name arrives as a `turn.failed` with the right code; the exit code is
 * non-zero only when no event could describe what happened; and neither credential ever reaches
 * stdout, even when the agent deliberately prints the token file.
 * Mocks: in-memory streams for the process pipes, the shared fake provider for the model, provider
 * factories that refuse to build a real one, and a local bare repository for GitHub.
 */
import { rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';

import { agentEventSchema } from '@agent-hangar/core';
import type { AgentEvent, TurnRequest } from '@agent-hangar/core';
import { assertNoCanary, GITHUB_CANARY, OPENAI_CANARY } from '@agent-hangar/core/testing';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';

import { EXIT } from './cli.js';
import type { CliDeps, CliIo, CliOverrides } from './cli.js';
import { createGitRunner } from './git.js';
import type { GitRunner } from './git.js';
import type { ProviderFactories } from './provider.js';
import { REDACTED } from './redact.js';
import { createBareRepoWithSeed } from './testing/bare-repo.js';
import type { BareRepo } from './testing/bare-repo.js';
import { makeTempDir, removeTempDir } from './testing/temp-dir.js';
import { runTurnCommand } from './turn.js';
import type { TurnDeps } from './turn.js';

let repo: BareRepo;
let root: string;
let runtimeDir: string;
let originFile: string;
let stdout: string[];
let stderr: string[];
let sigintHandlers: (() => void)[];

/**
 * Remote named by every fixture request.
 *
 * The turn request crosses `turnRequestSchema`, which requires a credential-free hierarchical
 * `http(s)` URL, so the `file://` path of the local bare repository can no longer be the URL the
 * worker sends. The fixture therefore names a plausible GitHub remote and {@link gitAgainstFixture}
 * redirects it to the repository on disk, which keeps every git command in these tests real and
 * changes only where `origin` lives.
 */
const REMOTE_URL = 'https://github.com/agent-hangar/fixture.git';

/**
 * Wiring every turn here is run with, and none of them may use.
 *
 * The environment {@link io} builds names the fake provider, so these turns never construct a real
 * one — and the turn that asks for `openai` is there to be refused for a missing key, before any
 * factory is consulted. Refusing to build says which provider the suite is running against, where
 * a stub would let a turn that quietly reached the real SDK look like an ordinary pass.
 */
const NO_REAL_PROVIDER: ProviderFactories = {
  openai: () => {
    throw new Error('this suite runs against the fake provider; no real one may be built');
  },
};

/**
 * Real git, with {@link REMOTE_URL} pointing at the seeded bare repository.
 *
 * @returns A runner that substitutes the remote and delegates everything else.
 */
function gitAgainstFixture(): GitRunner {
  const real = createGitRunner();
  return {
    // The subcommand is never a URL, so only the arguments after it are translated; keeping it
    // separate is also what preserves the non-empty tuple the runner's type promises.
    run: (args, options) =>
      real.run(
        [args[0], ...args.slice(1).map((arg) => (arg === REMOTE_URL ? repo.url : arg))],
        options,
      ),
  };
}

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
    repo: { url: REMOTE_URL, baseBranch: 'main', workBranch: 'agent/work' },
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
    providerFactories: NO_REAL_PROVIDER,
    workspaceRoot: root,
    runtimeDir,
    originFile,
    git: gitAgainstFixture(),
    ...overrides,
  });
}

/**
 * The message of the last emitted event, when that event is a `turn.failed`.
 *
 * @returns The failure message, or an empty string when the last event was something else.
 */
function lastFailureMessage(): string {
  const last = emitted().at(-1);
  return last?.type === 'turn.failed' ? last.error.message : '';
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
  // Stands in for the root-owned file the runner places before the container starts. Every test
  // that does not say otherwise runs as a workspace created for the fixture's own origin.
  originFile = path.join(runtimeDir, 'allowed-origin');
  await writeFile(originFile, 'https://github.com\n', 'utf8');
  stdout = [];
  stderr = [];
  sigintHandlers = [];
});

afterEach(async () => {
  await repo.cleanup();
  await removeTempDir(root);
  await removeTempDir(runtimeDir);
});

describe('what runTurnCommand asks to be given', () => {
  it('will not accept process resources and overrides alone, without the provider wiring', () => {
    // Every turn builds a provider, and which one the environment names is not knowable when the
    // dependencies are assembled — so a turn assembled without the wiring is a turn that may have
    // nothing to run against. It takes what the dispatcher was given rather than restating it,
    // which is what keeps the two from disagreeing again. Checked by the compiler, not at run
    // time: these are what fail if the field goes back to optional.
    expectTypeOf<{ io: CliIo } & CliOverrides>().not.toExtend<TurnDeps>();
    expectTypeOf<TurnDeps>().toExtend<CliDeps>();
  });
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
    // The UI links the operator to Settings from this event, so the message has to be the one
    // about the missing key. A runtime whose wiring was left out reports a different configuration
    // failure with the same code, and only the message tells an operator's problem from a build's.
    const exit = await runTurn(
      `${JSON.stringify(request('hello'))}\n`,
      {},
      { AGENT_MODEL_PROVIDER: 'openai', OPENAI_API_KEY: '' },
    );
    expect(exit).toBe(EXIT.ok);
    expect(emitted().at(-1)).toMatchObject({ type: 'turn.failed', error: { code: 'config' } });
    expect(lastFailureMessage()).toBe('OPENAI_API_KEY is not set in the workspace environment');
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

  it('applies the placed URL policy and the container paths when none are chosen', async () => {
    // Production overrides nothing beyond the wiring it must supply, so the policy comes from the
    // file at its default path, which does not exist here. Nothing touches `/workspace` or `/tmp`
    // and nothing reaches the network: a container nobody prepared is a configuration failure
    // before anything clones.
    const turn = request('hello');
    const exit = await runTurnCommand({
      io: io(
        `${JSON.stringify({ ...turn, repo: { ...turn.repo, url: 'http://github.com/acme/demo' } })}\n`,
      ),
      providerFactories: NO_REAL_PROVIDER,
    });
    expect(exit).toBe(EXIT.ok);
    expect(emitted().at(-1)).toMatchObject({ type: 'turn.failed', error: { code: 'config' } });
    expect(lastFailureMessage()).toContain('/opt/agent-runtime/allowed-origin');
  });

  it('refuses a repository on a forge the workspace was not created for', async () => {
    // The whole point of binding the container to one origin: this URL is a perfectly ordinary
    // GitHub repository, and this workspace exists for a local forge, so preparation refuses it
    // rather than clone — and authenticate to — something nobody provisioned it for.
    await writeFile(originFile, 'http://host.docker.internal:3907\n', 'utf8');

    const exit = await runTurn(`${JSON.stringify(request('hello'))}\n`);

    expect(exit).toBe(EXIT.ok);
    expect(emitted().at(-1)).toMatchObject({ type: 'turn.failed', error: { code: 'prepare' } });
    expect(lastFailureMessage()).toContain('http://host.docker.internal:3907/<owner>/<repo>');
  });

  it('fails closed when the container was never told which origin it serves', async () => {
    // A container nobody prepared has no forge to fall back to; reporting it as configuration is
    // what puts the missing file in front of the operator instead of an authentication failure.
    await rm(originFile, { force: true });

    const exit = await runTurn(`${JSON.stringify(request('hello'))}\n`);

    expect(exit).toBe(EXIT.ok);
    expect(emitted().at(-1)).toMatchObject({ type: 'turn.failed', error: { code: 'config' } });
    expect(lastFailureMessage()).toContain('must hold the origin this workspace was created for');
  });

  it('ignores an origin named in the environment', async () => {
    // The variable this policy used to travel in is model-controlled: the shell tool runs a
    // command the model wrote, and a command may set any variable for the process it starts.
    // Naming a foreign origin there must change nothing, because nothing reads it any more.
    const exit = await runTurn(
      `${JSON.stringify(request('hello'))}\n`,
      {},
      {
        AH_GIT_ALLOWED_ORIGIN: 'https://evil.test',
      },
    );

    expect(exit).toBe(EXIT.ok);
    expect(emitted().map((event) => event.type)).toContain('prepare.done');
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
      {},
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
