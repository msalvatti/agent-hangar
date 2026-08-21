/**
 * Unit tests for `infra/scripts/run.sh`.
 *
 * Layer: unit (spawns bash with PATH shims; no real Docker, no real Next.js/tsx).
 * Goal: instance/port derivation flows into the printed URL and the `--print-only` command line,
 * `AH_*` beats `CONDUCTOR_*`, the env file is created only when absent, `--production` runs
 * the built output on the instance's own port with the development resolution condition off, and
 * the app refuses to start while a master key rotation holds its lock or against a workspace image
 * that was not built from this checkout.
 * Mocks: docker/pnpm/openssl/node/concurrently via `infra/scripts/testing/shims.ts`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createShimDir, readShimLog, spawnScript, writeExtraShim } from './testing/shims.js';
import { expectedWorkspaceDigest, SHIM_BUNDLE_DIGEST } from './testing/workspace-digest.js';

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

describe('run.sh and the workspace image', () => {
  /**
   * Builds the environment of a run whose workspace image is present and reports a chosen digest.
   *
   * @param dir - Sandbox directory used as HOME and for the env file.
   * @param log - Shim log path.
   * @param imageDigest - Digest the image carries.
   * @returns The environment for {@link spawnScript}.
   */
  function envWithImage(dir: string, log: string, imageDigest: string): Record<string, string> {
    return {
      HOME: dir,
      AH_ENV_FILE: join(dir, '.env.local'),
      AH_SHIM_LOG: log,
      AH_SHIM_BUNDLE_DIGEST: SHIM_BUNDLE_DIGEST,
      AH_SHIM_IMAGE_DIGEST: imageDigest,
    };
  }

  /**
   * The refusal this check exists for. An image built from another revision starts containers that
   * run an agent runtime this tree does not contain, and nothing downstream says so: the turn
   * succeeds, and the result describes a combination of worker and runtime that was never released
   * together. Measured — a rebuild in a second checkout retargeted the shared tag a minute into a
   * run. So the app does not start, and the message names the one command that fixes it.
   */
  it('refuses to start against an image built from other sources', () => {
    const dir = sandbox();
    sandboxes.push(dir);
    const log = join(dir, 'log');
    const shimDir = createShimDir({ log, docker: { image: 'present' } });
    const result = spawnScript(scriptPath, {
      shimDir,
      env: envWithImage(dir, log, 'c'.repeat(64)),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('was not built from this checkout');
    expect(result.stderr).toContain('pnpm infra:image');
    expect(readShimLog(log).some((line) => line.startsWith('pnpm exec concurrently'))).toBe(false);
  });

  /** An image that carries this tree is the case the check is silent about. */
  it('starts against an image built from this checkout', () => {
    const dir = sandbox();
    sandboxes.push(dir);
    const log = join(dir, 'log');
    const shimDir = createShimDir({ log, docker: { image: 'present' } });
    const result = spawnScript(scriptPath, {
      shimDir,
      env: envWithImage(dir, log, expectedWorkspaceDigest()),
    });
    expect(result.status).toBe(0);
    expect(readShimLog(log).some((line) => line.startsWith('pnpm exec concurrently'))).toBe(true);
  });

  /**
   * Present, in use, and unverifiable is not the same as absent. The image exists, this instance is
   * about to create containers from it, and the checkout cannot say what is inside — the state the
   * check exists to refuse. Starting anyway because nothing was *proven* wrong is how a run ends up
   * reporting a result for a runtime nobody can name. Found by review: the first version of this
   * check blocked only on `stale` and waved this through with a warning on stderr.
   */
  it('refuses to start against an image it cannot check', () => {
    const dir = sandbox();
    sandboxes.push(dir);
    const log = join(dir, 'log');
    const shimDir = createShimDir({ log, docker: { image: 'present' } });
    // Answers `node -v`, fails the bundle digest — a worktree whose dependencies are not installed.
    writeExtraShim(
      shimDir,
      'node',
      "if [ \"$1\" = '-v' ]; then printf 'v24.0.0\\n'; exit 0; fi\nexit 1",
    );
    const result = spawnScript(scriptPath, {
      shimDir,
      env: envWithImage(dir, log, expectedWorkspaceDigest()),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('could not be checked against this checkout');
    expect(readShimLog(log).some((line) => line.startsWith('pnpm exec concurrently'))).toBe(false);
  });

  /**
   * A missing image is not refused. It is already loud everywhere it matters — the worker logs it,
   * `/api/health` reports it and the UI shows a banner — and a developer working on the interface
   * has no reason to build one. This is the case that stops the refusal above from being written as
   * "anything other than current": refusing here, and on the `unavailable` that a stopped Docker
   * produces, would make the interface unstartable without Docker.
   */
  it('starts with no workspace image at all', () => {
    const dir = sandbox();
    sandboxes.push(dir);
    const log = join(dir, 'log');
    const shimDir = createShimDir({ log, docker: { image: 'missing' } });
    const result = spawnScript(scriptPath, {
      shimDir,
      env: envWithImage(dir, log, expectedWorkspaceDigest()),
    });
    expect(result.status).toBe(0);
    expect(readShimLog(log).some((line) => line.startsWith('pnpm exec concurrently'))).toBe(true);
  });

  /**
   * Docker stopped altogether must still start the app. The interface is worked on without a
   * daemon — the README says so — and there is no image to be wrong about: nothing can be created
   * from one. This is the other half of the refusal above, and the reason the check is not written
   * as "anything other than current".
   */
  it('starts with Docker stopped', () => {
    const dir = sandbox();
    sandboxes.push(dir);
    const log = join(dir, 'log');
    const shimDir = createShimDir({ log, docker: { availability: 'down' } });
    const result = spawnScript(scriptPath, {
      shimDir,
      env: envWithImage(dir, log, expectedWorkspaceDigest()),
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('Docker is not reachable');
    expect(readShimLog(log).some((line) => line.startsWith('pnpm exec concurrently'))).toBe(true);
  });

  /**
   * `--print-only` starts nothing, so it asks Docker nothing either: the mode exists to show what
   * would run, and making it depend on a daemon would break the tests that read the command line.
   */
  it('asks Docker nothing in --print-only mode', () => {
    const dir = sandbox();
    sandboxes.push(dir);
    const log = join(dir, 'log');
    const shimDir = createShimDir({ log, docker: { image: 'present' } });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--print-only'],
      env: envWithImage(dir, log, 'c'.repeat(64)),
    });
    expect(result.status).toBe(0);
    expect(readShimLog(log).some((line) => line.startsWith('docker'))).toBe(false);
  });

  /**
   * An env file written before the image tag carried the instance still names the machine-global
   * one, and honouring it would leave the collision this closes in place. The refusal names the
   * tag the instance derives and both ways to get there.
   */
  it('refuses an env file that records another instance-wide image tag', () => {
    const dir = sandbox();
    sandboxes.push(dir);
    const log = join(dir, 'log');
    const envFile = join(dir, '.env.local');
    const shimDir = createShimDir({ log, docker: { image: 'present' } });
    spawnScript(scriptPath, {
      shimDir,
      args: ['--print-only'],
      env: envWithImage(dir, log, expectedWorkspaceDigest()),
    });
    writeFileSync(
      envFile,
      readFileSync(envFile, 'utf8').replace(
        'WORKSPACE_IMAGE="agent-hangar/workspace:default"',
        'WORKSPACE_IMAGE="agent-hangar/workspace:dev"',
      ),
    );

    const result = spawnScript(scriptPath, {
      shimDir,
      env: envWithImage(dir, log, expectedWorkspaceDigest()),
    });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('agent-hangar/workspace:default');
    expect(result.stderr).toContain('pnpm run setup --force');
  });
});
