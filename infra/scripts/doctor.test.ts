/**
 * Unit tests for `infra/scripts/doctor.sh`.
 *
 * Layer: unit (spawns bash with PATH shims and real ephemeral TCP listeners; no real Docker,
 * Postgres or Redis).
 * Goal: an all-green machine exits 0; each required failure (Docker down, image missing, wrong
 * key mode, Postgres down, migrations pending) reports the documented fix and exits 1; the
 * optional Secrets/OpenAI rows never fail the exit code and skip in the documented cascade;
 * `--json` parses into 10 objects with the four documented keys.
 * Mocks: docker/pnpm/openssl/node via `infra/scripts/testing/shims.ts`; a bespoke
 * `AH_DOCTOR_HELPER_CMD` shim standing in for the secrets-status/openai-check helpers; real
 * `node:net` listeners standing in for Postgres/Redis reachability — bound on the ports `env.sh`
 * derives from AH_PORT_BASE, because the derivation deliberately ignores POSTGRES_PORT/REDIS_PORT.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createShimDir, spawnScript, writeExtraShim, writeGnuStatShim } from './testing/shims.js';
import type { DockerShimOptions, PnpmShimOptions } from './testing/shims.js';

const scriptPath = fileURLToPath(new URL('./doctor.sh', import.meta.url));

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

/** Lowest and highest port base `env.sh` accepts. */
const MIN_PORT_BASE = 1024;
const MAX_PORT_BASE = 65000;

/** How many adjacent-pair candidates to try before giving up. */
const PORT_BASE_ATTEMPTS = 50;

/** A reserved port base together with the listeners holding its derived ports. */
interface BoundPorts {
  /** Value to pass as `AH_PORT_BASE`; `+ 1` and `+ 2` are the bound ports. */
  portBase: number;
  /** Releases both listeners. */
  close: () => void;
}

/**
 * Binds a loopback listener, or reports that the port is taken.
 *
 * @param port - Port to bind; `0` lets the OS choose a free one.
 * @returns The listening server, or `null` when the port could not be bound.
 */
function tryListen(port: number): Promise<Server | null> {
  return new Promise((resolve) => {
    const server: Server = createServer();
    server.once('error', () => {
      resolve(null);
    });
    server.listen(port, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

/**
 * Reads the port a listening server was given.
 *
 * @param server - A server that has already emitted `listening`.
 * @returns Its loopback port.
 */
function portOf(server: Server): number {
  const address = server.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
}

/**
 * Reserves a port base whose derived Postgres and Redis ports are both listening.
 *
 * `env.sh` derives POSTGRES_PORT/REDIS_PORT from AH_PORT_BASE and ignores any same-named variable
 * in the environment, so a test that needs "Postgres is reachable" listens where the derivation
 * points instead of pointing the derivation at a listener it picked. The OS hands out one free
 * port; the base is that port minus one, and the Redis port next to it is bound explicitly, which
 * is why the search may have to try more than one candidate.
 *
 * @returns The reserved base and a function releasing both listeners.
 */
async function bindDerivedPorts(): Promise<BoundPorts> {
  for (let attempt = 0; attempt < PORT_BASE_ATTEMPTS; attempt += 1) {
    const postgres = await tryListen(0);
    if (postgres !== null) {
      const portBase = portOf(postgres) - 1;
      const inRange = portBase >= MIN_PORT_BASE && portBase + 2 <= MAX_PORT_BASE;
      const redis = inRange ? await tryListen(portBase + 2) : null;
      if (redis !== null) {
        return {
          portBase,
          close: () => {
            postgres.close();
            redis.close();
          },
        };
      }
      postgres.close();
    }
  }
  throw new Error('could not reserve an adjacent Postgres/Redis port pair');
}

/**
 * Reserves a port base whose derived ports nothing listens on, to simulate an unreachable service.
 *
 * @returns A base whose `+ 1` and `+ 2` ports are free.
 */
async function closedPortBase(): Promise<number> {
  // A pair bound and immediately released stays free for the duration of one test: the OS hands
  // out ephemeral ports in rotation rather than reissuing the one just returned.
  const bound = await bindDerivedPorts();
  bound.close();
  return bound.portBase;
}

interface HelperFixture {
  path: string;
  dir: string;
}

/**
 * Writes the `AH_DOCTOR_HELPER_CMD` shim: it inspects its own last path argument to tell the
 * secrets-status and openai-check invocations apart, and answers from the environment.
 */
function helperShim(shimDir: string): HelperFixture {
  const path = writeExtraShim(
    shimDir,
    'helper.sh',
    [
      'case "$1" in',
      '  *secrets-status*)',
      '    printf \'%s\\n\' "$AH_SHIM_SECRETS_LINES"',
      '    exit "${AH_SHIM_SECRETS_RC:-0}"',
      '    ;;',
      '  *openai-check*)',
      '    printf \'%s\\n\' "$AH_SHIM_OPENAI_LINE"',
      '    exit "${AH_SHIM_OPENAI_RC:-0}"',
      '    ;;',
      'esac',
      'exit 9',
    ].join('\n'),
  );
  return { path, dir: shimDir };
}

interface Sandbox {
  dir: string;
  log: string;
  keyPath: string;
  portBase: number;
}

async function greenSandbox(): Promise<Sandbox> {
  const dir = mkdtempSync(join(tmpdir(), 'ah-doctor-'));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const keyPath = join(dir, 'master.key');
  writeFileSync(keyPath, `${'0'.repeat(64)}\n`);
  chmodSync(keyPath, 0o600);
  const ports = await bindDerivedPorts();
  cleanups.push(ports.close);
  return { dir, log: join(dir, 'log'), keyPath, portBase: ports.portBase };
}

function greenEnv(sandbox: Sandbox, extra: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: sandbox.dir,
    AH_INSTANCE: 'default',
    AH_PORT_BASE: String(sandbox.portBase),
    MASTER_KEY_PATH: sandbox.keyPath,
    AH_SHIM_LOG: sandbox.log,
    AH_SHIM_SECRETS_LINES: 'GITHUB_PAT=set:ab12\nOPENAI_API_KEY=set:cd34',
    AH_SHIM_OPENAI_LINE: 'ok gpt-5.6-sol',
    ...extra,
  };
}

function greenDocker(overrides: DockerShimOptions = {}): DockerShimOptions {
  return { availability: 'up', image: 'present', ...overrides };
}

function greenPnpm(overrides: PnpmShimOptions = {}): PnpmShimOptions {
  return { migrateStatusExitCode: 0, ...overrides };
}

describe('doctor.sh — all green', () => {
  /**
   * The helper command override is one executable path, not a word list: a path containing a
   * space must still resolve to a single command. Splitting it on whitespace would look for an
   * executable that does not exist and turn the Secrets row into a helper error.
   */
  it('runs a helper override whose path contains a space', async () => {
    const sandbox = await greenSandbox();
    const shimDir = createShimDir({ log: sandbox.log, docker: greenDocker(), pnpm: greenPnpm() });
    const helperPath = writeExtraShim(
      shimDir,
      'helper with space.sh',
      [
        'case "$1" in',
        '  *secrets-status*)',
        '    printf \'%s\\n\' "$AH_SHIM_SECRETS_LINES"',
        '    exit 0',
        '    ;;',
        '  *openai-check*)',
        '    printf \'%s\\n\' "$AH_SHIM_OPENAI_LINE"',
        '    exit 0',
        '    ;;',
        'esac',
        'exit 9',
      ].join('\n'),
    );
    const result = spawnScript(scriptPath, {
      shimDir,
      env: greenEnv(sandbox, { AH_DOCTOR_HELPER_CMD: helperPath }),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('GitHub PAT: set (…ab12)');
    expect(result.stdout).not.toContain('helper error');
  });

  /**
   * Every required row passes and both optional rows report success: exit 0.
   */
  it('exits 0 when every check passes', async () => {
    const sandbox = await greenSandbox();
    const shimDir = createShimDir({ log: sandbox.log, docker: greenDocker(), pnpm: greenPnpm() });
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      env: greenEnv(sandbox, { AH_DOCTOR_HELPER_CMD: helper.path }),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('All required checks passed');
    expect(result.stdout).toContain('instance=default');
    for (const symbol of ['✓']) {
      expect(result.stdout).toContain(symbol);
    }
  });

  /**
   * `--json` parses into 10 objects, each with the four documented keys.
   */
  it('--json prints 10 rows with the documented keys', async () => {
    const sandbox = await greenSandbox();
    const shimDir = createShimDir({ log: sandbox.log, docker: greenDocker(), pnpm: greenPnpm() });
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(sandbox, { AH_DOCTOR_HELPER_CMD: helper.path }),
    });
    expect(result.status).toBe(0);
    const rows = JSON.parse(result.stdout) as {
      check: string;
      status: string;
      detail: string;
      fix: string;
    }[];
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['check', 'detail', 'fix', 'status']);
    }
    expect(rows.map((row) => row.check)).toEqual([
      'Node',
      'pnpm',
      'Docker socket',
      'Postgres',
      'Redis',
      'Migrations',
      'Workspace image',
      'Master key',
      'Secrets',
      'OpenAI model',
    ]);
  });
});

describe('doctor.sh — required failures', () => {
  /**
   * Docker unreachable: the socket row is ✗ with the R2 fix, the image row is skipped, exit 1.
   */
  it('reports Docker down with the R2 fix and skips the image row', async () => {
    const sandbox = await greenSandbox();
    const shimDir = createShimDir({
      log: sandbox.log,
      docker: greenDocker({ availability: 'down' }),
      pnpm: greenPnpm(),
    });
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(sandbox, { AH_DOCTOR_HELPER_CMD: helper.path }),
    });
    expect(result.status).toBe(1);
    const rows = JSON.parse(result.stdout) as { check: string; status: string; fix: string }[];
    const docker = rows.find((row) => row.check === 'Docker socket');
    const image = rows.find((row) => row.check === 'Workspace image');
    expect(docker?.status).toBe('✗');
    expect(docker?.fix).toContain('DOCKER_HOST=unix://');
    expect(image?.status).toBe('–');
  });

  /**
   * The workspace image is missing: fix is `pnpm infra:image`.
   */
  it('reports a missing workspace image with pnpm infra:image', async () => {
    const sandbox = await greenSandbox();
    const shimDir = createShimDir({
      log: sandbox.log,
      docker: greenDocker({ image: 'missing' }),
      pnpm: greenPnpm(),
    });
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(sandbox, { AH_DOCTOR_HELPER_CMD: helper.path }),
    });
    expect(result.status).toBe(1);
    const rows = JSON.parse(result.stdout) as { check: string; status: string; fix: string }[];
    const image = rows.find((row) => row.check === 'Workspace image');
    expect(image).toEqual({
      check: 'Workspace image',
      status: '✗',
      detail: 'missing',
      fix: 'pnpm infra:image',
    });
  });

  /**
   * A master key file with mode 644 is refused with `chmod 600`, and the Secrets row is skipped.
   */
  it('reports a wrongly-permissioned master key with chmod 600', async () => {
    const sandbox = await greenSandbox();
    chmodSync(sandbox.keyPath, 0o644);
    const shimDir = createShimDir({ log: sandbox.log, docker: greenDocker(), pnpm: greenPnpm() });
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(sandbox, { AH_DOCTOR_HELPER_CMD: helper.path }),
    });
    expect(result.status).toBe(1);
    const rows = JSON.parse(result.stdout) as {
      check: string;
      status: string;
      fix: string;
      detail: string;
    }[];
    const key = rows.find((row) => row.check === 'Master key');
    expect(key?.status).toBe('✗');
    expect(key?.fix).toContain('chmod 600');
    const secrets = rows.find((row) => row.check === 'Secrets');
    expect(secrets?.status).toBe('–');
  });

  /**
   * A missing master key reports the `pnpm setup` fix.
   */
  it('reports a missing master key with pnpm setup', async () => {
    const sandbox = await greenSandbox();
    rmSync(sandbox.keyPath);
    const shimDir = createShimDir({ log: sandbox.log, docker: greenDocker(), pnpm: greenPnpm() });
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(sandbox, { AH_DOCTOR_HELPER_CMD: helper.path }),
    });
    const rows = JSON.parse(result.stdout) as { check: string; status: string; fix: string }[];
    const key = rows.find((row) => row.check === 'Master key');
    expect(key).toEqual({ check: 'Master key', status: '✗', detail: 'missing', fix: 'pnpm setup' });
  });

  /**
   * Postgres unreachable: the Postgres row is ✗, Migrations and Secrets are skipped with
   * "postgres down"/"master key or database unavailable", and OpenAI model is skipped too
   * (nothing reports the key as set).
   */
  it('cascades Postgres-down into the dependent rows', async () => {
    const sandbox = await greenSandbox();
    const shimDir = createShimDir({ log: sandbox.log, docker: greenDocker(), pnpm: greenPnpm() });
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(sandbox, {
        AH_DOCTOR_HELPER_CMD: helper.path,
        AH_PORT_BASE: String(await closedPortBase()),
      }),
    });
    expect(result.status).toBe(1);
    const rows = JSON.parse(result.stdout) as { check: string; status: string; detail: string }[];
    expect(rows.find((row) => row.check === 'Postgres')?.status).toBe('✗');
    expect(rows.find((row) => row.check === 'Migrations')).toEqual({
      check: 'Migrations',
      status: '–',
      detail: 'postgres down',
      fix: '',
    });
    expect(rows.find((row) => row.check === 'Secrets')?.status).toBe('–');
    expect(rows.find((row) => row.check === 'OpenAI model')?.status).toBe('–');
  });

  /**
   * Pending migrations report the `pnpm db:migrate` fix.
   */
  it('reports pending migrations with pnpm db:migrate', async () => {
    const sandbox = await greenSandbox();
    const shimDir = createShimDir({
      log: sandbox.log,
      docker: greenDocker(),
      pnpm: greenPnpm({ migrateStatusExitCode: 1 }),
    });
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(sandbox, { AH_DOCTOR_HELPER_CMD: helper.path }),
    });
    expect(result.status).toBe(1);
    const rows = JSON.parse(result.stdout) as { check: string; status: string; fix: string }[];
    const migrations = rows.find((row) => row.check === 'Migrations');
    expect(migrations).toEqual({
      check: 'Migrations',
      status: '✗',
      detail: 'pending',
      fix: 'pnpm db:migrate',
    });
  });
});

describe('doctor.sh — optional rows never fail the exit code', () => {
  /**
   * An unset secret reports a warning with a Settings-page fix and does not fail the exit code;
   * the OpenAI row is skipped because no key is set.
   */
  it('reports unset secrets as a warning without failing the run', async () => {
    const sandbox = await greenSandbox();
    const shimDir = createShimDir({ log: sandbox.log, docker: greenDocker(), pnpm: greenPnpm() });
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(sandbox, {
        AH_DOCTOR_HELPER_CMD: helper.path,
        AH_SHIM_SECRETS_LINES: 'GITHUB_PAT=set:ab12\nOPENAI_API_KEY=unset',
      }),
    });
    expect(result.status).toBe(0);
    const rows = JSON.parse(result.stdout) as {
      check: string;
      status: string;
      detail: string;
      fix: string;
    }[];
    const secrets = rows.find((row) => row.check === 'Secrets');
    expect(secrets?.status).toBe('⚠');
    expect(secrets?.detail).toBe('GitHub PAT: set (…ab12) · OpenAI key: unset');
    expect(secrets?.fix).toContain('/settings');
    expect(secrets?.fix).toContain(String(sandbox.portBase));
    const openai = rows.find((row) => row.check === 'OpenAI model');
    expect(openai).toEqual({
      check: 'OpenAI model',
      status: '–',
      detail: 'no OpenAI key',
      fix: '',
    });
  });

  /**
   * An OpenAI key that is set and reachable reports the model id, still exit 0.
   */
  it('reports the OpenAI model as reachable when the key is set', async () => {
    const sandbox = await greenSandbox();
    const shimDir = createShimDir({ log: sandbox.log, docker: greenDocker(), pnpm: greenPnpm() });
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(sandbox, { AH_DOCTOR_HELPER_CMD: helper.path }),
    });
    expect(result.status).toBe(0);
    const rows = JSON.parse(result.stdout) as { check: string; status: string; detail: string }[];
    expect(rows.find((row) => row.check === 'OpenAI model')).toEqual({
      check: 'OpenAI model',
      status: '✓',
      detail: 'gpt-5.6-sol',
      fix: '',
    });
  });

  /**
   * A model-missing outcome from the OpenAI helper is a warning, not a failure.
   */
  it('reports model-missing as a warning', async () => {
    const sandbox = await greenSandbox();
    const shimDir = createShimDir({ log: sandbox.log, docker: greenDocker(), pnpm: greenPnpm() });
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(sandbox, {
        AH_DOCTOR_HELPER_CMD: helper.path,
        AH_SHIM_OPENAI_LINE: 'model-missing gpt-5.6-sol (available: a, b)',
        AH_SHIM_OPENAI_RC: '5',
      }),
    });
    expect(result.status).toBe(0);
    const rows = JSON.parse(result.stdout) as {
      check: string;
      status: string;
      detail: string;
      fix: string;
    }[];
    const openai = rows.find((row) => row.check === 'OpenAI model');
    expect(openai?.status).toBe('⚠');
    expect(openai?.detail).toBe('model-missing gpt-5.6-sol (available: a, b)');
    expect(openai?.fix).toContain('OPENAI_MODEL');
  });

  /**
   * An auth failure from the OpenAI helper reports the Settings-page fix.
   */
  it('reports an auth failure with the Settings fix', async () => {
    const sandbox = await greenSandbox();
    const shimDir = createShimDir({ log: sandbox.log, docker: greenDocker(), pnpm: greenPnpm() });
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(sandbox, {
        AH_DOCTOR_HELPER_CMD: helper.path,
        AH_SHIM_OPENAI_LINE: 'auth',
        AH_SHIM_OPENAI_RC: '6',
      }),
    });
    expect(result.status).toBe(0);
    const rows = JSON.parse(result.stdout) as {
      check: string;
      status: string;
      detail: string;
      fix: string;
    }[];
    const openai = rows.find((row) => row.check === 'OpenAI model');
    expect(openai).toEqual({
      check: 'OpenAI model',
      status: '⚠',
      detail: 'auth',
      fix: 'Replace the OpenAI key in Settings',
    });
  });

  /**
   * A network failure from the OpenAI helper reports the network/base-URL fix.
   */
  it('reports a network failure with the network fix', async () => {
    const sandbox = await greenSandbox();
    const shimDir = createShimDir({ log: sandbox.log, docker: greenDocker(), pnpm: greenPnpm() });
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(sandbox, {
        AH_DOCTOR_HELPER_CMD: helper.path,
        AH_SHIM_OPENAI_LINE: 'network connection reset',
        AH_SHIM_OPENAI_RC: '7',
      }),
    });
    expect(result.status).toBe(0);
    const rows = JSON.parse(result.stdout) as {
      check: string;
      status: string;
      detail: string;
      fix: string;
    }[];
    const openai = rows.find((row) => row.check === 'OpenAI model');
    expect(openai?.status).toBe('⚠');
    expect(openai?.fix).toContain('OPENAI_BASE_URL');
  });

  /**
   * The secrets-status helper's own db-unreachable/master-key-missing outcomes are reported
   * verbatim as skipped rows (defensive: doctor.sh's own bash-level gating already prevents this
   * in practice, since row 9 is only reached when Postgres and the master key both passed).
   */
  it.each([
    ['3', 'db-unreachable'],
    ['4', 'master-key-missing'],
  ])('reports the secrets helper exit %s as skipped with %s', async (rc, detail) => {
    const sandbox = await greenSandbox();
    const shimDir = createShimDir({ log: sandbox.log, docker: greenDocker(), pnpm: greenPnpm() });
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(sandbox, {
        AH_DOCTOR_HELPER_CMD: helper.path,
        AH_SHIM_SECRETS_RC: rc,
      }),
    });
    expect(result.status).toBe(0);
    const rows = JSON.parse(result.stdout) as { check: string; status: string; detail: string }[];
    const secrets = rows.find((row) => row.check === 'Secrets');
    expect(secrets).toEqual({ check: 'Secrets', status: '–', detail, fix: '' });
  });
});

describe('doctor.sh on a GNU userland', () => {
  /**
   * The Linux-only regression this shim reproduces on any machine: with GNU coreutils, the key's
   * mode was read by a `stat -f … || stat -c …` chain whose first branch prints a filesystem block
   * on stdout before failing. The mode came back as that block with the real mode appended, so a
   * correctly-permissioned key was reported as wrongly-permissioned, the run exited 1, and the
   * embedded newlines made `--json` unparseable.
   */
  it('reads the key mode correctly and still emits valid JSON', async () => {
    const sandbox = await greenSandbox();
    const shimDir = createShimDir({ log: sandbox.log, docker: greenDocker(), pnpm: greenPnpm() });
    writeGnuStatShim(shimDir);
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(sandbox, { AH_DOCTOR_HELPER_CMD: helper.path }),
    });

    expect(result.status).toBe(0);
    const rows = JSON.parse(result.stdout) as { check: string; status: string; detail: string }[];
    const key = rows.find((row) => row.check === 'Master key');
    expect(key?.status).toBe('✓');
    expect(key?.detail).toBe(`${sandbox.keyPath} (mode 600)`);
  });

  /**
   * The check still refuses a group-readable key on the same userland: the fix is about reading
   * the mode, not about accepting whatever it reads.
   */
  it('still refuses a group-readable key', async () => {
    const sandbox = await greenSandbox();
    const shimDir = createShimDir({ log: sandbox.log, docker: greenDocker(), pnpm: greenPnpm() });
    writeGnuStatShim(shimDir, '644');
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(sandbox, { AH_DOCTOR_HELPER_CMD: helper.path }),
    });

    expect(result.status).toBe(1);
    const rows = JSON.parse(result.stdout) as { check: string; status: string; fix: string }[];
    const key = rows.find((row) => row.check === 'Master key');
    expect(key?.status).toBe('✗');
    expect(key?.fix).toContain('chmod 600');
  });
});

describe('doctor.sh usage', () => {
  /**
   * An unrecognised flag exits 2 with a usage line.
   */
  it('rejects an unknown flag', async () => {
    const sandbox = await greenSandbox();
    const shimDir = createShimDir({ log: sandbox.log, docker: greenDocker(), pnpm: greenPnpm() });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--nope'],
      env: greenEnv(sandbox),
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage');
  });
});
