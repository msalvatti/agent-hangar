/**
 * Unit tests for the temporary-directory helper.
 *
 * Layer: unit.
 * Goal: the helper creates a real empty directory under the system temp root and removes it
 * again, including a directory that is already gone, so suites can clean up unconditionally.
 * Mocks: none.
 */
import { mkdir, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir, removeTempDir } from './temp-dir.js';

describe('makeTempDir', () => {
  /** Suites rely on the directory existing and starting out empty. */
  it('creates an empty directory under the system temporary root', async () => {
    const directory = await makeTempDir('probe');
    try {
      expect(directory.startsWith(tmpdir())).toBe(true);
      expect((await stat(directory)).isDirectory()).toBe(true);
      await expect(readdir(directory)).resolves.toStrictEqual([]);
    } finally {
      await removeTempDir(directory);
    }
  });
});

describe('removeTempDir', () => {
  /** `afterEach` runs even when the test failed before creating anything. */
  it('removes a populated directory and tolerates one that is already gone', async () => {
    const directory = await makeTempDir('cleanup');
    await mkdir(path.join(directory, 'nested'), { recursive: true });
    await removeTempDir(directory);
    await expect(stat(directory)).rejects.toThrow();
    await expect(removeTempDir(directory)).resolves.toBeUndefined();
  });
});
