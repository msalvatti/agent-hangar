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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { workspaceImageStatus } from './docker';
import type { WorkspaceImageStatus } from './docker';
import { repoRoot, resolveE2eEnv, webRoot } from './env';
import type { E2eEnv } from './env';
import { startGitServer, stopGitServer } from './gitserver';
import { clearWorkerHeartbeat } from './heartbeat';
import { writeMasterKey } from './master-key';
import { exec } from './process';
import { readStackState, writeStackState } from './stack-state';
import { startWorker, stopWorker, workerLogPath } from './worker';

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

/** Why each answer other than `current` stops the run, in the words of the refusal. */
const IMAGE_REFUSAL_REASONS: Record<Exclude<WorkspaceImageStatus, 'current'>, string> = {
  missing: 'is missing',
  stale:
    'was not built from this checkout, so the run would measure a runtime this tree does not contain',
  unverifiable:
    'could not be checked against this checkout, because the runtime bundle did not build',
  unavailable: 'could not be checked, because Docker did not answer',
};

/**
 * Refuses to start a real run against an image that is missing or does not carry this tree.
 *
 * A stale image is the failure this checks for, and it is worse than a missing one: nothing about
 * the run announces it. The suite comes up, the specs pass or fail, and what they measured was an
 * agent runtime that is in no tree — measured once, when a rebuild in another checkout retargeted
 * the shared tag a minute into a run and the recorded failure described a combination of worker
 * and runtime that had never existed together.
 *
 * `unavailable` is refused too. It means the question could not be asked, and a harness that
 * treated "could not check" as "checked and fine" would be exactly the kind of vacuous pass the
 * readiness gate below already exists to prevent.
 *
 * @param env - The resolved environment.
 * @throws Error naming the command that fixes it.
 */
async function assertWorkspaceImage(env: E2eEnv): Promise<void> {
  const status = await workspaceImageStatus(repoRoot(), env.workspaceImage);
  if (status === 'current') {
    return;
  }
  throw new Error(
    `Workspace image "${env.workspaceImage}" ${IMAGE_REFUSAL_REASONS[status]}. Build it with: ` +
      `WORKSPACE_IMAGE=${env.workspaceImage} pnpm infra:image`,
  );
}

/** Applies the migrations to the test database. */
async function migrate(env: E2eEnv): Promise<void> {
  await exec('pnpm', ['--filter', '@agent-hangar/core', 'db:migrate'], {
    cwd: repoRoot(),
    env: { DATABASE_URL: env.databaseUrl },
  });
}

/** Where `next dev` records the server holding this checkout. */
const DEV_LOCK_PATH = 'apps/web/.next/dev/lock';

/** What that lock file carries; only the two fields this needs are read. */
const devLockSchema = z.object({ pid: z.number().int().positive(), appUrl: z.string() });

/**
 * Refuses when a `next dev` server from this checkout is already running.
 *
 * Next serialises the dev server per directory, not per port, so the real leg's own `next dev`
 * cannot start while a developer's is up — it exits with "Another next dev server is already
 * running" and Playwright reports only that its web server would not start. By then this script
 * has brought compose, the migrations, the git server and a worker up, and none of them is torn
 * down, because Playwright does not run a global teardown for a run that never began: the worker
 * is left holding the queues of the `test` instance until someone finds it.
 *
 * So the collision is caught here, before anything is started, and named: the alternative is a
 * failure two layers away from its cause and a process nobody knows to kill.
 *
 * A stale lock does not block anything — the process it names is checked, and a lock left by a
 * crash names a pid that is gone.
 *
 * @throws Error naming the running server and both ways forward.
 */
function assertNoDevServer(): void {
  const lock = join(repoRoot(), DEV_LOCK_PATH);
  let parsed: { pid: number; appUrl: string };
  try {
    parsed = devLockSchema.parse(JSON.parse(readFileSync(lock, 'utf8')));
  } catch {
    // No lock, or one this does not understand: nothing to refuse.
    return;
  }
  try {
    // Signal 0 asks whether the process exists without touching it.
    process.kill(parsed.pid, 0);
  } catch {
    return;
  }
  throw new Error(
    `A Next dev server from this checkout is already running (pid ${String(parsed.pid)}, ${parsed.appUrl}).\n` +
      'Next allows one dev server per directory, so the real-mode suite cannot start its own and ' +
      'nothing below would be torn down when it fails.\n' +
      'Stop it (the process running `pnpm dev`), or run the mock leg instead with E2E_MODE=mock.',
  );
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
  assertNoDevServer();
  writeMasterKey(env);
  if (skipCompose(processEnv)) {
    process.stdout.write('prepare-stack: E2E_SKIP_COMPOSE=1, using the services already running\n');
  } else {
    await composeUp(env);
  }
  await migrate(env);
  await assertWorkspaceImage(env);
  const gitServer = await startGitServer({
    port: env.gitServerPort,
    instance: env.instance,
    host: env.gitServerHost,
    bindAddress: env.gitServerBindAddress,
    repoRoot: repoRoot(),
  });
  const previous = readStackState(env);
  // Everything from here on is a process this script owns, so a failure past this point has to put
  // them back. Playwright runs no global teardown for a run that never began, and the git server
  // and the worker would otherwise outlive the command that started them — the worker holding the
  // `test` instance's queues until somebody goes looking for it with `ps`.
  let worker;
  try {
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
    worker = await startWorker(env);
  } catch (error) {
    // Best effort, and deliberately so: the failure being reported is the one worth reporting, and
    // a teardown that threw on its way out would replace it with its own.
    await stopGitServer(gitServer).catch(() => undefined);
    throw error;
  }
  writeStackState(env, { ...previous, gitServer, worker });
  process.stdout.write(
    `prepare-stack: git server ready at ${gitServer.url}; worker ${String(worker.pid)} started, ` +
      `logging to ${workerLogPath(env)}\n`,
  );
}

await prepareStack(resolveE2eEnv());
