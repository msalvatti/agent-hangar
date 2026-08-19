/**
 * Shared in-memory tables used by every `InMemory*Repository`.
 *
 * Layer: test double.
 *
 * One store per test gives the eight repositories a common view so cascades (chat → messages,
 * turns, tool calls; job → runs) behave like the Postgres schema.
 */
import { randomUUID } from 'node:crypto';

import type { Clock } from '../../config/clock.js';
import { NotFoundError } from '../../errors.js';
import type {
  Chat,
  JobRun,
  Message,
  ScheduledJob,
  SecretRecord,
  ToolCallLog,
  Turn,
  Workspace,
} from '../../persistence/entities.js';
import type { SecretKey } from '../../secrets/types.js';

/** Tables of the in-memory database. */
export class InMemoryStore {
  readonly chats = new Map<string, Chat>();
  readonly messages = new Map<string, Message>();
  readonly turns = new Map<string, Turn>();
  readonly workspaces = new Map<string, Workspace>();
  readonly scheduledJobs = new Map<string, ScheduledJob>();
  readonly jobRuns = new Map<string, JobRun>();
  readonly toolCalls = new Map<string, ToolCallLog>();
  readonly secrets = new Map<SecretKey, SecretRecord>();

  constructor(readonly clock: Clock) {}

  /** Generates a row id. */
  newId(): string {
    return randomUUID();
  }

  /** Current instant from the injected clock. */
  now(): Date {
    return this.clock.now();
  }

  /**
   * Reads a row or throws `NotFoundError`.
   *
   * @param table - Map to read from.
   * @param entity - Entity name for the error.
   * @param id - Row id.
   */
  require<T>(table: Map<string, T>, entity: string, id: string): T {
    const row = table.get(id);
    if (row === undefined) {
      throw new NotFoundError(entity, id);
    }
    return row;
  }
}
