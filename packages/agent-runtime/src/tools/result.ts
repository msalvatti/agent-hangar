/**
 * Shape of a tool outcome and the helpers every tool shares.
 *
 * Layer: domain.
 *
 * A tool never throws: a failure is an ordinary result the model reads and reacts to, which keeps
 * one bad path or a missing file from ending the whole turn.
 */
import type { ToolResultStatus } from '@agent-hangar/core';

/** Outcome of one tool call. */
export interface ToolResult {
  /** Text fed back to the model; already truncated to the turn's budget. */
  output: string;
  /** Process exit code for `run_shell`; `null` when no process ran or it was killed. */
  exitCode: number | null;
  /** Size of the untruncated output, so the model and the UI can see what was cut. */
  bytes: number;
  /** Whether the call succeeded, failed, or hit its timeout. */
  status: ToolResultStatus;
}

/** Result of {@link truncateOutput}. */
export interface TruncatedOutput {
  /** The text to report, with a notice appended when it was cut. */
  text: string;
  /** Size of the input in bytes, whether or not it was cut. */
  bytes: number;
  /** Whether anything was removed. */
  truncated: boolean;
}

/** Replacement character a cut UTF-8 sequence decodes to. */
const REPLACEMENT_CHARACTER = '�';

/**
 * Builds a failed result out of an explanatory message.
 *
 * @param message - What went wrong, in terms the model can act on. Never contains a secret.
 * @returns A `FAILED` result carrying the message as its output.
 */
export function failure(message: string): ToolResult {
  return {
    output: message,
    exitCode: null,
    bytes: Buffer.byteLength(message),
    status: 'FAILED',
  };
}

/**
 * Renders a thrown value as a message a tool result can carry.
 *
 * `catch` binds `unknown`, and a rejected promise can carry anything at all; the tools have to
 * report something either way rather than letting the turn fall over.
 *
 * @param error - Whatever was thrown.
 * @returns The error's message, or the value rendered as text.
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Renders a thrown value for a diagnostic, keeping the stack when there is one.
 *
 * Diagnostics go to the worker's debug log, where a stack is the whole point; a bundled build can
 * still strip it, and a rejection can carry something that is not an error at all.
 *
 * @param error - Whatever was thrown.
 * @returns The stack, the message, or the value rendered as text.
 */
export function describeErrorWithStack(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : describeError(error);
}

/**
 * Caps output at the turn's byte budget, appending a notice when anything was removed.
 *
 * The cut is made on bytes rather than characters because the budget protects the model's context
 * window, which is charged by bytes; a partially copied multi-byte sequence is dropped so the
 * result is always valid UTF-8.
 *
 * @param text - Full output collected from the tool.
 * @param maxBytes - Budget from the turn's limits.
 * @returns The capped text, the original size and whether it was cut.
 */
export function truncateOutput(text: string, maxBytes: number): TruncatedOutput {
  const bytes = Buffer.byteLength(text);
  if (bytes <= maxBytes) {
    return { text, bytes, truncated: false };
  }
  const kept = Buffer.from(text).subarray(0, maxBytes).toString('utf8');
  const whole = kept.endsWith(REPLACEMENT_CHARACTER) ? kept.slice(0, -1) : kept;
  return { text: `${whole}\n[truncated: ${String(bytes)} bytes total]`, bytes, truncated: true };
}
