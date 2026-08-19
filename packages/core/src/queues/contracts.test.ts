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
  parseTurnEventEntry,
  TURN_EVENT_FIELD,
  turnCommand,
  turnCommandChannel,
  turnEventsStreamKey,
  WORKER_HEARTBEAT_INTERVAL_SEC,
  WORKER_HEARTBEAT_TTL_SEC,
  workerHeartbeatKey,
  workerHeartbeatSchema,
} from './contracts.ts';

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

describe('worker heartbeat', () => {
  /**
   * The health route looks the heartbeat up by instance, so the key layout is part of the
   * contract between the worker that writes it and the web process that reads it.
   */
  it('builds the documented heartbeat key', () => {
    expect(workerHeartbeatKey('default')).toBe('health:worker:default');
    expect(workerHeartbeatKey('w2a')).toBe('health:worker:w2a');
  });

  /**
   * The TTL must leave room for more than one missed write, otherwise a single slow cycle would
   * report a healthy worker as down.
   */
  it('keeps the TTL a multiple of the write interval', () => {
    expect(WORKER_HEARTBEAT_TTL_SEC).toBe(90);
    expect(WORKER_HEARTBEAT_INTERVAL_SEC).toBe(30);
    expect(WORKER_HEARTBEAT_TTL_SEC / WORKER_HEARTBEAT_INTERVAL_SEC).toBeGreaterThanOrEqual(3);
  });

  /**
   * The payload crosses a process boundary as JSON, so every field is validated: a heartbeat the
   * schema rejects is reported as "worker down" rather than surfacing partial readings.
   */
  it('accepts a complete heartbeat and rejects malformed ones', () => {
    const heartbeat = {
      at: '2026-08-19T10:00:00.000Z',
      dockerOk: true,
      imagePresent: false,
      containers: 2,
    };
    expect(workerHeartbeatSchema.parse(heartbeat)).toEqual(heartbeat);
    expect(workerHeartbeatSchema.safeParse({ ...heartbeat, at: 'yesterday' }).success).toBe(false);
    expect(workerHeartbeatSchema.safeParse({ ...heartbeat, containers: -1 }).success).toBe(false);
    expect(workerHeartbeatSchema.safeParse({ ...heartbeat, dockerOk: 'yes' }).success).toBe(false);
  });
});

describe('parseTurnEventEntry', () => {
  /**
   * The happy path: the worker writes `['event', '<JSON>']`, and the reader gets the typed event
   * back so an SSE frame can carry the event's own `type`.
   */
  it('reads the event out of the documented field list', () => {
    const event = { type: 'assistant.delta', text: 'hi' };
    expect(parseTurnEventEntry([TURN_EVENT_FIELD, JSON.stringify(event)])).toEqual(event);
  });

  /**
   * Extra fields are tolerated as long as `event` is among them: a future producer may add
   * bookkeeping fields, and the reader must not break on them.
   */
  it('finds the event field among others', () => {
    const event = { type: 'turn.cancelled' };
    const fields = ['seq', '7', TURN_EVENT_FIELD, JSON.stringify(event)];
    expect(parseTurnEventEntry(fields)).toEqual(event);
  });

  /**
   * Every unreadable shape yields `null` rather than throwing: the entries come from another
   * process, and one bad entry must not end a live stream.
   */
  it('returns null for entries it cannot decode', () => {
    expect(parseTurnEventEntry([])).toBeNull();
    expect(parseTurnEventEntry(['other', 'value'])).toBeNull();
    expect(parseTurnEventEntry([TURN_EVENT_FIELD])).toBeNull();
    expect(parseTurnEventEntry([TURN_EVENT_FIELD, 'not json'])).toBeNull();
    expect(parseTurnEventEntry([TURN_EVENT_FIELD, '{"type":"unknown.event"}'])).toBeNull();
    expect(parseTurnEventEntry([TURN_EVENT_FIELD, '{"type":"assistant.delta"}'])).toBeNull();
  });
});
