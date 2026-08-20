/**
 * Unit tests for `infra/scripts/ws.sh`.
 *
 * Layer: unit (spawns bash with PATH shims; no real Docker).
 * Goal: `list` filters and formats by the resolved instance's label, `reap` removes only that
 * instance's containers and reports the count (including zero), the instance comes from the
 * checkout's env file and a shell that contradicts it stops the command, and an unrecognised or
 * missing subcommand exits 2.
 * Mocks: docker via `infra/scripts/testing/shims.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createShimDir, readShimLog, spawnScript, writeInstanceEnvFile } from './testing/shims.js';

const scriptPath = fileURLToPath(new URL('./ws.sh', import.meta.url));

const dirs: string[] = [];

/**
 * Builds a throwaway checkout. `envFile` points inside it and does not exist unless a test asks
 * for one, so the shell decides — and never the developer's real `.env.local`, which the scripts
 * would otherwise read through the repository-root default.
 *
 * @param instance - Instance to record in an env file; none is written when omitted.
 * @returns The directory, its env file path and the shim log path.
 */
function sandbox(instance?: string): { dir: string; envFile: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ah-ws-'));
  dirs.push(dir);
  const envFile = join(dir, '.env.local');
  if (instance !== undefined) {
    writeInstanceEnvFile(envFile, { instance, home: dir });
  }
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

describe('ws.sh list', () => {
  /**
   * `list` filters by the resolved instance's label and requests the documented format string.
   */
  it('filters by instance label and requests the documented columns', () => {
    const { envFile, log } = sandbox();
    const shimDir = createShimDir({ log, docker: { psNames: ['ah-ws-feat-x-1'] } });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['list'],
      env: { HOME: '/tmp', AH_ENV_FILE: envFile, AH_INSTANCE: 'feat-x', AH_SHIM_LOG: log },
    });
    expect(result.status).toBe(0);
    const invocation = readShimLog(log).find((line) => line.startsWith('docker ps'));
    expect(invocation).toContain('--filter label=ah.instance=feat-x');
    expect(invocation).toContain('{{.Names}}');
    expect(invocation).toContain('{{.Label "ah.kind"}}');
  });

  /**
   * The table header is printed even with zero rows (real `docker ps --format table` behaviour).
   */
  it('prints the header even with zero rows', () => {
    const { envFile, log } = sandbox();
    const shimDir = createShimDir({ log, docker: { psNames: [] } });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['list'],
      env: { HOME: '/tmp', AH_ENV_FILE: envFile, AH_SHIM_LOG: log },
    });
    expect(result.stdout).toContain('NAMES');
  });
});

describe('ws.sh reap', () => {
  /**
   * `reap` removes every id the instance-scoped lookup returns and reports the count.
   */
  it('removes the instance-scoped ids and reports the count', () => {
    const { envFile, log } = sandbox();
    const shimDir = createShimDir({ log, docker: { psIds: ['abc123', 'def456'] } });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['reap'],
      env: { HOME: '/tmp', AH_ENV_FILE: envFile, AH_INSTANCE: 'feat-x', AH_SHIM_LOG: log },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Removed 2 workspace container(s) of instance feat-x');
    expect(readShimLog(log).some((line) => line.includes('rm -f abc123 def456'))).toBe(true);
  });

  /**
   * An id carrying whitespace stays a single argument to `docker rm`. The lookup output is split
   * on line boundaries into an array, so the number of arguments comes from the number of lines
   * and never from the whitespace inside one of them.
   */
  it('passes an id containing whitespace as one argument', () => {
    const { envFile, log } = sandbox();
    const shimDir = createShimDir({ log, docker: { psIds: ['abc 123'] } });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['reap'],
      env: { HOME: '/tmp', AH_ENV_FILE: envFile, AH_INSTANCE: 'feat-x', AH_SHIM_LOG: log },
    });
    expect(result.status).toBe(0);
    const args = readShimLog(log).filter((line) => line.startsWith('rm-arg '));
    expect(args).toEqual(['rm-arg abc 123']);
    expect(result.stdout).toContain('Removed 1 workspace container(s)');
  });

  /**
   * `reap` with nothing to remove reports zero and never calls `docker rm`.
   */
  it('reports zero and skips rm -f when nothing matches', () => {
    const { envFile, log } = sandbox();
    const shimDir = createShimDir({ log, docker: { psIds: [] } });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['reap'],
      env: { HOME: '/tmp', AH_ENV_FILE: envFile, AH_SHIM_LOG: log },
    });
    expect(result.stdout).toContain('Removed 0 workspace container(s)');
    expect(readShimLog(log).some((line) => line.startsWith('docker rm'))).toBe(false);
  });
});

describe('ws.sh instance resolution', () => {
  /**
   * `reap` destroys containers, so which instance it belongs to may not come from a stale shell
   * variable: it comes from the env file this checkout was set up with, and is printed before
   * anything is removed.
   */
  it('reaps the instance the checkout is configured for, not the shell default', () => {
    const { dir, envFile, log } = sandbox('feat-y');
    const shimDir = createShimDir({ log, docker: { psIds: ['abc123'] } });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['reap'],
      env: { HOME: dir, AH_ENV_FILE: envFile, AH_SHIM_LOG: log },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Reaping workspace containers of instance "feat-y"');
    const entries = readShimLog(log);
    expect(entries.some((line) => line.includes('label=ah.instance=feat-y'))).toBe(true);
    expect(entries.some((line) => line.includes('label=ah.instance=default'))).toBe(false);
  });

  /**
   * A shell naming another instance stops the command instead of deciding for it.
   */
  it('refuses when the shell contradicts the checkout', () => {
    const { dir, envFile, log } = sandbox('feat-y');
    const shimDir = createShimDir({ log, docker: { psIds: ['abc123'] } });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['reap'],
      env: { HOME: dir, AH_ENV_FILE: envFile, AH_INSTANCE: 'other', AH_SHIM_LOG: log },
    });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('Refusing to guess');
    expect(readShimLog(log)).toEqual([]);
  });
});

describe('ws.sh usage', () => {
  /**
   * Neither argument nor an unrecognised one is accepted; both exit 2 with a usage line.
   */
  it.each([[[]], [['reset']]] as const)('rejects %j with exit 2', (args) => {
    const { envFile, log } = sandbox();
    const shimDir = createShimDir({ log });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: [...args],
      env: { HOME: '/tmp', AH_ENV_FILE: envFile, AH_SHIM_LOG: log },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage');
  });
});
