/** @vitest-environment node */
/**
 * Unit tests for the two event-stream routes.
 *
 * Layer: unit.
 * Goal: each route resolves the right stream key, refuses what it cannot stream, and passes the
 * resume point through with the header winning over the query.
 * Mocks: the `bullmq` module.
 */
import { turnEventsStreamKey } from '@agent-hangar/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SSE_HEADERS } from '../sse';
import { FakeRedis } from '../testing/fake-redis';
import { createTestContainer } from '../testing/test-container';
import type { TestContainer } from '../testing/test-container';

import { createChat } from './chats';
import { chatEvents, runEvents } from './events';

vi.mock('bullmq', () => import('../testing/fake-queue'));

afterEach(() => {
  vi.restoreAllMocks();
});

/** A repository URL the contracts accept. */
const REPO_URL = 'https://github.com/acme/widgets';

/**
 * Builds a stream request.
 *
 * @param path - Path below the API root, query included.
 * @param headers - Extra request headers.
 * @returns The request.
 */
function stream(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1:3000${path}`, {
    headers: { host: '127.0.0.1:3000', ...headers },
  });
}

/**
 * Creates a chat with one queued turn through the API.
 *
 * @param harness - The test container.
 * @returns The chat and turn ids.
 */
async function seedChat(harness: TestContainer): Promise<{ chatId: string; turnId: string }> {
  const request = new Request('http://127.0.0.1:3000/api/chats', {
    method: 'POST',
    headers: {
      host: '127.0.0.1:3000',
      origin: 'http://127.0.0.1:3000',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ repoUrl: REPO_URL, baseBranch: 'main', prompt: 'work' }),
  });
  return (await (await createChat(harness.container, request)).json()) as {
    chatId: string;
    turnId: string;
  };
}

/**
 * Closes a stream response so no reader is left blocked.
 *
 * @param response - The stream response.
 */
async function drain(response: Response): Promise<void> {
  await response.body?.cancel();
}

describe('chatEvents', () => {
  /**
   * The happy path streams the chat's most recent turn, which is the one the transcript is
   * rendering.
   */
  it('streams the latest turn of a chat', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedChat(harness);
    const response = await chatEvents(harness.container, stream(`/api/chats/${chatId}/events`), {
      id: chatId,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(SSE_HEADERS['Content-Type']);
    expect(harness.doubles.redis.duplicates).toHaveLength(1);
    await drain(response);
    expect(turnEventsStreamKey(turnId)).toBe(`events:turn:${turnId}`);
  });

  /**
   * A `Last-Event-ID` header makes the stream replay from that entry, which is what the browser
   * sends on its own reconnects.
   */
  it('replays from the Last-Event-ID header', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedChat(harness);
    const key = turnEventsStreamKey(turnId);
    const first = await harness.doubles.redis.xadd(key, 'event', '{"type":"turn.cancelled"}');
    const spy = vi.spyOn(FakeRedis.prototype, 'xrange');

    const response = await chatEvents(
      harness.container,
      stream(`/api/chats/${chatId}/events`, { 'last-event-id': first }),
      { id: chatId },
    );
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledWith(key, `(${first}`, '+');
    });
    await drain(response);
  });

  /**
   * The header wins over `?from=`: the browser maintains the header, while the query is only the
   * page's own guess after a full reload.
   */
  it('prefers the header over the from parameter', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedChat(harness);
    const key = turnEventsStreamKey(turnId);
    await harness.doubles.redis.xadd(key, 'event', '{"type":"turn.cancelled"}');
    const spy = vi.spyOn(FakeRedis.prototype, 'xrange');

    const response = await chatEvents(
      harness.container,
      stream(`/api/chats/${chatId}/events?from=1-1`, { 'last-event-id': '9-9' }),
      { id: chatId },
    );
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledWith(key, '(9-9', '+');
    });
    await drain(response);
  });

  /**
   * A header that is not an entry id is ignored rather than refused: the cost of ignoring it is
   * one replayed transcript, and the cost of refusing it is a stream that never opens.
   */
  it('ignores a malformed Last-Event-ID', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedChat(harness);
    await harness.doubles.redis.xadd(
      turnEventsStreamKey(turnId),
      'event',
      '{"type":"turn.cancelled"}',
    );
    const spy = vi.spyOn(FakeRedis.prototype, 'xrange');
    const response = await chatEvents(
      harness.container,
      stream(`/api/chats/${chatId}/events`, { 'last-event-id': 'nonsense' }),
      { id: chatId },
    );
    await response.text();
    expect(spy).not.toHaveBeenCalled();
  });

  /**
   * A `?from=` that is not an entry id is a request the client built wrong, so it is refused; the
   * client controls that value directly, unlike the header.
   */
  it('rejects a malformed from parameter', async () => {
    const harness = createTestContainer();
    const { chatId } = await seedChat(harness);
    const response = await chatEvents(
      harness.container,
      stream(`/api/chats/${chatId}/events?from=bad`),
      { id: chatId },
    );
    expect(response.status).toBe(400);
  });

  /**
   * An unknown chat, and a chat whose turns are all gone, are both missing: there is no stream to
   * open, and holding the connection would look like a stream that never produces anything.
   */
  it('reports a missing chat and a chat with no turns', async () => {
    const harness = createTestContainer();
    const unknown = await chatEvents(harness.container, stream('/api/chats/nope/events'), {
      id: 'nope',
    });
    expect(unknown.status).toBe(404);

    const chat = await harness.doubles.repos.chats.create({
      title: 'Seeded',
      repoUrl: REPO_URL,
      baseBranch: 'main',
    });
    const empty = await chatEvents(harness.container, stream(`/api/chats/${chat.id}/events`), {
      id: chat.id,
    });
    expect(empty.status).toBe(404);
    expect(await empty.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});

describe('runEvents', () => {
  /**
   * A run streams from its own id, because the worker writes the run's events under that key.
   */
  it('streams a job run', async () => {
    const harness = createTestContainer();
    const job = await harness.doubles.repos.scheduledJobs.create({
      name: 'Nightly triage',
      cron: '0 3 * * *',
      timezone: 'Europe/Lisbon',
      prompt: 'Triage new issues',
      repoUrl: REPO_URL,
      branch: 'main',
      enabled: true,
    });
    const run = await harness.doubles.repos.jobRuns.create({
      jobId: job.id,
      trigger: 'MANUAL',
      model: 'gpt-test',
      scheduledFor: harness.doubles.clock.now(),
    });
    const response = await runEvents(harness.container, stream(`/api/runs/${run.id}/events`), {
      id: run.id,
    });
    expect(response.status).toBe(200);
    expect(harness.doubles.redis.duplicates).toHaveLength(1);
    await drain(response);
  });

  /**
   * An unknown run has no stream key to read.
   */
  it('reports an unknown run as missing', async () => {
    const harness = createTestContainer();
    const response = await runEvents(harness.container, stream('/api/runs/nope/events'), {
      id: 'nope',
    });
    expect(response.status).toBe(404);
  });
});
