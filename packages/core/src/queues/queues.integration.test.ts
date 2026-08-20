/**
 * Integration tests (@redis) for the connection, queue and worker factories.
 *
 * Layer: integration.
 * Goal: against a real Redis, the two connection roles carry opposite retry policies, a worker
 * built from a producer connection is refused, a turn round-trips from producer to consumer, and
 * enqueuing the same turn twice produces one job, and a turn whose job is retained in a terminal
 * state can be dispatched again once that job is released.
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
  releaseTerminalJob,
} from './queues.ts';
import { describeRedis, pingOrFail, uniquePrefix } from './redis.integration-helper.ts';

/** Wall-clock limit per test; a Redis round trip is fast, a broken one must not hang the run. */
const TEST_TIMEOUT_MS = 30_000;

/** How long a swallowed enqueue is given to prove it produced no work. */
const SETTLE_MS = 500;

/** How long {@link waitForState} waits for BullMQ to record a state it is about to reach. */
const STATE_TIMEOUT_MS = 5000;

/**
 * Waits for a job to report a state, polling rather than assuming it is recorded synchronously.
 *
 * BullMQ moves a job to `active` around the processor call, not before it, so reading the state
 * the instant the processor runs is a race.
 *
 * @param queue - Queue holding the job.
 * @param jobId - Job to watch.
 * @param state - State to wait for.
 * @throws Error When the state is not reached in {@link STATE_TIMEOUT_MS}.
 */
async function waitForState(queue: Queue, jobId: string, state: string): Promise<void> {
  const deadline = Date.now() + STATE_TIMEOUT_MS;
  let seen: string | undefined;
  while (Date.now() < deadline) {
    seen = await (await queue.getJob(jobId))?.getState();
    if (seen === state) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Job ${jobId} was ${String(seen)}, not ${state}, within ${STATE_TIMEOUT_MS} ms`);
}

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

  /**
   * The property the whole retry feature rests on, and the one no queue double can be trusted for:
   * retention keeps a finished job holding its id, and BullMQ answers the next `add` for that id by
   * returning the held job instead of enqueuing work. Measured here against a real Redis — before
   * `releaseTerminalJob` the second dispatch ran nothing at all, in both terminal states.
   */
  it.each([
    ['completed', () => Promise.resolve(undefined)],
    ['failed', () => Promise.reject(new Error('worker blew up'))],
  ])(
    're-dispatches a turn whose job is retained as %s',
    async (terminalState, processor) => {
      const turnId = `turn-${terminalState}-${prefix}`;
      let runs = 0;

      const settled = new Promise<void>((resolve) => {
        worker = createWorker<RunTurnPayload>(
          QUEUE_NAMES.chatTurns,
          () => {
            runs += 1;
            return processor();
          },
          { connection: consumer, prefix },
        );
        worker.on(terminalState === 'completed' ? 'completed' : 'failed', () => {
          resolve();
        });
      });

      await enqueueRunTurn(queue, { turnId });
      await settled;
      expect(runs).toBe(1);
      expect(await (await queue.getJob(turnId))?.getState()).toBe(terminalState);

      // Without the release this add is silently swallowed and `runs` stays at 1 forever.
      const ranAgain = new Promise<void>((resolve) => {
        worker?.on(terminalState === 'completed' ? 'completed' : 'failed', () => {
          if (runs > 1) {
            resolve();
          }
        });
      });
      await expect(releaseTerminalJob(queue, turnId)).resolves.toBe('released');
      await enqueueRunTurn(queue, { turnId });
      await ranAgain;

      expect(runs).toBe(2);

      await worker?.close();
      worker = undefined;
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * The other half of the same rule: live work is never released, so the deterministic id still
   * collapses a duplicate dispatch of a job that has not run.
   */
  it(
    'refuses to release a job that is still waiting',
    async () => {
      const turnId = `turn-waiting-${prefix}`;
      await enqueueRunTurn(queue, { turnId });

      await expect(releaseTerminalJob(queue, turnId)).resolves.toBe('live');
      expect(await (await queue.getJob(turnId))?.getState()).toBe('waiting');
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * The window the whole refusal exists for, driven by a real worker rather than described: while a
   * processor is still running its job is `active`, which is exactly the state a chat turn is in
   * between the worker recording its outcome and the processor returning. The release must say
   * `live` — not `absent`, which would read as "the id is free" — and an enqueue attempted anyway
   * must be swallowed, which is what makes treating `live` as success a silent no-op.
   */
  it(
    'answers live for a job a worker is still holding, and the enqueue is swallowed',
    async () => {
      // Fully isolated: its own prefix, queue and connections. A worker close also closes the
      // connection it was handed, and a job left waiting by an earlier test would be taken first
      // by a processor that never returns — neither of which this test should depend on.
      const ownPrefix = uniquePrefix();
      const turnId = `turn-active-${ownPrefix}`;
      const holderProducer = createQueueConnection(url);
      const holderConsumer = createWorkerConnection(url);
      const ownQueue = createQueue(QUEUE_NAMES.chatTurns, {
        connection: holderProducer,
        prefix: ownPrefix,
      });
      let release: (() => void) | undefined;
      let runs = 0;
      const holder = createWorker<RunTurnPayload>(
        QUEUE_NAMES.chatTurns,
        () => {
          runs += 1;
          return new Promise<undefined>((resolveJob) => {
            release = () => {
              resolveJob(undefined);
            };
          });
        },
        { connection: holderConsumer, prefix: ownPrefix },
      );

      try {
        await enqueueRunTurn(ownQueue, { turnId });
        await waitForState(ownQueue, turnId, 'active');

        await expect(releaseTerminalJob(ownQueue, turnId)).resolves.toBe('live');

        // What a caller that ignored the answer would get: nothing.
        await enqueueRunTurn(ownQueue, { turnId });
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
        expect(runs).toBe(1);
        expect(await ownQueue.getJobCountByTypes('waiting', 'delayed', 'prioritized')).toBe(0);
        expect(await (await ownQueue.getJob(turnId))?.getState()).toBe('active');
      } finally {
        release?.();
        await holder.close();
        await ownQueue.obliterate({ force: true });
        await ownQueue.close();
        await closeConnection(holderProducer);
        await closeConnection(holderConsumer);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
