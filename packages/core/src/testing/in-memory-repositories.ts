/**
 * Factory of the in-memory repositories: every port of `persistence/ports.ts`, backed by Maps,
 * with the same invariants as Postgres (gap-free message `seq`, one live workspace per chat,
 * unique `JobRun.workspaceId`, cascade deletes).
 *
 * Layer: test double.
 */
import { systemClock } from '../config/clock.ts';
import type { Clock } from '../config/clock.ts';
import type { Repositories } from '../persistence/ports.ts';

import {
  InMemoryChatRepository,
  InMemoryMessageRepository,
  InMemoryTurnRepository,
} from './in-memory/chats.ts';
import { InMemoryJobRunRepository, InMemoryScheduledJobRepository } from './in-memory/jobs.ts';
import { InMemoryStore } from './in-memory/store.ts';
import {
  InMemorySecretRepository,
  InMemoryToolCallLogRepository,
} from './in-memory/tool-calls-and-secrets.ts';
import { InMemoryWorkspaceRepository } from './in-memory/workspaces.ts';

export {
  InMemoryChatRepository,
  InMemoryJobRunRepository,
  InMemoryMessageRepository,
  InMemoryScheduledJobRepository,
  InMemorySecretRepository,
  InMemoryStore,
  InMemoryToolCallLogRepository,
  InMemoryTurnRepository,
  InMemoryWorkspaceRepository,
};

/** All eight repositories plus the store they share (for direct assertions). */
export interface InMemoryRepositories extends Repositories {
  store: InMemoryStore;
}

/**
 * Creates a fresh in-memory database and one repository per port.
 *
 * @param clock - Source of timestamps (defaults to the system clock).
 * @returns The repositories and their shared store.
 */
export function createInMemoryRepositories(clock: Clock = systemClock): InMemoryRepositories {
  const store = new InMemoryStore(clock);
  return {
    store,
    chats: new InMemoryChatRepository(store),
    messages: new InMemoryMessageRepository(store),
    turns: new InMemoryTurnRepository(store),
    workspaces: new InMemoryWorkspaceRepository(store),
    scheduledJobs: new InMemoryScheduledJobRepository(store),
    jobRuns: new InMemoryJobRunRepository(store),
    toolCalls: new InMemoryToolCallLogRepository(store),
    secrets: new InMemorySecretRepository(store),
  };
}
