/** @vitest-environment node */
/**
 * Integration test (@redis) for `DELETE /api/jobs/:id` overlapping `PATCH /api/jobs/:id`, against
 * a real BullMQ Job Scheduler in a real Redis.
 *
 * Layer: integration.
 * Goal: the one thing no queue double can settle — that what survives an interleaved delete is a
 * genuine repeatable scheduler in Redis, firing on its cron for a job whose row is gone, and that
 * neither ordering of the two requests leaves one behind. The rival request is driven from inside
 * a real step of the request under test, so the interleaving is the window that exists rather than
 * a schedule the test got lucky with.
 * Mocks: none for the queues or Redis — needs `REDIS_URL`. The repositories are the in-memory
 * doubles: which store holds the row is not what this test is about.
 */
import { randomUUID } from 'node:crypto';

import {
  createLogger,
  createQueue,
  createQueueConnection,
  createRedactor,
  listSchedulers,
  loadConfig,
  QUEUE_NAMES,
} from '@agent-hangar/core';
import type { ApplicationQueues, Repositories } from '@agent-hangar/core';
import {
  createInMemoryRepositories,
  GITHUB_CANARY,
  OPENAI_CANARY,
} from '@agent-hangar/core/testing';
import type { Redis } from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ServerContainer } from '../container';
import { FakeSecretsService } from '../testing/fake-secrets';
import { FakeDatabase, StubGithubClient, TEST_ENV } from '../testing/test-container';

import { createJob, deleteJob, updateJob } from './jobs';

/** Environment variable naming the Redis to test against. */
const REDIS_URL_ENV = 'REDIS_URL';

/** Origin every request in this file is addressed to. */
const ORIGIN = 'http://127.0.0.1:3000';

/** A repository URL the contracts and the host allow-list both accept. */
const REPO_URL = 'https://github.com/acme/widgets';

/** A valid job definition. */
const JOB_BODY = {
  name: 'Nightly triage',
  cron: '0 3 * * *',
  timezone: 'Europe/Lisbon',
  prompt: 'Triage new issues',
  repoUrl: REPO_URL,
  branch: 'main',
  enabled: true,
};

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
 * Builds a same-origin request for the job routes.
 *
 * @param path - Path under the origin.
 * @param method - HTTP method.
 * @param body - JSON body, when the route reads one.
 * @returns The request.
 */
function jobRequest(path: string, method: string, body?: unknown): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { host: '127.0.0.1:3000', origin: ORIGIN, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describeRedis('@redis deleteJob overlapping updateJob', (url) => {
  let connection: Redis;
  let queues: ApplicationQueues;
  let repos: Repositories;
  let container: ServerContainer;

  afterEach(async () => {
    vi.restoreAllMocks();
    await queues.scheduledJobs.obliterate({ force: true });
    await queues.chatTurns.close();
    await queues.scheduledJobs.close();
    await queues.workspaceGc.close();
    connection.disconnect();
  });

  /**
   * Assembles a container whose queues and Redis are real, and creates one enabled job through the
   * route so its scheduler is registered exactly as the product registers it.
   *
   * @returns The id of the created job.
   */
  async function seedJob(): Promise<string> {
    const prefix = `ah-jobs-${randomUUID()}`;
    connection = createQueueConnection(url);
    queues = {
      chatTurns: createQueue(QUEUE_NAMES.chatTurns, { connection, prefix }),
      scheduledJobs: createQueue(QUEUE_NAMES.scheduledJobs, { connection, prefix }),
      workspaceGc: createQueue(QUEUE_NAMES.workspaceGc, { connection, prefix }),
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
            // Discarded on purpose; this suite asserts on responses, rows and schedulers.
          },
        },
      }),
      prisma: new FakeDatabase(),
      repos,
      redis: connection,
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
    const created = await createJob(container, jobRequest('/api/jobs', 'POST', JOB_BODY));
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect(await listSchedulers(queues.scheduledJobs)).toHaveLength(1);
    return id;
  }

  /**
   * The edit lands after the delete has taken the scheduler out of Redis and before the row is
   * gone, so it registers a schedule the delete is about to orphan. What is asserted is Redis
   * itself: no repeatable scheduler is left under the deleted job's key.
   */
  it('leaves no scheduler in Redis when an edit lands between the two steps of a delete', async () => {
    const jobId = await seedJob();
    const edits: Response[] = [];
    const { scheduledJobs } = queues;
    const removeJobScheduler = scheduledJobs.removeJobScheduler.bind(scheduledJobs);
    vi.spyOn(scheduledJobs, 'removeJobScheduler').mockImplementation(async (key: string) => {
      const removed = await removeJobScheduler(key);
      if (edits.length === 0) {
        edits.push(
          await updateJob(container, jobRequest('/api/jobs', 'PATCH', { cron: '0 4 * * *' }), {
            id: jobId,
          }),
        );
      }
      return removed;
    });

    const deleted = await deleteJob(container, jobRequest('/api/jobs', 'DELETE'), { id: jobId });

    expect(edits.map((response) => response.status)).toEqual([200]);
    expect(deleted.status).toBe(204);
    expect(await repos.scheduledJobs.get(jobId)).toBeNull();
    expect(await listSchedulers(queues.scheduledJobs)).toEqual([]);
  });

  /**
   * The other ordering: the whole delete runs while the edit is between its row write and its
   * scheduler write, so the edit's upsert is the last write of all. The read it does afterwards is
   * what catches it, and the schedule it just registered is taken back out of Redis.
   */
  it('leaves no scheduler in Redis when a delete runs while an edit is registering one', async () => {
    const jobId = await seedJob();
    const deletes: Response[] = [];
    const update = repos.scheduledJobs.update.bind(repos.scheduledJobs);
    vi.spyOn(repos.scheduledJobs, 'update').mockImplementation(async (id, patch) => {
      const updated = await update(id, patch);
      if (deletes.length === 0) {
        deletes.push(await deleteJob(container, jobRequest('/api/jobs', 'DELETE'), { id }));
      }
      return updated;
    });

    const edited = await updateJob(
      container,
      jobRequest('/api/jobs', 'PATCH', { cron: '0 4 * * *' }),
      {
        id: jobId,
      },
    );

    expect(deletes.map((response) => response.status)).toEqual([204]);
    expect(edited.status).toBe(404);
    expect(await repos.scheduledJobs.get(jobId)).toBeNull();
    expect(await listSchedulers(queues.scheduledJobs)).toEqual([]);
  });
});
