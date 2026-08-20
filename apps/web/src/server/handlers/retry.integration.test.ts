/** @vitest-environment node */
/**
 * Integration test (@redis) for the retry route against a real BullMQ queue and a real worker.
 *
 * Layer: integration.
 * Goal: the one thing no queue double can settle — what the endpoint answers while the previous
 * attempt's job is genuinely `active`. The worker records a turn's outcome before its processor
 * returns, so a Retry can arrive with the row already `FAILED` and the job still running; the route
 * has to refuse rather than enqueue into a window where BullMQ would answer with the running job
 * and nothing would run. The suite then lets the attempt finish and retries again, so the advice
 * the refusal gives is shown to be true rather than hopeful.
 * Mocks: none for the queue or Redis — needs `REDIS_URL`. Repositories, secrets, GitHub and the
 * health probe stay in-memory: none of them is what this test is about.
 */
import { randomUUID } from 'node:crypto';

import {
  createLogger,
  createQueue,
  createQueueConnection,
  createRedactor,
  createWorker,
  createWorkerConnection,
  JOB_NAMES,
  loadConfig,
  QUEUE_NAMES,
} from '@agent-hangar/core';
import type { ApplicationQueues, Repositories, RunTurnPayload } from '@agent-hangar/core';
import {
  createInMemoryRepositories,
  GITHUB_CANARY,
  OPENAI_CANARY,
} from '@agent-hangar/core/testing';
import type { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { ServerContainer } from '../container';
import { FakeSecretsService } from '../testing/fake-secrets';
import { FakeDatabase, StubGithubClient, TEST_ENV } from '../testing/test-container';

import { retryTurn } from './turns';

/** Environment variable naming the Redis to test against. */
const REDIS_URL_ENV = 'REDIS_URL';

/** Wall-clock limit per test. */
const TEST_TIMEOUT_MS = 30_000;

/** How long the helpers wait for BullMQ to record a state it is about to reach. */
const STATE_TIMEOUT_MS = 5000;

/** How long a swallowed enqueue is given to prove it produced no work. */
const SETTLE_MS = 500;

/** Origin every request in this file is addressed to. */
const ORIGIN = 'http://127.0.0.1:3000';

/** Repository URL the contracts accept. */
const REPO_URL = 'https://github.com/acme/widgets';

/** The error the worker recorded on the turn before its processor returned. */
const WORKER_ERROR = 'OpenAI rejected the request';

/**
 * Reads the configured Redis URL.
 *
 * @returns The URL, or `null` when it is unset.
 */
function redisUrl(): string | null {
  const url = process.env[REDIS_URL_ENV];
  return url === undefined || url.length === 0 ? null : url;
}

/**
 * Declares a suite that needs Redis, skipping locally and failing loudly in CI.
 *
 * @param name - Suite name, `@redis` tagged.
 * @param body - Suite body, receiving the configured URL.
 */
function describeRedis(name: string, body: (url: string) => void): void {
  const url = redisUrl();
  if (url !== null) {
    describe(name, () => {
      body(url);
    });
    return;
  }
  if (process.env.CI !== undefined) {
    describe(name, () => {
      /** A missing service in CI must fail the run rather than silently skip. */
      it('fails loudly: Redis required in CI', () => {
        throw new Error(`${REDIS_URL_ENV} is not set; CI must provide Redis.`);
      });
    });
    return;
  }
  describe.skip(name, () => {
    body('');
  });
}

/**
 * Builds a same-origin retry request.
 *
 * @param id - Turn id.
 * @returns The request.
 */
function retryRequest(id: string): Request {
  return new Request(`${ORIGIN}/api/turns/${id}/retry`, {
    method: 'POST',
    headers: { host: '127.0.0.1:3000', origin: ORIGIN },
  });
}

/**
 * Reads what BullMQ currently says about a job.
 *
 * @param queue - Queue holding the job.
 * @param jobId - Job to read.
 * @returns The state, or `undefined` when no job holds that id at all.
 */
async function jobState(queue: Queue, jobId: string): Promise<string | undefined> {
  return await (await queue.getJob(jobId))?.getState();
}

/**
 * Waits for a job to report a state, polling rather than assuming it is recorded synchronously.
 *
 * Only used for the transitions BullMQ makes on its own after the processor has returned. A state
 * the test itself is responsible for producing is asserted outright, so a wait here never stands
 * in for a missing ordering guarantee.
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
    seen = await jobState(queue, jobId);
    if (seen === state) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Job ${jobId} was ${String(seen)}, not ${state}, within ${STATE_TIMEOUT_MS} ms`);
}

/** A promise together with the function that settles it. */
interface Latch {
  /** Settles when {@link Latch.settle} is called. */
  readonly settled: Promise<void>;
  /** Settles {@link Latch.settled}; settling an already settled promise is a no-op. */
  readonly settle: () => void;
}

/**
 * Creates a latch, so both halves of a hand-off exist before either of them is used.
 *
 * `Promise` passes its resolver to an executor instead of returning it, and this project compiles
 * against a library older than `Promise.withResolvers`, so the resolver is captured here. The
 * capture is complete before this function returns — a Promise executor runs synchronously — which
 * is what the definite-assignment assertion states. That ordering is the entire point: a resolver
 * a caller reaches before the code that assigns it has run is `undefined`, and calling it is then
 * a silent no-op rather than a failure.
 *
 * @returns The promise and the function that settles it.
 */
function createLatch(): Latch {
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { settled, settle };
}

/** The first attempt at a turn, held `active` by a worker that is waiting to be let go. */
interface RunningAttempt {
  /** Settles once the first run has recorded the turn's outcome and is holding its job `active`. */
  readonly recorded: Promise<void>;
  /** Lets the first run return, so BullMQ can move its job to `completed`. Idempotent. */
  readonly release: () => void;
  /** How many times the processor has run. */
  readonly runs: () => number;
}

describeRedis('@redis retryTurn against a running worker', (url) => {
  let producer: Redis;
  let consumer: Redis;
  let queues: ApplicationQueues;
  let repos: Repositories;
  let container: ServerContainer;
  let worker: Worker | undefined;
  let prefix: string;

  beforeAll(() => {
    prefix = `ah-retry-${randomUUID()}`;
  });

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    await queues.chatTurns.obliterate({ force: true });
    await queues.chatTurns.close();
    await queues.scheduledJobs.close();
    await queues.workspaceGc.close();
    producer.disconnect();
    consumer.disconnect();
  });

  /**
   * Assembles a container whose queues and Redis are real and whose stores are not, plus the chat
   * and turn the retry acts on.
   *
   * @returns The turn id the tests drive.
   */
  async function seedTurn(): Promise<string> {
    producer = createQueueConnection(url);
    consumer = createWorkerConnection(url);
    queues = {
      chatTurns: createQueue(QUEUE_NAMES.chatTurns, { connection: producer, prefix }),
      scheduledJobs: createQueue(QUEUE_NAMES.scheduledJobs, { connection: producer, prefix }),
      workspaceGc: createQueue(QUEUE_NAMES.workspaceGc, { connection: producer, prefix }),
    };
    repos = createInMemoryRepositories();
    const redactor = createRedactor();
    container = {
      config: loadConfig(TEST_ENV),
      logger: createLogger({
        level: 'silent',
        redactor,
        destination: {
          write(): void {
            // Discarded on purpose; this suite asserts on responses and rows.
          },
        },
      }),
      prisma: new FakeDatabase(),
      repos,
      redis: producer,
      queues,
      secrets: new FakeSecretsService({
        GITHUB_PAT: GITHUB_CANARY,
        OPENAI_API_KEY: OPENAI_CANARY,
      }),
      redactor,
      github: new StubGithubClient(),
      clock: { now: () => new Date() },
      sse: { heartbeatMs: 50, blockMs: 50 },
      dispose: () => Promise.resolve(),
    };

    const chat = await repos.chats.create({
      title: 'Retry against a live job',
      repoUrl: REPO_URL,
      baseBranch: 'main',
    });
    await repos.messages.append(chat.id, 'USER', 'work');
    const turn = await repos.turns.create({ chatId: chat.id, model: 'gpt-5.6-sol' });
    return turn.id;
  }

  /**
   * Starts a worker that reproduces the product's ordering: the turn's terminal status is written
   * before the processor returns, and the first run then blocks so the job stays `active`.
   *
   * Both latches are created here, before the worker is, so a test never holds a release function
   * the processor has not assigned yet. Waiting for the job to report `active` instead would not
   * settle that: BullMQ marks a job `active` when it hands it to the worker, and the processor
   * body runs after, so `active` is reached while the turn row is still untouched and nothing can
   * be released. What both tests actually depend on is the first run having recorded its outcome,
   * and that is what {@link RunningAttempt.recorded} reports.
   *
   * @returns The handle the tests drive the running attempt through.
   */
  function startBlockingWorker(): RunningAttempt {
    let runs = 0;
    const recorded = createLatch();
    const held = createLatch();
    worker = createWorker<RunTurnPayload>(
      QUEUE_NAMES.chatTurns,
      async (job) => {
        runs += 1;
        await repos.turns.finish(
          job.data.turnId,
          'FAILED',
          { inputTokens: 0, outputTokens: 0, stepCount: 1 },
          WORKER_ERROR,
        );
        if (runs === 1) {
          recorded.settle();
          await held.settled;
        }
        return undefined;
      },
      { connection: consumer, prefix },
    );
    return { recorded: recorded.settled, release: held.settle, runs: () => runs };
  }

  /**
   * The window itself, produced the way the product produces it: the processor writes the turn's
   * terminal status and keeps running, so the row is `FAILED` while the job is `active`. The
   * endpoint must answer 409 and leave the row untouched — a 200 here would be the silent no-op,
   * and a `QUEUED` row would be the wedge, since nothing picks it up and cancel cannot remove it.
   */
  it(
    'refuses while the previous attempt is still running, leaving the turn retryable',
    async () => {
      const turnId = await seedTurn();
      const attempt = startBlockingWorker();

      try {
        await queues.chatTurns.add(JOB_NAMES.runTurn, { turnId }, { jobId: turnId });
        await attempt.recorded;
        // The window, asserted rather than waited for: the processor is inside its job, so the job
        // is `active` at this instant, and the row the endpoint will read is already terminal.
        expect(await jobState(queues.chatTurns, turnId)).toBe('active');
        expect(await repos.turns.get(turnId)).toMatchObject({ status: 'FAILED' });

        const response = await retryTurn(container, retryRequest(turnId), { id: turnId });

        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          error: { code: 'PREVIOUS_ATTEMPT_RUNNING' },
        });
        expect(await repos.turns.get(turnId)).toMatchObject({
          status: 'FAILED',
          error: WORKER_ERROR,
        });
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
        expect(attempt.runs()).toBe(1);
        expect(await queues.chatTurns.getJobCountByTypes('waiting', 'delayed', 'prioritized')).toBe(
          0,
        );
      } finally {
        attempt.release();
      }
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * The other number: once that attempt finishes the job becomes `completed`, the release succeeds,
   * and the same request runs the turn a second time. That is what makes "try again in a moment" a
   * description of a window that always closes rather than a hope.
   */
  it(
    'accepts the same retry once the previous attempt has finished',
    async () => {
      const turnId = await seedTurn();
      const attempt = startBlockingWorker();

      try {
        await queues.chatTurns.add(JOB_NAMES.runTurn, { turnId }, { jobId: turnId });
        await attempt.recorded;
        expect(await jobState(queues.chatTurns, turnId)).toBe('active');
        expect((await retryTurn(container, retryRequest(turnId), { id: turnId })).status).toBe(409);
      } finally {
        // Released in `finally` so a failed expectation above is what the run reports: a processor
        // left blocked would instead hang the worker's close and hide it behind a hook timeout.
        attempt.release();
      }
      await waitForState(queues.chatTurns, turnId, 'completed');

      const response = await retryTurn(container, retryRequest(turnId), { id: turnId });

      expect(response.status).toBe(200);
      await waitForState(queues.chatTurns, turnId, 'completed');
      expect(attempt.runs()).toBe(2);
    },
    TEST_TIMEOUT_MS,
  );
});
