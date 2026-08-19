/**
 * Path confinement: every path the model names is resolved inside `/workspace` or rejected.
 *
 * Layer: domain.
 *
 * The agent is driven by a model that reads untrusted repository content, so a path argument is
 * attacker-influenced. Three escapes are closed: `..` segments, an absolute path outside the root,
 * and a symlink whose target leaves the root. The last one needs the real filesystem — a purely
 * lexical check would happily resolve `link/file` inside the root while the kernel writes to
 * wherever `link` points.
 */
import { realpath } from 'node:fs/promises';
import path from 'node:path';

/** A path argument resolved outside the workspace root. */
export class PathEscapeError extends Error {
  /** Stable identifier so callers can branch without matching the message. */
  readonly code = 'path_escape';

  /**
   * @param message - What was rejected, in workspace-relative terms.
   */
  constructor(message: string) {
    super(message);
    this.name = 'PathEscapeError';
  }
}

/**
 * Reports whether `candidate` is `root` itself or sits underneath it.
 *
 * @param root - Absolute, symlink-free root.
 * @param candidate - Absolute, symlink-free path to test.
 * @returns `true` when the candidate is contained by the root.
 */
function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/**
 * Resolves the deepest ancestor of `target` that exists, following symlinks.
 *
 * Resolution has to stop at the deepest existing ancestor because the tools legitimately create
 * files and directories that do not exist yet; the ancestor is what the kernel will actually write
 * under, so it is what must be proven to be inside the workspace.
 *
 * The walk terminates at `root` rather than at the filesystem root: the caller has already
 * established lexically that `target` is `root` or sits under it, so the chain of parents reaches
 * `root` exactly.
 *
 * @param root - Workspace root as given, possibly through symbolic links.
 * @param realRoot - Already-resolved real path of `root`.
 * @param target - Absolute path under `root`, existing or not.
 * @returns The real path of the deepest existing ancestor.
 */
async function realDeepestAncestor(
  root: string,
  realRoot: string,
  target: string,
): Promise<string> {
  let candidate = target;
  while (candidate !== root) {
    try {
      return await realpath(candidate);
    } catch {
      candidate = path.dirname(candidate);
    }
  }
  return realRoot;
}

/**
 * Resolves a model-supplied path against the workspace root, rejecting every escape.
 *
 * @param root - Workspace root, absolute (`/workspace` in the container).
 * @param userPath - Path as the model wrote it; relative or absolute.
 * @returns The absolute path, kept logical rather than resolved so callers can create what is
 *   still missing under it.
 * @throws PathEscapeError when the path leaves the workspace by any route.
 */
export async function resolveInsideWorkspace(root: string, userPath: string): Promise<string> {
  const absolute = path.resolve(root, userPath);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new PathEscapeError(`path escapes the workspace: ${userPath}`);
  }
  const realRoot = await realpath(root);
  const realAncestor = await realDeepestAncestor(root, realRoot, absolute);
  if (!isInside(realRoot, realAncestor)) {
    throw new PathEscapeError(`path escapes the workspace through a symbolic link: ${userPath}`);
  }
  return absolute;
}

/**
 * Renders an absolute path the way it should appear in a message to the model.
 *
 * @param root - Workspace root.
 * @param absolute - Absolute path inside the root.
 * @returns The workspace-relative path with forward slashes; `.` for the root itself.
 */
export function displayPath(root: string, absolute: string): string {
  const relative = path.relative(root, absolute);
  return relative === '' ? '.' : relative.split(path.sep).join('/');
}
