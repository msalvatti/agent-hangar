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
  it('resolves a relative path to an existing file', async () => {
    // The ordinary case every tool starts from.
    await expect(resolveInsideWorkspace(root, 'src/a.ts')).resolves.toBe(
      path.join(root, 'src', 'a.ts'),
    );
  });

  it('resolves a path written with a leading dot segment', async () => {
    // Models routinely write `./x`; it is not an escape.
    await expect(resolveInsideWorkspace(root, './src')).resolves.toBe(path.join(root, 'src'));
  });

  it('resolves the root itself', async () => {
    // `list_dir` defaults to `.`, which resolves to the root and must be accepted.
    await expect(resolveInsideWorkspace(root, '.')).resolves.toBe(root);
  });

  it('resolves an absolute path that is inside the root', async () => {
    // The container's own paths are absolute; only leaving the root is forbidden.
    const inside = path.join(root, 'src');
    await expect(resolveInsideWorkspace(root, inside)).resolves.toBe(inside);
  });

  it('resolves a path whose directories do not exist yet', async () => {
    // `write_file` creates parents, so the check has to stop at the deepest existing ancestor.
    await expect(resolveInsideWorkspace(root, 'new/deep/file.txt')).resolves.toBe(
      path.join(root, 'new', 'deep', 'file.txt'),
    );
  });

  it('resolves a path under a symbolic link that stays inside the root', async () => {
    // Repositories contain internal links; only links that leave the workspace are a problem.
    await symlink(path.join(root, 'src'), path.join(root, 'alias'));
    await expect(resolveInsideWorkspace(root, 'alias/a.ts')).resolves.toBe(
      path.join(root, 'alias', 'a.ts'),
    );
  });

  it.each([
    ['a parent segment', '../escape'],
    ['an absolute path elsewhere', '/etc/passwd'],
    ['parent segments in the middle', 'src/../../escape'],
  ])('rejects %s', async (_name, candidate) => {
    // Lexical escapes are refused before the filesystem is touched at all.
    await expect(resolveInsideWorkspace(root, candidate)).rejects.toBeInstanceOf(PathEscapeError);
  });

  it('rejects a path that leaves the root through a symbolic link', async () => {
    // The lexical check passes here; only resolving the link exposes the escape.
    await symlink(outside, path.join(root, 'link'));
    const promise = resolveInsideWorkspace(root, 'link/secret.txt');
    await expect(promise).rejects.toBeInstanceOf(PathEscapeError);
    await expect(promise).rejects.toThrow('symbolic link');
  });

  it('rejects a path under a symbolic link whose target does not exist', async () => {
    // The deepest existing ancestor is the link's target directory, which is outside the root.
    await symlink(outside, path.join(root, 'link'));
    await expect(resolveInsideWorkspace(root, 'link/missing/file')).rejects.toBeInstanceOf(
      PathEscapeError,
    );
  });

  it('accepts a root that is itself reached through a symbolic link', async () => {
    // macOS resolves the system temporary directory through /private; the root must still match.
    const alias = path.join(outside, 'root-alias');
    await symlink(root, alias);
    await expect(resolveInsideWorkspace(alias, 'src/a.ts')).resolves.toBe(
      path.join(alias, 'src', 'a.ts'),
    );
  });

  it('carries a stable code so callers do not match on the message', () => {
    // The tools branch on this to distinguish an escape from an ordinary I/O failure.
    expect(new PathEscapeError('nope').code).toBe('path_escape');
  });
});

describe('displayPath', () => {
  it('renders a nested path with forward slashes', () => {
    // Messages go to a model that thinks in POSIX paths.
    expect(displayPath(root, path.join(root, 'src', 'a.ts'))).toBe('src/a.ts');
  });

  it('renders the root itself as a dot', () => {
    // `list_dir` with no argument lists the root, and an empty string reads as a bug.
    expect(displayPath(root, root)).toBe('.');
  });
});
