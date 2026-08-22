/**
 * `list_dir`: lists a workspace directory, following `.gitignore` inside a repository.
 *
 * Layer: domain.
 *
 * Asking git for the listing is what keeps the result useful: a plain walk of a checked-out
 * repository is dominated by `node_modules` and build output, which burns the model's context
 * without telling it anything. Outside a repository the tool falls back to a bounded walk.
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { createGitRunner } from '../git.js';
import type { GitRunner } from '../git.js';

import { displayPath, PathEscapeError, resolveInsideWorkspace } from './paths.js';
import { failure, truncateOutput } from './result.js';
import type { ToolResult } from './result.js';
import { MAX_LIST_DIR_DEPTH } from './schemas.js';
import type { ListDirArgs } from './schemas.js';

/** Entries listed before the rest is summarised. */
const DEFAULT_MAX_ENTRIES = 500;

/** Directory never listed: it is git's own storage, not repository content. */
const GIT_DIRECTORY = '.git';

/** Everything `list_dir` needs from the turn. */
export interface ListDirContext {
  /** Absolute workspace root. */
  workspaceRoot: string;
  /** Child environment used for the git invocations. */
  env: Record<string, string>;
  /** Byte budget for the result. */
  maxOutputBytes: number;
  /** Entries listed before the remainder is summarised; defaults to 500. */
  maxEntries?: number;
  /** Git runner; injectable for tests. */
  git?: GitRunner;
}

/**
 * Expands one repository-relative file path into the entries a listing of `depth` should show.
 *
 * @param relative - Path of a tracked or untracked file, relative to the listed directory.
 * @param depth - How many levels the listing covers.
 * @returns The intermediate directories within the depth, plus the file itself when it fits.
 */
function expandEntry(relative: string, depth: number): string[] {
  const segments = relative.split('/');
  const entries: string[] = [];
  for (let level = 1; level < Math.min(segments.length, depth + 1); level += 1) {
    entries.push(`${segments.slice(0, level).join('/')}/`);
  }
  if (segments.length <= depth) {
    entries.push(relative);
  }
  return entries;
}

/**
 * Lists the directory through git, honouring `.gitignore`.
 *
 * @param git - Git runner.
 * @param base - Directory to list.
 * @param env - Child environment.
 * @param depth - How many levels to cover.
 * @returns The entries, or `null` when the directory is not inside a work tree.
 */
async function listThroughGit(
  git: GitRunner,
  base: string,
  env: Record<string, string>,
  depth: number,
): Promise<string[] | null> {
  const inside = await git.run(['rev-parse', '--is-inside-work-tree'], { cwd: base, env });
  if (inside.code !== 0) {
    return null;
  }
  const listed = await git.run(
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'],
    { cwd: base, env },
  );
  if (listed.code !== 0) {
    return null;
  }
  return listed.stdout
    .split('\0')
    .filter((entry) => entry !== '')
    .flatMap((entry) => expandEntry(entry, depth));
}

/**
 * Walks the directory tree directly, for a directory that is not inside a repository.
 *
 * @param base - Directory to list.
 * @param depth - How many levels to cover.
 * @returns The entries, directories marked with a trailing slash.
 */
async function listThroughReaddir(base: string, depth: number): Promise<string[]> {
  const entries: string[] = [];
  const walk = async (directory: string, prefix: string, level: number): Promise<void> => {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      if (child.name === GIT_DIRECTORY) {
        continue;
      }
      const relative = `${prefix}${child.name}`;
      if (!child.isDirectory()) {
        entries.push(relative);
        continue;
      }
      entries.push(`${relative}/`);
      if (level < depth) {
        await walk(path.join(directory, child.name), `${relative}/`, level + 1);
      }
    }
  };
  await walk(base, '', 1);
  return entries;
}

/**
 * Sorts, deduplicates and caps the entries, then renders them as one entry per line.
 *
 * @param entries - Raw entries from either listing strategy.
 * @param maxEntries - How many to show before summarising the rest.
 * @returns The rendered listing.
 */
function renderListing(entries: readonly string[], maxEntries: number): string {
  const unique = [...new Set(entries)].sort();
  const shown = unique.slice(0, maxEntries);
  const omitted = unique.length - shown.length;
  const lines = omitted > 0 ? [...shown, `[… ${String(omitted)} more entries omitted]`] : shown;
  return lines.join('\n');
}

/**
 * Lists a directory of the workspace.
 *
 * @param args - Validated arguments.
 * @param context - Listing context.
 * @returns One entry per line, or a failed result explaining what went wrong.
 */
export async function listDir(args: ListDirArgs, context: ListDirContext): Promise<ToolResult> {
  let base: string;
  try {
    // Stryker disable next-line StringLiteral: resolving the workspace root against the current
    // directory and against an empty path both land on the root itself, so the two spellings of
    // "no path was given" name the same directory.
    base = await resolveInsideWorkspace(context.workspaceRoot, args.path ?? '.');
  } catch (error) {
    return failure(error instanceof PathEscapeError ? error.message : 'path could not be resolved');
  }
  const shown = displayPath(context.workspaceRoot, base);
  const entry = await stat(base).catch(() => null);
  if (entry === null) {
    return failure(`directory not found: ${shown}`);
  }
  if (!entry.isDirectory()) {
    return failure(`not a directory: ${shown}`);
  }
  // The schema already bounds `depth`; clamping again keeps the walk finite for any caller.
  const depth = Math.min(args.depth ?? 1, MAX_LIST_DIR_DEPTH);
  const git = context.git ?? createGitRunner();
  const entries =
    (await listThroughGit(git, base, context.env, depth)) ??
    (await listThroughReaddir(base, depth));
  const { text, bytes } = truncateOutput(
    renderListing(entries, context.maxEntries ?? DEFAULT_MAX_ENTRIES),
    context.maxOutputBytes,
  );
  return { output: text, exitCode: 0, bytes, status: 'SUCCEEDED' };
}
