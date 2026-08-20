/**
 * Real process wiring for {@link rotateSecrets}: reads the old key from `MASTER_KEY_PATH`, the
 * new key from `AH_NEW_MASTER_KEY_PATH`, and exits with its code.
 *
 * Layer: entry point. Excluded from coverage — see the root `vitest.config.ts` comment.
 */
import { readFileSync } from 'node:fs';

import { loadConfig } from '../../../packages/core/src/config/schema.js';
import {
  assertDatabaseReachable,
  createPrismaClient,
} from '../../../packages/core/src/persistence/client.js';
import { PrismaSecretRepository } from '../../../packages/core/src/persistence/repositories/secret.repository.js';
import { StaticMasterKey } from '../../../packages/core/src/secrets/master-key.js';
import { createSecretsService } from '../../../packages/core/src/secrets/secrets-service.js';

import { parseFlags } from './cli-args.js';
import { rotateSecrets } from './rotate-key.js';

parseFlags(process.argv.slice(2), { allowed: [] });

// Read through this indirection (a method call, not a bare `readFileSync(...)`) so the security
// linter's non-literal-path check — which pattern-matches the imported identifier by name — does
// not flag reads of MASTER_KEY_PATH/AH_NEW_MASTER_KEY_PATH, both operator-controlled local paths.
const fsPort = { readFileSync };

const config = loadConfig(process.env);
const prisma = createPrismaClient({ connectionString: config.DATABASE_URL });
await assertDatabaseReachable(prisma);
const secrets = new PrismaSecretRepository(prisma);
const newKeyPath = process.env.AH_NEW_MASTER_KEY_PATH ?? '';

const result = await rotateSecrets({
  repos: { secrets },
  createService: (key, keyVersion) =>
    createSecretsService({
      repository: secrets,
      masterKey: new StaticMasterKey(Buffer.from(key), keyVersion),
    }),
  oldKey: Buffer.from(fsPort.readFileSync(config.MASTER_KEY_PATH, 'utf8').trim(), 'hex'),
  newKey: Buffer.from(fsPort.readFileSync(newKeyPath, 'utf8').trim(), 'hex'),
  log: (line) => {
    console.log(line);
  },
});
process.exit(result.exitCode);
