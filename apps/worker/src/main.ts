/**
 * Worker entry point: boots with the real dependencies and exits cleanly on SIGINT/SIGTERM.
 *
 * Layer: entry point (composition root; excluded from unit coverage as pure wiring).
 */
import {
  assertDatabaseReachable,
  createPrismaClient,
  createQueueConnection,
  createRedactor,
  loadConfig,
} from '@agent-hangar/core';

import { defaultWorkerFactories, startWorker } from './app.js';
import { boot } from './boot.js';
import { createContainer, factoriesFor } from './container.js';
import { createLogger } from './logger.js';

const redactor = createRedactor();
const logger = createLogger({ level: process.env.LOG_LEVEL ?? 'info', redactor });

try {
  const { config, prisma, redis } = await boot({
    loadConfig,
    createPrismaClient,
    assertDatabaseReachable,
    createRedis: createQueueConnection,
    logger,
  });
  const container = await createContainer({
    config,
    factories: factoriesFor({ prisma, redis, redactor, logger }),
  });
  const app = await startWorker(container, defaultWorkerFactories);
  const stop = (signal: string): void => {
    logger.info({ signal }, 'signal received');
    void app.shutdown().then(() => {
      process.exit(0);
    });
  };
  process.once('SIGINT', () => {
    stop('SIGINT');
  });
  process.once('SIGTERM', () => {
    stop('SIGTERM');
  });
} catch (error) {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
