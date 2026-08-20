/**
 * Real process wiring for {@link openaiCheck}: prints its line and exits with its code.
 *
 * Layer: entry point. Excluded from coverage — see the root `vitest.config.ts` comment.
 */
import { loadConfig } from '../../../packages/core/src/config/schema.js';
import { createModelProvider } from '../../../packages/core/src/model/registry.js';
import {
  assertDatabaseReachable,
  createPrismaClient,
} from '../../../packages/core/src/persistence/client.js';
import { PrismaSecretRepository } from '../../../packages/core/src/persistence/repositories/secret.repository.js';

import { parseFlags } from './cli-args.js';
import { createFileBackedSecretsService } from './file-backed-secrets-service.js';
import { openaiCheck } from './openai-check.js';

parseFlags(process.argv.slice(2), { allowed: [] });
const result = await openaiCheck({
  env: process.env,
  loadConfig,
  createDatabaseClient: (connectionString) => createPrismaClient({ connectionString }),
  assertDatabaseReachable,
  createSecretRepository: (client) => new PrismaSecretRepository(client),
  createSecretsService: createFileBackedSecretsService,
  createProvider: (apiKey, baseURL) =>
    createModelProvider('openai', {
      openai: { apiKey, ...(baseURL === undefined ? {} : { baseURL }) },
    }),
});
console.log(result.line);
process.exit(result.exitCode);
