// Public API of persistence: entities and repository ports; the Prisma repositories are exported
// explicitly (not with `export *`) so the composition root, the classes and the persistence-only
// error stay reachable from `@agent-hangar/core` while the internal mappers, the Prisma error
// translator and the row types they speak stay inside `persistence/repositories`.
export * from './entities.ts';
export * from './ports.ts';
export * from './client.ts';
export { createRepositories } from './repositories/index.ts';
export { PersistenceMappingError } from './repositories/errors.ts';
export { PrismaChatRepository } from './repositories/chat.repository.ts';
export { PrismaJobRunRepository } from './repositories/job-run.repository.ts';
export { PrismaMessageRepository } from './repositories/message.repository.ts';
export { PrismaScheduledJobRepository } from './repositories/scheduled-job.repository.ts';
export { PrismaSecretRepository } from './repositories/secret.repository.ts';
export { PrismaToolCallLogRepository } from './repositories/tool-call-log.repository.ts';
export { PrismaTurnRepository } from './repositories/turn.repository.ts';
export { PrismaWorkspaceRepository } from './repositories/workspace.repository.ts';
