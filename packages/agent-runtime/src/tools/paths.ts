/**
 * Path confinement: every path the model names is resolved inside `/workspace` or rejected.
 *
 * Layer: domain.
 *
 * The agent is driven by a model that reads untrusted repository content, so a path argument is
 * attacker-influenced. Three escapes are closed: `..` segments, an absolute path outside the root,
 * and a symlink whose target leaves the root. The last one needs the real filesystem — a purely
 * lexical check would happily resolve `link/file` inside the root while the kernel writes to
 * wherever `link` points — and it has to treat a link whose target does not exist yet as the
 * escape it is, because creating that target is precisely what `write_file` would do.
 *
 * What remains outside this helper's reach is the gap between the check and the operation: the
 * shell tool can plant a symbolic link in between. Closing that needs the operation itself to
 * refuse to follow links (`O_NOFOLLOW` against a directory descriptor), which is a change to how
 * every tool opens its file rather than to how the path is judged.
 */
import { readlink, realpath } from 'node:fs/promises';
import path from 'node:path';

/**
 * Symbolic links followed before a path is refused outright.
 *
 * A chain of links that never lands on a real location is either a cycle or an attempt to outrun
 * the check; the kernel gives up at a comparable depth for the same reason.
 */
const MAX_SYMLINK_HOPS = 32;

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
 * Resolves where the kernel would actually act for `target`, existing or not.
 *
 * Three cases, and the middle one is the whole reason this is not just `realpath`:
 *
 * - The path resolves: `realpath` has followed every link and reports the real location.
 * - The path is a **dangling** symbolic link — it exists, but its target does not. `realpath`
 *   fails here exactly as it does for a path that is absent altogether, yet the two are not the
 *   same: opening a dangling link with `O_CREAT` creates the file *at the link's target*. The
 *   link is therefore read and the walk continues from where it points, so a link into `/etc`
 *   whose target is missing is judged on `/etc`, not on the directory holding the link.
 * - The path is simply absent: what decides the location is its parent, so the walk moves up.
 *
 * The walk needs no special case for the root: the caller has already resolved it, which is only
 * possible because it exists, so the last step up the tree resolves like any other.
 *
 * @param target - Absolute path under the workspace root, existing or not.
 * @returns The real path the operation would land on.
 * @throws PathEscapeError when the chain of links is longer than {@link MAX_SYMLINK_HOPS}.
 */
async function realResolvedTarget(target: string): Promise<string> {
  let candidate = target;
  let hops = 0;
  for (;;) {
    const resolved = await realpath(candidate).catch(() => null);
    if (resolved !== null) {
      return resolved;
    }
    const link = await readlink(candidate).catch(() => null);
    if (link === null) {
      candidate = path.dirname(candidate);
      continue;
    }
    hops += 1;
    if (hops > MAX_SYMLINK_HOPS) {
      throw new PathEscapeError(`too many symbolic links to resolve: ${target}`);
    }
    // The link exists, so the directory holding it does too and resolves; the target is read
    // relative to that real directory, which is how the kernel reads a relative link.
    const parent = await realpath(path.dirname(candidate));
    candidate = path.resolve(parent, link);
  }
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
  const realTarget = await realResolvedTarget(absolute);
  if (!isInside(realRoot, realTarget)) {
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
