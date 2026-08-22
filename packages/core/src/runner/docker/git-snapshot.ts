/**
 * Git state capture for a workspace, built from plain `git` invocations.
 *
 * Layer: service (adapter).
 *
 * The snapshot is taken just before a workspace is destroyed and is the only trace of the work
 * that survives: branch, head, dirtiness, divergence from the remote, and a short textual summary.
 * Every step degrades to a null or a zero instead of failing — an empty repository, a detached
 * HEAD or a missing remote are ordinary states, not errors, and losing the whole snapshot because
 * of one of them would lose the restore hints for the entire chat.
 */
import type { WorkspaceSnapshot } from '../types.ts';

/** Largest summary retained, matching the contract's 16 KB budget. */
const MAX_SUMMARY_BYTES = 16_384;

/** Marker appended when the summary had to be cut. */
const TRUNCATION_NOTICE = '\n[truncated]';

/** Git state used when `/workspace` is not a repository at all. */
const NO_GIT_STATE = {
  branch: null,
  headSha: null,
  dirty: false,
  ahead: 0,
  behind: 0,
} as const;

/** Result of one captured command run inside the workspace. */
export interface CaptureResult {
  /** Process exit code; `null` when the process was terminated. */
  code: number | null;
  /** Decoded stdout. */
  stdout: string;
  /** Decoded stderr. */
  stderr: string;
}

/** Runs a command inside the workspace and captures its output. */
export type CaptureExec = (cmd: readonly string[]) => Promise<CaptureResult>;

/**
 * Cuts a summary down to the contract's byte budget.
 *
 * The budget is in bytes, not characters, because it bounds what is written to Postgres and
 * streamed to the browser — so the result must respect it after re-encoding, not before. Cutting
 * the buffer at a fixed offset does not: a cut landing inside a multi-byte sequence decodes to a
 * three-byte replacement character, so a head of `keep` bytes can come back as `keep + 2`, and the
 * finished string overshoots the cap it was supposed to enforce. The cut is therefore walked back
 * to a character boundary, which can only shrink the result.
 *
 * @param summary - Full `git status` + `git diff --stat` text.
 * @returns The summary unchanged, or its head plus a truncation marker, never over the budget.
 */
export function truncateSummary(summary: string): string {
  // The three encodings named in this function are stated for the reader: Node falls back to UTF-8
  // for a name it does not recognise rather than refusing, so no observation can tell one spelling
  // from another — which is why the directives below sit on those three lines.
  // Stryker disable next-line StringLiteral
  const bytes = Buffer.from(summary, 'utf8');
  if (bytes.length <= MAX_SUMMARY_BYTES) {
    return summary;
  }
  // Stryker disable next-line StringLiteral
  const keep = MAX_SUMMARY_BYTES - Buffer.byteLength(TRUNCATION_NOTICE, 'utf8');
  let head = bytes.subarray(0, keep).toString('utf8');
  // Drop the trailing replacement character produced by a cut inside a sequence, then any further
  // character whose re-encoding still does not fit.
  // Stryker disable next-line StringLiteral,ConditionalExpression,EqualityOperator: the encoding is
  // as above, and the emptiness guard cannot decide anything — a head with nothing in it encodes to
  // no bytes at all, which is never over the budget, so the loop has already ended.
  while (head.length > 0 && Buffer.byteLength(head, 'utf8') > keep) {
    head = head.slice(0, -1);
  }
  return `${head}${TRUNCATION_NOTICE}`;
}

/**
 * Whether a parsed field is a count this can report.
 *
 * @param value - One field of the command's output, already through `Number`.
 * @returns `true` when it is a whole number, narrowing it to one.
 */
function isCount(value: number | undefined): value is number {
  return Number.isInteger(value);
}

/**
 * Parses `git rev-list --left-right --count <upstream>...HEAD`.
 *
 * The left count is what the upstream has and the checkout does not (behind); the right count is
 * the reverse (ahead).
 *
 * @param output - Raw command stdout.
 * @returns Ahead/behind counts, both zero when the output is not two integers.
 */
export function parseAheadBehind(output: string): { ahead: number; behind: number } {
  const [behind, ahead] = output.trim().split(/\s+/).map(Number);
  // Asked as one question rather than four. A field that is missing and a field that is not a
  // whole number are the same answer here, and `Number.isInteger` already refuses both — but it
  // says nothing about the type, so the two would still have to be narrowed by hand. A predicate
  // that carries the narrowing removes that second pair of checks entirely.
  if (!isCount(behind) || !isCount(ahead)) {
    return { ahead: 0, behind: 0 };
  }
  return { ahead, behind };
}

/**
 * Reads the current branch name.
 *
 * @param run - Command runner scoped to the workspace directory.
 * @returns The branch name, or `null` on a detached HEAD or an unborn branch.
 */
async function readBranch(run: CaptureExec): Promise<string | null> {
  const result = await run(['git', 'rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = result.stdout.trim();
  return result.code === 0 && branch !== '' && branch !== 'HEAD' ? branch : null;
}

/**
 * Reads the commit currently checked out.
 *
 * @param run - Command runner scoped to the workspace directory.
 * @returns The 40-character sha, or `null` in a repository with no commits yet.
 */
async function readHeadSha(run: CaptureExec): Promise<string | null> {
  const result = await run(['git', 'rev-parse', 'HEAD']);
  return result.code === 0 ? result.stdout.trim() : null;
}

/**
 * Reads the divergence between the checkout and its remote-tracking branch.
 *
 * @param run - Command runner scoped to the workspace directory.
 * @param branch - Branch whose `origin/` counterpart is compared.
 * @returns Ahead/behind counts; zeros when there is no such remote branch.
 */
async function readAheadBehind(
  run: CaptureExec,
  branch: string,
): Promise<{ ahead: number; behind: number }> {
  const result = await run([
    'git',
    'rev-list',
    '--left-right',
    '--count',
    `origin/${branch}...HEAD`,
  ]);
  return result.code === 0 ? parseAheadBehind(result.stdout) : { ahead: 0, behind: 0 };
}

/**
 * Captures the git state of a workspace.
 *
 * @param run - Command runner scoped to the workspace directory.
 * @param takenAt - Instant the snapshot belongs to, from the injected clock.
 * @returns The snapshot; all-null git state when the directory is not a repository.
 */
export async function captureGitSnapshot(
  run: CaptureExec,
  takenAt: Date,
): Promise<WorkspaceSnapshot> {
  const insideRepo = await run(['git', 'rev-parse', '--is-inside-work-tree']);
  if (insideRepo.code !== 0) {
    return { takenAt, git: { ...NO_GIT_STATE }, summary: '' };
  }

  const branch = await readBranch(run);
  const headSha = await readHeadSha(run);
  const status = await run(['git', 'status', '--porcelain']);
  const divergence = branch === null ? { ahead: 0, behind: 0 } : await readAheadBehind(run, branch);
  const diffstat = await run(['git', 'diff', '--stat']);

  return {
    takenAt,
    git: { branch, headSha, dirty: status.stdout.trim() !== '', ...divergence },
    summary: truncateSummary(`${status.stdout}\n${diffstat.stdout}`),
  };
}
