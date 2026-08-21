/**
 * Shared fixture for the turn-loop suites: a temporary workspace, a collected event stream and a
 * cancellation handle, wired to `runTurnLoop` the way the worker wires it.
 *
 * Layer: test double.
 *
 * The loop has more behaviour than one suite can hold under the review cap, and every one of those
 * suites needs the same three things and the same call. Handing them out from here is what lets
 * the suites be split by subject — the model and its tools, the ways a turn is interrupted, what
 * lands on the remote — without each one carrying its own copy of the wiring, which is the version
 * that drifts.
 *
 * {@link createLoopHarness} registers its own `beforeEach`/`afterEach`, so it is called once at the
 * top level of a suite file and nowhere else: each test then gets a fresh directory, an empty event
 * log and an unaborted controller.
 */
import type { AgentEvent, AgentModelProvider, ModelEvent, TurnRequest } from '@agent-hangar/core';
import { FakeAgentModelProvider } from '@agent-hangar/core/testing';
import type { ProviderScript } from '@agent-hangar/core/testing';
import { afterEach, beforeEach } from 'vitest';

import { createChildEnv } from '../child-env.js';
import { createGitRunner } from '../git.js';
import { runTurnLoop } from '../loop.js';
import type { LoopDeps, LoopOutcome } from '../loop.js';
import { createToolExecutor, TOOL_DEFINITIONS } from '../tools/index.js';

import { makeTempDir, removeTempDir } from './temp-dir.js';

/** Environment the loop's children run in; the developer's own git configuration is excluded. */
const CHILD_ENV = createChildEnv({
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
});

/** Limits of a request built by {@link LoopHarness.request}, before any override. */
const DEFAULT_LIMITS: TurnRequest['limits'] = {
  maxSteps: 8,
  maxTurnMs: 1_200_000,
  toolTimeoutMs: 10_000,
  maxToolOutputBytes: 32_768,
};

/** What one turn-loop suite is handed for the duration of a single test. */
export interface LoopHarness {
  /** Temporary directory standing in for `/workspace`, fresh for every test. */
  readonly root: string;
  /** Every event the loop emitted so far in this test, in order. */
  readonly events: AgentEvent[];
  /** Environment the loop's children run in, for a suite that spawns git of its own. */
  readonly childEnv: ReturnType<typeof createChildEnv>;
  /** Cancels the turn under test, as the worker does when the operator presses Stop. */
  cancel(): void;
  /**
   * Builds a request whose last user message selects a script.
   *
   * @param prompt - Text of the user message.
   * @param limits - Limit overrides.
   * @returns The request.
   */
  request(prompt: string, limits?: Partial<TurnRequest['limits']>): TurnRequest;
  /**
   * Runs the loop against a scripted provider, collecting its events into {@link LoopHarness.events}.
   *
   * @param turn - The request.
   * @param provider - Provider to stream from.
   * @param overrides - Loop dependencies to replace.
   * @returns How the turn ended.
   */
  run(
    turn: TurnRequest,
    provider: AgentModelProvider,
    overrides?: Partial<LoopDeps>,
  ): Promise<LoopOutcome>;
  /**
   * Lists the types of the emitted events.
   *
   * @returns One type per event, in order.
   */
  eventTypes(): string[];
}

/**
 * Builds a provider that replays a script.
 *
 * @param script - Steps keyed by the last user message.
 * @returns The provider.
 */
export function scripted(script: ProviderScript): FakeAgentModelProvider {
  return new FakeAgentModelProvider({ script });
}

/**
 * Builds a four-step script in which every step ends with the same error.
 *
 * Four is the loop's own retry budget, so a retryable code is exhausted by exactly this script and
 * a non-retryable one ends the turn on the first step.
 *
 * @param code - Error category.
 * @returns The script.
 */
export function errorScript(code: 'rate_limit' | 'auth'): ProviderScript {
  const events: ModelEvent[] = [
    { type: 'error', code, message: `${code} from provider`, retryable: code === 'rate_limit' },
  ];
  return { default: [{ events }, { events }, { events }, { events }] };
}

/** The parts of one test's fixture the loop's dependencies are built around. */
interface LoopFixture {
  root: string;
  events: AgentEvent[];
  signal: AbortSignal;
}

/**
 * Assembles the dependencies the loop is run with, the way the worker assembles them.
 *
 * `emit` collects rather than writes, `redactText` is the identity — redaction has its own suite —
 * and `lastEmittedAt` answers zero, which reads as "nothing has been written yet" and so leaves the
 * heartbeat free to fire. A suite that cares about any of the three replaces it through
 * `overrides`, which is applied last for exactly that reason.
 *
 * @param turn - The request, whose limits size the tool executor.
 * @param provider - Provider to stream from.
 * @param fixture - This test's workspace, event log and cancellation signal.
 * @param overrides - Dependencies to replace.
 * @returns The full dependency set.
 */
function loopDeps(
  turn: TurnRequest,
  provider: AgentModelProvider,
  fixture: LoopFixture,
  overrides: Partial<LoopDeps>,
): LoopDeps {
  return {
    request: turn,
    provider,
    tools: createToolExecutor({
      workspaceRoot: fixture.root,
      childEnv: CHILD_ENV,
      toolTimeoutMs: turn.limits.toolTimeoutMs,
      maxToolOutputBytes: turn.limits.maxToolOutputBytes,
    }),
    toolDefinitions: TOOL_DEFINITIONS,
    emit: async (event) => {
      fixture.events.push(event);
      await Promise.resolve();
    },
    redactText: (text) => text,
    lastEmittedAt: () => 0,
    workspaceRoot: fixture.root,
    childEnv: CHILD_ENV,
    git: createGitRunner(),
    signal: fixture.signal,
    ...overrides,
  };
}

/**
 * Registers the per-test fixture and returns the handle the suite drives it through.
 *
 * @param label - Short name of the calling suite, so a stray temporary directory names its owner.
 * @returns The harness, whose `root` and `events` are replaced before each test.
 */
export function createLoopHarness(label: string): LoopHarness {
  let root = '';
  let events: AgentEvent[] = [];
  let controller = new AbortController();

  beforeEach(async () => {
    root = await makeTempDir(label);
    events = [];
    controller = new AbortController();
  });

  afterEach(async () => {
    await removeTempDir(root);
  });

  return {
    get root() {
      return root;
    },
    get events() {
      return events;
    },
    childEnv: CHILD_ENV,
    cancel() {
      controller.abort();
    },
    request(prompt, limits = {}) {
      return {
        protocolVersion: 1,
        turnId: 'turn-1',
        model: 'fake-model',
        instructions: 'be useful',
        items: [{ role: 'user', content: prompt }],
        repo: { url: 'https://github.com/acme/widgets', baseBranch: 'main', workBranch: 'agent/x' },
        limits: { ...DEFAULT_LIMITS, ...limits },
        prepare: { clone: false },
      };
    },
    run(turn, provider, overrides = {}) {
      return runTurnLoop(
        loopDeps(turn, provider, { root, events, signal: controller.signal }, overrides),
      );
    },
    eventTypes() {
      return events.map((event) => event.type);
    },
  };
}
