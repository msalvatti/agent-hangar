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
import type { Redactor } from '../../secrets/types.ts';
import type { PrismaClient } from '../generated/client.ts';
import type { Repositories } from '../ports.ts';

import { PrismaChatRepository } from './chat.repository.ts';
import { PrismaJobRunRepository } from './job-run.repository.ts';
import { PrismaMessageRepository } from './message.repository.ts';
import { PrismaScheduledJobRepository } from './scheduled-job.repository.ts';
import { PrismaSecretRepository } from './secret.repository.ts';
import { PrismaToolCallLogRepository } from './tool-call-log.repository.ts';
import { PrismaTurnRepository } from './turn.repository.ts';
import { PrismaWorkspaceRepository } from './workspace.repository.ts';

export * from './errors.ts';
export * from './mappers.ts';
export { translatePrismaError } from './prisma-errors.ts';
export type { PrismaErrorContext } from './prisma-errors.ts';
export { PrismaChatRepository } from './chat.repository.ts';
export { PrismaJobRunRepository } from './job-run.repository.ts';
export { PrismaMessageRepository } from './message.repository.ts';
export { PrismaScheduledJobRepository } from './scheduled-job.repository.ts';
export { PrismaSecretRepository } from './secret.repository.ts';
export { PrismaToolCallLogRepository } from './tool-call-log.repository.ts';
export { PrismaTurnRepository } from './turn.repository.ts';
export { PrismaWorkspaceRepository } from './workspace.repository.ts';

/**
 * Builds every Prisma repository, wired to the same client and redactor.
 *
 * @param prisma - Connected Prisma client, shared by every repository.
 * @param redactor - Shared redactor; repositories that never see agent/tool output do not use it.
 * @returns One repository instance per port of `persistence/ports.ts`.
 */
export function createRepositories(prisma: PrismaClient, redactor: Redactor): Repositories {
  return {
    chats: new PrismaChatRepository(prisma, redactor),
    messages: new PrismaMessageRepository(prisma, redactor),
    turns: new PrismaTurnRepository(prisma, redactor),
    workspaces: new PrismaWorkspaceRepository(prisma, redactor),
    scheduledJobs: new PrismaScheduledJobRepository(prisma, redactor),
    jobRuns: new PrismaJobRunRepository(prisma, redactor),
    toolCalls: new PrismaToolCallLogRepository(prisma, redactor),
    secrets: new PrismaSecretRepository(prisma),
  };
}
