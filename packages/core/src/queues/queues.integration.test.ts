/**
 * Integration tests (@redis) for the connection, queue and worker factories.
 *
 * Layer: integration.
 * Goal: against a real Redis, the two connection roles carry opposite retry policies, a worker
 * built from a producer connection is refused, a turn round-trips from producer to consumer, and
 * enqueuing the same turn twice produces one job.
 * Mocks: none — needs `REDIS_URL`. Fails loudly when `CI=1` and Redis is unreachable; skips with
 * an instruction locally. Every run uses its own key prefix and obliterates the queue afterwards.
 */
import type { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { QUEUE_NAMES } from './contracts.ts';
import type { RunTurnPayload } from './contracts.ts';
import {
  closeConnection,
  createQueue,
  createQueueConnection,
  createWorker,
  createWorkerConnection,
  enqueueRunTurn,
} from './queues.ts';
import { describeRedis, pingOrFail, uniquePrefix } from './redis.integration-helper.ts';

/** Wall-clock limit per test; a Redis round trip is fast, a broken one must not hang the run. */
const TEST_TIMEOUT_MS = 30_000;

describeRedis('@redis queue factories', (url) => {
  const prefix = uniquePrefix();
  let producer: Redis;
  let consumer: Redis;
  let queue: Queue;
  let worker: Worker | undefined;

  beforeAll(async () => {
    producer = createQueueConnection(url);
    consumer = createWorkerConnection(url);
    await pingOrFail(producer, url);
    queue = createQueue(QUEUE_NAMES.chatTurns, { connection: producer, prefix });
  });

  afterAll(async () => {
    await worker?.close();
    await queue.obliterate({ force: true });
    await queue.close();
    await closeConnection(producer);
    await closeConnection(consumer);
  });

  /**
   * The two roles must differ on a real client, not only on a constructed options object: a
   * consumer needs unlimited retries for its blocking reads, and a producer must keep a budget so
   * a request-scoped `add` fails instead of hanging.
   */
  it(
    'gives the two connection roles opposite retry policies',
    () => {
      expect(consumer.options.maxRetriesPerRequest).toBeNull();
      expect(producer.options.maxRetriesPerRequest).not.toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * The guard fires before BullMQ is constructed, so a misconfigured worker never subscribes and
   * never silently drops jobs it failed to read.
   */
  it(
    'refuses to build a worker on the producer connection',
    () => {
      expect(() =>
        createWorker(QUEUE_NAMES.chatTurns, () => Promise.resolve(undefined), {
          connection: producer,
          prefix,
        }),
      ).toThrow(/maxRetriesPerRequest: null/);
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * The whole point of the factories: what the web app enqueues is what the worker receives, under
   * the turn id, and enqueuing the same turn twice leaves one job rather than two containers.
   */
  it(
    'round-trips a turn and stays idempotent on the turn id',
    async () => {
      const turnId = `turn-${prefix}`;
      const received = new Promise<{ id: string | undefined; data: RunTurnPayload }>((resolve) => {
        worker = createWorker<RunTurnPayload>(
          QUEUE_NAMES.chatTurns,
          (job) => {
            resolve({ id: job.id, data: job.data });
            return Promise.resolve(undefined);
          },
          { connection: consumer, prefix },
        );
      });

      await expect(enqueueRunTurn(queue, { turnId })).resolves.toBe(turnId);
      await expect(enqueueRunTurn(queue, { turnId })).resolves.toBe(turnId);

      const job = await received;
      expect(job.id).toBe(turnId);
      expect(job.data).toEqual({ turnId });

      await worker?.close();
      worker = undefined;
      expect(await queue.getJobCountByTypes('completed', 'waiting', 'active', 'delayed')).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});
