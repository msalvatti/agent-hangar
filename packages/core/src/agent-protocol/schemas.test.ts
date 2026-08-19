/**
 * Unit tests for the agent protocol Zod schemas.
 *
 * Layer: unit.
 * Goal: every schema accepts its spec example and rejects a malformed variant, and the derived
 * types stay structurally compatible with the model-provider contract.
 * Mocks: none.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { ConversationItem } from '../model/types.js';

import {
  agentEventSchema,
  conversationItemSchema,
  PROTOCOL_VERSION,
  toolNameSchema,
  turnRequestSchema,
} from './schemas.js';
import type { AgentEvent, ProtocolConversationItem, TurnRequest } from './types.js';

/** A valid turn request used as the baseline of every mutation below. */
const validRequest: TurnRequest = {
  protocolVersion: 1,
  turnId: 'turn-1',
  model: 'gpt-5.6-sol',
  instructions: 'You are a coding agent.',
  items: [
    { role: 'user', content: 'Fix the tests' },
    { type: 'tool_call', callId: 'c1', name: 'run_shell', arguments: '{"command":"ls"}' },
    { type: 'tool_result', callId: 'c1', output: 'README.md' },
  ],
  repo: {
    url: 'https://github.com/acme/widgets',
    baseBranch: 'main',
    workBranch: 'agent/abc123',
    expectedHeadSha: 'deadbeef',
  },
  limits: {
    maxSteps: 40,
    maxTurnMs: 1_200_000,
    toolTimeoutMs: 300_000,
    maxToolOutputBytes: 32_768,
  },
  prepare: { clone: true },
};

/** Every event variant with realistic values. */
const validEvents: AgentEvent[] = [
  { type: 'turn.started', turnId: 'turn-1', at: '2026-08-19T10:00:00.000Z' },
  { type: 'prepare.progress', message: 'Cloning…' },
  { type: 'prepare.done', headSha: 'abc123', branch: 'agent/abc123' },
  { type: 'step.started', step: 1 },
  { type: 'assistant.delta', text: 'Looking' },
  { type: 'assistant.message', text: 'Looking at the repo.' },
  { type: 'tool.call', callId: 'c1', name: 'run_shell', args: { command: 'ls' }, seq: 0 },
  { type: 'tool.output.delta', callId: 'c1', stream: 'stdout', text: 'README.md\n' },
  {
    type: 'tool.result',
    callId: 'c1',
    exitCode: 0,
    bytes: 10,
    durationMs: 12,
    status: 'SUCCEEDED',
  },
  { type: 'git.pushed', branch: 'agent/abc123', sha: 'abc123' },
  { type: 'heartbeat', at: '2026-08-19T10:00:10.000Z' },
  {
    type: 'turn.completed',
    usage: { inputTokens: 100, outputTokens: 20 },
    steps: 2,
    finalMessage: 'Done.',
  },
  {
    type: 'turn.completed',
    usage: { inputTokens: 100, outputTokens: 20 },
    steps: 40,
    finalMessage: 'Stopped at the step limit.',
    stoppedBy: 'limit',
  },
  { type: 'turn.failed', error: { code: 'auth', message: 'OpenAI rejected the key' } },
  { type: 'turn.cancelled' },
  { type: 'protocol.error', line: '{oops', reason: 'invalid JSON' },
];

describe('toolNameSchema', () => {
  /**
   * The four tools of the runtime are accepted; anything else (including case variants) is
   * rejected so a typo in the runtime cannot reach the model.
   */
  it('accepts the four tool names and rejects others', () => {
    for (const name of ['run_shell', 'read_file', 'write_file', 'list_dir']) {
      expect(toolNameSchema.safeParse(name).success).toBe(true);
    }
    expect(toolNameSchema.safeParse('RUN_SHELL').success).toBe(false);
    expect(toolNameSchema.safeParse('delete_repo').success).toBe(false);
  });
});

describe('conversationItemSchema', () => {
  /**
   * All three item shapes parse; a message with an unknown role and a tool call without a call id
   * are rejected.
   */
  it('accepts message, tool_call and tool_result items and rejects malformed ones', () => {
    for (const item of validRequest.items) {
      expect(conversationItemSchema.safeParse(item).success).toBe(true);
    }
    expect(conversationItemSchema.safeParse({ role: 'tool', content: 'x' }).success).toBe(false);
    expect(
      conversationItemSchema.safeParse({ type: 'tool_call', name: 'run_shell', arguments: '{}' })
        .success,
    ).toBe(false);
  });

  /**
   * Compile-time contract: the protocol item type must be assignable to the model contract's
   * `ConversationItem` and vice versa, otherwise the worker could not forward history to the
   * provider without mapping.
   */
  it('derives a type structurally equal to the model ConversationItem', () => {
    expectTypeOf<ProtocolConversationItem>().toEqualTypeOf<ConversationItem>();
  });
});

describe('turnRequestSchema', () => {
  /**
   * The spec example parses unchanged (no coercion, no stripping of required fields).
   */
  it('accepts the spec example', () => {
    const result = turnRequestSchema.safeParse(validRequest);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(validRequest);
  });

  /**
   * `expectedHeadSha` is optional, but when present it must look like a git sha.
   */
  it('allows omitting expectedHeadSha but validates its shape', () => {
    const { expectedHeadSha: _omitted, ...repo } = validRequest.repo;
    expect(turnRequestSchema.safeParse({ ...validRequest, repo }).success).toBe(true);
    expect(
      turnRequestSchema.safeParse({ ...validRequest, repo: { ...repo, expectedHeadSha: 'zzz' } })
        .success,
    ).toBe(false);
  });

  /**
   * Boundary values: a different protocol version, a credential-bearing or relative repo URL and
   * non-positive limits are rejected.
   */
  it('rejects wrong protocol version, bad repo url and non-positive limits', () => {
    expect(turnRequestSchema.safeParse({ ...validRequest, protocolVersion: 2 }).success).toBe(
      false,
    );
    expect(
      turnRequestSchema.safeParse({
        ...validRequest,
        repo: { ...validRequest.repo, url: 'acme/w' },
      }).success,
    ).toBe(false);
    expect(
      turnRequestSchema.safeParse({
        ...validRequest,
        limits: { ...validRequest.limits, maxSteps: 0 },
      }).success,
    ).toBe(false);
  });

  /**
   * The exported protocol version constant matches the literal in the schema.
   */
  it('exports the protocol version accepted by the schema', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

describe('agentEventSchema', () => {
  /**
   * Every variant in the spec (plus `protocol.error` and `stoppedBy: 'limit'`) round-trips.
   */
  it.each(validEvents.map((event) => [event.type, event] as const))(
    'accepts %s',
    (_type, event) => {
      const result = agentEventSchema.safeParse(event);
      expect(result.success).toBe(true);
      expect(result.data).toEqual(event);
    },
  );

  /**
   * Malformed variants: unknown type, wrong field type, missing field, bad enum value, bad
   * timestamp.
   */
  it.each([
    ['unknown type', { type: 'turn.paused' }],
    ['step as string', { type: 'step.started', step: '1' }],
    [
      'missing finalMessage',
      { type: 'turn.completed', usage: { inputTokens: 1, outputTokens: 1 }, steps: 1 },
    ],
    ['bad stream', { type: 'tool.output.delta', callId: 'c', stream: 'stdin', text: '' }],
    [
      'bad status',
      { type: 'tool.result', callId: 'c', exitCode: 0, bytes: 0, durationMs: 0, status: 'OK' },
    ],
    ['bad timestamp', { type: 'heartbeat', at: 'yesterday' }],
    [
      'bad stoppedBy',
      {
        type: 'turn.completed',
        usage: { inputTokens: 1, outputTokens: 1 },
        steps: 1,
        finalMessage: '',
        stoppedBy: 'user',
      },
    ],
    ['bad tool name', { type: 'tool.call', callId: 'c', name: 'rm_rf', args: {}, seq: 0 }],
  ])('rejects %s', (_label, event) => {
    expect(agentEventSchema.safeParse(event).success).toBe(false);
  });

  /**
   * `tool.call.args` is `unknown` but required: a call without args is rejected, while `null`
   * args (a tool with no parameters) are accepted.
   */
  it('requires args on tool.call but accepts null', () => {
    expect(
      agentEventSchema.safeParse({ type: 'tool.call', callId: 'c', name: 'list_dir', seq: 0 })
        .success,
    ).toBe(false);
    expect(
      agentEventSchema.safeParse({
        type: 'tool.call',
        callId: 'c',
        name: 'list_dir',
        args: null,
        seq: 0,
      }).success,
    ).toBe(true);
  });
});
