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
 * It is spawned into its own process group so the whole tree — the package runner and the worker
 * it supervises — can be stopped together.
 */
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';

import { repoRoot, serverEnv } from './env';
import type { E2eEnv } from './env';
import { exec } from './process';

/** Arguments the worker is spawned with; also part of how a recorded process is identified. */
const WORKER_ARGS = ['--filter', 'worker', 'dev'] as const;

/**
 * The spawned command line, as `ps` reports it. Specific enough that an unrelated command cannot
 * match by accident, but NOT specific to this checkout: every worker of every checkout on the
 * machine shares it, which is why the start time below is what actually establishes identity.
 */
const WORKER_COMMAND = WORKER_ARGS.join(' ');

/** How long a stopped worker is given to exit before it is killed outright. */
const STOP_TIMEOUT_MS = 15_000;

/** Interval between checks that the worker has gone. */
const STOP_POLL_MS = 200;

/** A worker this run started. */
export interface WorkerHandle {
  /** Process id of the group leader. */
  pid: number;
  /**
   * The leader's start time as `ps` reports it. A process id is reused by the operating system,
   * and every concurrent checkout runs a worker with the same command line, so the id and the
   * command line together still do not identify one; the start time does.
   */
  startedAt: string;
}

/** Where the worker's output is written, so a failed run can be read afterwards. */
export function workerLogPath(env: E2eEnv): string {
  return `${env.tmpDir}/worker.log`;
}

/**
 * Whether a command line, as `ps` reports it, is a worker's.
 *
 * @param commandLine - A line of `ps -o command=` output.
 * @returns `true` when the line is a worker invocation.
 */
export function isWorkerCommandLine(commandLine: string): boolean {
  return commandLine.includes(WORKER_COMMAND);
}

/**
 * Whether an observed process is the very worker a handle refers to.
 *
 * Both halves are required. The command line rules out an unrelated program that inherited the id;
 * the start time rules out another checkout's worker, which has the same command line and could
 * hold a reused id. Signalling is by process group, so a wrong answer here reaches a whole tree
 * that belongs to somebody else.
 *
 * @param handle - The worker this run started.
 * @param commandLine - `ps -o command=` output for the handle's id.
 * @param startedAt - `ps -o lstart=` output for the same id.
 * @returns `true` only when both agree with the handle.
 */
export function isSameWorker(
  handle: WorkerHandle,
  commandLine: string,
  startedAt: string,
): boolean {
  return isWorkerCommandLine(commandLine) && startedAt.trim() === handle.startedAt.trim();
}

/** What `ps` reports about a recorded process id, when something still holds it. */
export interface LeaderFacts {
  /** `ps -o command=` output. */
  commandLine: string;
  /** `ps -o lstart=` output. */
  startedAt: string;
}

/**
 * Whether the recorded process group is still this run's, and may therefore be signalled.
 *
 * The recorded id is the package runner's, and the package runner exits while the worker it
 * supervises is still draining — so the leader having gone says nothing about the group. Reading
 * only the leader therefore has two answers to give, not one.
 *
 * While the leader is there, identity comes from what `ps` reports about it. Once it is gone, its
 * id can still name a live group only if that group is ours: an operating system does not hand a
 * process id out again while a process group carrying that id has members, so a surviving group
 * under the recorded id is the tree this run left behind. Reporting it stopped is what would put a
 * second worker on the queues the first is still consuming.
 *
 * @param handle - The worker this run started.
 * @param leader - What `ps` reports for its id, or `undefined` when nothing holds that id.
 * @param groupAlive - Whether any process of the recorded group still exists.
 * @returns `true` when the group belongs to this run.
 */
export function ownsRecordedGroup(
  handle: WorkerHandle,
  leader: LeaderFacts | undefined,
  groupAlive: boolean,
): boolean {
  return leader === undefined
    ? groupAlive
    : isSameWorker(handle, leader.commandLine, leader.startedAt);
}

/**
 * Reads one field of a process from `ps`.
 *
 * @param pid - Process id to inspect.
 * @param field - `ps` output field, such as `command=` or `lstart=`.
 * @returns The field's value, or `undefined` when no process has that id.
 * @throws CommandError when `ps` cannot be run at all.
 */
async function readProcessField(pid: number, field: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec('ps', ['-p', String(pid), '-o', field]);
    const value = stdout.trim();
    return value.length === 0 ? undefined : value;
  } catch {
    // `ps` exits non-zero when nothing has that id. It also would if `ps` itself were missing,
    // which is why the caller never treats "absent" as a reason to signal anything.
    return undefined;
  }
}

/**
 * Whether any process of a group is still alive.
 *
 * The negative id asks about the whole group, not the leader: the package runner can exit while
 * the worker it supervises is still draining, and waiting on the leader alone would report the
 * tree gone while it is still consuming the queues.
 *
 * @param pid - Process id of the group leader.
 * @returns `true` while at least one process of the group exists.
 */
function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Resolves once the whole group is gone, or `false` when the budget runs out. */
async function waitForGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (groupExists(pid)) {
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
 * Starts the worker detached, with the stack's environment.
 *
 * @param env - The resolved environment.
 * @returns A handle identifying this worker, id and start time together.
 * @throws Error when the process cannot be spawned or its start time cannot be read.
 */
export async function startWorker(env: E2eEnv): Promise<WorkerHandle> {
  const log = openSync(workerLogPath(env), 'a');
  let pid: number;
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
    pid = child.pid;
  } finally {
    // The child holds its own duplicate of the descriptor; this one has no further use.
    closeSync(log);
  }
  const startedAt = await readProcessField(pid, 'lstart=');
  if (startedAt === undefined) {
    // It died within milliseconds of being spawned — a bad configuration does exactly this — so
    // the reason is already in its log, and pointing there beats reporting the missing field.
    throw new Error(
      `The worker (${String(pid)}) exited immediately; see ${workerLogPath(env)} for why`,
    );
  }
  return { pid, startedAt };
}

/**
 * Stops the worker's whole process group and waits for every process in it to go.
 *
 * The wait is the point: the worker shuts down gracefully, and starting a replacement while the
 * old one is still draining would put two workers on the same queues — the very thing stopping it
 * is meant to prevent. A group that will not leave within the budget is killed outright, and one
 * that survives even that is reported rather than assumed gone. A group whose leader has already
 * gone is stopped too, for the reason {@link ownsRecordedGroup} gives.
 *
 * @param handle - Handle returned by {@link startWorker}.
 * @param timeoutMs - How long to wait for a graceful exit, and again after the kill.
 * @throws Error when the group is still alive after being killed.
 * @throws CommandError when the recorded process cannot be inspected.
 */
export async function stopWorker(handle: WorkerHandle, timeoutMs = STOP_TIMEOUT_MS): Promise<void> {
  const [commandLine, startedAt] = await Promise.all([
    readProcessField(handle.pid, 'command='),
    readProcessField(handle.pid, 'lstart='),
  ]);
  // Either field missing means the leader is not there to be identified — including the case where
  // it exits between the two reads, which would otherwise leave a half-read leader looking like a
  // mismatch and its live group untouched.
  const leader =
    commandLine === undefined || startedAt === undefined ? undefined : { commandLine, startedAt };
  if (!ownsRecordedGroup(handle, leader, groupExists(handle.pid))) {
    return;
  }
  signalGroup(handle.pid, 'SIGTERM');
  if (await waitForGroupExit(handle.pid, timeoutMs)) {
    return;
  }
  signalGroup(handle.pid, 'SIGKILL');
  if (!(await waitForGroupExit(handle.pid, timeoutMs))) {
    throw new Error(
      `The worker group ${String(handle.pid)} was still alive after SIGKILL; a second worker ` +
        `would consume the same queues, so this run cannot safely continue`,
    );
  }
}
