/**
 * Unit tests for what the loop does with the findings preparation hands it.
 *
 * Layer: unit.
 * Goal: a finding about the checkout reaches the model as part of the conversation it plans
 * against, and a preparation that found nothing costs that conversation nothing.
 * Mocks: a provider that records the input it is given and answers once; the tools and the git
 * runner are stubs, because no step of these turns calls either.
 *
 * A suite of its own rather than more cases in `loop.test.ts`: that file is already over the
 * 800-line cap this project reviews against.
 */
import type { AgentModelProvider, ModelTurnInput, TurnRequest } from '@agent-hangar/core';
import { FAKE_USAGE } from '@agent-hangar/core/testing';
import { describe, expect, it } from 'vitest';

import type { GitRunner } from './git.js';
import { runTurnLoop } from './loop.js';
import type { LoopDeps } from './loop.js';
import type { ToolExecutor } from './tools/index.js';

/** Neither is reached: these turns end at the first step, before any tool call or push check. */
const UNUSED_TOOLS: ToolExecutor = {
  execute: () => Promise.reject(new Error('no tool call was expected')),
};
const UNUSED_GIT: GitRunner = {
  run: () => Promise.reject(new Error('no git command was expected')),
};

/**
 * Builds the smallest request that runs one step.
 *
 * @returns The request.
 */
function request(): TurnRequest {
  return {
    protocolVersion: 1,
    turnId: 'turn-1',
    model: 'fake-model',
    instructions: 'be useful',
    items: [{ role: 'user', content: 'hi' }],
    repo: { url: 'https://github.com/acme/widgets', baseBranch: 'main', workBranch: 'agent/x' },
    limits: {
      maxSteps: 4,
      maxTurnMs: 60_000,
      toolTimeoutMs: 10_000,
      maxToolOutputBytes: 32_768,
    },
    prepare: { clone: false },
  };
}

/**
 * A provider that records what it is asked to stream, then answers once.
 *
 * Recording the input is the point: the assertion is about the conversation the model is actually
 * shown, rather than about anything the loop reports having done.
 *
 * @param inputs - Array each round-trip's input is appended to.
 * @returns The provider.
 */
function recording(inputs: ModelTurnInput[]): AgentModelProvider {
  return {
    name: 'recording',
    async *stream(input: ModelTurnInput) {
      inputs.push(input);
      yield { type: 'text.done', text: 'done' };
      yield { type: 'response.done', responseId: 'r1', usage: FAKE_USAGE };
      await Promise.resolve();
    },
    listModels: () => Promise.resolve([]),
  };
}

/**
 * Runs one turn against the recording provider.
 *
 * @param inputs - Array each round-trip's input is appended to.
 * @param overrides - Loop dependencies to add, such as the preparation findings.
 */
async function run(inputs: ModelTurnInput[], overrides: Partial<LoopDeps> = {}): Promise<void> {
  await runTurnLoop({
    request: request(),
    provider: recording(inputs),
    tools: UNUSED_TOOLS,
    toolDefinitions: [],
    // Discarded on purpose: what this suite measures is on the provider's side of the loop, and
    // the event sequence is already pinned by `loop.test.ts`.
    emit: () => Promise.resolve(),
    redactText: (text) => text,
    lastEmittedAt: () => 0,
    workspaceRoot: '/workspace',
    childEnv: {},
    git: UNUSED_GIT,
    signal: new AbortController().signal,
    ...overrides,
  });
}

describe('runTurnLoop and what preparation found', () => {
  /**
   * A work branch that diverged from its remote is a fact about the ground the turn stands on,
   * and the agent is what can reconcile it — it has git and it is already in the workspace. The
   * finding used to reach the event stream only, so the model planned against a branch nobody had
   * told it had moved.
   */
  it('shows preparation findings to the model', async () => {
    const inputs: ModelTurnInput[] = [];
    await run(inputs, { prepareNotes: ['Warning: agent/x and origin/agent/x have diverged'] });

    expect(inputs[0]?.items).toStrictEqual([
      { role: 'user', content: 'hi' },
      {
        role: 'system',
        content:
          'Workspace preparation reported:\n- Warning: agent/x and origin/agent/x have diverged',
      },
    ]);
  });

  /** Several findings travel as one item, so the window pays once however much was found. */
  it('carries every finding in a single system item', async () => {
    const inputs: ModelTurnInput[] = [];
    await run(inputs, { prepareNotes: ['Warning: first', 'Warning: second'] });

    expect(inputs[0]?.items).toHaveLength(2);
    expect(inputs[0]?.items[1]).toStrictEqual({
      role: 'system',
      content: 'Workspace preparation reported:\n- Warning: first\n- Warning: second',
    });
  });

  /** A clean preparation adds nothing, so an ordinary turn pays no context for the mechanism. */
  it('adds nothing to the conversation when preparation found nothing', async () => {
    const inputs: ModelTurnInput[] = [];
    await run(inputs);

    expect(inputs[0]?.items).toStrictEqual([{ role: 'user', content: 'hi' }]);
  });
});
