/**
 * `write_file`: writes UTF-8 text to a workspace file, creating the parent directories.
 *
 * Layer: domain.
 *
 * Confinement is entirely `resolveInsideWorkspace`'s job, and it already covers the symlink case:
 * an existing target that points outside the workspace resolves to its real location, which the
 * containment check rejects before a single byte is written.
 */
import { mkdir, writeFile as writeFileToDisk } from 'node:fs/promises';
import path from 'node:path';

import { displayPath, PathEscapeError, resolveInsideWorkspace } from './paths.js';
import { describeError, failure } from './result.js';
import type { ToolResult } from './result.js';
import type { WriteFileArgs } from './schemas.js';

/** Everything `write_file` needs from the turn. */
export interface WriteFileContext {
  /** Absolute workspace root. */
  workspaceRoot: string;
}

/**
 * Writes a text file into the workspace.
 *
 * @param args - Validated arguments.
 * @param context - Write context.
 * @returns How many bytes were written, or a failed result explaining what went wrong.
 */
export async function writeFile(
  args: WriteFileArgs,
  context: WriteFileContext,
): Promise<ToolResult> {
  let absolute: string;
  try {
    absolute = await resolveInsideWorkspace(context.workspaceRoot, args.path);
  } catch (error) {
    return failure(error instanceof PathEscapeError ? error.message : 'path could not be resolved');
  }
  const shown = displayPath(context.workspaceRoot, absolute);
  const bytes = Buffer.byteLength(args.content);
  try {
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFileToDisk(absolute, args.content, 'utf8');
  } catch (error) {
    return failure(`could not write ${shown}: ${describeError(error)}`);
  }
  return {
    output: `wrote ${String(bytes)} bytes to ${shown}`,
    exitCode: 0,
    bytes,
    status: 'SUCCEEDED',
  };
}
