/**
 * Unit tests for the worker's remaining test doubles.
 *
 * Layer: unit.
 * Goal: each double behaves like the collaborator it stands in for — the publisher records in
 * order and hands back stream-shaped ids, the command listener routes and releases, the secrets
 * service reveals only what it holds, the queues answer scheduler queries from what they recorded,
 * and the test container wires the whole set with the real redactor.
 * Mocks: none; these are the doubles themselves.
 */
import { GITHUB_CANARY, OPENAI_CANARY } from '@agent-hangar/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { createFakeQueues, FakeQueue } from './fake-queues.js';
import { FakeSecretsService } from './fake-secrets.js';
import { InMemoryCommandListener } from './in-memory-commands.js';
import { InMemoryTurnEventPublisher } from './in-memory-publisher.js';
import { createTestContainer } from './test-container.js';

describe('InMemoryTurnEventPublisher', () => {
  /**
   * Publication order is the guarantee the SSE route depends on, so the double preserves it and
   * hands back ids shaped like the ones Redis returns.
   */
  it('records publications in order and returns stream-shaped ids', async () => {
    const publisher = new InMemoryTurnEventPublisher();

    const first = await publisher.publish('turn-1', { type: 'turn.cancelled' });
    await publisher.publish('turn-2', { type: 'heartbeat', at: '2026-01-01T00:00:00.000Z' });
    await publisher.publish('turn-1', { type: 'prepare.progress', message: 'x' });

    expect(first).toBe('0-1');
    expect(publisher.records).toHaveLength(3);
    expect(publisher.eventsFor('turn-1').map((event) => event.type)).toEqual([
      'turn.cancelled',
      'prepare.progress',
    ]);
  });
});

describe('InMemoryCommandListener', () => {
  /**
   * Cancellation reaches only the subscribed turn, and an unsubscribed one reports that nothing
   * received it rather than throwing.
   */
  it('delivers a cancellation to the subscribed turn only', async () => {
    const listener = new InMemoryCommandListener();
    const onCancel = vi.fn();
    await listener.subscribe('turn-1', { onCancel });

    expect(listener.emitCancel('turn-1')).toBe(true);
    expect(listener.emitCancel('turn-2')).toBe(false);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  /**
   * The subscription count is what a processor test asserts to prove the `finally` released it.
   */
  it('releases the subscription', async () => {
    const listener = new InMemoryCommandListener();
    const stop = await listener.subscribe('turn-1', { onCancel: vi.fn() });
    expect(listener.subscriptions).toBe(1);

    await stop();

    expect(listener.subscriptions).toBe(0);
    expect(listener.emitCancel('turn-1')).toBe(false);
  });
});

describe('FakeSecretsService', () => {
  /**
   * `reveal` hands back exactly what was seeded, and `null` for a key that was never stored —
   * which is how the missing-credential path is exercised.
   */
  it('reveals seeded values and null for the rest', async () => {
    const secrets = new FakeSecretsService({ GITHUB_PAT: GITHUB_CANARY });

    await expect(secrets.reveal('GITHUB_PAT')).resolves.toBe(GITHUB_CANARY);
    await expect(secrets.reveal('OPENAI_API_KEY')).resolves.toBeNull();
  });

  /**
   * Setting and removing behave like the real service, and the status exposes only the masking
   * characters.
   */
  it('sets, removes and reports masked status', async () => {
    const secrets = new FakeSecretsService();

    const { last4 } = await secrets.set('OPENAI_API_KEY', OPENAI_CANARY);
    expect(last4).toBe(OPENAI_CANARY.slice(-4));
    await expect(secrets.status()).resolves.toEqual({
      GITHUB_PAT: { set: false },
      OPENAI_API_KEY: { set: true, last4 },
    });

    await secrets.remove('OPENAI_API_KEY');
    await expect(secrets.reveal('OPENAI_API_KEY')).resolves.toBeNull();
  });
});

describe('FakeQueue', () => {
  /**
   * `getJobSchedulers` answers from what `upsertJobScheduler` recorded, so a reconciliation test
   * can assert the second boot is a no-op instead of only that the first registered something.
   */
  it('records jobs and answers scheduler queries from what it stored', async () => {
    const queue = new FakeQueue();

    await queue.add('run-turn', { turnId: 't1' }, { jobId: 't1' });
    await queue.upsertJobScheduler(
      'job-1',
      { pattern: '*/5 * * * *', tz: 'UTC' },
      { name: 'n', data: 1 },
    );

    expect(queue.jobs).toEqual([
      { name: 'run-turn', data: { turnId: 't1' }, opts: { jobId: 't1' } },
    ]);
    await expect(queue.getJobSchedulers()).resolves.toEqual([
      { key: 'job-1', pattern: '*/5 * * * *', tz: 'UTC', template: { name: 'n', data: 1 } },
    ]);
    expect(queue.scheduler('job-1')?.template.name).toBe('n');
  });

  /**
   * Removal reports whether anything was registered, which is what makes a reconcile plan's
   * removals assertable, and `close` is observable so the container test can prove it ran.
   */
  it('reports removals and closing', async () => {
    const queue = new FakeQueue();
    await queue.upsertJobScheduler('job-1', { pattern: '* * * * *' }, { name: 'n', data: null });

    await expect(queue.removeJobScheduler('job-1')).resolves.toBe(true);
    await expect(queue.removeJobScheduler('job-1')).resolves.toBe(false);
    expect(queue.removed).toEqual(['job-1', 'job-1']);

    await queue.close();
    expect(queue.closed).toBe(true);
  });

  /**
   * An `add` without options records the absent options rather than inventing any.
   */
  it('records an add without options', async () => {
    const queues = createFakeQueues();

    await queues.workspaceGc.add('reap-idle', {});

    expect(queues.workspaceGc.jobs).toEqual([{ name: 'reap-idle', data: {}, opts: undefined }]);
  });
});

describe('createTestContainer', () => {
  /**
   * The default container holds both credentials, the real redactor and the in-memory doubles, so
   * a processor test starts from a worker that could actually run a turn.
   */
  it('wires in-memory collaborators and both credentials', async () => {
    const container = createTestContainer();

    await expect(container.secrets.reveal('GITHUB_PAT')).resolves.toBe(GITHUB_CANARY);
    await expect(container.secrets.reveal('OPENAI_API_KEY')).resolves.toBe(OPENAI_CANARY);
    expect(container.runner.kind).toBe('fake');
    expect(container.config.AGENT_MODEL_PROVIDER).toBe('fake');
    expect(container.redactor.redact(`token ${GITHUB_CANARY}`)).toBe('token [REDACTED]');
  });

  /**
   * Overrides replace a collaborator wholesale, which is how a test drops a credential or freezes
   * the clock at a chosen instant.
   */
  it('applies overrides', () => {
    const secrets = new FakeSecretsService();

    const container = createTestContainer({ secrets });

    expect(container.secrets).toBe(secrets);
  });

  /**
   * Log lines are captured rather than printed, and they pass through the container's redactor,
   * so a test can assert both what was logged and that it carries no credential.
   */
  it('captures redacted log lines', () => {
    const container = createTestContainer();

    container.logger.warn({ value: GITHUB_CANARY }, 'careless');

    expect(container.logs).toHaveLength(1);
    expect(container.logs[0]).toContain('careless');
    expect(container.logs[0]).not.toContain(GITHUB_CANARY);
  });
});
