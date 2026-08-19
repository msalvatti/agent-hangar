/**
 * Unit tests for the file-backed master key provider.
 *
 * Layer: unit.
 * Goal: the key file is created 0600 with 32 random bytes, refused when group or other can reach
 * it or its directory, refused when it is a symbolic link or any other non-regular file, refused
 * when malformed, cached after the first load, and tolerant of a lost creation race.
 * Mocks: the happy paths run against a real temporary directory; the write failure paths use a
 * {@link KeyFileSystem} stub so no permission tricks are needed.
 */
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ConfigError } from '../errors.js';

import type { KeyFileSystem } from './master-key-file.js';
import {
  MasterKeyFile,
  isRegularFile,
  isWorldOrGroupReadable,
  nodeKeyFileSystem,
} from './master-key-file.js';
import { MASTER_KEY_BYTES, MASTER_KEY_VERSION } from './master-key.js';

const KEY_HEX = 'a'.repeat(64);
const OTHER_KEY_HEX = 'b'.repeat(64);

const roots: string[] = [];

/**
 * Creates a throwaway directory that is removed after the test.
 *
 * @returns Absolute path of the fresh directory.
 */
async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ah-key-'));
  roots.push(root);
  return root;
}

/**
 * Wraps the real file system, replacing `writeFile` with a rejection.
 *
 * @param error - Value the stubbed `writeFile` rejects with.
 * @returns A file-system port whose other operations still hit the disk.
 */
function fileSystemFailingWrite(error: unknown): KeyFileSystem {
  return {
    ...nodeKeyFileSystem,
    // Thrown after a tick so the rejection reaches the caller exactly as `fs` would deliver it,
    // including values that are not `Error` instances.
    writeFile: async (): Promise<void> => {
      await Promise.resolve();
      throw error;
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('isWorldOrGroupReadable', () => {
  /**
   * Owner-only modes are the only acceptable ones; every group or other bit — read, write or
   * execute — disqualifies the file, so the check looks at the whole 0o077 mask.
   */
  it.each([
    [0o600, false],
    [0o400, false],
    [0o700, false],
    [0o640, true],
    [0o604, true],
    [0o610, true],
    [0o777, true],
  ])('reports mode %s as reachable by others: %s', (mode, expected) => {
    expect(isWorldOrGroupReadable(mode)).toBe(expected);
  });

  /**
   * `stat` returns the file-type bits alongside the permissions; they must not be mistaken for
   * group or other access.
   */
  it('ignores the file-type bits of a stat mode', () => {
    expect(isWorldOrGroupReadable(0o100600)).toBe(false);
  });
});

describe('isRegularFile', () => {
  /**
   * Only a regular file may hold the key. The mode word carries the file type in its high bits, so
   * every other kind of node the path could name has to be told apart from it.
   */
  it.each([
    ['regular file', 0o100600, true],
    ['named pipe', 0o010600, false],
    ['directory', 0o040700, false],
    ['character device', 0o020600, false],
    ['socket', 0o140600, false],
  ])('classifies a %s', (_label, mode, expected) => {
    expect(isRegularFile(mode)).toBe(expected);
  });
});

describe('MasterKeyFile', () => {
  /**
   * First run of the app: the directory and the key file do not exist yet. The file must appear
   * with owner-only permissions and 32 bytes of hex, because everything else in the secrets store
   * is only as private as this file.
   */
  it('creates a 0600 key file and its directory when missing', async () => {
    const root = await makeRoot();
    const path = join(root, 'nested', 'master.key');

    const masterKey = await new MasterKeyFile({ path }).load();

    expect(masterKey.key).toHaveLength(MASTER_KEY_BYTES);
    expect(masterKey.version).toBe(MASTER_KEY_VERSION);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, 'nested'))).mode & 0o077).toBe(0);
    expect(await readFile(path, 'utf8')).toMatch(/^[0-9a-f]{64}\n$/);
  });

  /**
   * Two runs in a row must not produce the same key by accident: the file is seeded from
   * `randomBytes`, so independent directories yield independent keys.
   */
  it('generates a different key for each new file', async () => {
    const first = await new MasterKeyFile({ path: join(await makeRoot(), 'master.key') }).load();
    const second = await new MasterKeyFile({ path: join(await makeRoot(), 'master.key') }).load();

    expect(first.key.equals(second.key)).toBe(false);
  });

  /**
   * An existing key file is the normal case; its content is loaded verbatim and a caller-supplied
   * version is carried through to every envelope written with it.
   */
  it('loads an existing key file and preserves the version', async () => {
    const path = join(await makeRoot(), 'master.key');
    await writeFile(path, `${KEY_HEX}\n`, { mode: 0o600 });

    const masterKey = await new MasterKeyFile({ path, version: 2 }).load();

    expect(masterKey.key.toString('hex')).toBe(KEY_HEX);
    expect(masterKey.version).toBe(2);
  });

  /**
   * Hex is case-insensitive; a key file written by another tool in upper case must decode to the
   * same bytes rather than being refused.
   */
  it('accepts upper-case hex', async () => {
    const path = join(await makeRoot(), 'master.key');
    await writeFile(path, KEY_HEX.toUpperCase(), { mode: 0o600 });

    const masterKey = await new MasterKeyFile({ path }).load();

    expect(masterKey.key.toString('hex')).toBe(KEY_HEX);
  });

  /**
   * The key is read once per process: a running worker must keep decrypting with the key it
   * started with even if the file is replaced underneath it.
   */
  it('caches the key after the first load', async () => {
    const path = join(await makeRoot(), 'master.key');
    await writeFile(path, `${KEY_HEX}\n`, { mode: 0o600 });
    const provider = new MasterKeyFile({ path });
    const first = await provider.load();

    await writeFile(path, `${OTHER_KEY_HEX}\n`, { mode: 0o600 });
    const second = await provider.load();

    expect(second).toBe(first);
    expect(second.key.toString('hex')).toBe(KEY_HEX);
  });

  /**
   * A key any other account can read is a compromised key. Both the world bit and the group bit
   * alone must be refused, and the message has to tell the operator exactly how to fix it.
   */
  it.each([0o644, 0o640, 0o604, 0o660])('refuses a key file with mode %s', async (mode) => {
    const path = join(await makeRoot(), 'master.key');
    await writeFile(path, `${KEY_HEX}\n`, { mode });

    const load = new MasterKeyFile({ path }).load();

    await expect(load).rejects.toThrow(ConfigError);
    await expect(load).rejects.toThrow(`chmod 600 ${path}`);
  });

  /**
   * `mkdir` applies its mode only when it creates the directory, so a directory that already
   * exists keeps whatever permissions it had. Anyone who can write there can replace the key file
   * regardless of the file's own mode, so a reachable directory is refused before anything is
   * written or read.
   */
  it.each([0o755, 0o750, 0o705, 0o770])('refuses a key directory with mode %s', async (mode) => {
    const root = await makeRoot();
    const directory = join(root, 'keys');
    await mkdir(directory);
    await chmod(directory, mode);
    const path = join(directory, 'master.key');

    const load = new MasterKeyFile({ path }).load();

    await expect(load).rejects.toThrow(ConfigError);
    await expect(load).rejects.toThrow(`chmod 700 ${directory}`);
  });

  /**
   * A symbolic link in the key file's place would redirect the read to material another account
   * controls, and `stat` follows links so the mode check would pass. `O_NOFOLLOW` refuses the open
   * outright, and nothing is created because the link already occupies the path.
   */
  it('refuses a key file that is a symbolic link', async () => {
    const root = await makeRoot();
    const target = join(root, 'planted.key');
    await writeFile(target, `${OTHER_KEY_HEX}\n`, { mode: 0o600 });
    const path = join(root, 'master.key');
    await symlink(target, path);

    const load = new MasterKeyFile({ path }).load();

    await expect(load).rejects.toThrow(ConfigError);
    await expect(load).rejects.toThrow('is a symbolic link');
  });

  /**
   * The permission check and the read run against one open handle, so a file swapped between the
   * two cannot slip through. Verified by making the port hand back a handle whose `stat` reports a
   * 0600 file while its content is the key that is actually returned.
   */
  it('reads the key from the same handle it checked the permissions of', async () => {
    const path = join(await makeRoot(), 'master.key');
    await writeFile(path, `${KEY_HEX}\n`, { mode: 0o600 });
    const opened: string[] = [];
    const fileSystem: KeyFileSystem = {
      ...nodeKeyFileSystem,
      open: async (target, flags) => {
        opened.push(target);
        return nodeKeyFileSystem.open(target, flags);
      },
    };

    const masterKey = await new MasterKeyFile({ path, fileSystem }).load();

    expect(masterKey.key.toString('hex')).toBe(KEY_HEX);
    expect(opened).toEqual([path]);
  });

  /**
   * Creation tolerates `EEXIST`, so a named pipe already sitting at the path is adopted as if it
   * were the key file. A blocking `open` on a pipe with no writer never returns, which would hang
   * startup outright; the open is therefore non-blocking and the handle is refused on its type.
   * The assertion that this test terminates at all is the point of it.
   */
  it('refuses a key file that is a named pipe instead of blocking on it', async () => {
    const path = join(await makeRoot(), 'master.key');
    execFileSync('mkfifo', ['-m', '600', path]);

    const load = new MasterKeyFile({ path }).load();

    await expect(load).rejects.toThrow(ConfigError);
    await expect(load).rejects.toThrow('is not a regular file');
  });

  /**
   * A directory at the path is the same class of mistake and must be refused on its type rather
   * than read as if it held hex.
   */
  it('refuses a key path that is a directory', async () => {
    const path = join(await makeRoot(), 'master.key');
    await mkdir(path, { mode: 0o700 });

    const load = new MasterKeyFile({ path }).load();

    await expect(load).rejects.toThrow(ConfigError);
    await expect(load).rejects.toThrow('is not a regular file');
  });

  /**
   * An open failure that is not a refused symbolic link — a deleted file, a denied read — is a
   * real problem the operator has to see, so it propagates untouched.
   */
  it('rethrows an open failure that is not a symbolic link', async () => {
    const path = join(await makeRoot(), 'master.key');
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const fileSystem: KeyFileSystem = {
      ...nodeKeyFileSystem,
      open: async (): Promise<never> => {
        await Promise.resolve();
        throw denied;
      },
    };

    const load = new MasterKeyFile({ path, fileSystem }).load();

    await expect(load).rejects.toBe(denied);
  });

  /**
   * Content that is not exactly 32 bytes of hex would silently produce a shorter AES key or throw
   * deep inside `node:crypto`; it is rejected with a message that names the file but never quotes
   * its content. Surrounding whitespace is refused rather than trimmed away: a file that a half
   * finished write left padded is not a key file, and only the single newline this provider writes
   * itself is tolerated.
   */
  it.each([
    ['too short', 'a'.repeat(63)],
    ['too long', 'a'.repeat(65)],
    ['not hex', 'z'.repeat(64)],
    ['empty', ''],
    ['leading whitespace', ` ${'a'.repeat(64)}`],
    ['leading newline', `\n${'a'.repeat(64)}`],
    ['tab padded', `\t${'a'.repeat(64)}\t`],
    ['two trailing newlines', `${'a'.repeat(64)}\n\n`],
    ['carriage return', `${'a'.repeat(64)}\r\n`],
  ])('refuses key file content that is %s', async (_label, content) => {
    const path = join(await makeRoot(), 'master.key');
    await writeFile(path, content, { mode: 0o600 });

    const error = await new MasterKeyFile({ path }).load().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ConfigError);
    // The exact message proves the rejected content is never quoted back to the caller.
    expect((error as ConfigError).message).toBe(
      `Master key file ${path} must contain ${MASTER_KEY_BYTES} bytes as 64 hex characters.`,
    );
  });

  /**
   * Two processes starting at the same time both try to create the file; the loser gets `EEXIST`
   * and must adopt the winner's key instead of failing or overwriting it.
   */
  it('adopts the existing key when it loses the creation race', async () => {
    const path = join(await makeRoot(), 'master.key');
    await writeFile(path, `${KEY_HEX}\n`, { mode: 0o600 });
    const raceError = Object.assign(new Error('file already exists'), { code: 'EEXIST' });

    const masterKey = await new MasterKeyFile({
      path,
      fileSystem: fileSystemFailingWrite(raceError),
    }).load();

    expect(masterKey.key.toString('hex')).toBe(KEY_HEX);
  });

  /**
   * Any other write failure — a read-only volume, a full disk — is a real problem the operator
   * has to see, so it is rethrown untouched instead of being mistaken for a lost race.
   */
  it('rethrows a write failure that is not a lost race', async () => {
    const path = join(await makeRoot(), 'master.key');
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });

    const load = new MasterKeyFile({ path, fileSystem: fileSystemFailingWrite(denied) }).load();

    await expect(load).rejects.toBe(denied);
  });

  /**
   * A rejection that is not an `Error` at all cannot be classified, so it must propagate rather
   * than be swallowed as a race.
   */
  it('rethrows a non-Error write rejection', async () => {
    const path = join(await makeRoot(), 'master.key');

    const load = new MasterKeyFile({ path, fileSystem: fileSystemFailingWrite('broken') }).load();

    await expect(load).rejects.toBe('broken');
  });
});
