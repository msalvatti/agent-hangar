/**
 * Unit tests for the NDJSON codec.
 *
 * Layer: unit.
 * Goal: the parser handles partial chunks, multiple lines per chunk, CRLF, multi-byte splits,
 * large lines, invalid JSON and schema violations without throwing; a rejection never echoes the
 * offending bytes (a workspace process could put a credential there) and an unterminated line is
 * capped instead of exhausting the heap; `encodeLine` produces one line per value; the stream
 * helper composes both.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ZodType } from 'zod';

import { CANARY_MARKER, GITHUB_CANARY, OPENAI_CANARY } from '../testing/canaries.js';

import {
  createNdjsonParser,
  encodeLine,
  parseNdjsonStream,
  PROTOCOL_MAX_LINE_LENGTH,
} from './ndjson.js';
import { agentEventSchema } from './schemas.js';

const encoder = new TextEncoder();

const pointSchema = z.object({ x: z.number(), y: z.number() });

async function* chunks(...parts: string[]): AsyncIterable<Uint8Array> {
  for (const part of parts) {
    yield await Promise.resolve(encoder.encode(part));
  }
}

/**
 * Asserts a schema-violating line yields nothing but the reason and the length.
 *
 * Generic so each call keeps its own schema type: a shared table would union them and `tsc`
 * could no longer match the schema to `createNdjsonParser`.
 *
 * @param schema - Schema the payload must fail.
 * @param payload - One line, carrying a canary where a leak would show.
 */
function expectSchemaViolationHidesCanary<T>(schema: ZodType<T>, payload: string): void {
  const parser = createNdjsonParser(schema);
  const items = parser.push(`${payload}\n`);
  expect(items).toEqual([
    { type: 'protocol.error', reason: 'schema-violation', length: payload.length },
  ]);
  expect(JSON.stringify(items)).not.toContain(CANARY_MARKER);
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
   * Invalid JSON: the line becomes a `protocol.error` item naming the reason and the line's
   * length and nothing else; the parser keeps going with the next line.
   */
  it('maps invalid JSON to protocol.error without throwing', () => {
    const parser = createNdjsonParser(pointSchema);
    const items = parser.push('{oops\n{"x":1,"y":2}\n');
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ type: 'protocol.error', reason: 'invalid-json', length: 5 });
    expect(items[1]).toEqual({ x: 1, y: 2 });
  });

  /**
   * Schema violation: valid JSON that does not satisfy the schema is also a `protocol.error`,
   * distinguished from a JSON failure by its reason so a consumer can branch on it.
   */
  it('maps schema violations to protocol.error with their own reason', () => {
    const parser = createNdjsonParser(pointSchema);
    const line = '{"x":"1","y":2}';
    expect(parser.push(`${line}\n`)).toEqual([
      { type: 'protocol.error', reason: 'schema-violation', length: line.length },
    ]);
  });

  /**
   * Schema violation at the root (a non-object) is reported the same way, so the reason
   * vocabulary stays closed whatever shape the bad line has.
   */
  it('reports root-level schema violations with the same reason', () => {
    const parser = createNdjsonParser(pointSchema);
    expect(parser.push('42\n')).toEqual([
      { type: 'protocol.error', reason: 'schema-violation', length: 2 },
    ]);
  });

  /**
   * Large line: a line far bigger than any chunk but still under the cap is reassembled and
   * parsed, and when such a line is malformed the event reports its length rather than its bytes.
   */
  it('reassembles large lines and reports only their length on error', () => {
    const parser = createNdjsonParser(z.object({ s: z.string() }));
    const big = 'a'.repeat(100_000);
    const line = `{"s":"${big}"}\n`;
    const half = Math.floor(line.length / 2);
    expect(parser.push(line.slice(0, half))).toEqual([]);
    expect(parser.push(line.slice(half))).toEqual([{ s: big }]);

    const bad = `{"s":${big}}`;
    expect(parser.push(`${bad}\n`)).toEqual([
      { type: 'protocol.error', reason: 'invalid-json', length: bad.length },
    ]);
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

describe('createNdjsonParser credential safety', () => {
  /**
   * A malformed line is written by a process inside the agent workspace, whose environment holds
   * the GitHub PAT and the OpenAI API key, and the resulting event is persisted and displayed.
   * A canary planted in such a line must not survive anywhere in the event — not as the raw line
   * and not inside a reason, because V8's `JSON.parse` message quotes a prefix of its input.
   */
  it.each([
    ['bare token', GITHUB_CANARY],
    ['token inside a broken object', `{"token": ${OPENAI_CANARY}}`],
    ['unterminated string', `{"a":"${GITHUB_CANARY}`],
    ['trailing garbage after valid JSON', `{"x":1,"y":2} ${OPENAI_CANARY}`],
  ])('never echoes a credential from an unparsable line (%s)', (_label, payload) => {
    const parser = createNdjsonParser(pointSchema);
    const items = parser.push(`${payload}\n`);
    expect(items).toEqual([
      { type: 'protocol.error', reason: 'invalid-json', length: payload.length },
    ]);
    expect(JSON.stringify(items)).not.toContain(CANARY_MARKER);
  });

  /**
   * Zod puts an unrecognised key straight into its issue message, so a strict schema is the
   * shortest path from a workspace-chosen key to a persisted event.
   */
  it('never echoes a credential from an unrecognised key', () => {
    expectSchemaViolationHidesCanary(
      z.strictObject({ a: z.string() }),
      `{"a":"ok","${GITHUB_CANARY}":1}`,
    );
  });

  /**
   * The other Zod channel: an attacker-chosen object key becomes a segment of the issue *path*,
   * which the old reason string joined and emitted.
   */
  it('never echoes a credential from a key in the issue path', () => {
    expectSchemaViolationHidesCanary(
      z.object({}).catchall(z.number()),
      `{"${OPENAI_CANARY}":"no"}`,
    );
  });

  /**
   * The cap is the third path that builds an event out of rejected bytes; a canary hidden in an
   * over-long line must not reach the event either.
   */
  it('never echoes a credential from an over-long line', () => {
    const parser = createNdjsonParser(pointSchema);
    const items = parser.push(GITHUB_CANARY + 'a'.repeat(PROTOCOL_MAX_LINE_LENGTH));
    expect(items).toEqual([
      {
        type: 'protocol.error',
        reason: 'line-too-long',
        length: GITHUB_CANARY.length + PROTOCOL_MAX_LINE_LENGTH,
      },
    ]);
    expect(JSON.stringify(items)).not.toContain(CANARY_MARKER);
  });

  /**
   * Whatever the parser emits must still validate as an agent event, so a `protocol.error` can be
   * published and persisted through the same path as every other event.
   */
  it('emits protocol.error items that satisfy the event schema', () => {
    const parser = createNdjsonParser(agentEventSchema);
    const [item] = parser.push(`${GITHUB_CANARY}\n`);
    expect(agentEventSchema.safeParse(item).success).toBe(true);
  });
});

describe('createNdjsonParser line cap', () => {
  /**
   * The producer runs inside the workspace, so an unterminated line is attacker controlled:
   * without a cap the buffer grows until the heap is exhausted. Crossing the cap reports exactly
   * one error, further chunks of the same line report nothing, buffered memory stays flat, and
   * the next well-formed line after the newline still parses — the parser resynchronises rather
   * than dying or corrupting the stream.
   */
  it('reports one error, stops growing, and resynchronises on the next line', () => {
    const parser = createNdjsonParser(pointSchema);
    const chunk = 'a'.repeat(PROTOCOL_MAX_LINE_LENGTH + 1);

    expect(parser.push(chunk)).toEqual([
      { type: 'protocol.error', reason: 'line-too-long', length: chunk.length },
    ]);
    expect(parser.bufferedLength()).toBe(0);

    for (let i = 0; i < 5; i += 1) {
      expect(parser.push(chunk)).toEqual([]);
      expect(parser.bufferedLength()).toBe(0);
    }

    expect(parser.push('still the same line\n{"x":1,"y":2}\n')).toEqual([{ x: 1, y: 2 }]);
    expect(parser.bufferedLength()).toBe(0);
  });

  /**
   * A line exactly at the cap is legitimate and must still parse: the limit rejects what exceeds
   * it, never what merely reaches it.
   */
  it('accepts a line exactly at the cap', () => {
    const parser = createNdjsonParser(z.object({ s: z.string() }));
    const padding = 'a'.repeat(PROTOCOL_MAX_LINE_LENGTH - '{"s":""}'.length);
    const line = `{"s":"${padding}"}`;
    expect(line).toHaveLength(PROTOCOL_MAX_LINE_LENGTH);
    expect(parser.push(`${line}\n`)).toEqual([{ s: padding }]);
  });

  /**
   * `bufferedLength` tracks the line in progress so a caller can prove the parser's memory use is
   * bounded, and `flush` clears a condemned line instead of emitting it as a trailing item.
   */
  it('tracks buffered characters and drops a condemned line on flush', () => {
    const parser = createNdjsonParser(pointSchema);
    expect(parser.push('{"x":1,')).toEqual([]);
    expect(parser.bufferedLength()).toBe(7);

    expect(parser.push('a'.repeat(PROTOCOL_MAX_LINE_LENGTH))).toHaveLength(1);
    expect(parser.flush()).toEqual([]);
    expect(parser.bufferedLength()).toBe(0);

    expect(parser.push('{"x":9,"y":8}\n')).toEqual([{ x: 9, y: 8 }]);
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
