/**
 * NDJSON codec shared by the worker (reader) and the agent runtime (writer).
 *
 * Layer: utility.
 *
 * The parser never throws on malformed input: a line that is not valid JSON, does not satisfy the
 * schema, or grows past {@link PROTOCOL_MAX_LINE_LENGTH} is mapped to a `protocol.error` event so
 * the consumer can persist and display it while the stream keeps flowing.
 *
 * Security: every byte fed to this parser is produced by a process running inside an agent
 * workspace, whose environment holds the GitHub PAT and the OpenAI API key, and `protocol.error`
 * events are persisted and displayed. Nothing derived from those bytes may reach an event, so a
 * rejection reports only a fixed reason code and a character count. Three echoes are deliberately
 * avoided: the offending line itself, V8's `JSON.parse` message (which quotes a prefix of its
 * input) and Zod's issue messages and paths (which quote unrecognised object keys).
 *
 * The same untrusted producer is why the buffer is capped: an unterminated line would otherwise
 * grow until the worker heap is exhausted.
 */
import type { ZodType } from 'zod';

import type { ProtocolErrorEvent, ProtocolErrorReason } from './types.js';

/**
 * Maximum number of characters buffered for a single line before the parser abandons it.
 *
 * Sized far above any legitimate event and far below anything that threatens the worker: the
 * largest event the runtime emits is a `tool.output.delta`, bounded by the turn's
 * `maxToolOutputBytes` limit (32 KB by default), so 1 MiB leaves three orders of magnitude of
 * headroom while capping what a runaway or hostile producer can pin in memory.
 */
export const PROTOCOL_MAX_LINE_LENGTH = 1_048_576;

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
  /**
   * Characters currently held for the line in progress.
   *
   * Never exceeds {@link PROTOCOL_MAX_LINE_LENGTH} plus the size of the chunk that crossed it,
   * which is what makes the parser's memory use bounded regardless of what the producer sends.
   */
  bufferedLength(): number;
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

/**
 * Builds a rejection event out of machine-generated facts only.
 *
 * @param reason - Which rejection occurred.
 * @param length - Characters of the offending line.
 * @returns The event; carries nothing derived from the rejected bytes.
 */
function protocolError(reason: ProtocolErrorReason, length: number): ProtocolErrorEvent {
  return { type: 'protocol.error', reason, length };
}

function parseLine<T>(schema: ZodType<T>, line: string): NdjsonItem<T> {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    // The thrown SyntaxError quotes a prefix of `line`; it must not escape this block.
    return protocolError('invalid-json', line.length);
  }
  const result = schema.safeParse(json);
  if (result.success) {
    return result.data;
  }
  // Zod issue messages and paths quote unrecognised keys, so only the count survives.
  return protocolError('schema-violation', line.length);
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
  // Set once a line passes the length cap: its remaining characters are dropped, unreported, until
  // the next newline lets the parser resynchronise on a fresh line.
  let discarding = false;

  const parseComplete = (): NdjsonItem<T>[] => {
    const items: NdjsonItem<T>[] = [];
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const raw = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (discarding) {
        discarding = false;
      } else {
        const line = raw.replace(/\r$/, '');
        if (line.trim().length > 0) {
          items.push(parseLine(schema, line));
        }
      }
      newline = buffer.indexOf('\n');
    }
    if (discarding) {
      // Tail of a condemned line: holding it would be the unbounded growth the cap exists to stop.
      buffer = '';
    } else if (buffer.length > PROTOCOL_MAX_LINE_LENGTH) {
      items.push(protocolError('line-too-long', buffer.length));
      discarding = true;
      buffer = '';
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
      // `parseComplete` empties the buffer while discarding, so a condemned tail never lands here.
      const rest = buffer.replace(/\r$/, '');
      buffer = '';
      discarding = false;
      if (rest.trim().length > 0) {
        items.push(parseLine(schema, rest));
      }
      return items;
    },
    bufferedLength() {
      return buffer.length;
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
