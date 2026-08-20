/**
 * Brings up everything the managed servers need before Playwright starts them.
 *
 * Layer: test support (spawns processes; entry point of `pnpm --filter web test:e2e`).
 *
 * Playwright launches `webServer` entries BEFORE `globalSetup` runs, so anything the web server or
 * the worker read at boot — the master key file, the database, its migrations, the workspace image
 * — has to exist before Playwright is started at all. That is why this is a separate step in the
 * `test:e2e` script rather than part of the global setup.
 *
 * In `mock` mode the only step is a production build of the web app. The mock API cannot run under
 * `next dev`: React strict mode invokes the boot effect twice, the second `worker.start()` is
 * rejected as "cannot configure an already enabled network", and the tree never renders. A
 * production build invokes it once. Nothing else is needed — no database, no Redis, no Docker.
 *
 * The worker is started here too, for the reason `support/worker.ts` gives; the global setup then
 * refuses to begin until it has reported.
 *
 * `E2E_SKIP_COMPOSE=1` keeps the migrations and the git server but leaves Postgres and Redis to
 * whoever already started them — that is how CI runs, with both as job services.
 * `E2E_SKIP_BUILD=1` reuses the build already in `.next`, for a developer iterating on one spec.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';

import { imageExists } from './docker';
import { repoRoot, resolveE2eEnv, webRoot } from './env';
import type { E2eEnv } from './env';
import { startGitServer } from './gitserver';
import { clearWorkerHeartbeat } from './heartbeat';
import { exec } from './process';
import { readStackState, writeStackState } from './stack-state';
import { startWorker, stopWorker, workerLogPath } from './worker';

/** Bytes of the master key; the secrets module expects a 32-byte hex key. */
const MASTER_KEY_BYTES = 32;

/** Permissions of the master key file: readable by its owner only. */
const MASTER_KEY_MODE = 0o600;

/**
 * Permissions of the directory holding it. The secrets module refuses a key whose directory group
 * or others can reach — write access to the directory is enough to replace the key — so `mkdir`
 * alone is not sufficient: the mode it applies is filtered by the umask, and a directory that
 * already exists keeps whatever permissions it had.
 */
const MASTER_KEY_DIR_MODE = 0o700;

/** Path of the compose file, relative to the repository root. */
const COMPOSE_FILE = 'infra/docker-compose.yml';

/** Whether the mock-mode production build should be reused rather than rebuilt. */
function skipBuild(processEnv: NodeJS.ProcessEnv): boolean {
  return processEnv.E2E_SKIP_BUILD === '1';
}

/** Whether compose should be skipped because the services are already provided. */
function skipCompose(processEnv: NodeJS.ProcessEnv): boolean {
  return processEnv.E2E_SKIP_COMPOSE === '1';
}

/** Writes a fresh master key for this run, in the shape and with the permissions it demands. */
function writeMasterKey(env: E2eEnv): void {
  mkdirSync(env.tmpDir, { recursive: true, mode: MASTER_KEY_DIR_MODE });
  chmodSync(env.tmpDir, MASTER_KEY_DIR_MODE);
  writeFileSync(env.masterKeyPath, `${randomBytes(MASTER_KEY_BYTES).toString('hex')}\n`, {
    mode: MASTER_KEY_MODE,
  });
}

/** Starts Postgres and Redis for the test instance. */
async function composeUp(env: E2eEnv): Promise<void> {
  await exec(
    'docker',
    ['compose', '-f', COMPOSE_FILE, '-p', env.composeProjectName, 'up', '-d', '--wait'],
    {
      cwd: repoRoot(),
      env: {
        COMPOSE_PROJECT_NAME: env.composeProjectName,
        POSTGRES_DB: env.postgresDb,
        POSTGRES_PORT: String(env.postgresPort),
        REDIS_PORT: String(env.redisPort),
      },
    },
  );
}

/** Applies the migrations to the test database. */
async function migrate(env: E2eEnv): Promise<void> {
  await exec('pnpm', ['--filter', '@agent-hangar/core', 'db:migrate'], {
    cwd: repoRoot(),
    env: { DATABASE_URL: env.databaseUrl },
  });
}

/**
 * Prepares the stack for one run.
 *
 * @param env - The resolved environment.
 * @param processEnv - Environment carrying the flags (defaults to `process.env`).
 * @throws Error when the workspace image is missing, naming the command that builds it.
 */
export async function prepareStack(
  env: E2eEnv,
  processEnv: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (env.mode === 'mock') {
    if (skipBuild(processEnv)) {
      process.stdout.write('prepare-stack: E2E_SKIP_BUILD=1, reusing the existing build\n');
      return;
    }
    process.stdout.write('prepare-stack: building the web app with the mock API enabled\n');
    await exec('pnpm', ['exec', 'next', 'build'], {
      cwd: webRoot(),
      env: { NEXT_PUBLIC_API_MOCK: '1' },
    });
    return;
  }
  writeMasterKey(env);
  if (skipCompose(processEnv)) {
    process.stdout.write('prepare-stack: E2E_SKIP_COMPOSE=1, using the services already running\n');
  } else {
    await composeUp(env);
  }
  await migrate(env);
  if (!(await imageExists(env.workspaceImage))) {
    throw new Error(
      `Workspace image "${env.workspaceImage}" is missing. Build it with: pnpm infra:image`,
    );
  }
  const gitServer = await startGitServer({
    port: env.gitServerPort,
    instance: env.instance,
    host: env.gitServerHost,
    bindAddress: env.gitServerBindAddress,
    repoRoot: repoRoot(),
  });
  const previous = readStackState(env);
  // A run killed before its teardown leaves its worker behind, and a second worker on the same
  // queues would take jobs the first is already running. The git server is reused; the worker is
  // replaced, because it holds no state worth keeping.
  if (previous.worker !== undefined) {
    await stopWorker(previous.worker);
  }
  // The heartbeat outlives the worker that wrote it by its own time-to-live, which is longer than
  // the readiness gate waits. Left in place, the gate would pass on the previous run's heartbeat
  // and start the specs against a worker that may never have come up — the exact vacuous pass the
  // gate exists to prevent. Cleared before the replacement is spawned, so only a fresh one counts.
  await clearWorkerHeartbeat(env);
  const worker = await startWorker(env);
  writeStackState(env, { ...previous, gitServer, worker });
  process.stdout.write(
    `prepare-stack: git server ready at ${gitServer.url}; worker ${String(worker.pid)} started, ` +
      `logging to ${workerLogPath(env)}\n`,
  );
}

await prepareStack(resolveE2eEnv());
