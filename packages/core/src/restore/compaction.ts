/**
 * One-line summaries of tool calls.
 *
 * Layer: domain (pure).
 *
 * At the end of a turn each tool call is compacted into a `TOOL_SUMMARY` message, so a later turn
 * knows what the agent already did without replaying megabytes of command output. These lines are
 * model input and are shown in the transcript.
 *
 * Security: the command and path text originates inside an agent workspace whose environment
 * holds the GitHub PAT and the OpenAI key. It reaches this module only after the repository layer
 * redacted it on write, and this module neither re-reads the environment nor copies the text into
 * an error message — a failure here reports the shape of the input, never its content.
 */
import type { ToolName } from '../agent-protocol/types.js';
import { assertNever } from '../workspace/lifecycle.js';
import type { ToolCallStatus } from '../workspace/types.js';

/** Longest command text a summary keeps before eliding the rest. */
export const MAX_SUMMARY_COMMAND_CHARS = 80;

/** Placeholder for an argument the log did not record or recorded in an unexpected shape. */
export const UNKNOWN_ARGUMENT = '?';

/** Milliseconds in a second. */
const SECOND_MS = 1000;

/** Seconds in a minute. */
const SECONDS_PER_MINUTE = 60;

/** What the summariser needs from one `ToolCallLog` row. */
export interface ToolCallSummaryInput {
  toolName: ToolName;
  /** Arguments as logged; treated as untrusted and read defensively. */
  args: unknown;
  exitCode: number | null;
  status: ToolCallStatus;
  durationMs: number | null;
  /** Bytes the tool reported writing, used when the arguments did not carry the content. */
  resultBytes?: number | null;
}

/**
 * Renders a duration for a human reader.
 *
 * @param ms - Duration in milliseconds, or `null` when it was not recorded.
 * @returns `n/a`, `<n> ms`, `<n> s` or `<m> min <s> s`, dropping a zero seconds remainder.
 *   The total is rounded before it is split, so a rounded-up remainder carries into the minutes
 *   instead of rendering an impossible `60 s`.
 */
export function humanDuration(ms: number | null): string {
  if (ms === null) {
    return 'n/a';
  }
  if (ms < SECOND_MS) {
    return `${ms} ms`;
  }
  // Rounding happens once, on the total, before the split into minutes and seconds. Rounding a
  // remainder instead lets the carry escape: 119_999 ms would render as "1 min 60 s".
  const totalSeconds = Math.round(ms / SECOND_MS);
  if (totalSeconds < SECONDS_PER_MINUTE) {
    return `${totalSeconds} s`;
  }
  const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}

/**
 * Reads a string field out of logged arguments without trusting their shape.
 *
 * @param args - Arguments as logged; may be anything.
 * @param key - Field to read.
 * @returns The string value, or `null` when it is absent or not a string.
 */
function stringArg(args: unknown, key: string): string | null {
  if (typeof args !== 'object' || args === null) {
    return null;
  }
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Renders the command of a shell call on one line, elided when it is long.
 *
 * @param args - Arguments as logged.
 * @returns The single-line command text, or the unknown placeholder.
 */
function commandText(args: unknown): string {
  const command = stringArg(args, 'command');
  if (command === null) {
    return UNKNOWN_ARGUMENT;
  }
  const singleLine = command.replace(/\s*\n\s*/g, ' ');
  return singleLine.length > MAX_SUMMARY_COMMAND_CHARS
    ? `${singleLine.slice(0, MAX_SUMMARY_COMMAND_CHARS)}…`
    : singleLine;
}

/**
 * Renders the summary of a shell call.
 *
 * @param entry - The logged call.
 * @returns The summary line.
 */
function shellSummary(entry: ToolCallSummaryInput): string {
  const command = commandText(entry.args);
  const duration = humanDuration(entry.durationMs);
  if (entry.status === 'TIMED_OUT') {
    return `ran \`${command}\` → timed out after ${duration}`;
  }
  if (entry.exitCode === null) {
    return `ran \`${command}\` → failed (${duration})`;
  }
  return `ran \`${command}\` → exit ${entry.exitCode} (${duration})`;
}

/**
 * Counts the bytes a write produced.
 *
 * @param entry - The logged call.
 * @returns The byte count from the logged content, falling back to what the tool reported.
 */
function writtenBytes(entry: ToolCallSummaryInput): number {
  const content = stringArg(entry.args, 'content');
  if (content !== null) {
    return Buffer.byteLength(content);
  }
  return entry.resultBytes ?? 0;
}

/**
 * Renders one logged tool call as a single summary line.
 *
 * @param entry - The logged call.
 * @returns The summary line the `TOOL_SUMMARY` message carries.
 */
export function toolSummaryText(entry: ToolCallSummaryInput): string {
  switch (entry.toolName) {
    case 'run_shell':
      return shellSummary(entry);
    case 'write_file':
      return `wrote ${stringArg(entry.args, 'path') ?? UNKNOWN_ARGUMENT} (${writtenBytes(entry)} bytes)`;
    case 'read_file':
      return `read ${stringArg(entry.args, 'path') ?? UNKNOWN_ARGUMENT}`;
    case 'list_dir':
      // `list_dir` defaults to the workspace root, which the log records as an absent path.
      return `listed ${stringArg(entry.args, 'path') ?? '/'}`;
    default:
      return assertNever(entry.toolName);
  }
}
