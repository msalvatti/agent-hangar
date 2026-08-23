/**
 * Unit tests for path confinement.
 *
 * Layer: unit.
 * Goal: every route out of the workspace is closed — `..` segments, absolute paths elsewhere, and
 * symbolic links whose target leaves the root — while the paths the tools legitimately need still
 * resolve, including files that do not exist yet and a root reached through a symlinked temp
 * directory.
 * Mocks: none; a real temporary directory stands in for `/workspace`.
 */
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir, removeTempDir } from '../testing/temp-dir.js';

import { displayPath, PathEscapeError, resolveInsideWorkspace } from './paths.js';

/**
 * Longest chain of dangling symbolic links the resolver is required to follow.
 *
 * Written here rather than imported: it is the limit the workspace is promised, so a change to the
 * number in the module has to be a deliberate change to this expectation too.
 */
const PERMITTED_SYMLINK_HOPS = 32;

let root: string;
let outside: string;

beforeEach(async () => {
  root = await makeTempDir('paths-root');
  outside = await makeTempDir('paths-outside');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a.ts'), 'export {};\n', 'utf8');
  await writeFile(path.join(outside, 'secret.txt'), 'not yours\n', 'utf8');
});

afterEach(async () => {
  await removeTempDir(root);
  await removeTempDir(outside);
});

describe('resolveInsideWorkspace', () => {
  /** The ordinary case every tool starts from. */
  it('resolves a relative path to an existing file', async () => {
    await expect(resolveInsideWorkspace(root, 'src/a.ts')).resolves.toBe(
      path.join(root, 'src', 'a.ts'),
    );
  });

  /** Models routinely write `./x`; it is not an escape. */
  it('resolves a path written with a leading dot segment', async () => {
    await expect(resolveInsideWorkspace(root, './src')).resolves.toBe(path.join(root, 'src'));
  });

  /** `list_dir` defaults to `.`, which resolves to the root and must be accepted. */
  it('resolves the root itself', async () => {
    await expect(resolveInsideWorkspace(root, '.')).resolves.toBe(root);
  });

  /** The container's own paths are absolute; only leaving the root is forbidden. */
  it('resolves an absolute path that is inside the root', async () => {
    const inside = path.join(root, 'src');
    await expect(resolveInsideWorkspace(root, inside)).resolves.toBe(inside);
  });

  /** `write_file` creates parents, so the check has to stop at the deepest existing ancestor. */
  it('resolves a path whose directories do not exist yet', async () => {
    await expect(resolveInsideWorkspace(root, 'new/deep/file.txt')).resolves.toBe(
      path.join(root, 'new', 'deep', 'file.txt'),
    );
  });

  /** Repositories contain internal links; only links that leave the workspace are a problem. */
  it('resolves a path under a symbolic link that stays inside the root', async () => {
    await symlink(path.join(root, 'src'), path.join(root, 'alias'));
    await expect(resolveInsideWorkspace(root, 'alias/a.ts')).resolves.toBe(
      path.join(root, 'alias', 'a.ts'),
    );
  });

  /** Lexical escapes are refused before the filesystem is touched at all. */
  it.each([
    ['a parent segment', '../escape'],
    ['an absolute path elsewhere', '/etc/passwd'],
    ['parent segments in the middle', 'src/../../escape'],
  ])('rejects %s', async (_name, candidate) => {
    const promise = resolveInsideWorkspace(root, candidate);
    await expect(promise).rejects.toBeInstanceOf(PathEscapeError);
    // The whole message, because both refusals raise the same class and only the wording says
    // which check caught it. A lexical escape that slipped past this one is still refused further
    // down, by the symbolic-link check — so a test that reads the class alone cannot tell a
    // working lexical check from one that has stopped running.
    await expect(promise).rejects.toThrow(`path escapes the workspace: ${candidate}`);
  });

  /** The lexical check passes here; only resolving the link exposes the escape. */
  it('rejects a path that leaves the root through a symbolic link', async () => {
    await symlink(outside, path.join(root, 'link'));
    const promise = resolveInsideWorkspace(root, 'link/secret.txt');
    await expect(promise).rejects.toBeInstanceOf(PathEscapeError);
    await expect(promise).rejects.toThrow('symbolic link');
  });

  /** The deepest existing ancestor is the link's target directory, which is outside the root. */
  it('rejects a path under a symbolic link whose target does not exist', async () => {
    await symlink(outside, path.join(root, 'link'));
    await expect(resolveInsideWorkspace(root, 'link/missing/file')).rejects.toBeInstanceOf(
      PathEscapeError,
    );
  });

  /**
   * `realpath` fails for a dangling link exactly as it does for an absent path, but the two are not
   * the same: writing to the link creates the file at its target, outside the workspace.
   */
  it('rejects a dangling symbolic link whose target is outside the root', async () => {
    await symlink(path.join(outside, 'not-there-yet.txt'), path.join(root, 'dangling'));
    await expect(resolveInsideWorkspace(root, 'dangling')).rejects.toThrow('symbolic link');
  });

  /** Following only the first link would judge the chain on a location still inside the root. */
  it('rejects a chain of dangling symbolic links that ends outside the root', async () => {
    await symlink(path.join(outside, 'not-there-yet.txt'), path.join(root, 'second'));
    await symlink(path.join(root, 'second'), path.join(root, 'first'));
    await expect(resolveInsideWorkspace(root, 'first')).rejects.toThrow('symbolic link');
  });

  /** Repositories carry links to files a build has not produced yet; those are not escapes. */
  it('accepts a dangling symbolic link whose target is inside the root', async () => {
    await symlink(path.join(root, 'generated.txt'), path.join(root, 'dangling'));
    await expect(resolveInsideWorkspace(root, 'dangling')).resolves.toBe(
      path.join(root, 'dangling'),
    );
  });

  /** Neither link resolves, and each names the other; the walk has to give up on its own. */
  it('rejects a cycle of symbolic links instead of following it forever', async () => {
    await symlink(path.join(root, 'b'), path.join(root, 'a'));
    await symlink(path.join(root, 'a'), path.join(root, 'b'));
    await expect(resolveInsideWorkspace(root, 'a')).rejects.toThrow('too many symbolic links');
  });

  /** macOS resolves the system temporary directory through /private; the root must still match. */
  it('accepts a root that is itself reached through a symbolic link', async () => {
    const alias = path.join(outside, 'root-alias');
    await symlink(root, alias);
    await expect(resolveInsideWorkspace(alias, 'src/a.ts')).resolves.toBe(
      path.join(alias, 'src', 'a.ts'),
    );
  });

  /** The tools branch on this to distinguish an escape from an ordinary I/O failure. */
  it('carries a stable code so callers do not match on the message', () => {
    expect(new PathEscapeError('nope').code).toBe('path_escape');
    // And a name, so an escape is recognisable in a log among the runtime's other failures.
    expect(new PathEscapeError('nope').name).toBe('PathEscapeError');
  });

  /**
   * The hop limit is a ceiling on work, not a rule about how many links a legitimate path may use,
   * so a chain that reaches exactly the limit still has to be followed to its end. Measured at the
   * limit and one link past it: a limit written one step off passes every test built from a chain
   * of two or three, and this one is what stands between a turn and a link farm that never
   * terminates.
   *
   * The links are dangling on purpose. `realpath` follows a chain that ends somewhere real in a
   * single call, so nothing would be counted; only a chain whose end is missing is walked link by
   * link, which is the walk the limit governs.
   */
  it.each([
    ['a chain of exactly the permitted length', PERMITTED_SYMLINK_HOPS, true],
    ['a chain one link longer than that', PERMITTED_SYMLINK_HOPS + 1, false],
  ])('follows %s: %s', async (_name, links, followed) => {
    const hop = (index: number): string => path.join(root, `hop-${String(index)}`);
    await symlink(path.join(root, 'hop-end'), hop(links));
    for (let index = links - 1; index >= 1; index -= 1) {
      await symlink(hop(index + 1), hop(index));
    }

    const promise = resolveInsideWorkspace(root, 'hop-1');
    if (followed) {
      await expect(promise).resolves.toBe(hop(1));
    } else {
      await expect(promise).rejects.toThrow('too many symbolic links');
    }
  });
});

describe('displayPath', () => {
  /** Messages go to a model that thinks in POSIX paths. */
  it('renders a nested path with forward slashes', () => {
    expect(displayPath(root, path.join(root, 'src', 'a.ts'))).toBe('src/a.ts');
  });

  /** `list_dir` with no argument lists the root, and an empty string reads as a bug. */
  it('renders the root itself as a dot', () => {
    expect(displayPath(root, root)).toBe('.');
  });
});
