// Public API of persistence: entities and repository ports; the Prisma repositories are exported
// explicitly (not with `export *`) so the composition root, the classes and the persistence-only
// error stay reachable from `@agent-hangar/core` while the internal mappers, the Prisma error
// translator and the row types they speak stay inside `persistence/repositories`.
export * from './entities.js';
export * from './ports.js';
export * from './client.js';
export { createRepositories } from './repositories/index.js';
export { PersistenceMappingError } from './repositories/errors.js';
export { PrismaChatRepository } from './repositories/chat.repository.js';
export { PrismaJobRunRepository } from './repositories/job-run.repository.js';
export { PrismaMessageRepository } from './repositories/message.repository.js';
export { PrismaScheduledJobRepository } from './repositories/scheduled-job.repository.js';
export { PrismaSecretRepository } from './repositories/secret.repository.js';
export { PrismaToolCallLogRepository } from './repositories/tool-call-log.repository.js';
export { PrismaTurnRepository } from './repositories/turn.repository.js';
export { PrismaWorkspaceRepository } from './repositories/workspace.repository.js';
