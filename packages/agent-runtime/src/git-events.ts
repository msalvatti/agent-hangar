/**
 * Detecting that the agent pushed, so the host can record where the work landed.
 *
 * Layer: domain.
 *
 * The agent pushes through `run_shell` like any other command, so there is no callback to hook.
 * Detection therefore reads both the command and its output: the command tells us the intent, the
 * output confirms that git really talked to a remote. Either is enough on its own, because a push
 * can hide behind a script and a command line can be written in ways no pattern will cover.
 */
import type { GitRunner } from './git.js';

/**
 * Shell operators that end one command and start another.
 *
 * One character rather than a run of them: consecutive operators only produce empty segments
 * between the real ones, and an empty segment names no command, so collapsing them would change
 * how many segments are looked at and never what the answer is.
 */
const COMMAND_SEPARATORS = /[;&|\n]/;

/** Runs of whitespace between the words of one command. */
const WHITESPACE = /\s+/;

/** The banner git prints when it has contacted a remote. */
const PUSH_OUTPUT_BANNER = /^To (https?:\/\/|git@|ssh:\/\/|file:\/\/|\/)/m;

/** The ref update line that follows the banner. */
const PUSH_OUTPUT_REF_UPDATE = /\s->\s/;

/** What one finished `run_shell` call produced. */
export interface ShellOutcome {
  /** Command as the model wrote it. */
  command: string;
  /** Combined output of the command. */
  output: string;
  /** Exit code, `null` when the command was killed. */
  exitCode: number | null;
}

/** Where the work tree currently is. */
export interface GitHead {
  /** Checked-out branch. */
  branch: string;
  /** Commit the branch points at. */
  sha: string;
}

/**
 * Global git options that consume the word after them.
 *
 * They are the reason the subcommand cannot simply be the word after `git`: in `git -C repo push`
 * the second word is the option's value, not the subcommand.
 */
const GIT_OPTIONS_WITH_VALUE = new Set([
  '-c',
  '-C',
  '--config-env',
  '--exec-path',
  '--git-dir',
  '--namespace',
  '--work-tree',
]);

/**
 * Reports whether one command segment runs git with `push` as its subcommand.
 *
 * Taking the subcommand rather than looking for the word anywhere is what keeps `git branch push`
 * and `git config alias.name push` from being reported as pushes: both succeed without a remote
 * ever being contacted, and a spurious `git.pushed` tells the host that work landed when none did.
 *
 * @param segment - One command of the line, already split from its neighbours.
 * @returns `true` when the segment's git subcommand is `push`.
 */
function segmentPushes(segment: string): boolean {
  // Not trimmed first: leading or trailing whitespace only adds empty words at the ends, and the
  // subcommand is found by the position of `git` rather than by counting from the start, so those
  // words shift every index by the same amount and are never read.
  const words = segment.split(WHITESPACE);
  const git = words.indexOf('git');
  if (git === -1) {
    return false;
  }
  let index = git + 1;
  for (let word = words[index]; word?.startsWith('-') === true; word = words[index]) {
    index += GIT_OPTIONS_WITH_VALUE.has(word) ? 2 : 1;
  }
  return words[index] === 'push';
}

/**
 * Reports whether a command line invokes `git push`.
 *
 * Splitting into words rather than matching one pattern keeps this linear in the length of the
 * command, which matters because the command comes from a model that has read untrusted
 * repository content: a pattern with overlapping quantifiers would be a denial-of-service knob.
 *
 * @param command - Command as the model wrote it.
 * @returns `true` when some segment of the command runs `git push`.
 */
function invokesGitPush(command: string): boolean {
  return command.split(COMMAND_SEPARATORS).some(segmentPushes);
}

/**
 * Reports whether a finished shell command pushed to a remote.
 *
 * @param outcome - Command, output and exit code of a `run_shell` call.
 * @returns `true` when the command succeeded and looks like a push.
 */
export function looksLikeGitPush(outcome: ShellOutcome): boolean {
  if (outcome.exitCode !== 0) {
    return false;
  }
  return (
    invokesGitPush(outcome.command) ||
    (PUSH_OUTPUT_BANNER.test(outcome.output) && PUSH_OUTPUT_REF_UPDATE.test(outcome.output))
  );
}

/**
 * Reads the branch and commit the work tree is on.
 *
 * @param git - Git runner.
 * @param cwd - Workspace root.
 * @param env - Child environment.
 * @returns The head, or `null` when the directory is not a usable repository.
 */
export async function resolveGitHead(
  git: GitRunner,
  cwd: string,
  env: Record<string, string>,
): Promise<GitHead | null> {
  const branch = await git.run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, env });
  const sha = await git.run(['rev-parse', 'HEAD'], { cwd, env });
  if (branch.code !== 0 || sha.code !== 0) {
    return null;
  }
  return { branch: branch.stdout.trim(), sha: sha.stdout.trim() };
}
