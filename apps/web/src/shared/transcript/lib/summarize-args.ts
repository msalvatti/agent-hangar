/**
 * One-line, redacted summary of a tool call's arguments for the collapsed transcript row.
 *
 * Layer: shared (formatting).
 */
import type { ToolName } from '@agent-hangar/core';

import { maskSecretShapes, toDisplayJson } from './redact-display';

/** Length a summary is truncated to before an ellipsis is appended. */
const SUMMARY_MAX_LENGTH = 96;

/** Length the JSON fallback is clamped to before the general truncation rule applies. */
const FALLBACK_MAX_LENGTH = 80;

function truncate(text: string): string {
  return text.length > SUMMARY_MAX_LENGTH ? `${text.slice(0, SUMMARY_MAX_LENGTH)}…` : text;
}

function stringField(args: unknown, field: string): string | null {
  // The object test narrows the type for the read below; a value of another kind has no field to
  // read, and the `typeof` check on what comes back would refuse it either way.
  // Stryker disable next-line ConditionalExpression
  if (typeof args !== 'object' || args === null) {
    return null;
  }
  const value = (args as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : null;
}

/** Reads a numeric field of an already-confirmed object (see the one caller, below). */
function numberField(record: Record<string, unknown>, field: string): number | null {
  const value = record[field];
  return typeof value === 'number' ? value : null;
}

/** Collapses a value to one line of JSON, for arguments that don't match the expected shape. */
function fallback(args: unknown): string {
  return toDisplayJson(args).replace(/\s+/g, ' ').slice(0, FALLBACK_MAX_LENGTH);
}

function summarizeReadFile(args: unknown): string {
  const path = stringField(args, 'path');
  if (path === null) {
    return fallback(args);
  }
  // A non-null path already proves (via stringField's own check) that args is a non-null object.
  const record = args as Record<string, unknown>;
  const startLine = numberField(record, 'startLine');
  const endLine = numberField(record, 'endLine');
  return startLine !== null && endLine !== null ? `${path}:${startLine}-${endLine}` : path;
}

/**
 * Builds the collapsed-row summary of a tool call's arguments, per tool: `run_shell` shows the
 * command, `read_file` shows `path[:start-end]`, `write_file`/`list_dir` show the path. Any shape
 * that doesn't match falls back to a clamped JSON dump. The result is always secret-masked and
 * capped at {@link SUMMARY_MAX_LENGTH} characters.
 *
 * @param name - The tool that was called.
 * @param args - Its arguments (untyped at this layer — the runtime validates them).
 * @returns A single-line, redacted summary.
 */
export function summarizeArgs(name: ToolName, args: unknown): string {
  let raw: string;
  switch (name) {
    case 'run_shell':
      raw = stringField(args, 'command') ?? fallback(args);
      break;
    case 'read_file':
      raw = summarizeReadFile(args);
      break;
    case 'write_file':
      raw = stringField(args, 'path') ?? fallback(args);
      break;
    case 'list_dir':
      raw = stringField(args, 'path') ?? '/';
      break;
  }
  return truncate(maskSecretShapes(raw));
}
