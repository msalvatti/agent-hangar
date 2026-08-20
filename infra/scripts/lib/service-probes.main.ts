/**
 * Real process wiring for {@link probeServices}: prints its lines and exits 0.
 *
 * Layer: entry point. Excluded from coverage — see the root `vitest.config.ts` comment.
 *
 * The exit code says whether the probe itself ran, not whether the services are healthy: that
 * verdict travels in the printed lines, which `doctor.sh` renders as two rows.
 */
import { loadConfig } from '../../../packages/core/src/config/schema.js';
import {
  assertDatabaseReachable,
  createPrismaClient,
  disconnectPrisma,
} from '../../../packages/core/src/persistence/client.js';
import { createQueueConnection } from '../../../packages/core/src/queues/queues.js';

import { parseFlags } from './cli-args.js';
import { probeServices } from './service-probes.js';

parseFlags(process.argv.slice(2), { allowed: [] });
// The client type is stated rather than inferred: the two database collaborators accept
// different slices of the client, so inference would settle on whichever slice it saw first and
// then reject the other.
const lines = await probeServices<ReturnType<typeof createPrismaClient>>({
  env: process.env,
  loadConfig,
  createDatabaseClient: (connectionString) => createPrismaClient({ connectionString }),
  assertDatabaseReachable,
  disconnectDatabase: disconnectPrisma,
  createRedisClient: createQueueConnection,
});
for (const line of lines) {
  console.log(line);
}
process.exit(0);
