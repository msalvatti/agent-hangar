/**
 * Unit tests for `infra/scripts/rotate-key.sh`.
 *
 * Layer: unit (spawns bash with PATH shims; no real Postgres, no real `tsx`).
 * Goal: without `--yes` nothing runs and the plan is printed; a successful rotation swaps the key
 * file atomically and keeps a mode-600 backup; a failed rotation leaves the current key
 * untouched and removes the half-written `.new`; a pre-existing `.new` is refused unless
 * `--resume`, in which case `openssl` is not called again.
 * Mocks: `openssl` via `infra/scripts/testing/shims.ts`; a bespoke `AH_DOCTOR_HELPER_CMD` shim
 * standing in for the secrets-status/rotate-key helpers.
 */
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createShimDir, readShimLog, spawnScript, writeExtraShim } from './testing/shims.js';

const scriptPath = fileURLToPath(new URL('./rotate-key.sh', import.meta.url));

const dirs: string[] = [];

interface Sandbox {
  dir: string;
  log: string;
  keyPath: string;
}

function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'ah-rotate-'));
  dirs.push(dir);
  const keyPath = join(dir, 'master.key');
  writeFileSync(keyPath, `${'a'.repeat(64)}\n`);
  chmodSync(keyPath, 0o600);
  return { dir, log: join(dir, 'log'), keyPath };
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function helperShim(shimDir: string): string {
  return writeExtraShim(
    shimDir,
    'helper.sh',
    [
      'case "$1" in',
      '  *secrets-status*)',
      '    printf \'%s\\n\' "${AH_SHIM_SECRETS_LINES:-GITHUB_PAT=set:ab12}"',
      '    exit "${AH_SHIM_SECRETS_RC:-0}"',
      '    ;;',
      '  *rotate-key*)',
      '    printf \'%s\\n\' "${AH_SHIM_ROTATE_LINE:-rotated 1 secret(s) to keyVersion 2}"',
      '    exit "${AH_SHIM_ROTATE_RC:-0}"',
      '    ;;',
      'esac',
      'exit 9',
    ].join('\n'),
  );
}

function fileMode(path: string): string {
  return (statSync(path).mode & 0o777).toString(8);
}

describe('rotate-key.sh without --yes', () => {
  /**
   * Prints the plan (key path, backup pattern, secret count) and exits 2 without touching
   * anything.
   */
  it('prints the plan and exits 2', () => {
    const box = sandbox();
    const shimDir = createShimDir({ log: box.log });
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      env: {
        HOME: box.dir,
        MASTER_KEY_PATH: box.keyPath,
        AH_SHIM_LOG: box.log,
        AH_DOCTOR_HELPER_CMD: helper,
      },
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain(box.keyPath);
    expect(result.stdout).toContain('bak-');
    expect(result.stdout).toContain('re-encrypts 1 secret(s)');
    expect(readFileSync(box.keyPath, 'utf8')).toBe(`${'a'.repeat(64)}\n`);
    expect(existsSync(`${box.keyPath}.new`)).toBe(false);
  });
});

describe('rotate-key.sh --yes success', () => {
  /**
   * Generates a new key, runs the helper, then swaps the files: the old content is preserved in
   * a mode-600 backup, and the new key (from the shimmed `openssl`) becomes `master.key`.
   */
  it('rotates the key and keeps a mode-600 backup of the old one', () => {
    const box = sandbox();
    const shimDir = createShimDir({ log: box.log });
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--yes'],
      env: {
        HOME: box.dir,
        MASTER_KEY_PATH: box.keyPath,
        AH_SHIM_LOG: box.log,
        AH_DOCTOR_HELPER_CMD: helper,
      },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Master key rotated');

    expect(readFileSync(box.keyPath, 'utf8')).toBe(`${'0'.repeat(64)}\n`);
    expect(fileMode(box.keyPath)).toBe('600');

    const backups = readdirSync(box.dir).filter((name) => name.startsWith('master.key.bak-'));
    expect(backups).toHaveLength(1);
    const backupPath = join(box.dir, backups[0] ?? '');
    expect(readFileSync(backupPath, 'utf8')).toBe(`${'a'.repeat(64)}\n`);
    expect(fileMode(backupPath)).toBe('600');

    expect(existsSync(`${box.keyPath}.new`)).toBe(false);
    expect(readShimLog(box.log)).toContain('openssl rand -hex 32');
  });
});

describe('rotate-key.sh --yes failure', () => {
  /**
   * A failing helper leaves the current key untouched, removes the half-written `.new`, and
   * exits with the helper's own code.
   */
  it('leaves the current key unchanged and removes .new on failure', () => {
    const box = sandbox();
    const shimDir = createShimDir({ log: box.log });
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--yes'],
      env: {
        HOME: box.dir,
        MASTER_KEY_PATH: box.keyPath,
        AH_SHIM_LOG: box.log,
        AH_DOCTOR_HELPER_CMD: helper,
        AH_SHIM_ROTATE_RC: '3',
      },
    });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('Rotation aborted');
    expect(readFileSync(box.keyPath, 'utf8')).toBe(`${'a'.repeat(64)}\n`);
    expect(existsSync(`${box.keyPath}.new`)).toBe(false);
  });
});

describe('rotate-key.sh --resume', () => {
  /**
   * A pre-existing `.new` is refused outright without `--resume`.
   */
  it('refuses a pre-existing .new without --resume', () => {
    const box = sandbox();
    writeFileSync(`${box.keyPath}.new`, `${'b'.repeat(64)}\n`);
    const shimDir = createShimDir({ log: box.log });
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--yes'],
      env: {
        HOME: box.dir,
        MASTER_KEY_PATH: box.keyPath,
        AH_SHIM_LOG: box.log,
        AH_DOCTOR_HELPER_CMD: helper,
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--resume');
    expect(readShimLog(box.log)).toEqual([]);
  });

  /**
   * `--resume` continues with the existing `.new` instead of generating a fresh one — `openssl`
   * is never called — and completes the rotation.
   */
  it('resumes with the existing .new without calling openssl again', () => {
    const box = sandbox();
    writeFileSync(`${box.keyPath}.new`, `${'b'.repeat(64)}\n`);
    const shimDir = createShimDir({ log: box.log });
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--yes', '--resume'],
      env: {
        HOME: box.dir,
        MASTER_KEY_PATH: box.keyPath,
        AH_SHIM_LOG: box.log,
        AH_DOCTOR_HELPER_CMD: helper,
      },
    });
    expect(result.status).toBe(0);
    expect(readShimLog(box.log).some((line) => line.includes('openssl'))).toBe(false);
    expect(readFileSync(box.keyPath, 'utf8')).toBe(`${'b'.repeat(64)}\n`);
  });
});

describe('rotate-key.sh usage', () => {
  /**
   * An unrecognised flag exits 2 with a usage line.
   */
  it('rejects an unknown flag', () => {
    const box = sandbox();
    const shimDir = createShimDir({ log: box.log });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--nope'],
      env: { HOME: box.dir, MASTER_KEY_PATH: box.keyPath, AH_SHIM_LOG: box.log },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage');
  });
});
