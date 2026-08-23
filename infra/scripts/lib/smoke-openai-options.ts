/**
 * The fixed contract of `pnpm smoke:openai`: its command line, its exit codes, and what the turn
 * is asked to do.
 *
 * Layer: utility (pure).
 *
 * Separated from the check itself because this is the part an operator interacts with directly,
 * and because it is where the promise "no credential reaches the output" is first kept: the base
 * URL is reduced to its origin here, once, so nothing downstream has to remember that an operator
 * may have spelt user information into it.
 *
 * The exit codes are the script's contract with whoever runs it — 0 proven, 1 ran and did not
 * prove it, 2 not in a state to try — and every module that ends the run early names one of them.
 */
import { repoUrl } from '../../../packages/core/src/api/contracts.js';

import type { FlagValue } from './cli-args.js';

/** Exit code of a turn that completed and did everything the check asked for. */
export const EXIT_OK = 0;

/** Exit code of a turn that ran but did not prove what the check asserts. */
export const EXIT_FAILED = 1;

/** Exit code when the instance is not in a state where the check can even start. */
export const EXIT_PRECONDITION = 2;

/** Repository the turn runs against when `--repo` is not given. */
export const DEFAULT_REPO_URL = 'https://github.com/octocat/Hello-World';

/** Default branch of {@link DEFAULT_REPO_URL}; the two are a pinned pair, never resolved live. */
export const DEFAULT_BRANCH = 'master';

/** Loopback host the web server binds, so a printed or probed URL needs no name resolution. */
const LOOPBACK_HOST = '127.0.0.1';

/** Web port assumed when the instance environment did not name one. */
const FALLBACK_WEB_PORT = '3000';

/** How long the turn may take before the check gives up, in seconds. */
export const DEFAULT_TIMEOUT_SECONDS = 300;

/** Milliseconds in a second. */
export const MS_PER_SECOND = 1000;

/** File the turn is asked to write. */
export const SMOKE_FILE = 'SMOKE.md';

/** The single prompt the turn runs on. */
export const SMOKE_PROMPT =
  'List the files in this repository, then create a file SMOKE.md containing the current date ' +
  'and a one-line summary of the repo. Do not push.';

/** Reported when either credential is missing from Settings. */
export const SETTINGS_MISSING_MESSAGE = 'Enter your keys in Settings first';

/** Flags this check accepts. */
export const SMOKE_FLAGS = ['base-url', 'repo', 'branch', 'timeout', 'keep'] as const;

/** Printed alongside any usage error. */
export const USAGE =
  'usage: pnpm smoke:openai [--base-url URL] [--repo URL --branch NAME] [--timeout SECONDS] [--keep]';

/** Resolved command line. */
export interface SmokeOptions {
  /** Origin of the running instance, without a trailing slash. */
  baseUrl: string;
  /** Repository the turn runs against. */
  repoUrl: string;
  /** Branch the workspace is prepared from. */
  branch: string;
  /** How long the turn may take before the check gives up. */
  timeoutMs: number;
  /** Whether the chat (and so its workspace) is left in place afterwards. */
  keep: boolean;
}

/**
 * Reads one flag's value, rejecting a flag that was given without one.
 *
 * @param flags - Parsed flags.
 * @param name - Flag to read.
 * @returns The value, or `undefined` when the flag was not given.
 * @throws Error when the flag was given without a value.
 */
function flagValue(flags: Record<string, FlagValue>, name: string): string | undefined {
  const value = flags[name];
  if (value === true) {
    throw new Error(`--${name} needs a value`);
  }
  return value;
}

/**
 * Validates the instance URL and reduces it to its origin.
 *
 * @param raw - The `--base-url` value, or the default derived from the instance's web port.
 * @returns The origin, which carries no path, query or user information.
 * @throws Error when the value is not an absolute HTTP URL.
 */
function resolveBaseUrl(raw: string): string {
  const url = URL.parse(raw);
  if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new Error(`--base-url must be an absolute http(s) URL`);
  }
  return url.origin;
}

/**
 * Reads the timeout, in seconds, as a positive integer.
 *
 * @param raw - The `--timeout` value, or `undefined`.
 * @returns The timeout in milliseconds.
 * @throws Error when the value is not a positive integer.
 */
function resolveTimeout(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_TIMEOUT_SECONDS * MS_PER_SECOND;
  }
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error('--timeout must be a whole number of seconds greater than zero');
  }
  return seconds * MS_PER_SECOND;
}

/**
 * Checks a repository URL against the shape the product itself accepts.
 *
 * Reused rather than re-stated, and applied here rather than left to the server, for one reason
 * beyond a clearer message: the resolved repository is printed in the report, and this schema is
 * what rejects a URL carrying user information. Refusing it before anything is printed is what
 * keeps a credential an operator typed into `--repo` out of the output.
 *
 * @param raw - The `--repo` value.
 * @returns The same URL.
 * @throws Error when the value is not a plain repository URL. The message never echoes the value.
 */
function checkRepoUrl(raw: string): string {
  if (!repoUrl.safeParse(raw).success) {
    throw new Error(
      '--repo must be <scheme>://<host>/<owner>/<repository>, with no credentials, query string or fragment',
    );
  }
  return raw;
}

/**
 * Turns parsed flags into the resolved command line.
 *
 * `--repo` without `--branch` is refused rather than guessed at. The default branch of an
 * arbitrary repository is not something this check can learn: `GET /api/repos` lists the token
 * owner's own repositories, and the branch listing does not say which one is the default. Running
 * a named repository against the default repository's branch would fail in the clone with a
 * message about the branch, which is the wrong question to leave an operator holding.
 *
 * @param flags - Flags as parsed from `process.argv`.
 * @param env - Environment supplying `WEB_PORT` for the default base URL.
 * @returns The resolved options.
 * @throws Error naming the problem, for the caller to print with {@link USAGE}.
 */
export function resolveOptions(
  flags: Record<string, FlagValue>,
  env: Readonly<Record<string, string | undefined>>,
): SmokeOptions {
  const repo = flagValue(flags, 'repo');
  const branch = flagValue(flags, 'branch');
  if (repo !== undefined && branch === undefined) {
    throw new Error('--branch is required with --repo: the default branch cannot be discovered');
  }
  const port = env.WEB_PORT ?? FALLBACK_WEB_PORT;
  return {
    baseUrl: resolveBaseUrl(flagValue(flags, 'base-url') ?? `http://${LOOPBACK_HOST}:${port}`),
    repoUrl: repo === undefined ? DEFAULT_REPO_URL : checkRepoUrl(repo),
    branch: branch ?? DEFAULT_BRANCH,
    timeoutMs: resolveTimeout(flagValue(flags, 'timeout')),
    keep: flags.keep !== undefined,
  };
}
