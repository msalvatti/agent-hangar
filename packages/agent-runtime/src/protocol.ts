/**
 * NDJSON adapters over the shared protocol codec: stdin request, stdout events, stderr diagnostics.
 *
 * Layer: adapter.
 *
 * The worker writes one `TurnRequest` to the runtime's stdin and reads `AgentEvent`s from its
 * stdout, one JSON object per line. Everything leaving this process passes through the runtime
 * redactor first, so a credential can never reach the pipe even when the agent itself printed it.
 */
import {
  encodeLine,
  parseNdjsonStream,
  ProtocolError,
  turnRequestSchema,
} from '@agent-hangar/core';
import type { AgentEvent, TurnRequest } from '@agent-hangar/core';

import type { RuntimeRedactor } from './redact.js';

/**
 * Writes redacted events to stdout, one line each, honouring backpressure.
 *
 * Both members are declared as function-valued properties rather than methods: callers pass them
 * straight into the loop and into preparation, and a closure carries no `this` to lose.
 */
export interface EventWriter {
  /** Serialises and writes one event; resolves once the line has been accepted by the stream. */
  emit: (event: AgentEvent) => Promise<void>;
  /** Timestamp of the last completed write, used to decide when a heartbeat is due. */
  lastEmittedAt: () => number;
}

/**
 * Reads the single `TurnRequest` the worker writes to stdin.
 *
 * @param stdin - Byte chunks of the runtime's standard input.
 * @returns The validated request.
 * @throws ProtocolError when the first line is not a valid request, or when the stream ends
 *   without one. The message names the parser's reason code and the line length only: the
 *   rejected bytes are attacker-influenced and must not be echoed.
 */
export async function readTurnRequest(stdin: AsyncIterable<Uint8Array>): Promise<TurnRequest> {
  for await (const item of parseNdjsonStream(stdin, turnRequestSchema)) {
    if ('type' in item) {
      throw new ProtocolError(
        `invalid TurnRequest on stdin: ${item.reason} (line of ${String(item.length)} characters)`,
      );
    }
    return item;
  }
  throw new ProtocolError('no TurnRequest received on stdin');
}

/**
 * Creates the stdout event writer.
 *
 * Writes are serialised through a promise chain so two concurrent `emit` calls can never
 * interleave halves of two JSON lines, which would corrupt the stream for the worker's parser.
 * Each line is awaited through the stream's own write callback, which both applies backpressure —
 * the next event is only offered once the previous one has been flushed — and surfaces a write
 * failure to the caller instead of leaving it as an unobserved `error` event.
 *
 * @param stdout - Stream the events are written to.
 * @param redactor - Applied to every event before it is serialised.
 * @param now - Clock used for {@link EventWriter.lastEmittedAt}; injectable for tests.
 * @returns The writer.
 */
export function createEventWriter(
  stdout: NodeJS.WritableStream,
  redactor: RuntimeRedactor,
  now: () => number = Date.now,
): EventWriter {
  let queue: Promise<void> = Promise.resolve();
  let lastAt = now();

  // A `Writable` reports a failed write twice: through the callback below, and as an `error`
  // event. With no listener for the event, Node turns it into an uncaught exception and the
  // runtime dies without the exit code the worker reads — so a broken pipe on stdout would look
  // like a crashed container rather than a finished turn. The callback stays the channel the
  // caller acts on; this listener exists so the second report is observed rather than fatal.
  stdout.on('error', () => undefined);

  const writeLine = (event: AgentEvent): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      stdout.write(encodeLine(redactor.redactEvent(event)), (error) => {
        if (error === undefined || error === null) {
          lastAt = now();
          resolve();
          return;
        }
        reject(error);
      });
    });

  return {
    emit(event) {
      const written = queue.then(() => writeLine(event));
      // The chain must survive a failed write: keeping the rejection in `queue` would make every
      // later event reject without ever being attempted.
      queue = written.catch(() => undefined);
      return written;
    },
    lastEmittedAt: () => lastAt,
  };
}

/**
 * Creates the stderr diagnostics sink.
 *
 * Diagnostics are best effort: they are forwarded to the worker's debug log and must never take
 * a turn down, so a broken stderr is swallowed.
 *
 * @param stderr - Stream the diagnostics are written to.
 * @param redactor - Applied to every message.
 * @returns A function that writes one redacted line.
 */
export function createDiagnostics(
  stderr: NodeJS.WritableStream,
  redactor: RuntimeRedactor,
): (message: string) => void {
  return (message) => {
    try {
      stderr.write(`${redactor.redactText(message)}\n`);
    } catch {
      // Nothing useful remains to report once the diagnostic channel itself is gone.
    }
  };
}
