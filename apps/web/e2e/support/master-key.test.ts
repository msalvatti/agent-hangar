/**
 * Unit tests for the master key a real-stack run writes.
 *
 * Layer: unit test.
 *
 * These run against a real temporary directory rather than an injected file system. What is being
 * pinned is the behaviour of the operating system's own calls — `writeFileSync` applies its `mode`
 * only when it creates the file, and `mkdirSync` filters its own through the umask — and a double
 * that recorded the mode it was handed would report success in exactly the case that fails.
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isWorldOrGroupReadable } from '@agent-hangar/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MASTER_KEY_DIR_MODE, MASTER_KEY_MODE, writeMasterKey } from './master-key';

/** Mask selecting the permission bits of a `stat` mode. */
const PERMISSION_BITS = 0o777;

/** Permissions wide enough for the secrets module to refuse the key. */
const WORLD_READABLE = 0o644;

/** Directory permissions wide enough for the secrets module to refuse the key. */
const WORLD_READABLE_DIR = 0o755;

/** A 32-byte key rendered as hex, followed by the newline the file ends with. */
const KEY_FILE_PATTERN = /^[0-9a-f]{64}\n$/u;

let root: string;
let paths: { masterKeyPath: string; tmpDir: string };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ah-w2c-key-'));
  const tmpDir = join(root, '.tmp');
  paths = { tmpDir, masterKeyPath: join(tmpDir, 'master.key') };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Permission bits of a path, with the file-type bits masked off. */
function permissionsOf(path: string): number {
  return statSync(path).mode & PERMISSION_BITS;
}

describe('writeMasterKey', () => {
  /**
   * Proves a first run produces the file the secrets module accepts: a 32-byte key in hex on one
   * line, reachable by its owner alone, in a directory nobody else can reach either.
   */
  it('writes a key the secrets module will accept', () => {
    writeMasterKey(paths);

    expect(readFileSync(paths.masterKeyPath, 'utf8')).toMatch(KEY_FILE_PATTERN);
    expect(permissionsOf(paths.masterKeyPath)).toBe(MASTER_KEY_MODE);
    expect(permissionsOf(paths.tmpDir)).toBe(MASTER_KEY_DIR_MODE);
    // The exact mode above is the intent; this is the rule the secrets module actually applies to
    // both, so the two assertions together fail for the right reason whichever one drifts.
    expect(isWorldOrGroupReadable(statSync(paths.masterKeyPath).mode)).toBe(false);
    expect(isWorldOrGroupReadable(statSync(paths.tmpDir).mode)).toBe(false);
  });

  /**
   * Proves the permissions of a key file left by an earlier run are tightened rather than
   * inherited. `writeFileSync` applies its `mode` only when it creates the file, so overwriting a
   * world-readable `master.key` would leave the fresh key exposed and make the secrets module
   * refuse it — the run would fail at boot, with the key readable in the meantime.
   */
  it('tightens the permissions of a key file left behind by an earlier run', () => {
    mkdirSync(paths.tmpDir, { recursive: true });
    writeFileSync(paths.masterKeyPath, 'stale\n');
    chmodSync(paths.masterKeyPath, WORLD_READABLE);

    writeMasterKey(paths);

    expect(permissionsOf(paths.masterKeyPath)).toBe(MASTER_KEY_MODE);
    expect(isWorldOrGroupReadable(statSync(paths.masterKeyPath).mode)).toBe(false);
    expect(readFileSync(paths.masterKeyPath, 'utf8')).toMatch(KEY_FILE_PATTERN);
  });

  /**
   * Proves the same for the directory, which `mkdirSync` leaves alone when it already exists:
   * write access to it is enough to replace the key, so the secrets module refuses a key reachable
   * through a directory group or others can enter.
   */
  it('tightens the permissions of a directory left behind by an earlier run', () => {
    mkdirSync(paths.tmpDir, { recursive: true });
    chmodSync(paths.tmpDir, WORLD_READABLE_DIR);

    writeMasterKey(paths);

    expect(permissionsOf(paths.tmpDir)).toBe(MASTER_KEY_DIR_MODE);
    expect(isWorldOrGroupReadable(statSync(paths.tmpDir).mode)).toBe(false);
  });
});
