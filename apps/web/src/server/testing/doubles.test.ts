/** @vitest-environment node */
/**
 * Unit tests for the server test doubles.
 *
 * Layer: unit.
 * Goal: the doubles behave the way the real services do where a handler depends on it — stream
 * ordering and exclusive ranges, a closed connection rejecting, masked secret status, recorded
 * jobs and schedulers — so a green route test means something.
 * Mocks: the `bullmq` module.
 */
import { QUEUE_NAMES } from '@agent-hangar/core';
import { GITHUB_CANARY, OPENAI_CANARY } from '@agent-hangar/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { fakeQueue, FakeQueue, FakeWorker, resetFakeQueues } from './fake-queue';
import { CONNECTION_CLOSED_MESSAGE, FakeRedis } from './fake-redis';
import { FakeSecretsService } from './fake-secrets';
import { createTestContainer, FakeDatabase, StubGithubClient } from './test-container';

vi.mock('bullmq', () => import('./fake-queue'));

describe('FakeRedis', () => {
  /**
   * String keys back the worker heartbeat the health route reads, so a missing key must read as
   * `null` rather than as an empty string the JSON parser would then choke on.
   */
  it('stores and reads string keys', async () => {
    const redis = new FakeRedis();
    expect(await redis.get('missing')).toBeNull();
    expect(await redis.exists('missing')).toBe(0);
    await redis.set('health:worker:test', '{}');
    expect(await redis.get('health:worker:test')).toBe('{}');
    expect(await redis.exists('health:worker:test')).toBe(1);
    expect(await redis.ping()).toBe('PONG');
  });

  /**
   * Cancel publishes on a channel; recording the messages is what lets a route test assert the
   * worker was told, without a subscriber.
   */
  it('records published messages', async () => {
    const redis = new FakeRedis();
    expect(await redis.publish('cmd:turn:t1', '{"type":"cancel"}')).toBe(0);
    expect(redis.published).toEqual([{ channel: 'cmd:turn:t1', message: '{"type":"cancel"}' }]);
  });

  /**
   * Stream ids are monotonic and shared across duplicated connections, because SSE replay
   * compares them as strings and a resumed reader must never see an id it already had.
   */
  it('appends entries with monotonic ids visible to duplicates', async () => {
    const redis = new FakeRedis();
    const first = await redis.xadd('s', 'event', '{"a":1}');
    const tail = redis.duplicate();
    const second = await tail.xadd('s', 'event', '{"a":2}');
    expect(second > first).toBe(true);
    expect(await tail.exists('s')).toBe(1);
    expect(await tail.xrange('s', '-', '+')).toEqual([
      [first, ['event', '{"a":1}']],
      [second, ['event', '{"a":2}']],
    ]);
    expect(redis.duplicates).toHaveLength(1);
  });

  /**
   * `Last-Event-ID` replay depends on the exclusive `(id` lower bound: an inclusive read would
   * redeliver the last frame the browser already rendered.
   */
  it('honours an exclusive lower bound and an upper bound', async () => {
    const redis = new FakeRedis();
    const first = await redis.xadd('s', 'event', '1');
    const second = await redis.xadd('s', 'event', '2');
    expect(await redis.xrange('s', `(${first}`, '+')).toEqual([[second, ['event', '2']]]);
    expect(await redis.xrange('s', first, '+')).toHaveLength(2);
    expect(await redis.xrange('s', '-', first)).toEqual([[first, ['event', '1']]]);
    expect(await redis.xrange('gone', '-', '+')).toEqual([]);
  });

  /**
   * The tail read answers with `null` when nothing follows the cursor, which is the signal the
   * pump uses to decide whether to keep waiting or to close.
   */
  it('reads only entries after the cursor and reports an empty tail as null', async () => {
    const redis = new FakeRedis();
    expect(await redis.xread('BLOCK', 10, 'STREAMS', 's', '0-0')).toBeNull();
    const id = await redis.xadd('s', 'event', '1');
    expect(await redis.xread('BLOCK', 10, 'STREAMS', 's', '0-0')).toEqual([
      ['s', [[id, ['event', '1']]]],
    ]);
    expect(await redis.xread('BLOCK', 10, 'STREAMS', 's', id)).toBeNull();
  });

  /**
   * ioredis rejects every command issued after the socket is dropped; the double does the same so
   * the SSE pump's abort path is exercised for real rather than assumed.
   */
  it('rejects every command once disconnected', async () => {
    const redis = new FakeRedis();
    redis.disconnect();
    expect(redis.closed).toBe(true);
    await expect(redis.ping()).rejects.toThrow(CONNECTION_CLOSED_MESSAGE);
    await expect(redis.get('k')).rejects.toThrow(CONNECTION_CLOSED_MESSAGE);
    await expect(redis.set('k', 'v')).rejects.toThrow(CONNECTION_CLOSED_MESSAGE);
    await expect(redis.exists('k')).rejects.toThrow(CONNECTION_CLOSED_MESSAGE);
    await expect(redis.publish('c', 'm')).rejects.toThrow(CONNECTION_CLOSED_MESSAGE);
    await expect(redis.xadd('s', 'event', '1')).rejects.toThrow(CONNECTION_CLOSED_MESSAGE);
    await expect(redis.xrange('s', '-', '+')).rejects.toThrow(CONNECTION_CLOSED_MESSAGE);
    await expect(redis.xread('BLOCK', 1, 'STREAMS', 's', '0-0')).rejects.toThrow(
      CONNECTION_CLOSED_MESSAGE,
    );
  });
});

describe('FakeQueue', () => {
  /**
   * The core producers set a deterministic `jobId` so a retried request enqueues one job; the
   * double keys its store the same way, which is what makes that assertion possible.
   */
  it('records enqueued jobs and finds them by their deterministic id', async () => {
    const queue = new FakeQueue('q');
    const job = await queue.add('run-turn', { turnId: 't1' }, { jobId: 't1' });
    expect(job.id).toBe('t1');
    expect(queue.added).toEqual([
      { name: 'run-turn', data: { turnId: 't1' }, opts: { jobId: 't1' } },
    ]);
    expect(await queue.getJob('t1')).toBe(job);
    await job.remove();
    expect(job.removed).toBe(true);
    expect(await queue.getJob('t1')).toBeUndefined();
  });

  /**
   * A producer that sets no id still gets a job back, mirroring BullMQ generating one; the cancel
   * path also needs a queue that hides its jobs, which is how BullMQ behaves once a job is gone.
   */
  it('generates an id and can hide its jobs', async () => {
    const queue = new FakeQueue('q');
    const job = await queue.add('run-scheduled-job', {});
    expect(job.id).toBe('generated-run-scheduled-job');
    expect(await job.getState()).toBe('waiting');
    queue.jobsVisible = false;
    expect(await queue.getJob(job.id)).toBeUndefined();
  });

  /**
   * The enqueue-failure path has to be reachable: a handler that wrote rows and then failed to
   * enqueue must mark the work failed rather than leave it queued forever.
   */
  it('can be made to reject an enqueue', async () => {
    const queue = new FakeQueue('q');
    queue.addFailure = new Error('redis down');
    await expect(queue.add('run-turn', {})).rejects.toThrow('redis down');
  });

  /**
   * Job Schedulers are keyed by scheduled-job id, so upserting twice replaces rather than
   * duplicates, and removing an absent key reports that nothing was there.
   */
  it('upserts, lists and removes schedulers by key', async () => {
    const queue = new FakeQueue('q');
    await queue.upsertJobScheduler(
      'j1',
      { pattern: '0 * * * *', tz: 'UTC' },
      { name: 'n', data: {} },
    );
    await queue.upsertJobScheduler('j1', { pattern: '5 * * * *' }, { name: 'n', data: {} });
    expect(await queue.getJobSchedulers()).toEqual([
      { key: 'j1', pattern: '5 * * * *', tz: undefined },
    ]);
    expect(await queue.removeJobScheduler('j1')).toBe(true);
    expect(await queue.removeJobScheduler('j1')).toBe(false);
  });

  /**
   * The module stands in for the whole of `bullmq`, and the core queue factory imports `Worker`
   * alongside `Queue`; leaving it out would break the import even though the web app never starts
   * a worker.
   */
  it('also stands in for the Worker export', () => {
    expect(new FakeWorker('chat-turns').name).toBe('chat-turns');
  });

  /**
   * A queue registered under a name is reachable by that name, and the registry is cleared
   * between tests so one test never reads another's jobs.
   */
  it('registers queues by name and clears them on reset', () => {
    resetFakeQueues();
    expect(() => fakeQueue(QUEUE_NAMES.chatTurns)).toThrow(/is the bullmq module mocked/);
    const queue = new FakeQueue(QUEUE_NAMES.chatTurns);
    expect(fakeQueue(QUEUE_NAMES.chatTurns)).toBe(queue);
  });
});

describe('FakeSecretsService', () => {
  /**
   * `status` is the only view the settings route has, and it must never carry a value: masking to
   * four characters here is what the route's "never echoes a secret" test is asserting against.
   */
  it('masks stored values and reports absence', async () => {
    const secrets = new FakeSecretsService({ GITHUB_PAT: GITHUB_CANARY });
    const status = await secrets.status();
    expect(status.GITHUB_PAT).toMatchObject({ set: true, last4: GITHUB_CANARY.slice(-4) });
    expect(status.OPENAI_API_KEY).toEqual({ set: false });
  });

  /**
   * Writing and removing move a key between those two states, and `set` answers with the mask the
   * UI displays.
   */
  it('stores, reveals and removes a value', async () => {
    const secrets = new FakeSecretsService();
    expect(await secrets.set('OPENAI_API_KEY', OPENAI_CANARY)).toEqual({
      last4: OPENAI_CANARY.slice(-4),
    });
    expect(await secrets.reveal('OPENAI_API_KEY')).toBe(OPENAI_CANARY);
    expect(secrets.revealCalls).toEqual(['OPENAI_API_KEY']);
    await secrets.remove('OPENAI_API_KEY');
    expect(await secrets.reveal('OPENAI_API_KEY')).toBeNull();
  });

  /**
   * A failing write has to be reachable so the settings route can prove it reports the failure
   * without quoting the value it was trying to store.
   */
  it('can be made to reject a write', async () => {
    const secrets = new FakeSecretsService();
    secrets.setFailure = new Error('key file unreadable');
    await expect(secrets.set('GITHUB_PAT', GITHUB_CANARY)).rejects.toThrow('key file unreadable');
  });
});

describe('StubGithubClient and FakeDatabase', () => {
  /**
   * The stub filters like the real client, so a route test exercises the same query semantics
   * without a network call.
   */
  it('filters repositories and returns scripted branches', async () => {
    const github = new StubGithubClient();
    github.repos = [
      {
        fullName: 'acme/widgets',
        url: 'u',
        defaultBranch: 'main',
        private: false,
        description: null,
      },
    ];
    github.branches = [{ name: 'main', sha: 'a', protected: false }];
    expect(await github.listRepos('WIDG')).toHaveLength(1);
    expect(await github.listRepos('none')).toHaveLength(0);
    expect(await github.listBranches()).toHaveLength(1);
    github.failure = new Error('boom');
    await expect(github.listRepos('')).rejects.toThrow('boom');
    await expect(github.listBranches()).rejects.toThrow('boom');
  });

  /**
   * The health probe needs three outcomes — answers, rejects, never settles — and disposal has to
   * be observable, so the container test can prove it closed the pool.
   */
  it('answers, fails and records disconnection', async () => {
    const database = new FakeDatabase();
    expect(await database.$queryRaw()).toEqual([]);
    await database.$disconnect();
    expect(database.disconnected).toBe(true);
    database.queryFailure = new Error('down');
    await expect(database.$queryRaw()).rejects.toThrow('down');
  });

  /**
   * The third outcome is a probe that never answers, which is what the health route's timeout
   * exists for; the double must really not settle, so the race below must pick the timer.
   */
  it('can hang instead of answering', async () => {
    const database = new FakeDatabase();
    database.queryHangs = true;
    const outcome = await Promise.race([
      database.$queryRaw().then(() => 'settled'),
      new Promise((resolve) =>
        setTimeout(() => {
          resolve('still waiting');
        }, 5),
      ),
    ]);
    expect(outcome).toBe('still waiting');
  });
});

describe('createTestContainer', () => {
  /**
   * The default container is the everyday setup: both credentials present, a pinned clock, and
   * queues reachable through the registry.
   */
  it('seeds both secrets and wires the doubles into the container', async () => {
    const { container, doubles } = createTestContainer();
    expect(container.clock.now().toISOString()).toBe('2026-08-19T10:00:00.000Z');
    expect((await container.secrets.status()).GITHUB_PAT.set).toBe(true);
    expect(container.queues.chatTurns).toBe(doubles.queues.chatTurns);
    await container.dispose();
    expect(doubles.redis.closed).toBe(true);
  });

  /**
   * The "not configured yet" state has to be buildable, because every write route refuses to
   * start work without both credentials.
   */
  it('can build a container with no secrets and a chosen clock', async () => {
    const { container } = createTestContainer({
      secretsSet: false,
      now: new Date('2020-01-01T00:00:00.000Z'),
    });
    expect(container.clock.now().toISOString()).toBe('2020-01-01T00:00:00.000Z');
    expect((await container.secrets.status()).OPENAI_API_KEY).toEqual({ set: false });
  });

  /**
   * Overrides land on the finished container, so one test can replace a single collaborator
   * without rebuilding the rest.
   */
  it('applies overrides over the assembled doubles', () => {
    const clock = { now: () => new Date('2030-01-01T00:00:00.000Z') };
    const { container } = createTestContainer({ overrides: { clock } });
    expect(container.clock).toBe(clock);
  });

  /**
   * Everything the logger wrote is readable, which is how a settings test asserts that no line
   * carried a credential.
   */
  it('captures logger output', () => {
    const { container, doubles } = createTestContainer();
    container.logger.info({ action: 'set' }, 'secret updated');
    expect(doubles.logOutput()).toContain('secret updated');
  });
});
