/**
 * Queue contracts: BullMQ queue/job names, payload schemas and Redis key helpers.
 *
 * Layer: contract.
 *
 * Producers (web) and consumers (worker) share these so a payload can never drift. Worker
 * connections use `maxRetriesPerRequest: null`; producers use defaults.
 */
import { z } from 'zod';

import { agentEventSchema } from '../agent-protocol/schemas.ts';
import type { AgentEvent } from '../agent-protocol/types.ts';

/** BullMQ queue names. */
export const QUEUE_NAMES = {
  chatTurns: 'chat-turns',
  scheduledJobs: 'scheduled-jobs',
  workspaceGc: 'workspace-gc',
} as const;

/** One of {@link QUEUE_NAMES}. */
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** BullMQ job names. */
export const JOB_NAMES = {
  runTurn: 'run-turn',
  runScheduledJob: 'run-scheduled-job',
  reapIdle: 'reap-idle',
  destroyChatWorkspace: 'destroy-chat-workspace',
} as const;

/** One of {@link JOB_NAMES}. */
export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

/** `chat-turns` / `run-turn` payload; the BullMQ `jobId` equals `turnId` for idempotency. */
export const runTurnPayload = z.object({ turnId: z.string().min(1) });

/** `scheduled-jobs` / `run-scheduled-job` payload. */
export const runScheduledJobPayload = z.object({
  jobId: z.string().min(1),
  trigger: z.enum(['SCHEDULE', 'MANUAL']),
});

/** `workspace-gc` / `reap-idle` payload (none). */
export const reapIdlePayload = z.object({});

/** `workspace-gc` / `destroy-chat-workspace` payload (archive destroys the live workspace). */
export const destroyChatWorkspacePayload = z.object({ chatId: z.string().min(1) });

/** Payload of `run-turn`. */
export type RunTurnPayload = z.infer<typeof runTurnPayload>;
/** Payload of `run-scheduled-job`. */
export type RunScheduledJobPayload = z.infer<typeof runScheduledJobPayload>;
/** Payload of `reap-idle`. */
export type ReapIdlePayload = z.infer<typeof reapIdlePayload>;
/** Payload of `destroy-chat-workspace`. */
export type DestroyChatWorkspacePayload = z.infer<typeof destroyChatWorkspacePayload>;

/** Interval of the idle-workspace GC scheduler. */
export const REAP_IDLE_EVERY_MS = 5 * 60_000;

/** Redis Stream TTL for turn events (SSE replay cache). */
export const TURN_EVENTS_TTL_SECONDS = 60 * 60;

/** Approximate maximum number of entries kept per turn event stream. */
export const TURN_EVENTS_MAXLEN = 5000;

/**
 * Redis Stream key carrying the events of one turn or job run.
 *
 * @param turnId - `Turn.id` or `JobRun.id`.
 */
export function turnEventsStreamKey(turnId: string): string {
  return `events:turn:${turnId}`;
}

/**
 * Redis pub/sub channel on which the web app publishes commands (`cancel`) for a turn.
 *
 * @param turnId - `Turn.id` or `JobRun.id`.
 */
export function turnCommandChannel(turnId: string): string {
  return `cmd:turn:${turnId}`;
}

/** Commands published on {@link turnCommandChannel}. */
export const turnCommand = z.object({ type: z.literal('cancel') });

/** A command published on the turn command channel. */
export type TurnCommand = z.infer<typeof turnCommand>;

/**
 * Redis key holding the worker's health heartbeat for one instance.
 *
 * `GET /api/health` reports Docker reachability and workspace-image presence from this key rather
 * than opening a Docker connection of its own: only the worker owns one, and the health route is
 * polled by the UI, so it must stay cheap.
 *
 * @param instance - `AH_INSTANCE`.
 * @returns The Redis key.
 */
export function workerHeartbeatKey(instance: string): string {
  return `health:worker:${instance}`;
}

/**
 * Lifetime of the heartbeat key, in seconds.
 *
 * Three writes fit in the window, so one slow cycle does not report a healthy worker as down. A
 * reader still compares `at` against the same window: a key can be present and stale while Redis
 * has not evicted it yet.
 */
export const WORKER_HEARTBEAT_TTL_SEC = 90;

/** How often the worker rewrites {@link workerHeartbeatKey}, in seconds. */
export const WORKER_HEARTBEAT_INTERVAL_SEC = 30;

/** Payload the worker stores under {@link workerHeartbeatKey}, JSON-encoded. */
export const workerHeartbeatSchema = z.object({
  /** When the worker took these readings. */
  at: z.iso.datetime(),
  /** Whether the Docker daemon answered. */
  dockerOk: z.boolean(),
  /** Whether the workspace image is present on the Docker host. */
  imagePresent: z.boolean(),
  /** Workspace containers the instance owned at that moment. */
  containers: z.number().int().nonnegative(),
});

/** A worker heartbeat. */
export type WorkerHeartbeat = z.infer<typeof workerHeartbeatSchema>;

/**
 * Name of the Redis Stream field carrying one JSON-encoded `AgentEvent`.
 *
 * The worker writes every entry of {@link turnEventsStreamKey} as the flat field list
 * `['event', '<JSON AgentEvent>']`; the web app reads it back with {@link parseTurnEventEntry}.
 */
export const TURN_EVENT_FIELD = 'event';

/**
 * Reads the `AgentEvent` out of one Redis Stream entry.
 *
 * The entry arrives as ioredis reports it: a flat `[name, value, name, value, …]` list. Anything
 * that does not decode to a valid event yields `null` rather than throwing, because the stream is
 * written by another process and one malformed entry must not end a live SSE stream.
 *
 * @param fields - Flat field list of one stream entry.
 * @returns The event, or `null` when the entry carries no valid one.
 */
export function parseTurnEventEntry(fields: readonly string[]): AgentEvent | null {
  // Stepping two at a time is what keeps names and values apart: a *value* that happens to read
  // `event` never lands on an even index, so it can never be mistaken for the field name.
  for (let index = 0; index < fields.length; index += 2) {
    if (fields[index] !== TURN_EVENT_FIELD) {
      continue;
    }
    const raw = fields[index + 1];
    if (raw === undefined) {
      return null;
    }
    const parsed = agentEventSchema.safeParse(parseJson(raw));
    return parsed.success ? parsed.data : null;
  }
  return null;
}

/**
 * Parses JSON without throwing.
 *
 * @param raw - Text read from a stream entry.
 * @returns The parsed value, or `undefined` when the text is not JSON.
 */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // A malformed entry is data, not a fault: `undefined` fails the schema check like any other
    // invalid payload, and the caller reports it as one unreadable entry.
    return undefined;
  }
}
