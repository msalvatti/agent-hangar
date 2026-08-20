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
  /** How many times this job was already attempted; above zero means a retry or a stall. */
  attemptsMade: number;
  /** When BullMQ produced the job, in epoch milliseconds. */
  timestamp?: number | undefined;
}
