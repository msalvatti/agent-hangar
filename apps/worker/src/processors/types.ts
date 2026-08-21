/**
 * What every processor needs from the worker container.
 *
 * Layer: contract.
 *
 * A structural subset rather than the container itself: the processors never touch a Redis
 * connection, a Prisma client or the worker-local environment, so they must not be able to. The
 * real `WorkerContainer` and the in-memory `TestContainer` both satisfy it, which is what lets
 * production and tests share one processor signature.
 */
import type {
  AppConfig,
  Clock,
  Redactor,
  Repositories,
  SecretsService,
  WorkspaceRunner,
} from '@agent-hangar/core';
import type { Logger } from 'pino';

import type { WorkspaceClaims } from '../claims.js';
import type { CommandListener } from '../commands.js';
import type { TurnEventPublisher } from '../events.js';
import type { WorkspaceImageStatus } from '../image-status.js';
import type { WorkerQueues } from '../queues.js';

/** Collaborators shared by the turn, scheduled-job and garbage-collection processors. */
export interface ProcessorDeps {
  config: AppConfig;
  logger: Logger;
  clock: Clock;
  repos: Repositories;
  runner: WorkspaceRunner;
  /** Worker-only: `reveal` is called here and nowhere else in the application. */
  secrets: SecretsService;
  redactor: Redactor;
  publisher: TurnEventPublisher;
  commands: CommandListener;
  queues: WorkerQueues;
  /** Updated by every workspace create, read by the health heartbeat. */
  imageStatus: WorkspaceImageStatus;
  /**
   * Extra variables every workspace container is created with, on top of its credentials.
   *
   * Resolved once, where the process reads its environment, rather than per create: it is the
   * same for every workspace, and a value that cannot be resolved has to stop the process rather
   * than fail each turn in turn. Empty unless the scripted model provider was selected.
   */
  fakeProviderEnv: Readonly<Record<string, string>>;
  /**
   * Exclusive ownership of a workspace within this process.
   *
   * Shared by every processor on purpose: a turn and a collection pass contend for the same
   * workspaces, so they have to contend for the same claims.
   */
  claims: WorkspaceClaims;
}

/**
 * The part of a BullMQ job a processor reads.
 *
 * Declared structurally so a test can hand a plain object in: constructing a real `Job` needs a
 * queue, a connection and a Redis server, none of which say anything about the processor.
 */
export interface ProcessorJob<TData> {
  /** BullMQ job id; equals the turn id for `run-turn`. */
  id?: string | undefined;
  /** Job name, which the garbage collector dispatches on. */
  name: string;
  /** Raw payload; every processor validates it with its Zod contract. */
  data: TData;
  /**
   * How many times BullMQ moved this job out of the stalled set and back onto the queue.
   *
   * Above zero means a previous execution stopped renewing the job's lock — the worker died, or
   * blocked long enough to look dead — so whatever that execution left half-written is nobody's
   * any more. Optional because the structural type is the part of a BullMQ job the processors
   * read, and a test constructs the deliveries it needs; absent counts as zero, which is the
   * reading that changes nothing.
   *
   * It is the only counter that recognises a redelivery, which is why BullMQ's `attemptsMade` is
   * deliberately absent from this shape rather than merely unused. That field counts *failed*
   * attempts: the stalled-recovery script increments this counter and never touches it, and
   * nothing in this application configures `attempts`, so it reads zero for every delivery this
   * worker will ever see. A processor that could reach it would sooner or later refine on it, and
   * the refinement would be dead the day it was written.
   */
  stalledCounter?: number | undefined;
  /** When BullMQ produced the job, in epoch milliseconds. */
  timestamp?: number | undefined;
}
