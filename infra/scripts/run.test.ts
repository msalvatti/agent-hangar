/**
 * Unit tests for `infra/scripts/run.sh`.
 *
 * Layer: unit (spawns bash with PATH shims; no real Docker, no real Next.js/tsx).
 * Goal: instance/port derivation flows into the printed URL and the `--print-only` command line,
 * `AH_*` beats `CONDUCTOR_*`, the env file is created only when absent, and `--production` runs
 * the built output on the instance's own port with the development resolution condition off.
 * Mocks: docker/pnpm/openssl/node/concurrently via `infra/scripts/testing/shims.ts`.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createShimDir, readShimLog, spawnScript } from './testing/shims.js';

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
   * `--production` runs the built output of both apps — `pnpm start`, not `pnpm dev` — and still
   * passes the instance's own web port. A `pnpm start` that bypassed this entry point would boot
   * both apps against the default-derived database, Redis and port whatever the instance is.
   */
  it('runs the built output on the instance port with --production', () => {
    const dir = sandbox();
    sandboxes.push(dir);
    const log = join(dir, 'log');
    const shimDir = createShimDir({ log });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--production', '--print-only'],
      env: {
        HOME: dir,
        AH_ENV_FILE: join(dir, '.env.local'),
        AH_SHIM_LOG: log,
        AH_INSTANCE: 'lane-b',
        AH_PORT_BASE: '3200',
      },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('instance=lane-b · http://localhost:3200');
    // `printf '%q '` escapes the spaces inside each concurrently argument.
    expect(result.stdout).toContain(String.raw`--filter\ web\ start\ --port\ 3200`);
    expect(result.stdout).toContain(String.raw`--filter\ worker\ start`);
    expect(result.stdout).not.toContain(String.raw`--filter\ web\ dev`);
  });

  /**
   * The development resolution condition belongs to the source-running mode only: the children
   * inherit it in development, and must not in production, where the build output is what has to
   * be loaded. The condition is read from the environment the spawned command actually receives,
   * not from the printed command line, which never carries `NODE_OPTIONS`.
   */
  it.each([
    [[], true],
    [['--production'], false],
  ] as const)(
    'passes --conditions=development to the children only in dev mode',
    (args, wanted) => {
      const dir = sandbox();
      sandboxes.push(dir);
      const log = join(dir, 'log');
      const shimDir = createShimDir({ log });
      const result = spawnScript(scriptPath, {
        shimDir,
        args: [...args],
        env: {
          HOME: dir,
          AH_ENV_FILE: join(dir, '.env.local'),
          AH_SHIM_LOG: log,
          NODE_OPTIONS: '--max-old-space-size=4096',
        },
      });
      expect(result.status).toBe(0);
      const inherited = readShimLog(log).find((line) => line.startsWith('node-options '));
      expect(inherited).toContain('--max-old-space-size=4096');
      expect(inherited?.includes('--conditions=development')).toBe(wanted);
    },
  );

  /**
   * An unrecognised flag exits 2 with a usage line rather than being forwarded to the children.
   */
  it('rejects an unknown flag', () => {
    const dir = sandbox();
    sandboxes.push(dir);
    const log = join(dir, 'log');
    const shimDir = createShimDir({ log });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--nope'],
      env: { HOME: dir, AH_ENV_FILE: join(dir, '.env.local'), AH_SHIM_LOG: log },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage');
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
