/**
 * Fixtures shared by the processor tests: the runners that fail in ways the fake cannot, the
 * scripted happy path, and the helpers that read back what the worker sent into a workspace.
 *
 * Layer: test double.
 *
 * They live here rather than in one test file because the turn processor and the scheduled-job
 * processor exercise the same failures against the same runner contract; a second copy of
 * "a runner whose create cannot reach the daemon" would be a second place to get it wrong.
 */
import { turnRequestSchema, WorkspaceImageMissing } from '@agent-hangar/core';
import type {
  AgentEvent,
  Chat,
  ExecEvent,
  ExecSpec,
  RunTurnPayload,
  Turn,
  WorkspaceHandle,
  WorkspaceHealth,
  WorkspaceSpec,
} from '@agent-hangar/core';
import { FakeClock, FakeWorkspaceRunner } from '@agent-hangar/core/testing';
import type { ExecScript, FakeWorkspaceRunnerOptions } from '@agent-hangar/core/testing';

import { createRunTurnProcessor } from '../processors/run-turn.js';
import type { ProcessorJob } from '../processors/types.js';

import type { FakeSecretsService } from './fake-secrets.js';
import { scriptedRuntime, stdinOf } from './scripted-runtime.js';
import { createTestContainer } from './test-container.js';
import type { TestContainer } from './test-container.js';

/** Public repository the processor tests work against. */
export const FIXTURE_REPO_URL = 'https://github.com/octocat/Hello-World.git';

/** Contents the scripted agent writes, so a summary's byte count is predictable. */
export const FIXTURE_NOTES_CONTENT = '# Notes\n';

/** A clock that moves on every read, so `lastActiveAt` can be told apart from `createdAt`. */
export class TickingClock extends FakeClock {
  /**
   * Reads the current instant and advances a second.
   *
   * @returns The instant before the advance.
   */
  override now(): Date {
    const instant = super.now();
    this.advance(1000);
    return instant;
  }
}

/** A runner whose containers are always reported as gone. */
export class GoneRunner extends FakeWorkspaceRunner {
  /**
   * @returns Always `gone`.
   */
  override health(): Promise<WorkspaceHealth> {
    return Promise.resolve({ status: 'gone' });
  }
}

/** A runner whose containers answer but are broken. */
export class UnhealthyRunner extends FakeWorkspaceRunner {
  /**
   * @returns Always `unhealthy`, with a fixed reason.
   */
  override health(): Promise<WorkspaceHealth> {
    return Promise.resolve({ status: 'unhealthy', reason: 'exec probe failed' });
  }
}

/** A runner that has no workspace image. */
export class ImagelessRunner extends FakeWorkspaceRunner {
  /**
   * @throws WorkspaceImageMissing Always.
   */
  override async create(): Promise<WorkspaceHandle> {
    await Promise.resolve();
    throw new WorkspaceImageMissing('agent-hangar/workspace:test');
  }
}

/** A runner whose `create` rejects with whatever the test supplies. */
export class UncreatableRunner extends FakeWorkspaceRunner {
  /**
   * @param failure - What `create` rejects with.
   * @param options - Forwarded to the fake runner.
   */
  constructor(
    private readonly failure: unknown,
    options: FakeWorkspaceRunnerOptions = {},
  ) {
    super(options);
  }

  /**
   * @throws unknown The failure this runner was built with.
   */
  override async create(): Promise<WorkspaceHandle> {
    await Promise.resolve();
    throw this.failure;
  }
}

/** A runner whose `exec` cannot be started at all. */
export class UnreachableRunner extends FakeWorkspaceRunner {
  /**
   * @param failure - What `exec` rejects with.
   * @param options - Forwarded to the fake runner.
   */
  constructor(
    private readonly failure: unknown,
    options: FakeWorkspaceRunnerOptions = {},
  ) {
    super(options);
  }

  /**
   * @throws unknown The failure this runner was built with.
   */
  override async *exec(): AsyncIterable<ExecEvent> {
    await Promise.resolve();
    throw this.failure;
  }
}

/**
 * Builds the socket error a Docker daemon that is not listening produces.
 *
 * @returns An error carrying `ECONNREFUSED`, as the driver's does.
 */
export function connectionRefused(): Error {
  return Object.assign(new Error('connect ECONNREFUSED /var/run/docker.sock'), {
    code: 'ECONNREFUSED',
  });
}

/**
 * The events a successful chat turn produces, in the order the runtime writes them.
 *
 * @returns A fresh array, so a test may edit its copy.
 */
export function happyTurnScript(): AgentEvent[] {
  return [
    { type: 'turn.started', turnId: 'ignored', at: '2026-01-01T00:00:00.000Z' },
    { type: 'prepare.progress', message: 'Cloning…' },
    { type: 'prepare.done', headSha: 'abc1234', branch: 'main' },
    { type: 'step.started', step: 1 },
    { type: 'assistant.delta', text: 'Writing' },
    {
      type: 'tool.call',
      callId: 'call-1',
      name: 'write_file',
      args: { path: 'NOTES.md', content: FIXTURE_NOTES_CONTENT },
      seq: 1,
    },
    { type: 'tool.output.delta', callId: 'call-1', stream: 'stdout', text: 'wrote ' },
    { type: 'tool.output.delta', callId: 'call-1', stream: 'stdout', text: 'NOTES.md' },
    {
      type: 'tool.result',
      callId: 'call-1',
      exitCode: 0,
      bytes: 14,
      durationMs: 12,
      status: 'SUCCEEDED',
    },
    { type: 'git.pushed', branch: 'agent/feature', sha: 'deadbee' },
    { type: 'step.started', step: 2 },
    { type: 'assistant.message', text: 'Created NOTES.md.' },
    {
      type: 'turn.completed',
      usage: { inputTokens: 11, outputTokens: 22 },
      steps: 2,
      finalMessage: 'Created NOTES.md.',
    },
  ];
}

/**
 * A runtime that starts a turn and then holds it open until the exec is cancelled.
 *
 * What a test built on it gets is a processor parked inside its exec, holding a `BUSY` workspace —
 * the state a second processor has to be told it cannot join.
 *
 * @returns The script.
 */
export function heldTurnScript(): ExecScript {
  return scriptedRuntime(
    [
      { type: 'turn.started', turnId: 'ignored', at: '2026-01-01T00:00:00.000Z' },
      { type: 'prepare.progress', message: 'Cloning…' },
    ],
    { holdUntilSignal: { afterEvent: 2 } },
  );
}

/** How a processor test wants its container wired. */
export interface ProcessorSetupOptions {
  /** Script the runner answers the runtime command with. */
  script?: ExecScript;
  /** Clock shared by the repositories and the runner. */
  clock?: FakeClock;
  /** Secrets service; omit a key to exercise the missing-credential path. */
  secrets?: FakeSecretsService;
  /** Builds the runner from the options the setup resolved. */
  runner?: (options: FakeWorkspaceRunnerOptions) => FakeWorkspaceRunner;
}

/**
 * Reports the moment a workspace is marked `BUSY`.
 *
 * A processor takes its workspace and starts executing in it, and a test that wants to interleave
 * a second processor with the first needs a point to interleave at. This is that point: once it
 * settles, the first processor owns a container and is inside its exec, which is the state every
 * race over a live workspace starts from.
 *
 * @param container - The container whose repositories are observed.
 * @returns A promise settling when some workspace of this container goes `BUSY`.
 */
export function whenWorkspaceIsBusy(container: TestContainer): Promise<void> {
  const repository = container.repos.workspaces;
  const setStatus = repository.setStatus.bind(repository);
  return new Promise<void>((resolve) => {
    repository.setStatus = async (id, status, update) => {
      const row = await setStatus(id, status, update);
      if (status === 'BUSY') {
        resolve();
      }
      return row;
    };
  });
}

/**
 * Builds a test container whose runner already carries the script the test needs.
 *
 * @param options - Script, clock, secrets and runner.
 * @returns The container.
 */
export function setupProcessorContainer(options: ProcessorSetupOptions = {}): TestContainer {
  const clock = options.clock ?? new FakeClock();
  const runnerOptions: FakeWorkspaceRunnerOptions = {
    clock,
    scripts: options.script === undefined ? [] : [options.script],
  };
  const runner = (options.runner ?? ((opts) => new FakeWorkspaceRunner(opts)))(runnerOptions);
  return createTestContainer({
    clock,
    runner,
    ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
  });
}

/**
 * The workspace spec of the last `create` the runner recorded.
 *
 * @param container - The test container.
 * @returns The spec the worker asked the runner for.
 */
export function lastCreateSpec(container: TestContainer): WorkspaceSpec {
  const call = container.runner.calls.findLast((entry) => entry.method === 'create');
  return call?.args[0] as WorkspaceSpec;
}

/**
 * The turn request the runtime was handed, read back from the recorded exec.
 *
 * @param container - The test container.
 * @returns The parsed request, so a malformed one fails here rather than in an assertion.
 */
export async function requestSentTo(container: TestContainer): Promise<unknown> {
  const call = container.runner.calls.findLast((entry) => entry.method === 'exec');
  return turnRequestSchema.parse(JSON.parse(await stdinOf(call?.args[1] as ExecSpec)));
}

/**
 * Everything a run persisted, as one string, for a leak assertion.
 *
 * @param container - The test container.
 * @returns The JSON of every in-memory table.
 */
export function persistedText(container: TestContainer): string {
  const { store } = container.repos;
  return JSON.stringify([
    [...store.chats.values()],
    [...store.messages.values()],
    [...store.turns.values()],
    [...store.workspaces.values()],
    [...store.toolCalls.values()],
    [...store.jobRuns.values()],
  ]);
}

/**
 * Seeds a chat with its opening user message and a queued turn.
 *
 * @param container - The test container.
 * @param options - Repository URL and base-branch overrides, for the cases where a stored value
 *   must be one the protocol refuses.
 * @returns The chat and the turn.
 */
export async function seedChatWithTurn(
  container: TestContainer,
  options: { repoUrl?: string; baseBranch?: string; prompt?: string } = {},
): Promise<{ chat: Chat; turn: Turn }> {
  const chat = await container.repos.chats.create({
    title: 'First task',
    repoUrl: options.repoUrl ?? FIXTURE_REPO_URL,
    baseBranch: options.baseBranch ?? 'main',
  });
  await container.repos.messages.append(
    chat.id,
    'USER',
    options.prompt ?? 'list files and create NOTES.md',
  );
  const turn = await container.repos.turns.create({
    chatId: chat.id,
    model: container.config.OPENAI_MODEL,
  });
  return { chat, turn };
}

/**
 * Builds the structural part of a BullMQ delivery of `run-turn`.
 *
 * @param turnId - The turn to run.
 * @param attemptsMade - How many times BullMQ already delivered it.
 * @returns The job.
 */
export function turnJob(turnId: string, attemptsMade = 0): ProcessorJob<RunTurnPayload> {
  return { id: turnId, name: 'run-turn', data: { turnId }, attemptsMade };
}

/**
 * Runs the turn processor over a seeded turn.
 *
 * @param container - The test container, which satisfies `ProcessorDeps`.
 * @param turnId - The turn to run.
 * @param attemptsMade - How many times BullMQ already delivered it.
 */
export async function runTurnOn(
  container: TestContainer,
  turnId: string,
  attemptsMade = 0,
): Promise<void> {
  await createRunTurnProcessor(container)(turnJob(turnId, attemptsMade));
}
