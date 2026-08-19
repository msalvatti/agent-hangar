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
 * File-system access goes through {@link KeyFileSystem} so the failure paths — lost creation
 * race, unreadable file, malformed content — are exercised by passing an instrumented
 * implementation instead of patching the module registry.
 *
 * Nothing here logs, and no error message ever carries file content: only the path.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
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

/** The only accepted file content: 32 bytes as hex, case-insensitive. */
const HEX_KEY_PATTERN = /^[0-9a-f]{64}$/i;

/** The file-system operations {@link MasterKeyFile} needs, as a narrow port. */
export interface KeyFileSystem {
  /** Creates the containing directory, including missing parents. */
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<string | undefined>;
  /** Reads the key file as text. */
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  /** Reads the key file's metadata; only `mode` is used. */
  stat(path: string): Promise<{ mode: number }>;
  /** Writes the key file, failing when it already exists. */
  writeFile(path: string, data: string, options: { mode: number; flag: 'wx' }): Promise<void>;
}

/** {@link KeyFileSystem} backed by `node:fs/promises`. */
export const nodeKeyFileSystem: KeyFileSystem = { mkdir, readFile, stat, writeFile };

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
   * @throws ConfigError when the file is reachable beyond its owner or does not hold 64 hex
   * characters.
   */
  async load(): Promise<MasterKey> {
    if (this.cached !== null) {
      return this.cached;
    }
    await this.fileSystem.mkdir(dirname(this.path), { recursive: true, mode: KEY_DIRECTORY_MODE });
    await this.createIfMissing();
    await this.assertOwnerOnly();
    const masterKey: MasterKey = { key: await this.readKeyBytes(), version: this.version };
    this.cached = masterKey;
    return masterKey;
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

  /** Refuses a key file that group or other can reach. */
  private async assertOwnerOnly(): Promise<void> {
    const stats = await this.fileSystem.stat(this.path);
    if (isWorldOrGroupReadable(stats.mode)) {
      throw new ConfigError(
        `Master key file ${this.path} is readable by group/others; run: chmod 600 ${this.path}`,
      );
    }
  }

  /**
   * Reads and validates the key material.
   *
   * @returns The decoded 32 key bytes.
   * @throws ConfigError when the content is not 64 hex characters.
   */
  private async readKeyBytes(): Promise<Buffer> {
    const hex = (await this.fileSystem.readFile(this.path, 'utf8')).trim();
    if (!HEX_KEY_PATTERN.test(hex)) {
      throw new ConfigError(
        `Master key file ${this.path} must contain ${MASTER_KEY_BYTES} bytes as 64 hex characters.`,
      );
    }
    return Buffer.from(hex, 'hex');
  }
}
