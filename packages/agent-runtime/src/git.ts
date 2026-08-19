/**
 * Small injectable git runner shared by the tools and by workspace preparation.
 *
 * Layer: adapter.
 *
 * Every git invocation goes through `spawn` with an argument array, never a shell string, so a
 * branch name or a URL cannot become shell syntax. The runner reports a non-zero exit as data
 * rather than throwing, because most callers want to branch on it; {@link gitOrThrow} is the
 * variant for the steps where a failure really is fatal.
 *
 * Credentials never appear here: the remote URL is credential-free and the token is released by
 * `askpass.sh`, which git calls itself.
 *
 * What a git command produces is capped for the same reason `run_shell` caps its child: `list_dir`
 * runs `ls-files` in a directory the model chose, inside a checkout whose content is untrusted, so
 * the size of the output is not something this process controls.
 */
import type { Readable } from 'node:stream';

import { nodeSpawn } from './spawn.js';
import type { SpawnFunction } from './spawn.js';

/** A git command line, guaranteed to name a subcommand. */
export type GitArgs = readonly [string, ...string[]];

/** Outcome of one git invocation. */
export interface GitCommandResult {
  /** Exit code, or `null` when git was killed or never started. */
  code: number | null;
  /** Standard output, capped at {@link MAX_GIT_OUTPUT_BYTES}. */
  stdout: string;
  /** Standard error, capped at {@link MAX_GIT_OUTPUT_BYTES}. */
  stderr: string;
}

/** Where and how one git command runs. */
export interface GitRunOptions {
  /** Working directory. */
  cwd: string;
  /** Child environment; the scrubbed one, so git authenticates only through `GIT_ASKPASS`. */
  env: Record<string, string>;
  /** Overrides the default timeout. */
  timeoutMs?: number;
}

/** Runs git commands. */
export interface GitRunner {
  /**
   * Runs one git command to completion.
   *
   * @param args - Subcommand and its arguments.
   * @param options - Working directory, environment and timeout.
   * @returns The exit code and the captured streams; never rejects for a non-zero exit.
   */
  run(args: GitArgs, options: GitRunOptions): Promise<GitCommandResult>;
}

/**
 * Default timeout for a git command.
 *
 * Sized for the slowest legitimate operation this project performs — a full-depth clone of a
 * large repository over a slow link — while still bounding a command that hangs.
 */
export const DEFAULT_GIT_TIMEOUT_MS = 600_000;

/**
 * Bytes kept from each of a git command's streams.
 *
 * Every caller either reads a fixed-size value — an object name, a ref line — or truncates the
 * output to the turn's byte budget before the model ever sees it, so nothing legitimate needs
 * more than this, and `list_dir` caps its listing at 500 entries on top of it. What
 * the cap removes is the case the callers cannot bound: `ls-files` listing a tree whose size the
 * repository decides, which would otherwise be accumulated whole and exhaust the container long
 * before the command's timeout could stop it.
 */
export const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Characters of stderr kept on a {@link GitError}. */
const MAX_STDERR_CHARS = 500;

/**
 * Collects one of a child's streams, keeping at most {@link MAX_GIT_OUTPUT_BYTES}.
 *
 * @param source - The child's stdout or stderr; `null` when it was not piped.
 * @returns A reader for whatever was kept, callable once the child has closed.
 */
function collectCapped(source: Readable | null): () => string {
  const parts: string[] = [];
  let kept = 0;
  // Setting the encoding lets the stream carry a multi-byte character across a chunk boundary.
  source?.setEncoding('utf8');
  source?.on('data', (chunk: string) => {
    if (kept >= MAX_GIT_OUTPUT_BYTES) {
      return;
    }
    parts.push(chunk);
    kept += Buffer.byteLength(chunk);
  });
  return () => parts.join('');
}

/** A git command that was expected to succeed did not. */
export class GitError extends Error {
  /** Exit code, or `null` when git was killed or never started. */
  readonly code: number | null;
  /** Captured stderr, capped so a runaway command cannot fill an event. */
  readonly stderr: string;

  /**
   * @param message - What failed; never contains a credential.
   * @param code - Exit code reported by git.
   * @param stderr - Captured stderr.
   */
  constructor(message: string, code: number | null, stderr: string) {
    super(message);
    this.name = 'GitError';
    this.code = code;
    this.stderr = stderr;
  }
}

/**
 * Creates a git runner.
 *
 * @param spawnFn - Process spawner; injectable so start failures and timeouts can be exercised.
 * @returns The runner.
 */
export function createGitRunner(spawnFn: SpawnFunction = nodeSpawn): GitRunner {
  return {
    run(args, options) {
      return new Promise<GitCommandResult>((resolve) => {
        const child = spawnFn('git', [...args], {
          cwd: options.cwd,
          env: options.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const stdout = collectCapped(child.stdout);
        const stderr = collectCapped(child.stderr);

        const timer = setTimeout(() => {
          child.kill('SIGKILL');
        }, options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS);
        const settle = (result: GitCommandResult): void => {
          clearTimeout(timer);
          resolve(result);
        };
        child.on('error', (error: Error) => {
          settle({ code: null, stdout: '', stderr: `failed to start git: ${error.message}` });
        });
        child.on('close', (code: number | null) => {
          settle({ code, stdout: stdout(), stderr: stderr() });
        });
      });
    },
  };
}

/**
 * Runs a git command that must succeed.
 *
 * @param git - Runner to use.
 * @param args - Subcommand and its arguments.
 * @param options - Working directory, environment and timeout.
 * @returns The trimmed standard output.
 * @throws GitError when git exited non-zero, carrying the first line of stderr as the message.
 */
export async function gitOrThrow(
  git: GitRunner,
  args: GitArgs,
  options: GitRunOptions,
): Promise<string> {
  const result = await git.run(args, options);
  if (result.code !== 0) {
    throw new GitError(
      `git ${args[0]} failed: ${result.stderr.split('\n', 1).join('')}`,
      result.code,
      result.stderr.slice(0, MAX_STDERR_CHARS),
    );
  }
  return result.stdout.trim();
}
