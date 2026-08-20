/**
 * Lifecycle of the worker process during a real-stack run.
 *
 * Layer: test support (spawns processes).
 *
 * The worker is a background service of the stack, like Postgres, Redis and the git server, and it
 * is started alongside them rather than by Playwright. Playwright cannot manage it: a `webServer`
 * entry waits on an HTTP status, the worker owns no port, and pointing its entry at the web
 * server's health route makes Playwright consider it already running and never start it at all —
 * which is silent, because nothing else in the run says the worker is missing.
 *
 * It is spawned into its own process group so the whole tree — `tsx watch` and the worker it
 * supervises — can be stopped together.
 */
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';

import type { E2eEnv } from './env';
import { repoRoot, serverEnv } from './env';

/** Where the worker's output is written, so a failed run can be read afterwards. */
export function workerLogPath(env: E2eEnv): string {
  return `${env.tmpDir}/worker.log`;
}

/**
 * Starts the worker detached, with the stack's environment.
 *
 * @param env - The resolved environment.
 * @returns The process id of the worker's process group leader.
 * @throws Error when the process cannot be spawned.
 */
export function startWorker(env: E2eEnv): number {
  const log = openSync(workerLogPath(env), 'a');
  const child = spawn('pnpm', ['--filter', 'worker', 'dev'], {
    cwd: repoRoot(),
    env: { ...process.env, ...serverEnv(env) },
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  if (child.pid === undefined) {
    throw new Error('Could not start the worker');
  }
  return child.pid;
}

/**
 * Stops the worker's whole process group, tolerating one that is already gone.
 *
 * @param pid - Process id returned by {@link startWorker}.
 */
export function stopWorker(pid: number): void {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // Already exited, or its group is gone: either way there is nothing left to stop.
  }
}
