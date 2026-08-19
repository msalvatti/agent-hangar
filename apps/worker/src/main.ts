/**
 * Worker entry point: boots with the real dependencies and exits cleanly on SIGINT/SIGTERM.
 *
 * Layer: entry point (composition root; excluded from unit coverage as pure wiring).
 */
import {
  assertDatabaseReachable,
  createPrismaClient,
  createRedactor,
  loadConfig,
} from '@agent-hangar/core';
import { Redis } from 'ioredis';

import { boot } from './boot.js';
import { createLogger } from './logger.js';

const logger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  redactor: createRedactor(),
});

try {
  const booted = await boot({
    loadConfig,
    createPrismaClient,
    assertDatabaseReachable,
    createRedis: (url) => new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: false }),
    logger,
  });
  logger.info(
    { instance: booted.config.AH_INSTANCE, webPort: booted.config.WEB_PORT },
    `worker ready (instance=${booted.config.AH_INSTANCE}, web port ${String(booted.config.WEB_PORT)})`,
  );
  const stop = (signal: string) => {
    logger.info({ signal }, 'signal received');
    booted.shutdown().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error({ err: error }, 'shutdown failed');
        process.exit(1);
      },
    );
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
