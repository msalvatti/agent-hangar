/**
 * Unit tests for the NDJSON protocol adapters.
 *
 * Layer: unit.
 * Goal: the request reader accepts a request split across chunks, turns a malformed first line
 * into a `ProtocolError` that names only the reason and the length, and reports an empty stdin;
 * the event writer emits exactly one redacted line per event, paces itself against a slow stream,
 * keeps concurrent emits in order and reports a write failure without poisoning the queue;
 * diagnostics are redacted, newline-terminated and never throw.
 * Mocks: in-memory `Writable` streams and async generators stand in for the process pipes.
 */
import { Writable } from 'node:stream';

import { ProtocolError } from '@agent-hangar/core';
import type { AgentEvent, TurnRequest } from '@agent-hangar/core';
import { assertNoCanary, GITHUB_CANARY } from '@agent-hangar/core/testing';
import { describe, expect, it } from 'vitest';

import { createDiagnostics, createEventWriter, readTurnRequest } from './protocol.js';
import { createRuntimeRedactor, REDACTED } from './redact.js';

const encoder = new TextEncoder();

/** A minimal valid request, used as the payload of the reader tests. */
const request: TurnRequest = {
  protocolVersion: 1,
  turnId: 'turn-1',
  model: 'fake-model',
  instructions: 'be useful',
  items: [{ role: 'user', content: 'hello' }],
  repo: { url: 'https://github.com/acme/widgets', baseBranch: 'main', workBranch: 'agent/x' },
  limits: { maxSteps: 40, maxTurnMs: 1_200_000, toolTimeoutMs: 300_000, maxToolOutputBytes: 32768 },
  prepare: { clone: true },
};

/**
 * Yields the given texts as byte chunks.
 *
 * @param parts - Text pieces, possibly splitting a line.
 * @returns An async iterable of encoded chunks.
 */
async function* chunks(...parts: string[]): AsyncIterable<Uint8Array> {
  for (const part of parts) {
    yield await Promise.resolve(encoder.encode(part));
  }
}

/**
 * A writable stream that records what it received.
 *
 * @param options - `slow` defers each write callback and shrinks the buffer so the stream applies
 *   real backpressure; the default accepts writes immediately.
 * @returns The stream and an accessor for everything written so far.
 */
function recordingStream(options: { slow?: boolean } = {}): {
  stream: Writable;
  chunks: string[];
  text: () => string;
} {
  const chunks: string[] = [];
  const stream = new Writable({
    highWaterMark: options.slow === true ? 1 : 64 * 1024,
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      if (options.slow === true) {
        setImmediate(callback);
        return;
      }
      callback();
    },
  });
  return { stream, chunks, text: () => chunks.join('') };
}

describe('readTurnRequest', () => {
  it('parses a request delivered in a single chunk', async () => {
    // The common case: the worker writes the whole request and closes stdin.
    await expect(readTurnRequest(chunks(`${JSON.stringify(request)}\n`))).resolves.toStrictEqual(
      request,
    );
  });

  it('parses a request split across chunks', async () => {
    // Pipes split writes arbitrarily; the codec buffers partial lines.
    const line = `${JSON.stringify(request)}\n`;
    const middle = Math.floor(line.length / 2);
    await expect(
      readTurnRequest(chunks(line.slice(0, middle), line.slice(middle))),
    ).resolves.toStrictEqual(request);
  });

  it('rejects a first line that is not valid JSON, naming only the reason and the length', async () => {
    // The rejected bytes come from the host pipe and must never be echoed back.
    const promise = readTurnRequest(chunks('not json\n'));
    await expect(promise).rejects.toBeInstanceOf(ProtocolError);
    await expect(promise).rejects.toThrow('invalid-json (line of 8 characters)');
  });

  it('rejects a first line that is valid JSON but violates the schema', async () => {
    // A wrong protocol version or a missing field is a schema violation, not a JSON error.
    await expect(readTurnRequest(chunks('{"protocolVersion":2}\n'))).rejects.toThrow(
      'schema-violation',
    );
  });

  it('rejects an empty stdin', async () => {
    // Without a turn id no event can be emitted, so the runtime can only exit with a diagnostic.
    await expect(readTurnRequest(chunks())).rejects.toThrow('no TurnRequest received on stdin');
  });
});

describe('createEventWriter', () => {
  it('writes one redacted JSON line per event', async () => {
    // The worker parses stdout as NDJSON: exactly one object per line, terminated by \n.
    const { stream, text } = recordingStream();
    const writer = createEventWriter(stream, createRuntimeRedactor({ values: [GITHUB_CANARY] }));
    await writer.emit({ type: 'assistant.delta', text: `token ${GITHUB_CANARY}` });
    await writer.emit({ type: 'turn.cancelled' });
    const lines = text().trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '') as unknown).toStrictEqual({
      type: 'assistant.delta',
      text: `token ${REDACTED}`,
    });
    assertNoCanary(text());
  });

  it('paces writes so a slow stream is never offered the next line early', async () => {
    // A full pipe must not be overrun; the next event waits for the previous one to flush.
    const { stream, chunks } = recordingStream({ slow: true });
    const writer = createEventWriter(stream, createRuntimeRedactor());
    const first = writer.emit({ type: 'step.started', step: 1 });
    const second = writer.emit({ type: 'step.started', step: 2 });
    // One microtask is enough for the first queued write to reach the stream; the second stays
    // behind it until the stream calls back.
    await Promise.resolve();
    expect(chunks).toHaveLength(1);
    await Promise.all([first, second]);
    expect(chunks).toHaveLength(2);
  });

  it('keeps concurrent emits in order and never interleaves two lines', async () => {
    // Tool output and model deltas are emitted from different call sites at the same time.
    const { stream, chunks } = recordingStream({ slow: true });
    const writer = createEventWriter(stream, createRuntimeRedactor());
    await Promise.all(
      [1, 2, 3, 4].map(async (step) => writer.emit({ type: 'step.started', step })),
    );
    expect(chunks.map((line) => JSON.parse(line) as unknown)).toStrictEqual([
      { type: 'step.started', step: 1 },
      { type: 'step.started', step: 2 },
      { type: 'step.started', step: 3 },
      { type: 'step.started', step: 4 },
    ]);
  });

  it('reports a write failure to its own caller and does not replay it on the next emit', async () => {
    // A poisoned promise chain would make every later event reject with the first failure and
    // never be attempted, hiding the real state of the pipe from the loop. No `error` listener is
    // added here on purpose: the writer installs its own, and without it the stream's own report
    // of the same failure would reach the process as an uncaught exception.
    const stream = new Writable({
      write(_chunk: Buffer, _encoding, callback) {
        callback(new Error('pipe closed'));
      },
    });
    const writer = createEventWriter(stream, createRuntimeRedactor());
    await expect(writer.emit({ type: 'step.started', step: 1 })).rejects.toThrow('pipe closed');
    await expect(writer.emit({ type: 'step.started', step: 2 })).rejects.toThrow(
      'Cannot call write after a stream was destroyed',
    );
  });

  it('reports the timestamp of the last completed write', async () => {
    // The loop uses this to decide when a heartbeat is due.
    const { stream } = recordingStream({});
    const clock = [100, 200];
    let index = 0;
    const writer = createEventWriter(stream, createRuntimeRedactor(), () => clock[index++] ?? 999);
    expect(writer.lastEmittedAt()).toBe(100);
    await writer.emit({ type: 'turn.cancelled' } satisfies AgentEvent);
    expect(writer.lastEmittedAt()).toBe(200);
  });
});

describe('createDiagnostics', () => {
  it('writes one redacted line per message', () => {
    // Diagnostics reach the worker's debug log, so they need the same redaction as events.
    const { stream, text } = recordingStream();
    const diag = createDiagnostics(stream, createRuntimeRedactor({ values: [GITHUB_CANARY] }));
    diag(`clone failed for ${GITHUB_CANARY}`);
    expect(text()).toBe(`clone failed for ${REDACTED}\n`);
  });

  it('swallows a write failure', () => {
    // Losing stderr must never take down a turn that is otherwise fine.
    const stream = new Writable({
      write() {
        throw new Error('stderr gone');
      },
    });
    const diag = createDiagnostics(stream, createRuntimeRedactor());
    expect(() => {
      diag('anything');
    }).not.toThrow();
  });
});
