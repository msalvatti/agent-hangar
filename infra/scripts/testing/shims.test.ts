/**
 * Unit tests for the infra script test shims.
 *
 * Layer: unit.
 * Goal: every shimmed executable logs its invocation and returns the configured canned result,
 * `readShimLog`/`spawnScript` behave for both the happy path and their edge cases, and
 * `writeExtraShim` supports both a fresh and an existing shim directory.
 * Mocks: none — the shims are real executable files spawned as real child processes.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createShimDir, readShimLog, spawnScript, writeExtraShim } from './shims.js';

function freshLogPath(): { dir: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ah-shim-test-'));
  return { dir, log: join(dir, 'log') };
}

describe('createShimDir', () => {
  /**
   * Every one of the five standard tools logs its own name plus arguments, in call order.
   */
  it('logs the invocation of every standard tool', () => {
    const { log } = freshLogPath();
    const shimDir = createShimDir({ log });
    execFileSync(join(shimDir, 'docker'), ['info'], { env: { AH_SHIM_LOG: log } });
    execFileSync(join(shimDir, 'pnpm'), ['install', '--frozen-lockfile'], {
      env: { AH_SHIM_LOG: log },
    });
    execFileSync(join(shimDir, 'openssl'), ['rand', '-hex', '32'], { env: { AH_SHIM_LOG: log } });
    execFileSync(join(shimDir, 'node'), ['-v'], { env: { AH_SHIM_LOG: log } });
    execFileSync(join(shimDir, 'concurrently'), ['-n', 'web,worker'], {
      env: { AH_SHIM_LOG: log },
    });
    expect(readShimLog(log)).toEqual([
      'docker info',
      'pnpm install --frozen-lockfile',
      'openssl rand -hex 32',
      'node -v',
      'concurrently -n web,worker',
    ]);
  });

  /**
   * `docker info` reports the configured availability; `up` (the default) exits 0.
   */
  it('docker info succeeds when availability is up (default)', () => {
    const { log } = freshLogPath();
    const shimDir = createShimDir({ log });
    expect(() =>
      execFileSync(join(shimDir, 'docker'), ['info'], { env: { AH_SHIM_LOG: log } }),
    ).not.toThrow();
  });

  /**
   * `docker info` fails when availability is `down`, and `docker compose … up` fails too unless a
   * different exit code was configured explicitly.
   */
  it('docker info and compose up fail when availability is down', () => {
    const { log } = freshLogPath();
    const shimDir = createShimDir({ log, docker: { availability: 'down' } });
    expect(() =>
      execFileSync(join(shimDir, 'docker'), ['info'], { env: { AH_SHIM_LOG: log } }),
    ).toThrow();
    expect(() =>
      execFileSync(join(shimDir, 'docker'), ['compose', '-f', 'x.yml', 'up', '-d', '--wait'], {
        env: { AH_SHIM_LOG: log },
      }),
    ).toThrow();
  });

  /**
   * An explicit `composeExitCode` wins over the availability-derived default.
   */
  it('honours an explicit composeExitCode', () => {
    const { log } = freshLogPath();
    const shimDir = createShimDir({ log, docker: { composeExitCode: 3 } });
    const result = spawnScript(join(shimDir, 'docker'), {
      shimDir,
      env: { AH_SHIM_LOG: log },
      args: ['compose', '-f', 'x.yml', 'down', '-v'],
    });
    expect(result.status).toBe(3);
  });

  /**
   * `docker image inspect` reports `present`/`missing` (default) as configured.
   */
  it.each([
    ['present', 0],
    ['missing', 1],
    [undefined, 1],
  ] as const)('docker image inspect reports %s', (image, expectedStatus) => {
    const { log } = freshLogPath();
    const shimDir = createShimDir({ log, docker: image === undefined ? {} : { image } });
    const result = spawnScript(join(shimDir, 'docker'), {
      shimDir,
      env: { AH_SHIM_LOG: log },
      args: ['image', 'inspect', 'agent-hangar/workspace:dev'],
    });
    expect(result.status).toBe(expectedStatus);
  });

  /**
   * `docker ps -aq --filter …` prints the configured container ids, one per line, or nothing when
   * none were configured.
   */
  it.each([
    [['abc123', 'def456'], 'abc123\ndef456'],
    [[], ''],
    [undefined, ''],
  ] as const)('docker ps -aq prints the configured ids: %j', (psIds, expected) => {
    const { log } = freshLogPath();
    const shimDir = createShimDir({
      log,
      docker: psIds === undefined ? {} : { psIds: [...psIds] },
    });
    const result = spawnScript(join(shimDir, 'docker'), {
      shimDir,
      env: { AH_SHIM_LOG: log },
      args: ['ps', '-aq', '--filter', 'label=ah.instance=default'],
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
  });

  /**
   * `docker ps --format 'table …'` prints a header line followed by the configured names, or the
   * header alone when no names were configured.
   */
  it.each([[['ah-ws-default-1']], [[]], [undefined]] as const)(
    'docker ps --format table prints a header and the configured names: %j',
    (psNames) => {
      const { log } = freshLogPath();
      const shimDir = createShimDir({
        log,
        docker: psNames === undefined ? {} : { psNames: [...psNames] },
      });
      const result = spawnScript(join(shimDir, 'docker'), {
        shimDir,
        env: { AH_SHIM_LOG: log },
        args: ['ps', '--filter', 'label=ah.instance=default', '--format', 'table {{.Names}}'],
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('NAMES');
      for (const name of psNames ?? []) {
        expect(result.stdout).toContain(name);
      }
    },
  );

  /**
   * `docker ps` fails when availability is `down`, mirroring a daemon that cannot be reached, and
   * an explicit `psExitCode` wins over that availability-derived default.
   */
  it.each([
    [{ availability: 'down' } as const, 1],
    [{ psExitCode: 7 } as const, 7],
    [{ availability: 'down', psExitCode: 0 } as const, 0],
  ])('docker ps exits with the configured code (%j)', (docker, expectedStatus) => {
    const { log } = freshLogPath();
    const shimDir = createShimDir({ log, docker });
    const result = spawnScript(join(shimDir, 'docker'), {
      shimDir,
      env: { AH_SHIM_LOG: log },
      args: ['ps', '-aq', '--filter', 'label=ah.instance=x'],
    });
    expect(result.status).toBe(expectedStatus);
  });

  /**
   * `docker rm -f <ids>` echoes each id and exits 0.
   */
  it('docker rm -f prints each removed id', () => {
    const { log } = freshLogPath();
    const shimDir = createShimDir({ log });
    const result = spawnScript(join(shimDir, 'docker'), {
      shimDir,
      env: { AH_SHIM_LOG: log },
      args: ['rm', '-f', 'abc123', 'def456'],
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['abc123', 'def456']);
  });

  /**
   * `docker build` always succeeds; `docker compose … exec …` prints the configured output and
   * exit code (used by `db-prune.sh` tests to simulate `psql`).
   */
  it('docker build succeeds and docker compose exec prints the configured psql output', () => {
    const { log } = freshLogPath();
    const shimDir = createShimDir({
      log,
      docker: { execOutput: '3', execExitCode: 0 },
    });
    const build = spawnScript(join(shimDir, 'docker'), {
      shimDir,
      env: { AH_SHIM_LOG: log },
      args: ['build', '-t', 'agent-hangar/workspace:dev', 'infra/workspace'],
    });
    expect(build.status).toBe(0);
    const exec = spawnScript(join(shimDir, 'docker'), {
      shimDir,
      env: { AH_SHIM_LOG: log },
      args: ['compose', '-f', 'x.yml', 'exec', '-T', 'postgres', 'psql', '-tAc', 'select 1'],
    });
    expect(exec.status).toBe(0);
    expect(exec.stdout.trim()).toBe('3');
  });

  /**
   * A `docker compose` invocation whose subcommand is none of `up`/`down`/`exec` (e.g. a bare
   * `docker compose config`) falls through cleanly instead of hanging or erroring.
   */
  it('docker compose with an unrecognised subcommand exits 0', () => {
    const { log } = freshLogPath();
    const shimDir = createShimDir({ log });
    const result = spawnScript(join(shimDir, 'docker'), {
      shimDir,
      env: { AH_SHIM_LOG: log },
      args: ['compose', '-f', 'x.yml', 'config'],
    });
    expect(result.status).toBe(0);
  });

  /**
   * An unrecognised top-level docker subcommand exits 0 rather than failing the script under test.
   */
  it('an unrecognised docker subcommand exits 0', () => {
    const { log } = freshLogPath();
    const shimDir = createShimDir({ log });
    const result = spawnScript(join(shimDir, 'docker'), {
      shimDir,
      env: { AH_SHIM_LOG: log },
      args: ['version'],
    });
    expect(result.status).toBe(0);
  });

  /**
   * `pnpm -v` prints the configured version (default `11.22.0`).
   */
  it.each([
    [undefined, '11.22.0'],
    ['12.0.0', '12.0.0'],
  ] as const)('pnpm -v prints %s', (version, expected) => {
    const { log } = freshLogPath();
    const shimDir = createShimDir({ log, pnpm: version === undefined ? {} : { version } });
    const result = spawnScript(join(shimDir, 'pnpm'), {
      shimDir,
      env: { AH_SHIM_LOG: log },
      args: ['-v'],
    });
    expect(result.stdout.trim()).toBe(expected);
  });

  /**
   * `pnpm … exec prisma migrate status` reports the configured exit code (default 0); every other
   * pnpm invocation exits 0 and prints nothing.
   */
  it.each([
    [undefined, 0],
    [1, 1],
  ] as const)('pnpm migrate status honours the configured exit code: %s', (exitCode, expected) => {
    const { log } = freshLogPath();
    const shimDir = createShimDir({
      log,
      pnpm: exitCode === undefined ? {} : { migrateStatusExitCode: exitCode },
    });
    const result = spawnScript(join(shimDir, 'pnpm'), {
      shimDir,
      env: { AH_SHIM_LOG: log },
      args: ['--filter', '@agent-hangar/core', 'exec', 'prisma', 'migrate', 'status'],
    });
    expect(result.status).toBe(expected);
  });

  /**
   * `node -v` prints the configured version (default `v24.0.0`).
   */
  it.each([
    [undefined, 'v24.0.0'],
    ['v25.0.0', 'v25.0.0'],
  ] as const)('node -v prints %s', (nodeVersion, expected) => {
    const { log } = freshLogPath();
    const shimDir = createShimDir({ log, ...(nodeVersion === undefined ? {} : { nodeVersion }) });
    const result = spawnScript(join(shimDir, 'node'), {
      shimDir,
      env: { AH_SHIM_LOG: log },
      args: ['-v'],
    });
    expect(result.stdout.trim()).toBe(expected);
  });
});

describe('readShimLog', () => {
  /**
   * A log file that was never written reads back as an empty array rather than throwing.
   */
  it('returns an empty array when the log file does not exist', () => {
    const { log } = freshLogPath();
    expect(readShimLog(log)).toEqual([]);
  });
});

describe('spawnScript', () => {
  /**
   * The spawned process's working directory defaults to the caller's `cwd` when none is given, and
   * can be overridden explicitly.
   */
  it('runs in the given working directory, or the caller default when omitted', () => {
    const { log } = freshLogPath();
    const shimDir = createShimDir({ log });
    const workdir = mkdtempSync(join(tmpdir(), 'ah-shim-cwd-'));
    const script = writeExtraShim(undefined, 'pwd.sh', 'pwd');
    const result = spawnScript(script, { shimDir, cwd: workdir, env: { AH_SHIM_LOG: log } });
    expect(result.stdout.trim()).toBe(realpathSync(workdir));

    const withoutCwd = spawnScript(script, { shimDir, env: { AH_SHIM_LOG: log } });
    expect(withoutCwd.stdout.trim()).toBe(realpathSync(process.cwd()));

    rmSync(workdir, { recursive: true, force: true });
  });

  /**
   * `env` and `args` are both optional: HOME defaults to `/tmp` and no arguments are passed.
   */
  it('defaults HOME and args when neither is supplied', () => {
    const shimDir = createShimDir({ log: freshLogPath().log });
    const script = writeExtraShim(undefined, 'echo-home.sh', 'printf \'%s %s\\n\' "$HOME" "$#"');
    const result = spawnScript(script, { shimDir });
    expect(result.stdout.trim()).toBe('/tmp 0');
  });
});

describe('writeExtraShim', () => {
  /**
   * A bespoke shim can be added to an existing shim directory, or written into a fresh one when
   * no directory is supplied.
   */
  it('writes into an existing directory and into a fresh one', () => {
    const { log } = freshLogPath();
    const shimDir = createShimDir({ log });
    const path = writeExtraShim(shimDir, 'helper', "printf 'ran\\n'\nexit 0\n");
    expect(path).toBe(join(shimDir, 'helper'));
    expect(execFileSync(path, { encoding: 'utf8' })).toBe('ran\n');

    const freshPath = writeExtraShim(undefined, 'helper', 'exit 7\n');
    const result = spawnScript(freshPath, { shimDir: shimDir, env: {} });
    expect(result.status).toBe(7);
  });
});
