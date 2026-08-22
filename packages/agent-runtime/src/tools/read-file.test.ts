/**
 * Unit tests for the file reader.
 *
 * Layer: unit.
 * Goal: the whole file and any sub-range come back as numbered lines, an impossible range and a
 * missing or non-file path fail with a readable message, an escape is refused, and a long file is
 * truncated with a notice while still reporting its real size.
 * Mocks: none; a real temporary directory stands in for `/workspace`.
 */
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir, removeTempDir } from '../testing/temp-dir.js';

import { readFile } from './read-file.js';
import type { ReadFileContext } from './read-file.js';

let root: string;
let outside: string;
let context: ReadFileContext;

beforeEach(async () => {
  root = await makeTempDir('read-file-root');
  outside = await makeTempDir('read-file-outside');
  await mkdir(path.join(root, 'dir'), { recursive: true });
  await writeFile(path.join(root, 'a.txt'), 'one\ntwo\nthree\n', 'utf8');
  await writeFile(path.join(root, 'empty.txt'), '', 'utf8');
  await writeFile(path.join(outside, 'secret.txt'), 'not yours\n', 'utf8');
  context = { workspaceRoot: root, maxOutputBytes: 32_768 };
});

afterEach(async () => {
  await removeTempDir(root);
  await removeTempDir(outside);
});

describe('readFile', () => {
  /** The numbers are what let the model point at a line when it asks for an edit. */
  it('returns the whole file as numbered lines', async () => {
    const result = await readFile({ path: 'a.txt', startLine: null, endLine: null }, context);
    expect(result).toStrictEqual({
      output: '1\tone\n2\ttwo\n3\tthree\n4\t',
      exitCode: 0,
      bytes: 14,
      status: 'SUCCEEDED',
    });
  });

  /** Reading a window of a large file is the normal way the model works. */
  it('returns only the requested range', async () => {
    const result = await readFile({ path: 'a.txt', startLine: 2, endLine: 3 }, context);
    expect(result.output).toBe('2\ttwo\n3\tthree');
  });

  /** The model guesses line numbers; overshooting should not be an error. */
  it('clamps a range that runs past the end of the file', async () => {
    const result = await readFile({ path: 'a.txt', startLine: 3, endLine: 900 }, context);
    expect(result.output).toBe('3\tthree\n4\t');
  });

  /** Silently swapping the bounds would hide a genuine mistake from the model. */
  it('fails when the range is inverted', async () => {
    const result = await readFile({ path: 'a.txt', startLine: 3, endLine: 2 }, context);
    expect(result).toMatchObject({
      status: 'FAILED',
      output: 'endLine is before startLine for a.txt',
    });
  });

  /** An empty file is a fact about the repository, not a failure. */
  it('returns an empty file as empty output with a successful status', async () => {
    const result = await readFile({ path: 'empty.txt', startLine: null, endLine: null }, context);
    expect(result).toMatchObject({ output: '', exitCode: 0, bytes: 0, status: 'SUCCEEDED' });
  });

  /** The model routinely guesses paths; it needs the workspace-relative name back. */
  it('fails when the file does not exist', async () => {
    const result = await readFile({ path: 'nope.txt', startLine: null, endLine: null }, context);
    expect(result).toMatchObject({ status: 'FAILED', output: 'file not found: nope.txt' });
  });

  /** Reading a directory would otherwise surface as an opaque EISDIR. */
  it('fails when the path names a directory', async () => {
    const result = await readFile({ path: 'dir', startLine: null, endLine: null }, context);
    expect(result).toMatchObject({ status: 'FAILED', output: 'is a directory: dir' });
  });

  /** Reading outside the workspace is exactly what confinement exists to prevent. */
  it.each([
    ['a parent segment', '../read-file-outside/secret.txt'],
    ['an absolute path elsewhere', '/etc/hosts'],
  ])('refuses a path that leaves the workspace through %s', async (_name, candidate) => {
    const result = await readFile({ path: candidate, startLine: null, endLine: null }, context);
    expect(result).toMatchObject({ status: 'FAILED' });
    expect(result.output).toContain('escapes the workspace');
  });

  /** The lexical path is innocent; only the link target reveals the escape. */
  it('refuses a symbolic link that points out of the workspace', async () => {
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    const result = await readFile({ path: 'link.txt', startLine: null, endLine: null }, context);
    expect(result.output).toContain('symbolic link');
  });

  /** A destroyed workspace must not surface as an unhandled rejection mid-turn. */
  it('reports a workspace root that cannot be resolved at all', async () => {
    const result = await readFile(
      { path: 'a.txt', startLine: null, endLine: null },
      {
        ...context,
        workspaceRoot: path.join(root, 'gone'),
      },
    );
    expect(result).toMatchObject({ status: 'FAILED', output: 'path could not be resolved' });
  });

  /**
   * The file has to be read whole before it can be numbered, and a large artefact in the checkout
   * would exhaust the container's memory limit.
   */
  it('refuses a file too large to load, pointing at the shell instead', async () => {
    await writeFile(path.join(root, 'huge.bin'), Buffer.alloc(4 * 1024 * 1024 + 1));
    const result = await readFile({ path: 'huge.bin', startLine: null, endLine: null }, context);
    expect(result.status).toBe('FAILED');
    expect(result.output).toContain('too large to read whole');
    expect(result.output).toContain('run_shell with head or sed');
  });

  /**
   * The cap is the largest file the tool will load, not the first size it refuses, so a file of
   * exactly that many bytes still has to come back. Measured at the limit as well as past it: the
   * refusal above passes just as happily against a check written one byte early, and that check
   * would turn a readable file into an instruction to go and use the shell instead.
   */
  it('reads a file of exactly the largest size it will load', async () => {
    await writeFile(path.join(root, 'exact.bin'), Buffer.alloc(4 * 1024 * 1024, 0x61));

    const result = await readFile({ path: 'exact.bin', startLine: null, endLine: null }, context);

    expect(result.status).toBe('SUCCEEDED');
    expect(result.output).not.toContain('too large to read whole');
  });

  /** The budget protects the model's context; the notice tells it what it is missing. */
  it('truncates a long file and still reports its real size', async () => {
    await writeFile(path.join(root, 'big.txt'), 'x'.repeat(5000), 'utf8');
    const result = await readFile(
      { path: 'big.txt', startLine: null, endLine: null },
      {
        ...context,
        maxOutputBytes: 64,
      },
    );
    expect(result.output).toContain('[truncated:');
    expect(result.bytes).toBe(5000);
  });
});
