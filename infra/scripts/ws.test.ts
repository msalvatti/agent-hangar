/**
 * Unit tests for `infra/scripts/ws.sh`.
 *
 * Layer: unit (spawns bash with PATH shims; no real Docker).
 * Goal: `list` filters and formats by the resolved instance's label, `reap` removes only that
 * instance's containers and reports the count (including zero), and an unrecognised or missing
 * subcommand exits 2.
 * Mocks: docker via `infra/scripts/testing/shims.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createShimDir, readShimLog, spawnScript } from './testing/shims.js';

const scriptPath = fileURLToPath(new URL('./ws.sh', import.meta.url));

const dirs: string[] = [];

function sandbox(): { log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ah-ws-'));
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

describe('ws.sh list', () => {
  /**
   * `list` filters by the resolved instance's label and requests the documented format string.
   */
  it('filters by instance label and requests the documented columns', () => {
    const { log } = sandbox();
    const shimDir = createShimDir({ log, docker: { psNames: ['ah-ws-feat-x-1'] } });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['list'],
      env: { HOME: '/tmp', AH_INSTANCE: 'feat-x', AH_SHIM_LOG: log },
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
    const { log } = sandbox();
    const shimDir = createShimDir({ log, docker: { psNames: [] } });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['list'],
      env: { HOME: '/tmp', AH_SHIM_LOG: log },
    });
    expect(result.stdout).toContain('NAMES');
  });
});

describe('ws.sh reap', () => {
  /**
   * `reap` removes every id the instance-scoped lookup returns and reports the count.
   */
  it('removes the instance-scoped ids and reports the count', () => {
    const { log } = sandbox();
    const shimDir = createShimDir({ log, docker: { psIds: ['abc123', 'def456'] } });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['reap'],
      env: { HOME: '/tmp', AH_INSTANCE: 'feat-x', AH_SHIM_LOG: log },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Removed 2 workspace container(s) of instance feat-x');
    expect(readShimLog(log).some((line) => line.includes('rm -f abc123 def456'))).toBe(true);
  });

  /**
   * `reap` with nothing to remove reports zero and never calls `docker rm`.
   */
  it('reports zero and skips rm -f when nothing matches', () => {
    const { log } = sandbox();
    const shimDir = createShimDir({ log, docker: { psIds: [] } });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['reap'],
      env: { HOME: '/tmp', AH_SHIM_LOG: log },
    });
    expect(result.stdout).toContain('Removed 0 workspace container(s)');
    expect(readShimLog(log).some((line) => line.startsWith('docker rm'))).toBe(false);
  });
});

describe('ws.sh usage', () => {
  /**
   * Neither argument nor an unrecognised one is accepted; both exit 2 with a usage line.
   */
  it.each([[[]], [['reset']]] as const)('rejects %j with exit 2', (args) => {
    const { log } = sandbox();
    const shimDir = createShimDir({ log });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: [...args],
      env: { HOME: '/tmp', AH_SHIM_LOG: log },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage');
  });
});
