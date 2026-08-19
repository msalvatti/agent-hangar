/**
 * NDJSON codec shared by the worker (reader) and the agent runtime (writer).
 *
 * Layer: utility.
 *
 * The parser never throws on malformed input: a line that is not valid JSON or does not satisfy
 * the schema is mapped to a `protocol.error` event so the consumer can persist and display it
 * while the stream keeps flowing.
 */
import type { ZodType } from 'zod';

import type { ProtocolErrorEvent } from './types.js';

/** Maximum number of characters of a bad line kept in a `protocol.error` event. */
export const PROTOCOL_ERROR_LINE_LIMIT = 200;

/** Items produced by the parser: valid values, or a `protocol.error` for each invalid line. */
export type NdjsonItem<T> = T | ProtocolErrorEvent;

/** Incremental NDJSON parser. */
export interface NdjsonParser<T> {
  /**
   * Feeds a chunk and returns every complete line parsed so far.
   *
   * @param chunk - Raw bytes (decoded incrementally, multi-byte safe) or text.
   */
  push(chunk: Uint8Array | string): NdjsonItem<T>[];
  /** Parses a trailing partial line (no newline at end of stream) and resets the buffer. */
  flush(): NdjsonItem<T>[];
}

/**
 * Serialises one value as a single NDJSON line.
 *
 * @param value - Any JSON-serialisable value.
 * @returns The JSON text followed by `\n`.
 */
export function encodeLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function protocolError(line: string, reason: string): ProtocolErrorEvent {
  return { type: 'protocol.error', line: line.slice(0, PROTOCOL_ERROR_LINE_LIMIT), reason };
}

function parseLine<T>(schema: ZodType<T>, line: string): NdjsonItem<T> {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch (error) {
    return protocolError(line, `invalid JSON: ${String(error)}`);
  }
  const result = schema.safeParse(json);
  if (result.success) {
    return result.data;
  }
  const reasons = result.error.issues.map((issue) =>
    issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`,
  );
  return protocolError(line, `schema violation: ${reasons.join('; ')}`);
}

/**
 * Creates an incremental parser that buffers partial lines, splits on `\n` (tolerating `\r\n`),
 * validates each line with `schema` and maps invalid lines to `protocol.error` items.
 *
 * @param schema - Zod schema every line must satisfy.
 * @returns A stateful parser; create one per stream.
 */
export function createNdjsonParser<T>(schema: ZodType<T>): NdjsonParser<T> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const parseComplete = (): NdjsonItem<T>[] => {
    const items: NdjsonItem<T>[] = [];
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line.trim().length > 0) {
        items.push(parseLine(schema, line));
      }
      newline = buffer.indexOf('\n');
    }
    return items;
  };

  return {
    push(chunk) {
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      return parseComplete();
    },
    flush() {
      buffer += decoder.decode();
      const items = parseComplete();
      const rest = buffer.replace(/\r$/, '');
      buffer = '';
      if (rest.trim().length > 0) {
        items.push(parseLine(schema, rest));
      }
      return items;
    },
  };
}

/**
 * Parses an NDJSON byte stream into validated values.
 *
 * @param source - Byte chunks, e.g. the stdout events of a workspace exec.
 * @param schema - Zod schema every line must satisfy.
 * @returns Validated values and `protocol.error` items in stream order.
 */
export async function* parseNdjsonStream<T>(
  source: AsyncIterable<Uint8Array>,
  schema: ZodType<T>,
): AsyncIterable<NdjsonItem<T>> {
  const parser = createNdjsonParser(schema);
  for await (const chunk of source) {
    yield* parser.push(chunk);
  }
  yield* parser.flush();
}
