/**
 * File-backed master key provider (`~/.agent-hangar/master.key` by default).
 *
 * Layer: service (adapter).
 *
 * The key file is created atomically with `O_EXCL` and mode 0600, so there is no window in which
 * it exists with wider permissions and two processes starting at once cannot overwrite each
 * other's key. A file that any other account can reach is refused rather than used: the whole
 * secrets store is only as private as this one file.
 *
 * Three separate defences keep another local account from substituting key material:
 *
 * 1. The containing directory is refused when group or other can reach it. `mkdir` only applies
 *    its mode when it actually creates the directory, so an existing wide-open directory would
 *    otherwise go unnoticed — and write access to the directory is enough to replace the file.
 * 2. The file is opened with `O_NOFOLLOW`, so the final path component can never be a symbolic
 *    link pointing at a file some other account controls.
 * 3. The permission check and the read both run against that one open handle, so there is no
 *    window between checking and reading in which the file could be swapped.
 *
 * Ancestors above the containing directory are not walked: on a single-user local install the
 * directory check plus `O_NOFOLLOW` closes the reachable paths, and a hostile ancestor would
 * either fail the same permission check or deny traversal outright. `O_NOFOLLOW` is a POSIX flag;
 * this provider targets Linux and macOS.
 *
 * File-system access goes through {@link KeyFileSystem} so the failure paths — lost creation
 * race, unreadable file, malformed content — are exercised by passing an instrumented
 * implementation instead of patching the module registry.
 *
 * Nothing here logs, and no error message ever carries file content: only the path.
 */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { ConfigError } from '../errors.js';

import type { MasterKey, MasterKeyProvider } from './master-key.js';
import { MASTER_KEY_BYTES, MASTER_KEY_VERSION } from './master-key.js';

/** Permission bits the key file is created with: owner read/write only. */
const KEY_FILE_MODE = 0o600;

/** Permission bits the containing directory is created with: owner access only. */
const KEY_DIRECTORY_MODE = 0o700;

/** Group and other permission bits; any of them set makes the key file unusable. */
const GROUP_AND_OTHER_BITS = 0o077;

/** Flags the key file is read with: read-only, and never through a symbolic link. */
const KEY_FILE_OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;

/** The only accepted file content: 32 bytes as hex, case-insensitive. */
const HEX_KEY_PATTERN = /^[0-9a-f]{64}$/i;

/** An open handle on the key file; the subset of `FileHandle` this provider uses. */
export interface KeyFileHandle {
  /** Reads the metadata of the open file itself, not of the path it was opened from. */
  stat(): Promise<{ mode: number }>;
  /** Reads the whole file as text. */
  readFile(options: { encoding: 'utf8' }): Promise<string>;
  /** Releases the handle. */
  close(): Promise<void>;
}

/** The file-system operations {@link MasterKeyFile} needs, as a narrow port. */
export interface KeyFileSystem {
  /** Creates the containing directory, including missing parents. */
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<string | undefined>;
  /** Opens the key file; the caller closes the returned handle. */
  open(path: string, flags: number): Promise<KeyFileHandle>;
  /** Reads the containing directory's metadata; only `mode` is used. */
  stat(path: string): Promise<{ mode: number }>;
  /** Writes the key file, failing when it already exists. */
  writeFile(path: string, data: string, options: { mode: number; flag: 'wx' }): Promise<void>;
}

/** {@link KeyFileSystem} backed by `node:fs/promises`. */
export const nodeKeyFileSystem: KeyFileSystem = { mkdir, open, stat, writeFile };

/** Construction options of {@link MasterKeyFile}. */
export interface MasterKeyFileOptions {
  /** Absolute path of the key file (`MASTER_KEY_PATH`). */
  path: string;
  /** Version stamped on envelopes; defaults to {@link MASTER_KEY_VERSION}. */
  version?: number;
  /** File-system operations; defaults to {@link nodeKeyFileSystem}. */
  fileSystem?: KeyFileSystem;
}

/**
 * Reports whether a `stat` mode grants any access to group or other.
 *
 * @param mode - Mode word as returned by `stat`; file-type bits are ignored.
 * @returns `true` when at least one group or other permission bit is set.
 */
export function isWorldOrGroupReadable(mode: number): boolean {
  return (mode & GROUP_AND_OTHER_BITS) !== 0;
}

/**
 * Reports whether a failed write lost the race to create the file.
 *
 * `EEXIST` is the expected outcome on every load after the first, because the file is always
 * opened with `wx`.
 *
 * @param error - Value thrown by `writeFile`.
 * @returns `true` when the file already existed.
 */
function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

/**
 * Reports whether a failed open refused to traverse a symbolic link.
 *
 * `O_NOFOLLOW` reports `ELOOP` when the final path component is a link, which is the signature of
 * an attempt to point the provider at key material it does not own.
 *
 * @param error - Value thrown by `open`.
 * @returns `true` when the path is a symbolic link.
 */
function isSymbolicLinkError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ELOOP';
}

/**
 * Decodes the key file's content.
 *
 * Exactly 64 hex characters are accepted, with at most one trailing newline — the byte the
 * provider itself writes. Leading whitespace, inner whitespace and repeated line breaks are
 * refused rather than trimmed away, so a truncated or half-written file cannot pass as valid.
 *
 * @param content - Raw file content.
 * @param path - Path quoted in the failure message; the content never is.
 * @returns The decoded 32 key bytes.
 * @throws ConfigError when the content is not 64 hex characters.
 */
function decodeKeyHex(content: string, path: string): Buffer {
  const hex = content.endsWith('\n') ? content.slice(0, -1) : content;
  if (!HEX_KEY_PATTERN.test(hex)) {
    throw new ConfigError(
      `Master key file ${path} must contain ${MASTER_KEY_BYTES} bytes as 64 hex characters.`,
    );
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Master key stored in a 0600 file, generated on first use.
 *
 * The key is read once and cached for the lifetime of the instance, so a running process is
 * unaffected by later changes to the file.
 */
export class MasterKeyFile implements MasterKeyProvider {
  private readonly path: string;
  private readonly version: number;
  private readonly fileSystem: KeyFileSystem;
  private cached: MasterKey | null = null;

  /**
   * @param options - Key file path, optional version and optional file-system port.
   */
  constructor(options: MasterKeyFileOptions) {
    this.path = options.path;
    this.version = options.version ?? MASTER_KEY_VERSION;
    this.fileSystem = options.fileSystem ?? nodeKeyFileSystem;
  }

  /**
   * Loads the master key, creating the file on first use.
   *
   * @returns The cached master key.
   * @throws ConfigError when the directory or the file is reachable beyond its owner, when the
   * path is a symbolic link, or when the content is not 64 hex characters.
   */
  async load(): Promise<MasterKey> {
    if (this.cached !== null) {
      return this.cached;
    }
    const directory = dirname(this.path);
    await this.fileSystem.mkdir(directory, { recursive: true, mode: KEY_DIRECTORY_MODE });
    await this.assertDirectoryOwnerOnly(directory);
    await this.createIfMissing();
    const masterKey: MasterKey = { key: await this.readKeyBytes(), version: this.version };
    this.cached = masterKey;
    return masterKey;
  }

  /**
   * Refuses a containing directory that group or other can reach.
   *
   * `mkdir` applies {@link KEY_DIRECTORY_MODE} only when it creates the directory, so a directory
   * that already existed keeps whatever permissions it had. Write access to it is enough to
   * replace the key file, which is why this is checked before anything is written or read.
   *
   * @param directory - Directory holding the key file.
   * @throws ConfigError when any group or other bit is set.
   */
  private async assertDirectoryOwnerOnly(directory: string): Promise<void> {
    const stats = await this.fileSystem.stat(directory);
    if (isWorldOrGroupReadable(stats.mode)) {
      throw new ConfigError(
        `Master key directory ${directory} is reachable by group/others; run: chmod 700 ${directory}`,
      );
    }
  }

  /** Creates the key file atomically, tolerating the case where it is already there. */
  private async createIfMissing(): Promise<void> {
    const hex = randomBytes(MASTER_KEY_BYTES).toString('hex');
    try {
      await this.fileSystem.writeFile(this.path, `${hex}\n`, {
        mode: KEY_FILE_MODE,
        flag: 'wx',
      });
    } catch (error) {
      if (!isFileExistsError(error)) {
        throw error;
      }
    }
  }

  /**
   * Opens the key file once, then checks its permissions and reads it through that same handle.
   *
   * Checking the path and reading the path separately would leave a window in which the file
   * could be replaced between the two, so both run against the open file itself.
   *
   * @returns The decoded 32 key bytes.
   * @throws ConfigError when the path is a symbolic link, when group or other can reach the file,
   * or when the content is not 64 hex characters.
   */
  private async readKeyBytes(): Promise<Buffer> {
    const handle = await this.openKeyFile();
    try {
      const stats = await handle.stat();
      if (isWorldOrGroupReadable(stats.mode)) {
        throw new ConfigError(
          `Master key file ${this.path} is readable by group/others; run: chmod 600 ${this.path}`,
        );
      }
      return decodeKeyHex(await handle.readFile({ encoding: 'utf8' }), this.path);
    } finally {
      await handle.close();
    }
  }

  /**
   * Opens the key file, refusing to follow a symbolic link.
   *
   * @returns An open read-only handle on the file itself.
   * @throws ConfigError when the path is a symbolic link.
   */
  private async openKeyFile(): Promise<KeyFileHandle> {
    try {
      return await this.fileSystem.open(this.path, KEY_FILE_OPEN_FLAGS);
    } catch (error) {
      if (isSymbolicLinkError(error)) {
        throw new ConfigError(
          `Master key file ${this.path} is a symbolic link; it must be a regular file.`,
        );
      }
      throw error;
    }
  }
}
