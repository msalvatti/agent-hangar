/**
 * Temporary directories that stand in for `/workspace` in tests.
 *
 * Layer: test double.
 *
 * Every suite that exercises the tools needs a real directory: path confinement is about what the
 * kernel does with symbolic links, and no in-memory filesystem reproduces that faithfully.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Prefix that makes a stray directory obviously ours. */
const PREFIX = 'agent-hangar-runtime-';

/**
 * Creates an empty temporary directory.
 *
 * @param name - Short label appended to the prefix, to tell suites apart in a stray directory.
 * @returns The absolute path.
 */
export async function makeTempDir(name: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `${PREFIX}${name}-`));
}

/**
 * Removes a directory created by {@link makeTempDir}.
 *
 * @param directory - Path returned by {@link makeTempDir}.
 */
export async function removeTempDir(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}
