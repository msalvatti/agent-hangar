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

import type { ProtocolErrorEvent, ProtocolErrorReason } from './types.ts';

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
   * Never exceeds {@link PROTOCOL_MAX_LINE_LENGTH} once a call has returned, which is what makes
   * the parser's memory use bounded regardless of what the producer sends.
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
 * Decides what one raw line (newline already stripped) contributes to the output.
 *
 * @param schema - Zod schema the line must satisfy.
 * @param raw - The line, possibly still carrying a trailing `\r`.
 * @returns The parsed value, a `protocol.error`, or `undefined` for a blank line to skip.
 *   `undefined` is unambiguous as a skip signal because `JSON.parse` never yields it.
 */
function classifyLine<T>(schema: ZodType<T>, raw: string): NdjsonItem<T> | undefined {
  if (raw.length > PROTOCOL_MAX_LINE_LENGTH) {
    // The cap binds complete lines as well: a producer that writes an over-long line and its
    // newline in a single chunk would otherwise have it parsed in full, straight past the limit
    // that exists to bound this work.
    return protocolError('line-too-long', raw.length);
  }
  const line = raw.replace(/\r$/, '');
  return line.trim().length > 0 ? parseLine(schema, line) : undefined;
}

/** Mutable state of one parser instance. */
interface ParserState {
  /** Characters received since the last newline. */
  buffer: string;
  /**
   * Set once a line passed the cap: its remaining characters are dropped, unreported, until the
   * next newline lets the parser resynchronise on a fresh line.
   */
  discarding: boolean;
}

/**
 * Drains every complete line from the buffer, then enforces the cap on whatever is left over.
 *
 * @param schema - Zod schema every line must satisfy.
 * @param state - Parser state; mutated in place.
 * @returns Items for the lines that completed during this call.
 */
function drainLines<T>(schema: ZodType<T>, state: ParserState): NdjsonItem<T>[] {
  const items: NdjsonItem<T>[] = [];
  let newline = state.buffer.indexOf('\n');
  while (newline !== -1) {
    const raw = state.buffer.slice(0, newline);
    state.buffer = state.buffer.slice(newline + 1);
    if (state.discarding) {
      state.discarding = false;
    } else {
      const item = classifyLine(schema, raw);
      if (item !== undefined) {
        items.push(item);
      }
    }
    newline = state.buffer.indexOf('\n');
  }
  if (state.discarding) {
    // Tail of a condemned line: holding it would be the unbounded growth the cap exists to stop.
    state.buffer = '';
  } else if (state.buffer.length > PROTOCOL_MAX_LINE_LENGTH) {
    items.push(protocolError('line-too-long', state.buffer.length));
    state.discarding = true;
    state.buffer = '';
  }
  return items;
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
  const state: ParserState = { buffer: '', discarding: false };

  return {
    push(chunk) {
      state.buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      return drainLines(schema, state);
    },
    flush() {
      state.buffer += decoder.decode();
      const items = drainLines(schema, state);
      // `drainLines` empties the buffer while discarding, so a condemned tail never lands here.
      const rest = state.buffer;
      state.buffer = '';
      state.discarding = false;
      const item = classifyLine(schema, rest);
      if (item !== undefined) {
        items.push(item);
      }
      return items;
    },
    bufferedLength() {
      return state.buffer.length;
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
