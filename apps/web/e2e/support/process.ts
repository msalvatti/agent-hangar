/**
 * Thin wrappers over child processes and polling, shared by the harness helpers that talk to
 * Docker, compose and the git server.
 *
 * Layer: test support (spawns processes).
 *
 * Every command is spawned with an argument array, never a shell string: the harness interpolates
 * ports, container names and image tags into these calls, and a shell would turn any of them into
 * a place to inject a second command.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Output a command may produce before it is killed; a compose or migration log is verbose. */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** What a finished command produced. */
export interface CommandResult {
  stdout: string;
  stderr: string;
}

/**
 * Failure of a command, carrying whatever the process managed to write.
 *
 * {@link CommandError.exitCode} separates the two failures a caller may need to tell apart: a
 * command that ran and rejected its input, and one that never started. Reporting a verdict for the
 * second is how a caller ends up acting on the absence of an answer it never received.
 */
export class CommandError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  /**
   * Status the command exited with, or `undefined` when it never ran — a missing executable, a
   * denied one, or one killed by a signal before it could report.
   */
  readonly exitCode: number | undefined;

  constructor(
    command: string,
    args: readonly string[],
    stdout: string,
    stderr: string,
    exitCode: number | undefined,
  ) {
    super(`${command} ${args.join(' ')} failed: ${stderr.trim() || stdout.trim()}`);
    this.name = 'CommandError';
    this.stdout = stdout;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

/**
 * Runs a command to completion.
 *
 * @param command - Executable name.
 * @param args - Arguments, passed without a shell.
 * @param options - Working directory and extra environment.
 * @returns Its output.
 * @throws CommandError when the command exits non-zero, and when it cannot be started at all —
 *   the two are told apart by its `exitCode`.
 */
export async function exec(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<CommandResult> {
  try {
    const result = await run(command, [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: { ...process.env, ...options.env },
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    // Node reports the exit status in `code` as a number, and a failure to start in the same field
    // as an `errno` string such as `ENOENT`. Only the number means the command ran.
    const failure = error as { stdout?: string; stderr?: string; code?: number | string };
    throw new CommandError(
      command,
      args,
      failure.stdout ?? '',
      failure.stderr ?? String(error),
      typeof failure.code === 'number' ? failure.code : undefined,
    );
  }
}

/**
 * Runs a command and reports whether it succeeded, for probes such as `docker image inspect`.
 *
 * @param command - Executable name.
 * @param args - Arguments.
 * @returns `true` when the command exited zero.
 */
export async function succeeds(command: string, args: readonly string[]): Promise<boolean> {
  try {
    await exec(command, args);
    return true;
  } catch {
    return false;
  }
}

/**
 * Polls `probe` until it reports success or the budget runs out.
 *
 * Deliberately not a sleep: a fixed wait either fails on a slow machine or wastes time on a fast
 * one, and it hides which condition the caller was actually waiting for.
 *
 * @param probe - Returns `true` once the condition holds.
 * @param options - Budget, interval and the description used in the timeout message.
 * @throws Error naming what never became true.
 */
export async function waitUntil(
  probe: () => Promise<boolean>,
  options: { timeoutMs: number; intervalMs: number; description: string },
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    if (await probe()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${String(options.timeoutMs)} ms waiting for ${options.description}`,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, options.intervalMs));
  }
}
