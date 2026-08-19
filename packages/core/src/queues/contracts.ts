/**
 * Queue contracts: BullMQ queue/job names, payload schemas and Redis key helpers.
 *
 * Layer: contract.
 *
 * Producers (web) and consumers (worker) share these so a payload can never drift. Worker
 * connections use `maxRetriesPerRequest: null`; producers use defaults.
 */
import { z } from 'zod';

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
