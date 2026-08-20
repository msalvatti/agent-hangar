/**
 * Unit tests for `infra/scripts/archive.sh`.
 *
 * Layer: unit (spawns bash with PATH shims; no real Docker).
 * Goal: teardown acts on the instance THIS checkout's env file records — never on the one a stale
 * shell variable derives — refuses outright when the two disagree, runs compose
 * `down -v --remove-orphans`, reaps only that instance's workspace containers (by label, never by
 * name prefix), removes or keeps the env file per `--keep-env`, `--dry-run` performs nothing, and
 * every case exits 0 except an unknown flag and a contradicted instance.
 * Mocks: docker via `infra/scripts/testing/shims.ts`.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createShimDir, readShimLog, spawnScript, writeInstanceEnvFile } from './testing/shims.js';

const scriptPath = fileURLToPath(new URL('./archive.sh', import.meta.url));

const dirs: string[] = [];

interface Checkout {
  /** Temporary directory standing in for one checkout, also its HOME. */
  dir: string;
  /** The `.env.local` that checkout was set up with. */
  envFile: string;
  /** Path the PATH shims append their invocations to. */
  log: string;
}

/**
 * Builds a checkout already set up for one instance: a real env file plus a shim log path.
 *
 * @param instance - Instance the checkout is configured for.
 * @param portBase - Port base recorded in the env file.
 * @returns The checkout's paths.
 */
function checkout(instance = 'feat-x', portBase = 3000): Checkout {
  const dir = mkdtempSync(join(tmpdir(), 'ah-archive-'));
  dirs.push(dir);
  const envFile = join(dir, '.env.local');
  writeInstanceEnvFile(envFile, { instance, portBase, home: dir });
  return { dir, envFile, log: join(dir, 'log') };
}

/**
 * Builds a bare directory with no env file, standing in for a checkout that was never set up.
 *
 * @returns The directory and a shim log path inside it.
 */
function unconfigured(): { dir: string; envFile: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ah-archive-'));
  dirs.push(dir);
  return { dir, envFile: join(dir, '.env.local'), log: join(dir, 'log') };
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('archive.sh instance resolution', () => {
  /**
   * The regression this suite exists for. The instance came from the shell, while `setup.sh`
   * wrote and read the checkout's env file, so archiving a checkout configured for `feat-x` from
   * an ordinary shell tore down the DEFAULT instance's compose stack — and deleted the feat-x
   * checkout's env file on the way out. One instance's containers, another instance's
   * configuration, from a single command meant to clean up one worktree.
   */
  it('acts on the instance the checkout is configured for, not on the shell default', () => {
    const { dir, envFile, log } = checkout('feat-x', 3100);
    const shimDir = createShimDir({ log, docker: { psIds: ['abc123'] } });
    const result = spawnScript(scriptPath, {
      shimDir,
      env: { HOME: dir, AH_ENV_FILE: envFile, AH_SHIM_LOG: log },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Archiving instance "feat-x"');
    expect(result.stdout).toContain('Tearing down compose resources (agent-hangar-feat-x)');
    expect(result.stdout).not.toContain('agent-hangar-default');
    const entries = readShimLog(log);
    expect(entries.some((line) => line.includes('label=ah.instance=default'))).toBe(false);
    expect(entries.some((line) => line.includes('label=ah.instance=feat-x'))).toBe(true);
  });

  /**
   * Two instances side by side: archiving from the checkout set up for `beta` names `beta`,
   * touches only `beta`'s label, and leaves the other checkout's env file exactly where it was.
   */
  it('archives only the checkout it runs in when two instances exist', () => {
    const alpha = checkout('alpha', 3200);
    const beta = checkout('beta', 3300);
    const shimDir = createShimDir({ log: beta.log, docker: { psIds: ['beta-1'] } });
    const result = spawnScript(scriptPath, {
      shimDir,
      env: { HOME: beta.dir, AH_ENV_FILE: beta.envFile, AH_SHIM_LOG: beta.log },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Archiving instance "beta"');
    const entries = readShimLog(beta.log);
    expect(entries.some((line) => line.includes('label=ah.instance=beta'))).toBe(true);
    expect(entries.some((line) => line.includes('alpha'))).toBe(false);
    expect(existsSync(beta.envFile)).toBe(false);
    expect(existsSync(alpha.envFile)).toBe(true);
  });

  /**
   * A shell naming a different instance is neither obeyed nor ignored: the command stops, names
   * both candidates, and destroys nothing.
   */
  it('refuses when the shell contradicts the checkout, and destroys nothing', () => {
    const { dir, envFile, log } = checkout('alpha', 3200);
    const shimDir = createShimDir({ log, docker: { psIds: ['abc123'] } });
    const result = spawnScript(scriptPath, {
      shimDir,
      env: { HOME: dir, AH_ENV_FILE: envFile, AH_INSTANCE: 'beta', AH_SHIM_LOG: log },
    });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('"beta"');
    expect(result.stderr).toContain('"alpha"');
    expect(result.stderr).toContain('Refusing to guess');
    expect(readShimLog(log)).toEqual([]);
    expect(existsSync(envFile)).toBe(true);
  });

  /**
   * A shell that agrees with the file is not a conflict — Conductor exports the workspace name in
   * every shell inside the worktree, and setup wrote the file from it.
   */
  it('proceeds when the shell names the same instance the checkout records', () => {
    const { dir, envFile, log } = checkout('feat-x', 3100);
    const shimDir = createShimDir({ log, docker: { psIds: [] } });
    const result = spawnScript(scriptPath, {
      shimDir,
      env: { HOME: dir, AH_ENV_FILE: envFile, AH_INSTANCE: 'feat-x', AH_SHIM_LOG: log },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No workspace containers for instance feat-x');
  });
});

describe('archive.sh', () => {
  /**
   * The full teardown sequence: compose down, then reap the workspace containers the shim
   * reports, then remove the env file — in that order, scoped to the resolved instance.
   */
  it('tears down compose, reaps workspace containers by label, and removes the env file', () => {
    const { dir, envFile, log } = checkout();
    const shimDir = createShimDir({ log, docker: { psIds: ['abc123', 'def456'] } });
    const result = spawnScript(scriptPath, {
      shimDir,
      env: { HOME: dir, AH_ENV_FILE: envFile, AH_SHIM_LOG: log },
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
    const { dir, envFile, log } = checkout();
    const shimDir = createShimDir({ log, docker: { psIds: [] } });
    spawnScript(scriptPath, {
      shimDir,
      args: ['--keep-env'],
      env: { HOME: dir, AH_ENV_FILE: envFile, AH_SHIM_LOG: log },
    });
    expect(existsSync(envFile)).toBe(true);
  });

  /**
   * When no workspace containers exist, `docker rm -f` is never called and the "no containers"
   * message is printed instead.
   */
  it('prints "no workspace containers" and skips rm -f when none exist', () => {
    const { dir, envFile, log } = checkout();
    const shimDir = createShimDir({ log, docker: { psIds: [] } });
    const result = spawnScript(scriptPath, {
      shimDir,
      env: { HOME: dir, AH_ENV_FILE: envFile, AH_SHIM_LOG: log },
    });
    expect(result.stdout).toContain('No workspace containers for instance feat-x');
    expect(readShimLog(log).some((line) => line.startsWith('docker rm'))).toBe(false);
  });

  /**
   * An id carrying whitespace stays a single argument to `docker rm`: the lookup output is split
   * on line boundaries into an array, so argument count follows line count, never the whitespace
   * inside a line.
   */
  it('passes an id containing whitespace as one argument', () => {
    const { dir, envFile, log } = checkout();
    const shimDir = createShimDir({ log, docker: { psIds: ['abc 123'] } });
    const result = spawnScript(scriptPath, {
      shimDir,
      env: { HOME: dir, AH_ENV_FILE: envFile, AH_SHIM_LOG: log },
    });
    expect(result.status).toBe(0);
    expect(readShimLog(log).filter((line) => line.startsWith('rm-arg '))).toEqual([
      'rm-arg abc 123',
    ]);
    expect(result.stdout).toContain('Removed 1 workspace container(s)');
  });

  /**
   * Teardown is best-effort end to end: with Docker unreachable both the compose teardown and the
   * container lookup fail, yet the run still reaches the env-file step, removes it, and exits 0.
   * A lookup failure that propagated under `set -e` would abort before that last step, which is
   * the one step that never needed Docker in the first place.
   */
  it('still removes the env file when Docker is unreachable', () => {
    const { dir, envFile, log } = checkout();
    const shimDir = createShimDir({ log, docker: { availability: 'down' } });
    const result = spawnScript(scriptPath, {
      shimDir,
      env: { HOME: dir, AH_ENV_FILE: envFile, AH_SHIM_LOG: log },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('compose teardown failed');
    expect(result.stderr).toContain('could not list workspace containers');
    expect(result.stdout).toContain('No workspace containers for instance feat-x');
    expect(existsSync(envFile)).toBe(false);
  });

  /**
   * `--dry-run` prints the three planned actions, calls neither `down` nor `rm`, and leaves the
   * env file in place.
   */
  it('--dry-run performs nothing and prints the plan', () => {
    const { dir, envFile, log } = checkout();
    const shimDir = createShimDir({ log, docker: { psIds: ['abc123'] } });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--dry-run'],
      env: { HOME: dir, AH_ENV_FILE: envFile, AH_SHIM_LOG: log },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('agent-hangar-feat-x');
    expect(result.stdout).toContain('ah.instance=feat-x');
    expect(readShimLog(log)).toEqual([]);
    expect(existsSync(envFile)).toBe(true);
  });

  /**
   * A checkout that was never set up has no file to follow, so the shell decides — and a
   * Conductor-style workspace name is slugified into the instance filter.
   */
  it('slugifies CONDUCTOR_WORKSPACE_NAME when the checkout has no env file', () => {
    const { dir, envFile, log } = unconfigured();
    const shimDir = createShimDir({ log, docker: { psIds: [] } });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--dry-run'],
      env: {
        HOME: dir,
        CONDUCTOR_WORKSPACE_NAME: 'Feature ABC',
        AH_ENV_FILE: envFile,
        AH_SHIM_LOG: log,
      },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ah.instance=feature-abc');
  });

  /**
   * An unrecognised flag prints usage and exits 2 without touching anything.
   */
  it('rejects an unknown flag', () => {
    const { dir, envFile, log } = checkout();
    const shimDir = createShimDir({ log });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--nope'],
      env: { HOME: dir, AH_ENV_FILE: envFile, AH_SHIM_LOG: log },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage');
    expect(readShimLog(log)).toEqual([]);
  });
});
