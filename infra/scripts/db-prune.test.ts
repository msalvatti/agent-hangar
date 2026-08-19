/**
 * Unit tests for `infra/scripts/db-prune.sh`.
 *
 * Layer: unit (spawns bash with PATH shims; no real Postgres).
 * Goal: the emitted SQL carries the right status filter and interval, `--days` overrides the
 * default and rejects a non-numeric value, `--dry-run` counts instead of deleting, and the
 * command runs through `docker compose … exec -T postgres psql` against the instance's database.
 * Mocks: docker (compose exec) via `infra/scripts/testing/shims.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createShimDir, readShimLog, spawnScript } from './testing/shims.js';

const scriptPath = fileURLToPath(new URL('./db-prune.sh', import.meta.url));

const dirs: string[] = [];

function sandbox(): { log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ah-db-prune-'));
  dirs.push(dir);
  return { log: join(dir, 'log') };
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('db-prune.sh', () => {
  /**
   * The default 30-day window deletes DESTROYED rows and runs against the resolved instance's
   * database through `docker compose … exec -T postgres psql`.
   */
  it('deletes with the default 30-day window against the instance database', () => {
    const { log } = sandbox();
    const shimDir = createShimDir({ log, docker: { execOutput: 'DELETE 3' } });
    const result = spawnScript(scriptPath, {
      shimDir,
      env: { HOME: '/tmp', AH_INSTANCE: 'default', AH_SHIM_LOG: log },
    });
    expect(result.status).toBe(0);
    const invocation = readShimLog(log).find((line) => line.includes('exec -T postgres psql'));
    expect(invocation).toContain('-d agent_hangar_default');
    expect(invocation).toContain("status = 'DESTROYED'");
    expect(invocation).toContain("interval '30 days'");
    expect(result.stdout).toContain('Pruned 3 destroyed workspace row(s) older than 30 days');
  });

  /**
   * `--days 7` narrows the interval to 7 days.
   */
  it('honours --days', () => {
    const { log } = sandbox();
    const shimDir = createShimDir({ log, docker: { execOutput: 'DELETE 0' } });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--days', '7'],
      env: { HOME: '/tmp', AH_SHIM_LOG: log },
    });
    expect(result.status).toBe(0);
    const invocation = readShimLog(log).find((line) => line.includes('exec -T postgres psql'));
    expect(invocation).toContain("interval '7 days'");
  });

  /**
   * A non-numeric `--days` value is rejected before any command runs.
   */
  it('rejects a non-numeric --days', () => {
    const { log } = sandbox();
    const shimDir = createShimDir({ log });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--days', 'x'],
      env: { HOME: '/tmp', AH_SHIM_LOG: log },
    });
    expect(result.status).toBe(2);
    expect(readShimLog(log)).toEqual([]);
  });

  /**
   * `--dry-run` issues a `SELECT count(*)` instead of a `DELETE` and reports a "would prune" line.
   */
  it('--dry-run counts instead of deleting', () => {
    const { log } = sandbox();
    const shimDir = createShimDir({ log, docker: { execOutput: '5' } });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--dry-run'],
      env: { HOME: '/tmp', AH_SHIM_LOG: log },
    });
    expect(result.status).toBe(0);
    const invocation = readShimLog(log).find((line) => line.includes('exec -T postgres psql'));
    expect(invocation).toContain('SELECT count(*)');
    expect(invocation).not.toContain('DELETE FROM');
    expect(result.stdout).toContain('Would prune 5 destroyed workspace row(s) older than 30 days');
  });

  /**
   * An unrecognised flag exits 2 with a usage line.
   */
  it('rejects an unknown flag', () => {
    const { log } = sandbox();
    const shimDir = createShimDir({ log });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--nope'],
      env: { HOME: '/tmp', AH_SHIM_LOG: log },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage');
  });
});
