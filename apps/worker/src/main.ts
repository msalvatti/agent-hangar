/**
 * Worker entry point: boots with the real dependencies and exits cleanly on SIGINT/SIGTERM.
 *
 * Layer: entry point (composition root; excluded from unit coverage as pure wiring).
 *
 * Security: a startup failure that is not a `ConfigError` comes from Prisma, ioredis or the
 * scheduler reconciliation, and those build their messages from the connection strings they were
 * configured with — passwords included, none of them known to the runtime-secret redactor. Such a
 * failure is logged by classification only. A `ConfigError` is the opposite case: its text is
 * written for the operator, naming the variable at fault or the host with its credentials already
 * stripped, and it is the message that makes a first run diagnosable.
 */
import {
  assertDatabaseReachable,
  ConfigError,
  createPrismaClient,
  createQueueConnection,
  createRedactor,
  describeClientFailure,
  loadConfig,
} from '@agent-hangar/core';

import { defaultWorkerFactories, startWorker } from './app.js';
import { boot } from './boot.js';
import { createContainer, defaultContainerFactories, factoriesFor } from './container.js';
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
    factories: factoriesFor(defaultContainerFactories, { prisma, redis, redactor, logger }),
  });
  const app = await startWorker(container, defaultWorkerFactories);
  const stop = (signal: string): void => {
    logger.info({ signal }, 'signal received');
    void app.shutdown().then(
      () => {
        process.exit(0);
      },
      (error: unknown) => {
        // The container was already released by the shutdown's own `finally`; what is left is to
        // say so and leave a nonzero status behind, rather than an unhandled rejection.
        logger.error({ signal, failure: describeClientFailure(error) }, 'shutdown failed');
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
  const failure = error instanceof ConfigError ? error.message : describeClientFailure(error);
  logger.error({ failure }, 'the worker could not start');
  process.exit(1);
}
