/** @vitest-environment node */
/**
 * Unit tests for the SSE stream factory.
 *
 * Layer: unit.
 * Goal: replay, tail, heartbeat, expiry and every way a stream can end — with the duplicated
 * connection always released and no timer left running.
 * Mocks: the in-memory Redis double; real timers, because the pump's block duration is what paces
 * the loop.
 */
import { createLogger, createRedactor } from '@agent-hangar/core';
import type { AgentEvent } from '@agent-hangar/core';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import type { RedisCommands, StreamRead } from './redis';
import {
  createSseResponse,
  formatSseFrame,
  SSE_EXPIRED_EVENT,
  SSE_HEADERS,
  SSE_HEARTBEAT_FRAME,
  SSE_TERMINAL_EVENTS,
} from './sse';
import { FakeRedis } from './testing/fake-redis';

/** Stream key every test in this file reads. */
const KEY = 'events:turn:t1';

/** Heartbeat and block interval; short enough that a real-timer test stays fast. */
const TICK_MS = 10;

/**
 * Builds a logger writing into an array.
 *
 * @returns The logger and a reader of everything it wrote.
 */
function captureLogger(): { logger: Logger; output: () => string } {
  const lines: string[] = [];
  const logger = createLogger({
    level: 'warn',
    redactor: createRedactor(),
    destination: {
      write(line: string): void {
        lines.push(line);
      },
    },
  });
  return { logger, output: () => lines.join('') };
}

/** A running stream and everything a test needs to drive it. */
interface Harness {
  response: Response;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  redis: FakeRedis;
  controller: AbortController;
  output: () => string;
}

/**
 * Opens a stream over a fresh in-memory Redis.
 *
 * @param options - Resume point, liveness and an optional pre-built connection.
 * @returns The harness.
 */
function open(
  options: {
    lastEventId?: string;
    finished?: boolean;
    /** Liveness read afresh on every check, for a turn that finishes while the stream is open. */
    isFinished?: () => Promise<boolean>;
    redis?: RedisCommands;
    fake?: FakeRedis;
  } = {},
): Harness {
  const fake = options.fake ?? new FakeRedis();
  const controller = new AbortController();
  const { logger, output } = captureLogger();
  const response = createSseResponse({
    redis: options.redis ?? fake,
    streamKey: KEY,
    ...(options.lastEventId === undefined ? {} : { lastEventId: options.lastEventId }),
    isFinished:
      options.isFinished ?? ((): Promise<boolean> => Promise.resolve(options.finished ?? false)),
    signal: controller.signal,
    heartbeatMs: TICK_MS,
    blockMs: TICK_MS,
    logger,
  });
  return { response, reader: response.body!.getReader(), redis: fake, controller, output };
}

/**
 * Reads chunks until the predicate holds or the stream ends.
 *
 * @param reader - Reader of the response body.
 * @param done - Called with everything read so far.
 * @returns Everything that was read.
 */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  done: (text: string) => boolean,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  while (!done(text)) {
    const chunk = await reader.read();
    if (chunk.done) {
      return text;
    }
    text += decoder.decode(chunk.value);
  }
  return text;
}

/**
 * Reads everything that is left until the stream closes.
 *
 * @param reader - Reader of the response body.
 * @returns Everything that was read before the close.
 */
function readToEnd(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  return readUntil(reader, () => false);
}

/**
 * Appends one agent event to the stream.
 *
 * @param redis - The Redis double.
 * @param event - The event to write.
 * @returns The generated entry id.
 */
function append(redis: FakeRedis, event: AgentEvent): Promise<string> {
  return redis.xadd(KEY, 'event', JSON.stringify(event));
}

describe('formatSseFrame', () => {
  /**
   * The wire format is exact: an extra or missing newline would either merge two frames or leave
   * one buffered until the next arrives.
   */
  it('emits the documented framing', () => {
    expect(formatSseFrame({ id: '1-1', event: 'assistant.delta', data: '{"a":1}' })).toBe(
      'id: 1-1\nevent: assistant.delta\ndata: {"a":1}\n\n',
    );
  });

  /**
   * A frame is split by a raw newline in its data, so the payload must be JSON — which escapes
   * every newline it contains. Text a model produced is the realistic case.
   */
  it('keeps a multi-line payload inside one frame', () => {
    const data = JSON.stringify({ type: 'assistant.delta', text: 'first\nsecond' });
    const frame = formatSseFrame({ id: '1-1', event: 'assistant.delta', data });
    expect(frame.split('\n\n')).toHaveLength(2);
    expect(frame).toContain('first\\nsecond');
  });
});

describe('createSseResponse', () => {
  /**
   * The headers are what stop a proxy from buffering or compressing the body; a stream that is
   * buffered is indistinguishable from a stream that is not working.
   */
  it('answers with the event-stream headers', async () => {
    const harness = open();
    expect(harness.response.status).toBe(200);
    for (const [name, value] of Object.entries(SSE_HEADERS)) {
      expect(harness.response.headers.get(name)).toBe(value);
    }
    harness.controller.abort();
    await harness.reader.read();
  });

  /**
   * Without a resume point the whole stream is replayed, in order and with the Redis ids the
   * browser will echo back on reconnect.
   */
  it('replays the whole stream when there is no resume point', async () => {
    const redis = new FakeRedis();
    const first = await append(redis, { type: 'assistant.delta', text: 'one' });
    const second = await append(redis, { type: 'assistant.delta', text: 'two' });
    const harness = open({ fake: redis });

    const text = await readUntil(harness.reader, (read) => read.includes('two'));
    expect(text).toContain(`id: ${first}\nevent: assistant.delta`);
    expect(text).toContain(`id: ${second}\n`);
    harness.controller.abort();
  });

  /**
   * With a resume point only later entries are sent: the exclusive lower bound is what keeps a
   * reconnect from repeating the frame the transcript already rendered.
   */
  it('replays only what follows the resume point', async () => {
    const redis = new FakeRedis();
    const first = await append(redis, { type: 'assistant.delta', text: 'one' });
    await append(redis, { type: 'assistant.delta', text: 'two' });
    const harness = open({ fake: redis, lastEventId: first });

    const text = await readUntil(harness.reader, (read) => read.includes('two'));
    expect(text).not.toContain('one');
    harness.controller.abort();
  });

  /**
   * The tail: an entry written after the client connected arrives without another request.
   */
  it('delivers an entry written after the client connected', async () => {
    const harness = open();
    const pending = readUntil(harness.reader, (read) => read.includes('later'));
    await append(harness.redis, { type: 'assistant.delta', text: 'later' });
    expect(await pending).toContain('event: assistant.delta');
    harness.controller.abort();
  });

  /**
   * An idle stream keeps polling: the loop has to survive several empty tail reads and still
   * deliver the entry that eventually arrives, which is the everyday case of a turn that spends a
   * while preparing its workspace.
   */
  it('keeps polling across empty tail reads', async () => {
    const harness = open();
    const pending = readUntil(harness.reader, (read) => read.includes('finally'));
    await new Promise((resolve) => setTimeout(resolve, TICK_MS * 3));
    await append(harness.redis, { type: 'assistant.delta', text: 'finally' });
    expect(await pending).toContain('finally');
    harness.controller.abort();
  });

  /**
   * A terminal event ends the stream: there will never be another, so holding the connection open
   * would only cost the browser a socket.
   */
  it('closes after a terminal event and releases the connection', async () => {
    const harness = open();
    await append(harness.redis, { type: 'turn.cancelled' });
    const text = await readUntil(harness.reader, (read) => read.includes('turn.cancelled'));
    expect(text).toContain(`event: ${SSE_TERMINAL_EVENTS[2] ?? ''}`);
    expect((await harness.reader.read()).done).toBe(true);
    expect(harness.redis.duplicates[0]?.closed).toBe(true);
  });

  /**
   * A terminal event found during replay ends the stream just as one found while tailing does; a
   * client that reconnects after the turn finished gets the tail of the transcript and a close.
   */
  it('closes when the terminal event arrives during replay', async () => {
    const redis = new FakeRedis();
    const first = await append(redis, { type: 'assistant.delta', text: 'one' });
    await append(redis, {
      type: 'turn.completed',
      usage: { inputTokens: 1, outputTokens: 1 },
      steps: 1,
      finalMessage: 'done',
    });
    const harness = open({ fake: redis, lastEventId: first });
    const text = await readUntil(harness.reader, (read) => read.includes('turn.completed'));
    expect(text).toContain('event: turn.completed');
    expect((await harness.reader.read()).done).toBe(true);
  });

  /**
   * The heartbeat is a comment frame, which every SSE client ignores; it exists so an idle proxy
   * does not decide the connection is dead.
   */
  it('sends a heartbeat comment while idle', async () => {
    const harness = open();
    const text = await readUntil(harness.reader, (read) => read.includes(SSE_HEARTBEAT_FRAME));
    expect(text).toBe(SSE_HEARTBEAT_FRAME);
    harness.controller.abort();
  });

  /**
   * The expiry path: the replay cache is gone and the work is over, so the client is told to
   * refetch the persisted transcript rather than wait for frames that will never come.
   */
  it('reports an expired stream once and closes', async () => {
    const harness = open({ finished: true });
    const text = await readUntil(harness.reader, (read) => read.includes(SSE_EXPIRED_EVENT));
    expect(text).toContain(`event: ${SSE_EXPIRED_EVENT}`);
    expect((await harness.reader.read()).done).toBe(true);
    expect(harness.redis.duplicates[0]?.closed).toBe(true);
  });

  /**
   * Regression: the work can finish after the stream is already open and before the worker has
   * written a single entry — a crash between claiming the turn and its first event. The cursor is
   * still at the start of the stream then, so the exit conditions have to be rechecked after every
   * empty read; testing them only once left the client heartbeating for ever.
   */
  it('closes an empty stream once the work finishes while it is being tailed', async () => {
    let finished = false;
    const harness = open({ isFinished: () => Promise.resolve(finished) });

    await readUntil(harness.reader, (read) => read.includes(SSE_HEARTBEAT_FRAME));
    finished = true;
    const text = await readToEnd(harness.reader);

    expect(text).toContain(`event: ${SSE_EXPIRED_EVENT}`);
    expect(harness.redis.duplicates[0]?.closed).toBe(true);
  });

  /**
   * A missing stream key while the turn is still queued means the worker has not started yet, so
   * the stream waits rather than reporting expiry.
   */
  it('waits when the stream is missing but the work has not finished', async () => {
    const harness = open();
    const pending = readUntil(harness.reader, (read) => read.includes('started'));
    await append(harness.redis, { type: 'assistant.delta', text: 'started' });
    expect(await pending).toContain('started');
    harness.controller.abort();
  });

  /**
   * The other belt-and-braces exit: the worker crashed without writing a terminal event, so the
   * stream ends once everything up to the cursor has been delivered.
   */
  it('closes when the work finished without a terminal event', async () => {
    const redis = new FakeRedis();
    await append(redis, { type: 'assistant.delta', text: 'one' });
    const harness = open({ fake: redis, finished: true });
    const text = await readToEnd(harness.reader);
    expect(text).toContain('one');
    expect(text).not.toContain('event: turn.');
    expect(harness.redis.duplicates[0]?.closed).toBe(true);
  });

  /**
   * An entry that does not decode is reported as a protocol error and the stream carries on: the
   * entries are written by another process, and one bad one must not end a live transcript.
   */
  it('reports an unreadable entry and keeps streaming', async () => {
    const harness = open();
    await harness.redis.xadd(KEY, 'event', 'not json');
    const pending = readUntil(harness.reader, (read) => read.includes('after'));
    await append(harness.redis, { type: 'assistant.delta', text: 'after' });
    const text = await pending;
    expect(text).toContain('event: protocol.error');
    expect(text).toContain('after');
    harness.controller.abort();
  });

  /**
   * The client going away ends the stream and drops the duplicated connection; a blocked reader
   * left behind would hold a Redis connection for its full block duration on every closed tab.
   */
  it('closes and releases the connection when the request is aborted', async () => {
    const harness = open();
    harness.controller.abort();
    expect((await harness.reader.read()).done).toBe(true);
    expect(harness.redis.duplicates[0]?.closed).toBe(true);
    expect(harness.output()).toBe('');
  });

  /**
   * The client can give up while the handler is still resolving which stream to read. The abort
   * event has already fired by then, so the factory has to notice it rather than wait for one.
   */
  it('closes immediately when the request was already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const redis = new FakeRedis();
    const { logger } = captureLogger();
    const response = createSseResponse({
      redis,
      streamKey: KEY,
      isFinished: () => Promise.resolve(false),
      signal: controller.signal,
      heartbeatMs: TICK_MS,
      blockMs: TICK_MS,
      logger,
    });
    expect((await response.body!.getReader().read()).done).toBe(true);
    expect(redis.duplicates[0]?.closed).toBe(true);
  });

  /**
   * Cancelling the reader is the other way a consumer goes away, and it has to release the same
   * resources as an abort.
   */
  it('releases the connection when the reader cancels', async () => {
    const harness = open();
    await harness.reader.cancel();
    expect(harness.redis.duplicates[0]?.closed).toBe(true);
    // Releasing twice must not fail: an abort may still arrive after the consumer has gone.
    harness.controller.abort();
  });

  /**
   * A read that fails while the stream is still open is a real fault, so it is logged — by the
   * error's class name, never by its message — and the stream is closed rather than left hanging.
   */
  it('logs a failure that arrives while the stream is open', async () => {
    const broken: RedisCommands = {
      ping: () => Promise.resolve('PONG'),
      get: () => Promise.resolve(null),
      exists: () => Promise.resolve(1),
      publish: () => Promise.resolve(0),
      xrange: () => Promise.resolve([]),
      xread: (): Promise<StreamRead[] | null> => Promise.reject(new TypeError('unexpected reply')),
      duplicate: () => broken,
      disconnect: () => undefined,
    };
    const harness = open({ redis: broken });
    expect((await harness.reader.read()).done).toBe(true);
    expect(harness.output()).toContain('event stream failed');
    expect(harness.output()).toContain('TypeError');
  });

  /**
   * The same failure arriving after the client left is the ordinary end of the loop, not an
   * incident, so nothing is logged.
   */
  it('stays silent when the failure follows the abort', async () => {
    const harness = open();
    harness.controller.abort();
    expect((await harness.reader.read()).done).toBe(true);
    await vi.waitFor(() => {
      expect(harness.output()).toBe('');
    });
  });
});
