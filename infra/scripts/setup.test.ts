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
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createShimDir,
  readShimLog,
  spawnScript,
  writeExtraShim,
  writeGnuStatShim,
} from './testing/shims.js';
import { expectedWorkspaceDigest, SHIM_BUNDLE_DIGEST } from './testing/workspace-digest.js';

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
    // Step 7 asks whether the image is *current*, not merely present: the `node` shim reports the
    // bundle digest of this tree and the `docker` shim reports the label the image carries, so
    // these two agreeing is what "the image needs no rebuild" means.
    AH_SHIM_BUNDLE_DIGEST: SHIM_BUNDLE_DIGEST,
    AH_SHIM_IMAGE_DIGEST: expectedWorkspaceDigest(),
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
   * A second run neither regenerates the master key nor rebuilds the (now present and current)
   * image, and leaves the env file byte-for-byte unchanged.
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
   * An image that is present but was built from other sources is rebuilt without being asked.
   * Reporting "workspace image present" and changing nothing would leave the machine in the one
   * broken state nothing downstream announces: containers created from that image run code that is
   * in no tree, and every turn taken through them succeeds.
   */
  it('rebuilds an image that is present but does not carry this tree', () => {
    const f = fixture();
    const shimDir = createShimDir({ log: f.log, docker: { image: 'present' } });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--skip-doctor'],
      env: baseEnv(f, { AH_SHIM_IMAGE_DIGEST: 'c'.repeat(64) }),
    });
    expect(result.status).toBe(0);
    expect(readShimLog(f.log).some((line) => line.includes('infra:image'))).toBe(true);
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
   * The whole of the reported failure, end to end. A checkout whose `.env.local` held 5 of the 17
   * keys — the missing one present only as a comment — ran `pnpm setup` and got
   * `MASTER_KEY_PATH: unbound variable` from step 4: a bash diagnostic that names one variable and
   * neither the file that lacks it, nor the eleven others, nor a way out.
   *
   * Two things have to hold for that to be fixed, and both are asserted here: the run stops with a
   * message that names the missing key and the file, and it stops at all — `eval "$(cmd)"` reports
   * the status of `eval`, so the refusal used to be discarded and the run carried on into the
   * dereference. Nothing may have been started by then, which is what the compose assertion is for.
   */
  it('refuses an incomplete env file instead of dying on an unbound variable', () => {
    const f = fixture();
    const envScript = fileURLToPath(new URL('./env.sh', import.meta.url));
    execFileSync('bash', [envScript, '--force'], {
      env: { PATH: process.env.PATH ?? '', HOME: f.homeDir, AH_ENV_FILE: f.envFile },
      encoding: 'utf8',
    });
    // The observed shape: the key is still in the file, but only as a comment.
    writeFileSync(
      f.envFile,
      readFileSync(f.envFile, 'utf8').replace(/^MASTER_KEY_PATH=/m, '# MASTER_KEY_PATH='),
    );
    const shimDir = createShimDir({ log: f.log, docker: { image: 'present' } });

    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--skip-install', '--skip-doctor'],
      // MASTER_KEY_PATH is deliberately not exported: the file is what has to supply it, and a
      // shell that already carries the value would hide the defect.
      env: { HOME: f.homeDir, AH_ENV_FILE: f.envFile, AH_SHIM_LOG: f.log },
    });

    expect(result.status).toBe(4);
    expect(result.stderr).toContain('MASTER_KEY_PATH');
    expect(result.stderr).toContain(f.envFile);
    expect(result.stderr).not.toContain('unbound variable');
    expect(readShimLog(f.log).some((line) => line.includes('docker compose'))).toBe(false);
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

describe('setup.sh on a GNU userland', () => {
  /**
   * The Linux-only regression this shim reproduces on any machine: the key-mode check read its
   * value from a `stat -f … || stat -c …` chain whose first branch, under GNU coreutils, prints a
   * filesystem block on stdout before failing. The mode came back as that block with the real mode
   * appended, so a correctly-permissioned key was refused and setup exited 1 before doing anything.
   */
  it('accepts a mode-600 key instead of refusing it', () => {
    const f = fixture();
    const shimDir = createShimDir({ log: f.log, docker: { image: 'present' } });
    writeGnuStatShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--skip-doctor'],
      env: baseEnv(f),
    });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('must be 0600');
  });

  /**
   * The refusal still fires on the same userland when the mode really is wrong: the fix is about
   * reading the mode, not about accepting whatever it reads.
   */
  it('still refuses a group-readable key', () => {
    const f = fixture();
    const shimDir = createShimDir({ log: f.log, docker: { image: 'present' } });
    writeGnuStatShim(shimDir, '644');
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--skip-doctor'],
      env: baseEnv(f),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('has mode 644');
    expect(result.stderr).toContain('chmod 600');
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

  /**
   * A second run whose shell names a different instance than the env file records is refused, and
   * refused before anything acts on either instance. Setup used to be the one entry point that
   * read the file with the weaker check: it discarded the instance the operator typed without a
   * word, migrated, built the image and brought compose up on the file's instance, and finished by
   * printing "Setup complete for instance <the other one>" — a wrong answer wearing the face of a
   * right one. The env file is left exactly as it was, because a refusal that edited it would be
   * the same mistake in the other direction.
   */
  it('refuses a second run whose shell contradicts the env file', () => {
    const f = fixture();
    const shimDir = createShimDir({ log: f.log, docker: { image: 'missing' } });
    spawnScript(scriptPath, { shimDir, args: ['--skip-doctor'], env: baseEnv(f) });
    const envBefore = readFileSync(f.envFile, 'utf8');

    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--skip-doctor'],
      env: baseEnv(f, { AH_INSTANCE: 'other', AH_PORT_BASE: '3410' }),
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('this shell selects instance "other"');
    expect(result.stderr).toContain('AH_ENV_FILE');
    expect(readFileSync(f.envFile, 'utf8')).toBe(envBefore);
  });
});
