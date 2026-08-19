/**
 * `read_file`: returns a workspace file as numbered lines, optionally a range of them.
 *
 * Layer: domain.
 *
 * Line numbers are what makes the output usable: the model quotes them back when it asks for an
 * edit, and they survive truncation, so a partial read is still unambiguous.
 */
import { readFile as readFileFromDisk, stat } from 'node:fs/promises';

import { displayPath, PathEscapeError, resolveInsideWorkspace } from './paths.js';
import { failure, truncateOutput } from './result.js';
import type { ToolResult } from './result.js';
import type { ReadFileArgs } from './schemas.js';

/** Everything `read_file` needs from the turn. */
export interface ReadFileContext {
  /** Absolute workspace root. */
  workspaceRoot: string;
  /** Byte budget for the result. */
  maxOutputBytes: number;
}

/**
 * Clamps the requested line range to what the file actually has.
 *
 * @param args - Validated arguments.
 * @param lineCount - Number of lines in the file.
 * @returns The 1-based inclusive range, or `null` when the request is contradictory.
 */
function clampRange(args: ReadFileArgs, lineCount: number): { start: number; end: number } | null {
  const start = Math.min(args.startLine ?? 1, lineCount);
  const end = Math.min(args.endLine ?? lineCount, lineCount);
  return end < start ? null : { start, end };
}

/**
 * Reads a text file from the workspace.
 *
 * @param args - Validated arguments.
 * @param context - Read context.
 * @returns The numbered lines, or a failed result explaining what went wrong.
 */
export async function readFile(args: ReadFileArgs, context: ReadFileContext): Promise<ToolResult> {
  let absolute: string;
  try {
    absolute = await resolveInsideWorkspace(context.workspaceRoot, args.path);
  } catch (error) {
    return failure(error instanceof PathEscapeError ? error.message : 'path could not be resolved');
  }
  const shown = displayPath(context.workspaceRoot, absolute);
  const entry = await stat(absolute).catch(() => null);
  if (entry === null) {
    return failure(`file not found: ${shown}`);
  }
  if (entry.isDirectory()) {
    return failure(`is a directory: ${shown}`);
  }
  const content = await readFileFromDisk(absolute, 'utf8');
  const lines = content === '' ? [] : content.split('\n');
  const range = clampRange(args, lines.length);
  if (range === null) {
    return failure(`endLine is before startLine for ${shown}`);
  }
  const numbered = lines
    .slice(range.start - 1, range.end)
    .map((line, index) => `${String(range.start + index)}\t${line}`)
    .join('\n');
  const { text } = truncateOutput(numbered, context.maxOutputBytes);
  return { output: text, exitCode: 0, bytes: entry.size, status: 'SUCCEEDED' };
}
