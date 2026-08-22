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
    // Both ids name entries the stream still holds, so the choice between them is the only thing
    // the replay bound can be reporting: a resume point that is not there any more is refused
    // before any replay is attempted.
    const older = await harness.doubles.redis.xadd(key, 'event', '{"type":"step.started"}');
    const newer = await harness.doubles.redis.xadd(key, 'event', '{"type":"turn.cancelled"}');
    const spy = vi.spyOn(FakeRedis.prototype, 'xrange');

    const response = await chatEvents(
      harness.container,
      stream(`/api/chats/${chatId}/events?from=${older}`, { 'last-event-id': newer }),
      { id: chatId },
    );
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledWith(key, `(${newer}`, '+');
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
    expect(await unknown.json()).toMatchObject({ error: { message: 'Chat not found' } });

    const chat = await harness.doubles.repos.chats.create({
      title: 'Seeded',
      repoUrl: REPO_URL,
      baseBranch: 'main',
    });
    const empty = await chatEvents(harness.container, stream(`/api/chats/${chat.id}/events`), {
      id: chat.id,
    });
    expect(empty.status).toBe(404);
    // The two absences are told apart by their wording: a chat that is not there and a chat whose
    // stream has not started are different things for the page to say, and only the sentence
    // distinguishes them.
    expect(await empty.json()).toMatchObject({
      error: { code: 'NOT_FOUND', message: 'Chat has no turns yet' },
    });
  });

  /**
   * A resume point is an entry id and nothing else. The header comes from the browser's own
   * reconnect, and a pattern that read part of one would hand Redis a cursor it refuses — or, worse,
   * one it accepts and answers from the wrong place.
   */
  it.each(['1700000000000-0x', 'x1700000000000-0', '17000000000000', '-0'])(
    'ignores %s as a resume point',
    async (header) => {
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
        stream(`/api/chats/${chatId}/events`, { 'last-event-id': header }),
        { id: chatId },
      );
      await response.text();

      expect(spy).not.toHaveBeenCalled();
    },
  );

  /**
   * A resume point with more than one digit on either side of the dash is an ordinary Redis id —
   * the left half is a millisecond timestamp — so it is used rather than ignored. A pattern that
   * accepted only single digits would silently replay the whole transcript on every reconnect.
   */
  it('resumes from a full entry id', async () => {
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
      stream(`/api/chats/${chatId}/events`, { 'last-event-id': '1700000000000-12' }),
      { id: chatId },
    );
    const text = await response.text();

    // The resume point reaches Redis as the client sent it: first to ask whether that entry is
    // still in the stream, then — when it is not — as the cursor the expiry frame echoes back.
    expect(spy).toHaveBeenCalledWith(
      turnEventsStreamKey(turnId),
      '1700000000000-12',
      '1700000000000-12',
    );
    expect(text).toContain('id: 1700000000000-12');
  });

  /**
   * A turn whose row went while the stream was open — its chat deleted from another tab — is not
   * live, so the stream ends. Reaching into a row that is not there would break the stream with a
   * failure instead, and the page would show it as a transcript that stopped for no reason.
   */
  it('ends the stream when the turn row goes while it is open', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedChat(harness);
    vi.spyOn(harness.doubles.repos.turns, 'get').mockResolvedValue(null);

    const response = await chatEvents(harness.container, stream(`/api/chats/${chatId}/events`), {
      id: chatId,
    });
    const text = await response.text();

    expect(turnId).toEqual(expect.any(String));
    expect(text).toContain('event: expired');
    expect(harness.doubles.logOutput()).not.toContain('event stream failed');
  });

  /**
   * A stream stays open while its turn is live and closes itself once the turn is not. The route
   * hands the stream the question rather than an answer, because the turn ends in another process
   * while this connection is already open.
   */
  it('closes the stream once the turn it follows is no longer live', async () => {
    const harness = createTestContainer();
    const { chatId, turnId } = await seedChat(harness);
    await harness.doubles.repos.turns.finish(turnId, 'SUCCEEDED', {
      inputTokens: 0,
      outputTokens: 0,
      stepCount: 0,
    });

    const response = await chatEvents(harness.container, stream(`/api/chats/${chatId}/events`), {
      id: chatId,
    });

    expect(await response.text()).toContain('event: expired');
  });

  /**
   * A rebound host is refused before any row is read: this stream carries a chat's whole
   * transcript, and rebinding is the case in which the browser lets an attacking page read it.
   */
  it('refuses a stream addressed to a rebound host', async () => {
    const harness = createTestContainer();
    const { chatId } = await seedChat(harness);

    const response = await chatEvents(
      harness.container,
      new Request(`http://attacker.test/api/chats/${chatId}/events`, {
        headers: { host: 'attacker.test' },
      }),
      { id: chatId },
    );

    expect(response.status).toBe(403);
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
    expect(await response.json()).toMatchObject({ error: { message: 'Run not found' } });
  });

  /**
   * A run's stream closes itself once the run is over, for the same reason a turn's does.
   */
  it('closes the stream once the run it follows is no longer live', async () => {
    const harness = createTestContainer();
    const job = await harness.doubles.repos.scheduledJobs.create({
      name: 'nightly',
      cron: '0 3 * * *',
      timezone: 'UTC',
      prompt: 'do it',
      repoUrl: REPO_URL,
      branch: 'main',
      enabled: true,
    });
    const run = await harness.doubles.repos.jobRuns.create({
      jobId: job.id,
      trigger: 'MANUAL',
      model: 'test-model',
      scheduledFor: harness.container.clock.now(),
    });
    await harness.doubles.repos.jobRuns.finish(run.id, {
      status: 'SUCCEEDED',
      usage: { inputTokens: 0, outputTokens: 0, stepCount: 0 },
    });

    const response = await runEvents(harness.container, stream(`/api/runs/${run.id}/events`), {
      id: run.id,
    });

    expect(await response.text()).toContain('event: expired');
  });

  /**
   * The same for a run whose row goes while its stream is open.
   */
  it('ends the run stream when the run row goes while it is open', async () => {
    const harness = createTestContainer();
    const job = await harness.doubles.repos.scheduledJobs.create({
      name: 'nightly',
      cron: '0 3 * * *',
      timezone: 'UTC',
      prompt: 'do it',
      repoUrl: REPO_URL,
      branch: 'main',
      enabled: true,
    });
    const run = await harness.doubles.repos.jobRuns.create({
      jobId: job.id,
      trigger: 'MANUAL',
      model: 'test-model',
      scheduledFor: harness.container.clock.now(),
    });
    const get = harness.doubles.repos.jobRuns.get.bind(harness.doubles.repos.jobRuns);
    let reads = 0;
    vi.spyOn(harness.doubles.repos.jobRuns, 'get').mockImplementation(async (id: string) => {
      reads += 1;
      return reads === 1 ? get(id) : null;
    });

    const response = await runEvents(harness.container, stream(`/api/runs/${run.id}/events`), {
      id: run.id,
    });
    const text = await response.text();

    expect(text).toContain('event: expired');
    expect(harness.doubles.logOutput()).not.toContain('event stream failed');
  });

  /**
   * And a rebound host is refused here too, before the run is looked up.
   */
  it('refuses a run stream addressed to a rebound host', async () => {
    const harness = createTestContainer();

    const response = await runEvents(
      harness.container,
      new Request('http://attacker.test/api/runs/nope/events', {
        headers: { host: 'attacker.test' },
      }),
      { id: 'nope' },
    );

    expect(response.status).toBe(403);
  });
});
