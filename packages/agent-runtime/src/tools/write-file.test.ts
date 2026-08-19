/**
 * Unit tests for the file writer.
 *
 * Layer: unit.
 * Goal: a new file is created together with its parent directories, an existing one is replaced,
 * the byte count is reported for multi-byte content, and nothing is written when the path leaves
 * the workspace by any route or the parent cannot hold a file.
 * Mocks: none; a real temporary directory stands in for `/workspace`.
 */
import { readFile, symlink, writeFile as writeFileToDisk } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir, removeTempDir } from '../testing/temp-dir.js';

import { writeFile } from './write-file.js';
import type { WriteFileContext } from './write-file.js';

let root: string;
let outside: string;
let context: WriteFileContext;

beforeEach(async () => {
  root = await makeTempDir('write-file-root');
  outside = await makeTempDir('write-file-outside');
  await writeFileToDisk(path.join(outside, 'secret.txt'), 'original\n', 'utf8');
  context = { workspaceRoot: root };
});

afterEach(async () => {
  await removeTempDir(root);
  await removeTempDir(outside);
});

describe('writeFile', () => {
  it('creates a nested file together with its parent directories', async () => {
    // The model writes to paths that do not exist yet more often than not.
    const result = await writeFile({ path: 'docs/notes/NOTES.md', content: '# Notes\n' }, context);
    expect(result).toStrictEqual({
      output: 'wrote 8 bytes to docs/notes/NOTES.md',
      exitCode: 0,
      bytes: 8,
      status: 'SUCCEEDED',
    });
    await expect(readFile(path.join(root, 'docs/notes/NOTES.md'), 'utf8')).resolves.toBe(
      '# Notes\n',
    );
  });

  it('replaces the contents of an existing file', async () => {
    // Editing is a full rewrite; a partial overwrite would corrupt the file.
    await writeFileToDisk(path.join(root, 'a.txt'), 'old and long\n', 'utf8');
    await writeFile({ path: 'a.txt', content: 'new\n' }, context);
    await expect(readFile(path.join(root, 'a.txt'), 'utf8')).resolves.toBe('new\n');
  });

  it('counts bytes rather than characters', async () => {
    // The budget and the report are both in bytes, and UTF-8 characters are not one byte each.
    const result = await writeFile({ path: 'accents.txt', content: 'héllo' }, context);
    expect(result.output).toBe('wrote 6 bytes to accents.txt');
  });

  it('refuses a path that leaves the workspace through a parent segment', async () => {
    // Writing outside the workspace would escape the container's isolation boundary.
    const result = await writeFile(
      { path: '../write-file-outside/secret.txt', content: 'owned' },
      context,
    );
    expect(result.status).toBe('FAILED');
    await expect(readFile(path.join(outside, 'secret.txt'), 'utf8')).resolves.toBe('original\n');
  });

  it('refuses to write through a symbolic link that points out of the workspace', async () => {
    // The link is the interesting case: the lexical path looks entirely innocent.
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    const result = await writeFile({ path: 'link.txt', content: 'owned' }, context);
    expect(result.output).toContain('symbolic link');
    await expect(readFile(path.join(outside, 'secret.txt'), 'utf8')).resolves.toBe('original\n');
  });

  it('reports a workspace root that cannot be resolved at all', async () => {
    // A destroyed workspace must not surface as an unhandled rejection mid-turn.
    const result = await writeFile(
      { path: 'a.txt', content: 'x' },
      {
        workspaceRoot: path.join(root, 'gone'),
      },
    );
    expect(result).toMatchObject({ status: 'FAILED', output: 'path could not be resolved' });
  });

  it('fails when a parent of the target is an ordinary file', async () => {
    // The kernel refuses this; the model gets a message naming the path instead of an exception.
    await writeFileToDisk(path.join(root, 'blocker'), 'x', 'utf8');
    const result = await writeFile({ path: 'blocker/child.txt', content: 'x' }, context);
    expect(result.status).toBe('FAILED');
    expect(result.output).toContain('could not write blocker/child.txt');
  });
});
