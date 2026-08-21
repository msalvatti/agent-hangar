/** @vitest-environment node */
/**
 * Integration tests for the SSE stream against a real Redis.
 *
 * Layer: integration.
 * Goal: the parts the in-memory double cannot prove — that `XRANGE` with an exclusive `(id` bound
 * and a blocking `XREAD` behave the way the pump assumes on Redis 8, and that dropping the
 * duplicated connection really ends a blocked read.
 * Mocks: none. Needs `REDIS_URL`; the suite skips locally without it and fails loudly in CI, the
 * same convention the `@db` suites in core follow.
 */
import { randomUUID } from 'node:crypto';

import { createLogger, createRedactor, turnEventsStreamKey } from '@agent-hangar/core';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSseResponse, SSE_EXPIRED_EVENT, SSE_HEARTBEAT_FRAME } from './sse';

/** Environment variable naming the Redis to test against. */
const REDIS_URL_ENV = 'REDIS_URL';

/** Heartbeat and block interval; short enough that the suite stays quick. */
const TICK_MS = 100;

/** How long a stream key lives, so a failed run leaves nothing behind. */
const KEY_TTL_SECONDS = 60;

/** Logger that writes nowhere; these tests assert on frames, not on logs. */
const logger = createLogger({
  level: 'silent',
  redactor: createRedactor(),
  destination: {
    write(): void {
      // Discarded on purpose.
    },
  },
});

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
 * A silently skipped integration suite is indistinguishable from a passing one, so a missing
 * service in CI has to fail the run.
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
      /**
       * CI must provide Redis; a skipped suite here would hide a broken transport.
       */
      it('fails loudly: Redis required in CI', () => {
        throw new Error(
          `${REDIS_URL_ENV} is not set; CI must provide Redis for the @redis suites.`,
        );
      });
    });
    return;
  }
  console.info(
    `[skip] ${name}: set ${REDIS_URL_ENV} to run it. Start the stack with "pnpm infra:up" and ` +
      'export the URL that "infra/scripts/env.sh --print" reports.',
  );
  describe.skip(name, () => {
    body('');
  });
}

describeRedis('@redis sse', (url) => {
  let client: Redis;
  const keys: string[] = [];

  beforeAll(async () => {
    client = new Redis(url);
    await client.ping();
  });

  afterAll(async () => {
    if (keys.length > 0) {
      await client.del(...keys);
    }
    await client.quit();
  });

  /**
   * Allocates a stream key nothing else uses, expiring it so a failed run leaves no rubbish.
   *
   * @returns The key.
   */
  function newKey(): string {
    const key = turnEventsStreamKey(`itest-${randomUUID()}`);
    keys.push(key);
    return key;
  }

  /**
   * Appends one event to a stream, in the flat field layout the worker writes.
   *
   * @param key - Stream key.
   * @param event - The event to encode.
   * @returns The generated entry id.
   */
  async function append(key: string, event: Record<string, unknown>): Promise<string> {
    const id = await client.xadd(key, '*', 'event', JSON.stringify(event));
    await client.expire(key, KEY_TTL_SECONDS);
    return id ?? '';
  }

  /**
   * Opens a stream over the real client.
   *
   * @param options - Stream key, resume point and liveness.
   * @returns The response and its abort controller.
   */
  function open(options: { key: string; lastEventId?: string; finished?: boolean }): {
    response: Response;
    controller: AbortController;
  } {
    const controller = new AbortController();
    const response = createSseResponse({
      redis: client,
      streamKey: options.key,
      ...(options.lastEventId === undefined ? {} : { lastEventId: options.lastEventId }),
      isFinished: () => Promise.resolve(options.finished ?? false),
      signal: controller.signal,
      heartbeatMs: TICK_MS,
      blockMs: TICK_MS,
      logger,
    });
    return { response, controller };
  }

  /**
   * Reads chunks until the predicate holds or the stream ends.
   *
   * @param response - The stream response.
   * @param done - Called with everything read so far.
   * @returns Everything that was read.
   */
  async function readUntil(response: Response, done: (text: string) => boolean): Promise<string> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!done(text)) {
      const chunk = await reader.read();
      if (chunk.done) {
        return text;
      }
      text += decoder.decode(chunk.value);
    }
    void reader.cancel();
    return text;
  }

  /**
   * Replay against a real server: three entries written before the client connected come back in
   * order, each carrying the id Redis assigned it.
   */
  it('replays every existing entry with its Redis id', async () => {
    const key = newKey();
    const ids = [
      await append(key, { type: 'assistant.delta', text: 'one' }),
      await append(key, { type: 'assistant.delta', text: 'two' }),
      await append(key, { type: 'assistant.delta', text: 'three' }),
    ];
    const { response, controller } = open({ key });
    const text = await readUntil(response, (read) => read.includes('three'));
    controller.abort();
    for (const id of ids) {
      expect(text).toContain(`id: ${id}\n`);
    }
    expect(text.indexOf('one')).toBeLessThan(text.indexOf('three'));
  });

  /**
   * The exclusive `(id` lower bound is a Redis 6.2 feature the reconnect path depends on; against
   * a real server it must return strictly later entries.
   */
  it('replays only what follows the resume point', async () => {
    const key = newKey();
    const first = await append(key, { type: 'assistant.delta', text: 'one' });
    await append(key, { type: 'assistant.delta', text: 'two' });
    const { response, controller } = open({ key, lastEventId: first });
    const text = await readUntil(response, (read) => read.includes('two'));
    controller.abort();
    expect(text).not.toContain('one');
  });

  /**
   * The case the cap creates, reproduced by making Redis really trim: the client's resume point is
   * an entry `XTRIM` removed, so the frames between it and the oldest survivor are gone for good.
   *
   * What makes this worth a real server is that Redis reports nothing about it. `XRANGE` with an
   * exclusive bound below the first surviving id answers with the surviving suffix and no error, so
   * a pump that trusted the resume point would deliver a contiguous-looking sequence with a hole in
   * the middle. The client is told to refetch the persisted transcript instead.
   */
  it('refuses a resume point Redis has trimmed away', async () => {
    const key = newKey();
    const trimmed = await append(key, { type: 'assistant.delta', text: 'trimmed' });
    await append(key, { type: 'assistant.delta', text: 'survivor' });
    await client.xtrim(key, 'MAXLEN', 1);
    expect(await client.xrange(key, trimmed, trimmed)).toHaveLength(0);

    const { response, controller } = open({ key, lastEventId: trimmed });
    const text = await readUntil(response, (read) => read.includes(SSE_EXPIRED_EVENT));
    controller.abort();

    expect(text).toContain(`event: ${SSE_EXPIRED_EVENT}`);
    expect(text).not.toContain('survivor');
  });

  /**
   * The blocking read really tails: an entry written from another connection after the client
   * connected arrives without a new request.
   */
  it('delivers an entry written after the client connected', async () => {
    const key = newKey();
    const { response, controller } = open({ key });
    const pending = readUntil(response, (read) => read.includes('later'));
    await append(key, { type: 'assistant.delta', text: 'later' });
    const text = await pending;
    controller.abort();
    expect(text).toContain('event: assistant.delta');
  });

  /**
   * The heartbeat keeps an idle connection alive; the interval is shortened here, and the shipped
   * default is asserted separately rather than waited out.
   */
  it('sends a heartbeat while idle', async () => {
    const key = newKey();
    const { response, controller } = open({ key });
    const text = await readUntil(response, (read) => read.includes(SSE_HEARTBEAT_FRAME));
    controller.abort();
    expect(text).toContain(SSE_HEARTBEAT_FRAME);
  });

  /**
   * A terminal event ends the stream against a real server too, which is what stops the browser
   * from reconnecting to a turn that is over.
   */
  it('closes after a terminal event', async () => {
    const key = newKey();
    await append(key, { type: 'turn.cancelled' });
    const { response } = open({ key });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let chunk = await reader.read();
    while (!chunk.done) {
      text += decoder.decode(chunk.value);
      chunk = await reader.read();
    }
    expect(text).toContain('event: turn.cancelled');
  });

  /**
   * A stream key that expired while the turn was finishing is the reconnect-too-late case: the
   * client is told to refetch the persisted transcript instead of waiting.
   */
  it('reports an expired stream', async () => {
    const { response } = open({ key: turnEventsStreamKey(`gone-${randomUUID()}`), finished: true });
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain(`event: ${SSE_EXPIRED_EVENT}`);
    expect((await reader.read()).done).toBe(true);
  });

  /**
   * Aborting the request ends the blocked read promptly rather than at the end of its block
   * duration, which is what keeps a closed tab from holding a Redis connection.
   */
  it('ends a blocked read when the request is aborted', async () => {
    const key = newKey();
    const { response, controller } = open({ key });
    const reader = response.body!.getReader();
    const pending = reader.read();
    controller.abort();
    expect((await pending).done).toBe(true);
  });
});
