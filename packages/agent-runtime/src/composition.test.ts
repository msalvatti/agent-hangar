/**
 * Unit tests for the production composition of the runtime.
 *
 * Layer: unit.
 * Goal: the runtime that ships really can build the OpenAI provider — the key from the container
 * environment reaches the wire, the endpoint the environment names is honoured, and a whole turn
 * runs from stdin to `turn.completed` against the real SDK client; while the same turn composed
 * without the factories fails with the configuration error, so an unwired build can never pass
 * for a wired one.
 * Mocks: a local HTTP server replaying a recorded Responses stream stands in for the API, and a
 * local bare repository stands in for GitHub. The OpenAI SDK, its client, the provider and the
 * mapping layer are all the real ones.
 */
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { Writable } from 'node:stream';

import { agentEventSchema, loadOpenAIFixture } from '@agent-hangar/core';
import type { AgentEvent, ModelEvent, TurnRequest } from '@agent-hangar/core';
import { assertNoCanary, OPENAI_CANARY } from '@agent-hangar/core/testing';
import type { ResponseStreamEvent } from 'openai/resources/responses/responses';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXIT, runCli } from './cli.js';
import type { CliIo, CliOverrides } from './cli.js';
import { PRODUCTION_PROVIDER_FACTORIES, runProductionCli } from './composition.js';
import { createGitRunner } from './git.js';
import type { GitRunner } from './git.js';
import { createBareRepoWithSeed } from './testing/bare-repo.js';
import type { BareRepo } from './testing/bare-repo.js';
import { makeTempDir, removeTempDir } from './testing/temp-dir.js';
import { RUNTIME_VERSION } from './version.js';

/** Remote named by the fixture request; {@link gitAgainstFixture} redirects it to disk. */
const REMOTE_URL = 'https://github.com/agent-hangar/fixture.git';

/**
 * Origin the workspace is created for, written to the file preparation reads.
 *
 * The real policy is exercised rather than bypassed: the turn resolves {@link REMOTE_URL} against
 * this origin exactly as a container does, and only the transport underneath it is local.
 */
const REMOTE_ORIGIN = 'https://github.com';

/** Text of the recorded response, and therefore of the assistant message the turn produces. */
const ANSWER = 'Hello, world.';

/** Identifier of the recorded response, echoed back in `response.done`. */
const RESPONSE_ID = 'resp_6f2a1c9b47e8d05a3b12c4d7';

/** Usage of the recorded response, as the mapping layer normalises it. */
const RECORDED_USAGE = { inputTokens: 120, outputTokens: 18 };

/** Exactly what a runtime composed without the factories reports instead of running the turn. */
const UNWIRED_FAILURE: AgentEvent = {
  type: 'turn.failed',
  error: {
    code: 'config',
    message:
      'the openai provider is not wired into this build; see packages/agent-runtime/src/composition.ts',
  },
};

/** A stub Responses API listening on the loopback interface. */
interface StubApi {
  /** Endpoint to hand the SDK, including the `/v1` prefix it expects. */
  baseURL: string;
  /** `Authorization` header of every request the SDK made, in order. */
  authorizations: string[];
  /** Stops listening. */
  close(): Promise<void>;
}

let repo: BareRepo;
let root: string;
let runtimeDir: string;
let originFile: string;
let stdout: string[];
let stderr: string[];
let api: StubApi;

/**
 * Restores the shape the SDK's stream accumulator expects of a message item.
 *
 * The recorded fixtures announce a message whose `content` already holds the (empty) text part
 * that the following `content_part.added` goes on to append, and the SDK refuses to append a part
 * at an index the array already fills. Replaying them through the real client — which is the
 * point of this suite — therefore needs the announcement the live API sends: an empty array.
 *
 * @param event - One event of a recorded stream.
 * @returns The same event, with an added message item emptied of its content.
 */
function withEmptyMessageContent(event: ResponseStreamEvent): ResponseStreamEvent {
  if (event.type !== 'response.output_item.added' || event.item.type !== 'message') {
    return event;
  }
  return { ...event, item: { ...event.item, content: [] } };
}

/**
 * Starts a stub Responses API that replays one recorded stream to every request.
 *
 * @param events - The stream to serve, in order.
 * @returns The endpoint, the credentials it observed and a way to stop it.
 */
async function startStubApi(events: readonly ResponseStreamEvent[]): Promise<StubApi> {
  const authorizations: string[] = [];
  const body = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
  const server = createServer((incoming, response) => {
    authorizations.push(incoming.headers.authorization ?? '');
    // The request body is drained rather than read: what it carries is the provider's business,
    // and the stream has to end before the response may.
    incoming.resume();
    incoming.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(body);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the stub API did not bind a TCP port');
  }
  const { port } = address;
  return {
    baseURL: `http://127.0.0.1:${String(port)}/v1`,
    authorizations,
    close: () =>
      new Promise<void>((resolve) => {
        // The SDK holds its connection open for reuse, and a socket the client still owns would
        // keep `close` from ever calling back.
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/**
 * Real git, with {@link REMOTE_URL} pointing at the seeded bare repository.
 *
 * @returns A runner that substitutes the remote and delegates everything else.
 */
function gitAgainstFixture(): GitRunner {
  const real = createGitRunner();
  return {
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
 * @returns The request the worker would write to stdin.
 */
function request(): TurnRequest {
  return {
    protocolVersion: 1,
    turnId: 'turn-1',
    model: 'gpt-5.6-sol',
    instructions: 'be useful',
    items: [{ role: 'user', content: 'say hello' }],
    repo: { url: REMOTE_URL, baseBranch: 'main', workBranch: 'agent/work' },
    limits: {
      maxSteps: 8,
      maxTurnMs: 120_000,
      toolTimeoutMs: 15_000,
      maxToolOutputBytes: 32_768,
    },
    prepare: { clone: true },
  };
}

/**
 * Builds the process resources with the given stdin content.
 *
 * `AGENT_MODEL_PROVIDER` is deliberately unset: the real provider is the default, so this is the
 * environment a workspace container actually receives.
 *
 * @param stdinText - Everything the worker writes to stdin.
 * @returns The resources.
 */
function io(stdinText: string): CliIo {
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
      OPENAI_API_KEY: OPENAI_CANARY,
      OPENAI_BASE_URL: api.baseURL,
    },
    cwd: root,
    signals: {
      onSigint: () => () => undefined,
    },
  };
}

/**
 * Overrides that put the turn on a local checkout without touching the provider wiring.
 *
 * @returns The workspace root, the private runtime directory and the redirected git runner.
 */
function localWorkspace(): CliOverrides {
  return { workspaceRoot: root, runtimeDir, originFile, git: gitAgainstFixture() };
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
  root = await makeTempDir('composition-workspace');
  runtimeDir = await makeTempDir('composition-runtime');
  originFile = path.join(runtimeDir, 'allowed-origin');
  await writeFile(originFile, `${REMOTE_ORIGIN}\n`, 'utf8');
  stdout = [];
  stderr = [];
  api = await startStubApi((await loadOpenAIFixture('text')).map(withEmptyMessageContent));
});

afterEach(async () => {
  await api.close();
  await repo.cleanup();
  await removeTempDir(root);
  await removeTempDir(runtimeDir);
});

describe('PRODUCTION_PROVIDER_FACTORIES', () => {
  it('streams a real round-trip through the OpenAI SDK', async () => {
    // The factory is the whole fix: it has to produce a provider that talks to the configured
    // endpoint with the configured key, not merely something shaped like one.
    const provider = PRODUCTION_PROVIDER_FACTORIES.openai({
      apiKey: OPENAI_CANARY,
      baseURL: api.baseURL,
    });
    const events: ModelEvent[] = [];
    for await (const event of provider.stream({
      model: 'gpt-5.6-sol',
      instructions: 'be useful',
      items: [{ role: 'user', content: 'say hello' }],
      tools: [],
    })) {
      events.push(event);
    }

    expect(provider.name).toBe('openai');
    expect(events).toContainEqual({ type: 'text.done', text: ANSWER });
    expect(events.at(-1)).toStrictEqual({
      type: 'response.done',
      responseId: RESPONSE_ID,
      usage: RECORDED_USAGE,
    });
    expect(api.authorizations).toStrictEqual([`Bearer ${OPENAI_CANARY}`]);
  });
});

describe('runProductionCli', () => {
  it('runs a whole turn against the real provider', async () => {
    // The defect this covers shipped a build whose every unit test passed against the fake
    // provider: only a turn that reaches the real one can tell the two builds apart.
    const exit = await runProductionCli(
      ['turn'],
      io(`${JSON.stringify(request())}\n`),
      localWorkspace(),
    );

    expect(exit).toBe(EXIT.ok);
    const events = emitted();
    expect(events.map((event) => event.type).at(-1)).toBe('turn.completed');
    expect(events).toContainEqual({ type: 'assistant.message', text: ANSWER });
    expect(api.authorizations).toStrictEqual([`Bearer ${OPENAI_CANARY}`]);
  });

  it('keeps the key out of everything the turn writes', async () => {
    // The key now reaches an SDK client that reports its own failures; nothing it produces may
    // travel back out through the event stream or the diagnostics.
    await runProductionCli(['turn'], io(`${JSON.stringify(request())}\n`), localWorkspace());

    assertNoCanary(stdout.join(''));
    assertNoCanary(stderr.join(''));
  });

  it('needs no overrides at all', async () => {
    // What `bin.ts` calls: two arguments, no seam left to fill in by hand.
    const exit = await runProductionCli(['--version'], io(''));

    expect(exit).toBe(EXIT.ok);
    expect(stdout.join('')).toBe(`${RUNTIME_VERSION}\n`);
  });
});

describe('the same turn composed without the factories', () => {
  it('fails as a configuration error instead of reaching the model', async () => {
    // This is the build that shipped. It stays reproducible so the difference the composition
    // makes is measured rather than assumed, and it is deliberately the only way to get here.
    const exit = await runCli(['turn'], io(`${JSON.stringify(request())}\n`), localWorkspace());

    expect(exit).toBe(EXIT.ok);
    expect(emitted()).toContainEqual(UNWIRED_FAILURE);
    expect(api.authorizations).toStrictEqual([]);
  });
});
