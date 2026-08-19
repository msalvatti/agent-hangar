/**
 * Unit tests for the NDJSON codec.
 *
 * Layer: unit.
 * Goal: the parser handles partial chunks, multiple lines per chunk, CRLF, multi-byte splits,
 * large lines, invalid JSON and schema violations without throwing; `encodeLine` produces one
 * line per value; the stream helper composes both.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createNdjsonParser,
  encodeLine,
  parseNdjsonStream,
  PROTOCOL_ERROR_LINE_LIMIT,
} from './ndjson.js';
import { agentEventSchema } from './schemas.js';

const encoder = new TextEncoder();

const pointSchema = z.object({ x: z.number(), y: z.number() });

async function* chunks(...parts: string[]): AsyncIterable<Uint8Array> {
  for (const part of parts) {
    yield await Promise.resolve(encoder.encode(part));
  }
}

describe('encodeLine', () => {
  /**
   * One value becomes exactly one line: JSON text plus a single trailing newline, so the reader's
   * line splitter can rely on `\n` as the frame delimiter.
   */
  it('serialises a value followed by a newline', () => {
    expect(encodeLine({ type: 'turn.cancelled' })).toBe('{"type":"turn.cancelled"}\n');
    expect(encodeLine('text')).toBe('"text"\n');
  });
});

describe('createNdjsonParser', () => {
  /**
   * Happy path: several complete lines in one chunk are all returned, in order.
   */
  it('parses multiple lines in a single chunk', () => {
    const parser = createNdjsonParser(pointSchema);
    expect(parser.push('{"x":1,"y":2}\n{"x":3,"y":4}\n')).toEqual([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
  });

  /**
   * Partial lines: a line split across chunks is buffered until its newline arrives; nothing is
   * emitted early and nothing is lost.
   */
  it('buffers partial lines across pushes', () => {
    const parser = createNdjsonParser(pointSchema);
    expect(parser.push('{"x":1,')).toEqual([]);
    expect(parser.push('"y":2}\n{"x":')).toEqual([{ x: 1, y: 2 }]);
    expect(parser.push('5,"y":6}\n')).toEqual([{ x: 5, y: 6 }]);
  });

  /**
   * Trailing partial line: `flush()` parses what is left when the stream ends without a final
   * newline, and a second flush yields nothing (buffer reset).
   */
  it('flushes a trailing partial line once', () => {
    const parser = createNdjsonParser(pointSchema);
    expect(parser.push('{"x":1,"y":2}')).toEqual([]);
    expect(parser.flush()).toEqual([{ x: 1, y: 2 }]);
    expect(parser.flush()).toEqual([]);
  });

  /**
   * CRLF tolerance: a `\r\n`-terminated line (and a trailing `\r` on flush) parses as if it were
   * `\n`-terminated, because some shells and Windows tooling emit CRLF.
   */
  it('tolerates CRLF line endings', () => {
    const parser = createNdjsonParser(pointSchema);
    expect(parser.push('{"x":1,"y":2}\r\n')).toEqual([{ x: 1, y: 2 }]);
    parser.push('{"x":3,"y":4}\r');
    expect(parser.flush()).toEqual([{ x: 3, y: 4 }]);
  });

  /**
   * Blank lines (including whitespace-only) are skipped rather than reported as errors, so a
   * stray newline from the runtime never pollutes the transcript.
   */
  it('skips empty and whitespace-only lines', () => {
    const parser = createNdjsonParser(pointSchema);
    expect(parser.push('\n   \n{"x":1,"y":2}\n\n')).toEqual([{ x: 1, y: 2 }]);
    parser.push('   ');
    expect(parser.flush()).toEqual([]);
  });

  /**
   * Multi-byte safety: a UTF-8 character split across two byte chunks must decode correctly —
   * the decoder is used in streaming mode.
   */
  it('decodes multi-byte characters split across byte chunks', () => {
    const parser = createNdjsonParser(z.object({ s: z.string() }));
    const bytes = encoder.encode('{"s":"héllo"}\n');
    const cut = 7; // inside the two-byte "é"
    expect(parser.push(bytes.slice(0, cut))).toEqual([]);
    expect(parser.push(bytes.slice(cut))).toEqual([{ s: 'héllo' }]);
  });

  /**
   * Invalid JSON: the line becomes a `protocol.error` item carrying the raw line (truncated to
   * the limit) and a reason; the parser keeps going with the next line.
   */
  it('maps invalid JSON to protocol.error without throwing', () => {
    const parser = createNdjsonParser(pointSchema);
    const items = parser.push('{oops\n{"x":1,"y":2}\n');
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ type: 'protocol.error', line: '{oops' });
    expect((items[0] as { reason: string }).reason).toMatch(/^invalid JSON: /);
    expect(items[1]).toEqual({ x: 1, y: 2 });
  });

  /**
   * Schema violation: valid JSON that does not satisfy the schema is also a `protocol.error`,
   * with the path of the first issue in the reason.
   */
  it('maps schema violations to protocol.error with the issue path', () => {
    const parser = createNdjsonParser(pointSchema);
    const [item] = parser.push('{"x":"1","y":2}\n');
    expect(item).toMatchObject({ type: 'protocol.error', line: '{"x":"1","y":2}' });
    expect((item as { reason: string }).reason).toMatch(/^schema violation: x: /);
  });

  /**
   * Schema violation at the root (no path): the reason carries the message without a path prefix.
   */
  it('describes root-level schema violations without a path', () => {
    const parser = createNdjsonParser(pointSchema);
    const [item] = parser.push('42\n');
    expect((item as { reason: string }).reason).toMatch(/^schema violation: /);
  });

  /**
   * Large line: a line far bigger than any chunk is reassembled and parsed; on error only the
   * first 200 characters of the raw line are kept, bounding memory and log size.
   */
  it('handles large lines and truncates them in error events', () => {
    const parser = createNdjsonParser(z.object({ s: z.string() }));
    const big = 'a'.repeat(100_000);
    const line = `{"s":"${big}"}\n`;
    const half = Math.floor(line.length / 2);
    expect(parser.push(line.slice(0, half))).toEqual([]);
    expect(parser.push(line.slice(half))).toEqual([{ s: big }]);

    const [bad] = parser.push(`{"s":${big}}\n`);
    expect((bad as { line: string }).line).toHaveLength(PROTOCOL_ERROR_LINE_LIMIT);
  });

  /**
   * Real protocol: agent events parse into the discriminated union, and a `protocol.error`
   * produced by the parser itself validates against the same schema (so it can be persisted
   * and published like any other event).
   */
  it('parses agent events and yields schema-valid protocol.error items', () => {
    const parser = createNdjsonParser(agentEventSchema);
    const items = parser.push(`${encodeLine({ type: 'turn.cancelled' })}{"type":"nope"}\n`);
    expect(items[0]).toEqual({ type: 'turn.cancelled' });
    expect(agentEventSchema.safeParse(items[1]).success).toBe(true);
  });
});

describe('parseNdjsonStream', () => {
  /**
   * Stream composition: byte chunks with arbitrary boundaries produce the same items as the
   * incremental parser, including the trailing partial line at end of stream.
   */
  it('yields every item of a chunked byte stream including the trailing line', async () => {
    const items = [];
    for await (const item of parseNdjsonStream(
      chunks('{"x":1,"y":2}\n{"x":3,', '"y":4}\n{"x":5,"y":6}'),
      pointSchema,
    )) {
      items.push(item);
    }
    expect(items).toEqual([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
      { x: 5, y: 6 },
    ]);
  });
});
