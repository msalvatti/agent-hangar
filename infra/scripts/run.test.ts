/**
 * Unit tests for `infra/scripts/run.sh`.
 *
 * Layer: unit (spawns bash with PATH shims; no real Docker, no real Next.js/tsx).
 * Goal: instance/port derivation flows into the printed URL and the `--print-only` command line,
 * `AH_*` beats `CONDUCTOR_*`, and the env file is created only when absent.
 * Mocks: docker/pnpm/openssl/node/concurrently via `infra/scripts/testing/shims.ts`.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createShimDir, spawnScript } from './testing/shims.js';

const scriptPath = fileURLToPath(new URL('./run.sh', import.meta.url));

/** Fresh sandbox directory used as HOME and as the location of AH_ENV_FILE. */
function sandbox(): string {
  return mkdtempSync(join(tmpdir(), 'ah-run-'));
}

const sandboxes: string[] = [];

afterEach(() => {
  while (sandboxes.length > 0) {
    const dir = sandboxes.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('run.sh --print-only', () => {
  /**
   * Defaults (nothing AH_* or CONDUCTOR_* set) print the instance banner on port 3000 and a command line
   * that runs both the web app (with --port 3000) and the worker.
   */
  it('prints the default instance URL and command', () => {
    const dir = sandbox();
    sandboxes.push(dir);
    const log = join(dir, 'log');
    const shimDir = createShimDir({ log });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--print-only'],
      env: { HOME: dir, AH_ENV_FILE: join(dir, '.env.local'), AH_SHIM_LOG: log },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Agent Hangar · instance=default · http://localhost:3000');
    expect(result.stdout).toContain('worker');
    expect(result.stdout).toContain('3000');
  });

  /**
   * Explicit AH_INSTANCE/AH_PORT_BASE override the derived instance and port block.
   */
  it('honours AH_INSTANCE and AH_PORT_BASE', () => {
    const dir = sandbox();
    sandboxes.push(dir);
    const log = join(dir, 'log');
    const shimDir = createShimDir({ log });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--print-only'],
      env: {
        HOME: dir,
        AH_ENV_FILE: join(dir, '.env.local'),
        AH_SHIM_LOG: log,
        AH_INSTANCE: 'Feat_X',
        AH_PORT_BASE: '3100',
      },
    });
    expect(result.stdout).toContain('instance=feat-x · http://localhost:3100');
    expect(result.stdout).toContain('3100');
  });

  /**
   * AH_INSTANCE takes precedence over CONDUCTOR_WORKSPACE_NAME when both are set.
   */
  it('prefers AH_* over CONDUCTOR_* when both are set', () => {
    const dir = sandbox();
    sandboxes.push(dir);
    const log = join(dir, 'log');
    const shimDir = createShimDir({ log });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--print-only'],
      env: {
        HOME: dir,
        AH_ENV_FILE: join(dir, '.env.local'),
        AH_SHIM_LOG: log,
        AH_INSTANCE: 'lane-a',
        CONDUCTOR_WORKSPACE_NAME: 'other',
        CONDUCTOR_PORT: '6000',
      },
    });
    expect(result.stdout).toContain('instance=lane-a');
  });

  /**
   * Creates the env file when it is absent, and leaves an existing one untouched.
   */
  it('creates AH_ENV_FILE when absent and leaves it untouched when present', () => {
    const dir = sandbox();
    sandboxes.push(dir);
    const log = join(dir, 'log');
    const shimDir = createShimDir({ log });
    const envFile = join(dir, '.env.local');
    expect(existsSync(envFile)).toBe(false);

    spawnScript(scriptPath, {
      shimDir,
      args: ['--print-only'],
      env: { HOME: dir, AH_ENV_FILE: envFile, AH_SHIM_LOG: log },
    });
    expect(existsSync(envFile)).toBe(true);
    const before = readFileSync(envFile, 'utf8');

    spawnScript(scriptPath, {
      shimDir,
      args: ['--print-only'],
      env: { HOME: dir, AH_ENV_FILE: envFile, AH_SHIM_LOG: log },
    });
    expect(readFileSync(envFile, 'utf8')).toBe(before);
  });
});
