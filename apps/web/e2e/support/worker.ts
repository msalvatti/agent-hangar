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
import { closeSync, openSync } from 'node:fs';

import type { E2eEnv } from './env';
import { repoRoot, serverEnv } from './env';
import { exec } from './process';

/** Arguments the worker is spawned with; also how a recorded id is confirmed to still be it. */
const WORKER_ARGS = ['--filter', 'worker', 'dev'] as const;

/**
 * The spawned command line, as `ps` reports it. Specific enough that an unrelated process cannot
 * match by accident — the bare word "worker" appears in plenty of command lines, including this
 * repository's own paths.
 */
const WORKER_COMMAND = WORKER_ARGS.join(' ');

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
  try {
    const child = spawn('pnpm', [...WORKER_ARGS], {
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
  } finally {
    // The child holds its own duplicate of the descriptor; this one has no further use.
    closeSync(log);
  }
}

/**
 * Whether a command line, as `ps` reports it, is the worker's.
 *
 * Matched against the whole invocation rather than the word "worker", which appears in this
 * repository's own paths and in any number of unrelated command lines.
 *
 * @param commandLine - A line of `ps -o command=` output.
 * @returns `true` when the line is a worker invocation.
 */
export function isWorkerCommandLine(commandLine: string): boolean {
  return commandLine.includes(WORKER_COMMAND);
}

/**
 * Whether a process with this id currently exists.
 *
 * Signal `0` performs the permission and existence checks without delivering anything. `EPERM`
 * means it exists but belongs to someone else, which is reported as absent: this must never
 * signal a process it does not own.
 *
 * @param pid - Process id to test.
 * @returns `true` when a process this user may signal has that id.
 */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a recorded process id still names the worker.
 *
 * The id is read back from a file that outlives the run that wrote it, and the operating system
 * reuses ids, so signalling a whole process group by a stale id would reach whatever inherited it.
 * Existence is settled first, with no child process involved; only then is the command line read.
 * A failure of `ps` itself is NOT treated as "not the worker" — that would make every stop a
 * silent no-op on a machine without `ps` — so it propagates.
 *
 * @param pid - Process id recorded for a previous run.
 * @returns `true` when a live process with that id is the worker.
 * @throws CommandError when `ps` cannot be run at all.
 */
async function isWorkerProcess(pid: number): Promise<boolean> {
  if (!processExists(pid)) {
    return false;
  }
  const { stdout } = await exec('ps', ['-p', String(pid), '-o', 'command=']);
  return isWorkerCommandLine(stdout);
}

/** How long a stopped worker is given to exit before it is killed outright. */
const STOP_TIMEOUT_MS = 15_000;

/** Interval between checks that the worker has gone. */
const STOP_POLL_MS = 200;

/** Resolves once the process is gone, or when the budget runs out. */
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, STOP_POLL_MS));
  }
  return true;
}

/** Signals the process group, tolerating one that disappeared between check and signal. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Exited already, or its group is gone: nothing left to signal.
  }
}

/**
 * Stops the worker's whole process group and waits for it to go.
 *
 * The wait is the point: the worker shuts down gracefully, and starting a replacement while the
 * old one is still draining would put two workers on the same queues — the very thing stopping it
 * is meant to prevent. A worker that will not leave within the budget is killed outright.
 *
 * @param pid - Process id returned by {@link startWorker}.
 * @param timeoutMs - How long to wait for a graceful exit.
 * @throws CommandError when the recorded id cannot be inspected.
 */
export async function stopWorker(pid: number, timeoutMs = STOP_TIMEOUT_MS): Promise<void> {
  if (!(await isWorkerProcess(pid))) {
    return;
  }
  signalGroup(pid, 'SIGTERM');
  if (await waitForExit(pid, timeoutMs)) {
    return;
  }
  signalGroup(pid, 'SIGKILL');
  await waitForExit(pid, timeoutMs);
}
