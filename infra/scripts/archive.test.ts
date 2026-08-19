/**
 * Unit tests for `infra/scripts/archive.sh`.
 *
 * Layer: unit (spawns bash with PATH shims; no real Docker).
 * Goal: teardown runs compose `down -v --remove-orphans`, reaps only the resolved instance's
 * workspace containers (by label, never by name prefix), removes or keeps the env file per
 * `--keep-env`, `--dry-run` performs nothing, and every case exits 0 except an unknown flag.
 * Mocks: docker via `infra/scripts/testing/shims.ts`.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createShimDir, readShimLog, spawnScript } from './testing/shims.js';

const scriptPath = fileURLToPath(new URL('./archive.sh', import.meta.url));

const dirs: string[] = [];

function sandbox(): { dir: string; envFile: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ah-archive-'));
  dirs.push(dir);
  const envFile = join(dir, '.env.local');
  writeFileSync(envFile, '# placeholder env file\n');
  return { dir, envFile, log: join(dir, 'log') };
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('archive.sh', () => {
  /**
   * The full teardown sequence: compose down, then reap the workspace containers the shim
   * reports, then remove the env file — in that order, scoped to the resolved instance.
   */
  it('tears down compose, reaps workspace containers by label, and removes the env file', () => {
    const { envFile, log } = sandbox();
    const shimDir = createShimDir({ log, docker: { psIds: ['abc123', 'def456'] } });
    const result = spawnScript(scriptPath, {
      shimDir,
      env: { HOME: '/tmp', AH_INSTANCE: 'feat-x', AH_ENV_FILE: envFile, AH_SHIM_LOG: log },
    });
    expect(result.status).toBe(0);
    const entries = readShimLog(log);
    const down = entries.findIndex((line) => line.includes('down -v --remove-orphans'));
    const ps = entries.findIndex((line) =>
      line.includes('ps -aq --filter label=ah.instance=feat-x'),
    );
    const rm = entries.findIndex((line) => line.includes('rm -f abc123 def456'));
    expect(down).toBeGreaterThanOrEqual(0);
    expect(ps).toBeGreaterThan(down);
    expect(rm).toBeGreaterThan(ps);
    expect(existsSync(envFile)).toBe(false);
  });

  /**
   * `--keep-env` leaves the env file in place.
   */
  it('keeps the env file with --keep-env', () => {
    const { envFile, log } = sandbox();
    const shimDir = createShimDir({ log, docker: { psIds: [] } });
    spawnScript(scriptPath, {
      shimDir,
      args: ['--keep-env'],
      env: { HOME: '/tmp', AH_INSTANCE: 'feat-x', AH_ENV_FILE: envFile, AH_SHIM_LOG: log },
    });
    expect(existsSync(envFile)).toBe(true);
  });

  /**
   * When no workspace containers exist, `docker rm -f` is never called and the "no containers"
   * message is printed instead.
   */
  it('prints "no workspace containers" and skips rm -f when none exist', () => {
    const { envFile, log } = sandbox();
    const shimDir = createShimDir({ log, docker: { psIds: [] } });
    const result = spawnScript(scriptPath, {
      shimDir,
      env: { HOME: '/tmp', AH_INSTANCE: 'feat-x', AH_ENV_FILE: envFile, AH_SHIM_LOG: log },
    });
    expect(result.stdout).toContain('No workspace containers for instance feat-x');
    expect(readShimLog(log).some((line) => line.startsWith('docker rm'))).toBe(false);
  });

  /**
   * `--dry-run` prints the three planned actions, calls neither `down` nor `rm`, and leaves the
   * env file in place.
   */
  it('--dry-run performs nothing and prints the plan', () => {
    const { envFile, log } = sandbox();
    const shimDir = createShimDir({ log, docker: { psIds: ['abc123'] } });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--dry-run'],
      env: { HOME: '/tmp', AH_INSTANCE: 'feat-x', AH_ENV_FILE: envFile, AH_SHIM_LOG: log },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('agent-hangar-feat-x');
    expect(result.stdout).toContain('ah.instance=feat-x');
    expect(readShimLog(log)).toEqual([]);
    expect(existsSync(envFile)).toBe(true);
  });

  /**
   * A Conductor-style workspace name is slugified into the instance filter.
   */
  it('slugifies CONDUCTOR_WORKSPACE_NAME into the instance filter', () => {
    const { envFile, log } = sandbox();
    const shimDir = createShimDir({ log, docker: { psIds: [] } });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--dry-run'],
      env: {
        HOME: '/tmp',
        CONDUCTOR_WORKSPACE_NAME: 'Feature ABC',
        AH_ENV_FILE: envFile,
        AH_SHIM_LOG: log,
      },
    });
    expect(result.stdout).toContain('ah.instance=feature-abc');
  });

  /**
   * An unrecognised flag prints usage and exits 2 without touching anything.
   */
  it('rejects an unknown flag', () => {
    const { envFile, log } = sandbox();
    const shimDir = createShimDir({ log });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--nope'],
      env: { HOME: '/tmp', AH_ENV_FILE: envFile, AH_SHIM_LOG: log },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage');
    expect(readShimLog(log)).toEqual([]);
  });
});
