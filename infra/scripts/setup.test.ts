/**
 * Unit tests for `infra/scripts/setup.sh`.
 *
 * Layer: unit (spawns bash with PATH shims; no real Docker, Postgres, Redis or network).
 * Goal: the first run walks every step in order, a second run is idempotent (no key
 * regeneration, no image rebuild, env file untouched), `--force`/`--rebuild-image` override that,
 * a wrongly-permissioned key or an unreachable Docker refuse with the documented fix, doctor is
 * invoked last (or skipped with `--skip-doctor`), and an unknown flag is rejected.
 * Mocks: docker/pnpm/openssl/node via `infra/scripts/testing/shims.ts`; a fake doctor script.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createShimDir, readShimLog, spawnScript, writeExtraShim } from './testing/shims.js';

const scriptPath = fileURLToPath(new URL('./setup.sh', import.meta.url));

interface Fixture {
  dir: string;
  homeDir: string;
  envFile: string;
  keyPath: string;
  log: string;
}

const fixtures: Fixture[] = [];

/**
 * Builds a fresh sandbox: HOME, AH_ENV_FILE and MASTER_KEY_PATH all point inside a throwaway
 * temp directory, so a test run never touches the developer's real files.
 *
 * @returns The sandbox paths.
 */
function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'ah-setup-'));
  const homeDir = join(dir, 'home');
  const value: Fixture = {
    dir,
    homeDir,
    envFile: join(dir, '.env.local'),
    keyPath: join(dir, 'master.key'),
    log: join(dir, 'shim.log'),
  };
  fixtures.push(value);
  return value;
}

afterEach(() => {
  while (fixtures.length > 0) {
    const value = fixtures.pop();
    if (value !== undefined) {
      rmSync(value.dir, { recursive: true, force: true });
    }
  }
});

/**
 * Base environment every spawn needs: sandbox HOME, throwaway env file and key path, the shim
 * log, and `--skip-doctor` unless the caller wants doctor exercised.
 *
 * @param f - Sandbox fixture.
 * @param extra - Overrides/additions.
 * @returns The environment record for {@link spawnScript}.
 */
function baseEnv(f: Fixture, extra: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: f.homeDir,
    AH_ENV_FILE: f.envFile,
    MASTER_KEY_PATH: f.keyPath,
    AH_SHIM_LOG: f.log,
    ...extra,
  };
}

describe('setup.sh first run', () => {
  /**
   * Every shimmed step runs, in order: install, the Docker reachability check, key generation,
   * compose up, Prisma generate + migrate, then the image inspect / `pnpm infra:image` pair
   * (image missing). The build itself is routed through `infra:image` rather than a bare
   * `docker build`, so the build context is staged the same way regardless of what that script
   * ends up doing internally.
   */
  it('walks every step in order on a fresh sandbox', () => {
    const f = fixture();
    const shimDir = createShimDir({ log: f.log, docker: { image: 'missing' } });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--skip-doctor'],
      env: baseEnv(f),
    });
    expect(result.status).toBe(0);
    const log = readShimLog(f.log);
    const indexOf = (needle: string): number => log.findIndex((line) => line.includes(needle));

    const install = indexOf('pnpm install --frozen-lockfile');
    const info = indexOf('docker info');
    const rand = indexOf('openssl rand -hex 32');
    const composeUp = indexOf('up -d --wait');
    const generate = indexOf('db:generate');
    const migrate = indexOf('db:migrate');
    const inspect = indexOf('image inspect');
    const build = indexOf('pnpm infra:image');

    for (const step of [install, info, rand, composeUp, generate, migrate, inspect, build]) {
      expect(step).toBeGreaterThanOrEqual(0);
    }
    expect(install).toBeLessThan(info);
    expect(info).toBeLessThan(rand);
    expect(rand).toBeLessThan(composeUp);
    expect(composeUp).toBeLessThan(generate);
    expect(generate).toBeLessThan(migrate);
    expect(migrate).toBeLessThan(inspect);
    expect(inspect).toBeLessThan(build);
  });

  /**
   * `--skip-install` records no `pnpm install` invocation.
   */
  it('skips pnpm install with --skip-install', () => {
    const f = fixture();
    const shimDir = createShimDir({ log: f.log, docker: { image: 'present' } });
    spawnScript(scriptPath, {
      shimDir,
      args: ['--skip-install', '--skip-doctor'],
      env: baseEnv(f),
    });
    expect(readShimLog(f.log).some((line) => line.includes('pnpm install'))).toBe(false);
  });
});

describe('setup.sh second run', () => {
  /**
   * A second run neither regenerates the master key nor rebuilds the (now present) image, and
   * leaves the env file byte-for-byte unchanged.
   */
  it('is idempotent: no key regeneration, no image rebuild, env file untouched', () => {
    const f = fixture();
    const first = createShimDir({ log: f.log, docker: { image: 'missing' } });
    spawnScript(scriptPath, { shimDir: first, args: ['--skip-doctor'], env: baseEnv(f) });
    const envBefore = readFileSync(f.envFile, 'utf8');

    const secondLog = join(f.dir, 'second.log');
    const second = createShimDir({ log: secondLog, docker: { image: 'present' } });
    const result = spawnScript(scriptPath, {
      shimDir: second,
      args: ['--skip-doctor'],
      env: baseEnv(f, { AH_SHIM_LOG: secondLog }),
    });
    expect(result.status).toBe(0);
    const log = readShimLog(secondLog);
    expect(log.some((line) => line.includes('openssl'))).toBe(false);
    expect(log.some((line) => line.includes('infra:image'))).toBe(false);
    expect(readFileSync(f.envFile, 'utf8')).toBe(envBefore);
  });

  /**
   * `--force` rewrites the env file even though it already exists.
   */
  it('--force rewrites the env file', () => {
    const f = fixture();
    const shimDir = createShimDir({ log: f.log, docker: { image: 'missing' } });
    spawnScript(scriptPath, { shimDir, args: ['--skip-doctor'], env: baseEnv(f) });
    const before = readFileSync(f.envFile, 'utf8');
    writeFileSync(f.envFile, `${before}\n# stale marker\n`);

    spawnScript(scriptPath, {
      shimDir,
      args: ['--force', '--skip-doctor'],
      env: baseEnv(f),
    });
    expect(readFileSync(f.envFile, 'utf8')).not.toContain('stale marker');
  });

  /**
   * `--rebuild-image` forces a rebuild even when the image already reports as present.
   */
  it('--rebuild-image forces a build even when the image is present', () => {
    const f = fixture();
    const shimDir = createShimDir({ log: f.log, docker: { image: 'present' } });
    spawnScript(scriptPath, {
      shimDir,
      args: ['--rebuild-image', '--skip-doctor'],
      env: baseEnv(f),
    });
    expect(readShimLog(f.log).some((line) => line.includes('infra:image'))).toBe(true);
  });
});

describe('setup.sh refusals', () => {
  /**
   * A master key file with mode 644 is refused with the exact fix command in stderr, and setup
   * exits non-zero before reaching any later step.
   */
  it('refuses a master key file with the wrong mode', () => {
    const f = fixture();
    writeFileSync(f.keyPath, `${'0'.repeat(64)}\n`);
    chmodSync(f.keyPath, 0o644);
    const shimDir = createShimDir({ log: f.log });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--skip-install', '--skip-doctor'],
      env: baseEnv(f),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('chmod 600');
    expect(readShimLog(f.log).some((line) => line.includes('docker compose'))).toBe(false);
  });

  /**
   * An unreachable Docker daemon exits 1 with the documented fix.
   */
  it('refuses when Docker is unreachable', () => {
    const f = fixture();
    const shimDir = createShimDir({ log: f.log, docker: { availability: 'down' } });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--skip-install', '--skip-doctor'],
      env: baseEnv(f),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DOCKER_HOST=unix://');
  });

  /**
   * An unrecognised flag prints usage and exits 2 without running any step.
   */
  it('rejects an unknown flag', () => {
    const f = fixture();
    const shimDir = createShimDir({ log: f.log });
    const result = spawnScript(scriptPath, { shimDir, args: ['--nope'], env: baseEnv(f) });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage');
    expect(readShimLog(f.log)).toEqual([]);
  });
});

describe('setup.sh doctor handoff', () => {
  /**
   * `--skip-doctor` never invokes the configured doctor script.
   */
  it('does not invoke the doctor with --skip-doctor', () => {
    const f = fixture();
    const shimDir = createShimDir({ log: f.log, docker: { image: 'present' } });
    const fakeDoctor = writeExtraShim(
      shimDir,
      'fake-doctor.sh',
      'printf \'doctor invoked\\n\' >> "$AH_SHIM_LOG"\nexit 0\n',
    );
    spawnScript(scriptPath, {
      shimDir,
      args: ['--skip-doctor'],
      env: baseEnv(f, { AH_DOCTOR_SCRIPT: fakeDoctor }),
    });
    expect(readShimLog(f.log).some((line) => line.includes('doctor invoked'))).toBe(false);
  });

  /**
   * Without `--skip-doctor`, AH_DOCTOR_SCRIPT is invoked as the very last step and its exit code
   * becomes setup's own exit code.
   */
  it('invokes AH_DOCTOR_SCRIPT last and propagates its exit code', () => {
    const f = fixture();
    const shimDir = createShimDir({ log: f.log, docker: { image: 'present' } });
    const fakeDoctor = writeExtraShim(
      shimDir,
      'fake-doctor.sh',
      'printf \'doctor invoked\\n\' >> "$AH_SHIM_LOG"\nexit 5\n',
    );
    const result = spawnScript(scriptPath, {
      shimDir,
      env: baseEnv(f, { AH_DOCTOR_SCRIPT: fakeDoctor }),
    });
    expect(result.status).toBe(5);
    const log = readShimLog(f.log);
    expect(log.at(-1)).toBe('doctor invoked');
  });
});
