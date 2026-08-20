/**
 * Unit tests for `infra/scripts/run.sh`.
 *
 * Layer: unit (spawns bash with PATH shims; no real Docker, no real Next.js/tsx).
 * Goal: instance/port derivation flows into the printed URL and the `--print-only` command line,
 * `AH_*` beats `CONDUCTOR_*`, the env file is created only when absent, `--production` runs
 * the built output on the instance's own port with the development resolution condition off, and
 * the app refuses to start while a master key rotation holds its lock.
 * Mocks: docker/pnpm/openssl/node/concurrently via `infra/scripts/testing/shims.ts`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(result.stdout).toContain('Agent Hangar · instance=default · http://127.0.0.1:3000');
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
    expect(result.stdout).toContain('instance=feat-x · http://127.0.0.1:3100');
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
    expect(result.stdout).toContain('instance=lane-b · http://127.0.0.1:3200');
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

describe('run.sh during a master key rotation', () => {
  /**
   * Starting the app mid-rotation loses credentials whichever side of the swap the write lands on:
   * a secret saved between the rotation's reveal and its write is replaced by the value revealed
   * earlier, and one saved after the write is sealed under the old key, which nothing reads again
   * once the files swap. rotate-key.sh refuses while the app answers on its web port; this is the
   * other half, so the two together are exclusion rather than two point-in-time checks.
   */
  it('refuses to start while a live rotation holds the lock', () => {
    const dir = sandbox();
    sandboxes.push(dir);
    const log = join(dir, 'log');
    const keyPath = join(dir, 'master.key');
    // This test process is unquestionably running, so it stands in for a live rotation.
    writeFileSync(`${keyPath}.lock`, `${String(process.pid)}\n`);
    const result = spawnScript(scriptPath, {
      shimDir: createShimDir({ log }),
      env: {
        HOME: dir,
        AH_ENV_FILE: join(dir, '.env.local'),
        MASTER_KEY_PATH: keyPath,
        AH_SHIM_LOG: log,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('rotation is in progress');
    expect(readShimLog(log).some((line) => line.includes('concurrently'))).toBe(false);
  });

  /**
   * A lock left behind by a killed rotation must not keep the app down forever, and clearing
   * rotation state is not this script's job — so it starts and leaves the file exactly where it is
   * for rotate-key.sh to reclaim.
   */
  it('starts anyway when the lock owner is gone, without removing the lock', () => {
    const dir = sandbox();
    sandboxes.push(dir);
    const log = join(dir, 'log');
    const keyPath = join(dir, 'master.key');
    const finished = spawnSync('bash', ['-c', 'exit 0']);
    writeFileSync(`${keyPath}.lock`, `${String(finished.pid)}\n`);
    const result = spawnScript(scriptPath, {
      shimDir: createShimDir({ log }),
      env: {
        HOME: dir,
        AH_ENV_FILE: join(dir, '.env.local'),
        MASTER_KEY_PATH: keyPath,
        AH_SHIM_LOG: log,
      },
    });

    expect(result.status).toBe(0);
    expect(readShimLog(log).some((line) => line.includes('concurrently'))).toBe(true);
    expect(existsSync(`${keyPath}.lock`)).toBe(true);
  });

  /**
   * `--print-only` starts nothing, so it has nothing to refuse; the contract test that reads this
   * script's command line must keep working whatever is on disk.
   */
  it('still prints the command while a rotation holds the lock', () => {
    const dir = sandbox();
    sandboxes.push(dir);
    const log = join(dir, 'log');
    const keyPath = join(dir, 'master.key');
    writeFileSync(`${keyPath}.lock`, `${String(process.pid)}\n`);
    const result = spawnScript(scriptPath, {
      shimDir: createShimDir({ log }),
      args: ['--print-only'],
      env: {
        HOME: dir,
        AH_ENV_FILE: join(dir, '.env.local'),
        MASTER_KEY_PATH: keyPath,
        AH_SHIM_LOG: log,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('worker');
  });
});
