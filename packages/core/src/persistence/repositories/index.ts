/**
 * Composition root of the Prisma repositories: one class per port, wired into the same
 * `Repositories` shape `createInMemoryRepositories` returns.
 *
 * Layer: service (persistence).
 *
 * `PrismaClient` is the only Prisma-typed thing this module's public surface accepts, and only as
 * a constructor/factory parameter — nothing Prisma-typed is ever returned, mirroring
 * `createPrismaClient` in `persistence/client.ts`.
 */
import type { Redactor } from '../../secrets/types.js';
import type { PrismaClient } from '../generated/client.js';
import type { Repositories } from '../ports.js';

import { PrismaChatRepository } from './chat.repository.js';
import { PrismaJobRunRepository } from './job-run.repository.js';
import { PrismaMessageRepository } from './message.repository.js';
import { PrismaScheduledJobRepository } from './scheduled-job.repository.js';
import { PrismaSecretRepository } from './secret.repository.js';
import { PrismaToolCallLogRepository } from './tool-call-log.repository.js';
import { PrismaTurnRepository } from './turn.repository.js';
import { PrismaWorkspaceRepository } from './workspace.repository.js';

export * from './errors.js';
export * from './mappers.js';
export { translatePrismaError } from './prisma-errors.js';
export type { PrismaErrorContext } from './prisma-errors.js';
export { PrismaChatRepository } from './chat.repository.js';
export { PrismaJobRunRepository } from './job-run.repository.js';
export { PrismaMessageRepository } from './message.repository.js';
export { PrismaScheduledJobRepository } from './scheduled-job.repository.js';
export { PrismaSecretRepository } from './secret.repository.js';
export { PrismaToolCallLogRepository } from './tool-call-log.repository.js';
export { PrismaTurnRepository } from './turn.repository.js';
export { PrismaWorkspaceRepository } from './workspace.repository.js';

/**
 * Builds every Prisma repository, wired to the same client and redactor.
 *
 * @param prisma - Connected Prisma client, shared by every repository.
 * @param redactor - Shared redactor; repositories that never see agent/tool output do not use it.
 * @returns One repository instance per port of `persistence/ports.ts`.
 */
export function createRepositories(prisma: PrismaClient, redactor: Redactor): Repositories {
  return {
    chats: new PrismaChatRepository(prisma),
    messages: new PrismaMessageRepository(prisma, redactor),
    turns: new PrismaTurnRepository(prisma, redactor),
    workspaces: new PrismaWorkspaceRepository(prisma, redactor),
    scheduledJobs: new PrismaScheduledJobRepository(prisma, redactor),
    jobRuns: new PrismaJobRunRepository(prisma, redactor),
    toolCalls: new PrismaToolCallLogRepository(prisma, redactor),
    secrets: new PrismaSecretRepository(prisma),
  };
}
