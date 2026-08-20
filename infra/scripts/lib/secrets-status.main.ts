/**
 * Real process wiring for {@link secretsStatus}: prints its lines and exits with its code.
 *
 * Layer: entry point. Excluded from coverage — see the root `vitest.config.ts` comment.
 */
import { loadConfig } from '../../../packages/core/src/config/schema.js';
import {
  assertDatabaseReachable,
  createPrismaClient,
} from '../../../packages/core/src/persistence/client.js';
import { PrismaSecretRepository } from '../../../packages/core/src/persistence/repositories/secret.repository.js';

import { parseFlags } from './cli-args.js';
import { createFileBackedSecretsService } from './file-backed-secrets-service.js';
import { secretsStatus } from './secrets-status.js';

parseFlags(process.argv.slice(2), { allowed: [] });
const result = await secretsStatus({
  env: process.env,
  loadConfig,
  createDatabaseClient: (connectionString) => createPrismaClient({ connectionString }),
  assertDatabaseReachable,
  createSecretRepository: (client) => new PrismaSecretRepository(client),
  createSecretsService: createFileBackedSecretsService,
});
for (const line of result.lines) {
  console.log(line);
}
process.exit(result.exitCode);
