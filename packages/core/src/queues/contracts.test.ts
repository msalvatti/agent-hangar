/**
 * Unit tests for the queue contracts.
 *
 * Layer: unit.
 * Goal: queue/job names match the spec, payload schemas accept the documented shapes and reject
 * malformed ones, and the Redis key helpers produce the documented keys.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import {
  destroyChatWorkspacePayload,
  JOB_NAMES,
  QUEUE_NAMES,
  reapIdlePayload,
  runScheduledJobPayload,
  runTurnPayload,
  turnCommand,
  turnCommandChannel,
  turnEventsStreamKey,
} from './contracts.js';

describe('names', () => {
  /**
   * The literal queue and job names are part of the Redis data layout; a rename would orphan
   * queued work, so they are pinned here.
   */
  it('pins queue and job names', () => {
    expect(QUEUE_NAMES).toEqual({
      chatTurns: 'chat-turns',
      scheduledJobs: 'scheduled-jobs',
      workspaceGc: 'workspace-gc',
    });
    expect(JOB_NAMES).toEqual({
      runTurn: 'run-turn',
      runScheduledJob: 'run-scheduled-job',
      reapIdle: 'reap-idle',
      destroyChatWorkspace: 'destroy-chat-workspace',
    });
  });
});

describe('payload schemas', () => {
  /**
   * Each payload accepts its documented shape and rejects a missing or empty id / bad trigger.
   */
  it('validate documented payloads and reject malformed ones', () => {
    expect(runTurnPayload.parse({ turnId: 't1' })).toEqual({ turnId: 't1' });
    expect(runTurnPayload.safeParse({ turnId: '' }).success).toBe(false);

    expect(runScheduledJobPayload.parse({ jobId: 'j1', trigger: 'MANUAL' })).toEqual({
      jobId: 'j1',
      trigger: 'MANUAL',
    });
    expect(runScheduledJobPayload.safeParse({ jobId: 'j1', trigger: 'CRON' }).success).toBe(false);

    expect(reapIdlePayload.parse({})).toEqual({});

    expect(destroyChatWorkspacePayload.parse({ chatId: 'c1' })).toEqual({ chatId: 'c1' });
    expect(destroyChatWorkspacePayload.safeParse({}).success).toBe(false);

    expect(turnCommand.parse({ type: 'cancel' })).toEqual({ type: 'cancel' });
    expect(turnCommand.safeParse({ type: 'pause' }).success).toBe(false);
  });
});

describe('key helpers', () => {
  /**
   * Stream and channel keys follow `events:turn:<id>` / `cmd:turn:<id>` as documented in the
   * SSE and cancel flows.
   */
  it('build the documented Redis keys', () => {
    expect(turnEventsStreamKey('abc')).toBe('events:turn:abc');
    expect(turnCommandChannel('abc')).toBe('cmd:turn:abc');
  });
});
