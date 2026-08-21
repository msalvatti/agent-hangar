/**
 * Workspace preparation: bring `/workspace` to the commit the turn should start from.
 *
 * Layer: domain.
 *
 * The repository URL is validated before git ever sees it, against the single origin this
 * workspace was created for. A URL naming another origin — or carrying its own credentials — is
 * the one input that could turn preparation into an exfiltration step, and it is refused here as
 * well as in the askpass helper, because two independent checks are what keeps a change to either
 * one honest.
 *
 * That origin arrives in a root-owned file the runner places before the container starts, already
 * measured against the operator's `ALLOWED_REPO_HOSTS` by the host process. It is read from that
 * file and not from the environment for the same reason the askpass helper reads it from there:
 * this container runs shell commands the model chooses, and a command may set any variable for the
 * process it starts, so an environment entry is a policy the workspace can restate. The allow-list
 * itself is not handed to the container either — a policy naming several origins would let a
 * crafted URL pick whichever of them it liked.
 *
 * The binding is origin-level: scheme, host and port. A different repository on the same origin is
 * still accepted, because the origin is what the credential boundary is drawn around; narrowing to
 * one repository would be a different rule with different consequences for the agent's own git
 * commands, and it is not the rule stated here.
 *
 * The scheme is not judged here. Which transports may be cloned over is the operator's decision,
 * expressed by the allow-list entry this origin came from; whether a credential may cross that
 * transport is a separate question, answered independently by the helper, which releases nothing
 * over cleartext. A workspace created for an `http` origin therefore clones anonymously.
 *
 * Preparation runs before every turn, not only the first, because a chat's workspace outlives the
 * turn that created it. The second turn therefore finds the repository cloned, the work branch
 * already there and, usually, commits on it that nothing has pushed yet. Everything below is
 * written so that running it again over that workspace preserves what the previous turn left:
 * commits, and the edits it never committed.
 */
import { mkdir, readFile } from 'node:fs/promises';

import { ConfigError, prepareWarningText } from '@agent-hangar/core';
import type { AgentEvent, TurnRequest } from '@agent-hangar/core';
import { z } from 'zod';

import { GitError, gitOrThrow } from './git.js';
import type { GitRunner, GitRunOptions } from './git.js';

/** Characters of a sha shown in a progress message. */
const SHORT_SHA_LENGTH = 7;

/**
 * File naming the one origin this workspace may clone from.
 *
 * Spelled here, in the worker that writes it and in `askpass.sh` that also reads it, because the
 * three live on opposite sides of a container boundary and share no module — the same reason the
 * askpass path itself is spelled in each of them. Root-owned in a root-owned directory, so the
 * workspace user can read it and cannot author it.
 */
export const ALLOWED_ORIGIN_FILE = '/opt/agent-runtime/allowed-origin';

/** Owner and repository name, with an optional `.git` suffix and nothing else. */
const REPOSITORY_PATH = /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\.git)?$/;

/**
 * Branch names this lane will hand to git.
 *
 * Deliberately narrower than what git itself accepts. Two of the invocations below take a branch
 * as a positional argument, where a name beginning with `-` would be read as an option instead —
 * `--upload-pack=…` is the classic way that turns into command execution on a non-https remote.
 * The names come from the host rather than from the model, so this is defence in depth, but it
 * costs one regular expression and removes the whole class.
 */
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** Preparation could not bring the workspace to a usable state. */
export class PrepareError extends Error {
  /** Stable identifier; the loop maps it to `turn.failed { code: 'prepare' }`. */
  readonly code = 'prepare';

  /**
   * @param message - What failed; never contains a credential.
   */
  constructor(message: string) {
    super(message);
    this.name = 'PrepareError';
  }
}

/**
 * Which repository URLs preparation will hand to git.
 *
 * `origin` is what production runs: exactly one origin, the one the workspace was created for.
 * `any` skips the check and exists for the suites that clone a local `file://` remote; it is
 * reachable only by passing it in through {@link PrepareDeps}, never by anything the container
 * environment says, so no misconfiguration can produce it.
 */
export type RepositoryUrlPolicy =
  { readonly allow: 'origin'; readonly origin: string } | { readonly allow: 'any' };

/**
 * An origin as `URL` spells one: scheme, host, and a port only when it is not the scheme's
 * default. A value that survives this round-trip is already normalised, so comparing it to
 * `URL.origin` is a comparison of two canonical forms rather than of two spellings.
 */
const allowedOriginSchema = z.string().refine((value) => URL.parse(value)?.origin === value, {
  message: 'must be <scheme>://<host>[:<port>] and nothing else',
});

/**
 * Reads the origin this workspace was created for from the file the host placed.
 *
 * A missing, unreadable or malformed file is a container no host prepared, and it fails closed:
 * there is no forge to fall back to, because falling back to one would mean a workspace whose
 * origin was never decided still gets a repository policy from somewhere.
 *
 * @param file - Path of the file; defaults to {@link ALLOWED_ORIGIN_FILE}.
 * @returns The policy the turn runs under.
 * @throws ConfigError when the file cannot be read or does not hold a bare origin.
 */
export async function repositoryUrlPolicyFromFile(
  file: string = ALLOWED_ORIGIN_FILE,
): Promise<RepositoryUrlPolicy> {
  const content = await readFile(file, 'utf8').catch(() => null);
  const parsed = allowedOriginSchema.safeParse(content?.trim());
  if (!parsed.success) {
    throw new ConfigError(
      `${file} must hold the origin this workspace was created for, as <scheme>://<host>[:<port>]`,
    );
  }
  return { allow: 'origin', origin: parsed.data };
}

/** Everything preparation needs beyond the request. */
export interface PrepareDeps {
  /** Absolute workspace root. */
  workspaceRoot: string;
  /** Git runner. */
  git: GitRunner;
  /** Child environment: no credentials, `GIT_ASKPASS` set. */
  env: Record<string, string>;
  /**
   * Publishes one protocol event.
   *
   * @param event - Progress or completion of preparation.
   */
  emit(event: AgentEvent): Promise<void>;
  /**
   * Which URLs may be cloned. Deliberately not optional: a default would be a policy nobody chose,
   * and the only safe default — refusing everything — is more usefully reported by
   * {@link repositoryUrlPolicyFromEnv} as a configuration failure.
   */
  urlPolicy: RepositoryUrlPolicy;
}

/** Where preparation left the workspace, as the `prepare.done` event reports it. */
export interface PrepareResult {
  /** Commit the turn starts from. */
  headSha: string;
  /** Branch that is checked out. */
  branch: string;
}

/** What preparation left the workspace in, including what it found on the way. */
export interface PrepareOutcome extends PrepareResult {
  /**
   * Findings about the checkout the turn starts from, oldest first.
   *
   * Empty on the ordinary path. A non-empty entry means the ground is not where somebody expected
   * it — the work branch and its remote hold different commits, or HEAD moved since the snapshot —
   * and the agent is the one that can reconcile it, so the caller puts these in the model's
   * context as well as on screen.
   */
  notes: readonly string[];
}

/**
 * Whether a parsed URL names one repository on the workspace's own origin.
 *
 * The origin comparison is whole-origin equality, so scheme, host and port are decided by one
 * test: `github.com.evil.test`, `github.com@evil.test` and `github.com:8443` are each simply a
 * different origin. The path is not compared, only shaped — a different repository on the same
 * origin passes. Everything else here is a place a credential hides, and holds whatever the origin
 * is.
 *
 * @param parsed - The parsed repository URL.
 * @param origin - The origin this workspace was created for.
 * @returns `true` when git may be pointed at it.
 */
function isRepoUrlOnOrigin(parsed: URL, origin: string): boolean {
  return (
    parsed.origin === origin &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.search === '' &&
    parsed.hash === '' &&
    REPOSITORY_PATH.test(parsed.pathname)
  );
}

/**
 * Returns the URL preparation will hand to git, having refused anything off the workspace's
 * origin.
 *
 * What comes back is the URL as `URL` parsed it, not as it was written. Git echoes the remote it
 * was given into the credential prompt verbatim, and the askpass helper compares that prompt to an
 * origin the host produced with the same `URL` normalisation — so cloning the parse rather than
 * the text is what keeps the two spellings equal, and a repository written as
 * `https://GitHub.com:443/acme/widgets` authenticates instead of failing on a difference no one
 * can see.
 *
 * @param url - URL from the turn request.
 * @param policy - Which URLs this turn may clone.
 * @returns The URL to clone.
 * @throws PrepareError when the URL is off the workspace's origin, carries credentials, or is not
 *   a plain owner/repository path.
 */
export function resolveRepoUrl(url: string, policy: RepositoryUrlPolicy): string {
  if (policy.allow === 'any') {
    return url;
  }
  const parsed = URL.parse(url);
  if (parsed === null || !isRepoUrlOnOrigin(parsed, policy.origin)) {
    // The message names the origin and never the URL: a refused URL is exactly the one that may
    // be carrying a credential, and this text is persisted and shown.
    throw new PrepareError(
      `repository URL must be ${policy.origin}/<owner>/<repo> without credentials`,
    );
  }
  return parsed.href;
}

/**
 * Rejects a branch name git could read as an option.
 *
 * @param branch - Branch name from the turn request.
 * @param field - Which field it came from, for the message.
 * @throws PrepareError when the name is not one this lane will pass to git.
 */
export function assertBranchName(branch: string, field: string): void {
  if (!BRANCH_NAME.test(branch)) {
    throw new PrepareError(
      `${field} must start with a letter or digit and contain only letters, digits, dot, dash, underscore and slash`,
    );
  }
}

/**
 * Shortens a sha for a progress message.
 *
 * @param sha - Full object name.
 * @returns The abbreviated form.
 */
function short(sha: string): string {
  return sha.slice(0, SHORT_SHA_LENGTH);
}

/**
 * Reports whether the workspace already holds a git work tree.
 *
 * @param deps - Preparation dependencies.
 * @returns `true` when git recognises the workspace as a work tree.
 */
async function isWorkTree(deps: PrepareDeps): Promise<boolean> {
  const result = await deps.git.run(['rev-parse', '--is-inside-work-tree'], {
    cwd: deps.workspaceRoot,
    env: deps.env,
  });
  return result.code === 0;
}

/**
 * Clones the base branch, or refreshes a workspace that already holds the repository.
 *
 * @param repo - URL to clone and the branch to clone it at.
 * @param prepareOptions - Preparation section of the turn request.
 * @param deps - Preparation dependencies.
 * @throws PrepareError when cloning was not requested and the workspace holds no repository.
 */
async function cloneOrFetch(
  repo: { readonly url: string; readonly baseBranch: string },
  prepareOptions: TurnRequest['prepare'],
  deps: PrepareDeps,
): Promise<void> {
  const options = { cwd: deps.workspaceRoot, env: deps.env };
  const alreadyCloned = await isWorkTree(deps);
  if (!prepareOptions.clone) {
    if (!alreadyCloned) {
      throw new PrepareError('the workspace holds no repository and cloning was not requested');
    }
    return;
  }
  if (alreadyCloned) {
    await deps.emit({ type: 'prepare.progress', message: 'Refreshing the existing checkout…' });
    await gitOrThrow(deps.git, ['fetch', 'origin', '--prune'], options);
    return;
  }
  await mkdir(deps.workspaceRoot, { recursive: true });
  await deps.emit({
    type: 'prepare.progress',
    message: `Cloning ${repo.url} (branch ${repo.baseBranch})…`,
  });
  // Full depth: the agent is expected to read history, and a shallow clone cannot push a branch
  // that diverges from the shallow boundary.
  await gitOrThrow(deps.git, ['clone', '--branch', repo.baseBranch, '--', repo.url, '.'], options);
}

/** How far a local branch and its remote counterpart have moved apart. */
interface BranchDivergence {
  /** Commits the local branch has that the remote does not. */
  readonly ahead: number;
  /** Commits the remote branch has that the local one does not. */
  readonly behind: number;
}

/** What putting the work branch in place produced, for the progress messages. */
interface WorkBranchOutcome {
  /** One line naming where the checkout landed; the caller appends the commit. */
  readonly summary: string;
  /** A second line about commits the two tips do not share, or `null` when they agree. */
  readonly note: string | null;
}

/**
 * Spells a number of commits.
 *
 * @param count - How many commits.
 * @returns The count with the noun agreeing with it.
 */
function commits(count: number): string {
  return count === 1 ? '1 commit' : `${count} commits`;
}

/**
 * Reports whether the workspace already holds the branch as a local ref.
 *
 * @param branch - Work branch of the turn.
 * @param deps - Preparation dependencies.
 * @param options - Working directory and environment for git.
 * @returns `true` when `refs/heads/<branch>` resolves in this workspace.
 */
async function hasLocalBranch(
  branch: string,
  deps: PrepareDeps,
  options: GitRunOptions,
): Promise<boolean> {
  const result = await deps.git.run(
    ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
    options,
  );
  return result.code === 0;
}

/**
 * Reports whether the remote publishes the branch.
 *
 * A remote that cannot be reached reads as "not published", which is what this question has always
 * meant here: it decides where a branch that does not exist yet comes from, and what to say about
 * one that does, and neither is worth failing a turn over an answer git can be asked for again.
 *
 * @param branch - Work branch of the turn.
 * @param deps - Preparation dependencies.
 * @param options - Working directory and environment for git.
 * @returns `true` when the remote has a head of that name.
 */
async function hasRemoteBranch(
  branch: string,
  deps: PrepareDeps,
  options: GitRunOptions,
): Promise<boolean> {
  const result = await deps.git.run(['ls-remote', '--heads', 'origin', branch], options);
  return result.stdout.trim() !== '';
}

/**
 * Brings the remote-tracking ref of the work branch up to date.
 *
 * The refspec is forced because `refs/remotes/origin/<branch>` records what the remote says rather
 * than work of its own: a branch rewritten upstream would otherwise fail this fetch as a
 * non-fast-forward and leave preparation unable to finish at all.
 *
 * @param branch - Work branch of the turn.
 * @param deps - Preparation dependencies.
 * @param options - Working directory and environment for git.
 */
async function fetchWorkBranch(
  branch: string,
  deps: PrepareDeps,
  options: GitRunOptions,
): Promise<void> {
  await gitOrThrow(
    deps.git,
    ['fetch', 'origin', `+${branch}:refs/remotes/origin/${branch}`],
    options,
  );
}

/**
 * Counts the commits each side of the work branch has that the other does not.
 *
 * @param branch - Work branch of the turn, present both locally and as a remote-tracking ref.
 * @param deps - Preparation dependencies.
 * @param options - Working directory and environment for git.
 * @returns How far apart the two tips are.
 */
async function measureDivergence(
  branch: string,
  deps: PrepareDeps,
  options: GitRunOptions,
): Promise<BranchDivergence> {
  const local = `refs/heads/${branch}`;
  const remote = `refs/remotes/origin/${branch}`;
  const ahead = await gitOrThrow(deps.git, ['rev-list', '--count', `${remote}..${local}`], options);
  const behind = await gitOrThrow(
    deps.git,
    ['rev-list', '--count', `${local}..${remote}`],
    options,
  );
  return { ahead: Number(ahead), behind: Number(behind) };
}

/**
 * Says what the two tips of the work branch mean for the turn about to run.
 *
 * Nothing that produces this note moves a ref, so nothing here can lose a commit. The note exists
 * because the user has to be told that their branch and the remote hold different work, and the
 * agent has to know it is not starting from what the remote publishes.
 *
 * @param branch - Work branch of the turn.
 * @param divergence - How far apart the two tips are.
 * @returns The line to publish, or `null` when the two tips agree.
 */
function divergenceNote(branch: string, divergence: BranchDivergence): string | null {
  if (divergence.ahead > 0 && divergence.behind > 0) {
    return prepareWarningText(
      `${branch} and origin/${branch} have diverged (${commits(divergence.ahead)} here, ${commits(divergence.behind)} on the remote); preparation merged neither into the other.`,
    );
  }
  if (divergence.behind > 0) {
    return prepareWarningText(
      `origin/${branch} is ${commits(divergence.behind)} ahead of ${branch}; preparation did not merge it.`,
    );
  }
  if (divergence.ahead > 0) {
    return `${commits(divergence.ahead)} on ${branch} not yet pushed to origin/${branch}.`;
  }
  return null;
}

/**
 * Creates the work branch: from the remote when it publishes one, from the base branch otherwise.
 *
 * `checkout -B` is safe on this path and only on this path — the caller established that no local
 * branch of that name exists, so there is no ref here for it to reset.
 *
 * @param repo - Repository section of the turn request.
 * @param onRemote - Whether the remote publishes the work branch.
 * @param deps - Preparation dependencies.
 * @param options - Working directory and environment for git.
 * @returns What happened, for the progress messages.
 */
async function createWorkBranch(
  repo: TurnRequest['repo'],
  onRemote: boolean,
  deps: PrepareDeps,
  options: GitRunOptions,
): Promise<WorkBranchOutcome> {
  if (!onRemote) {
    await gitOrThrow(deps.git, ['checkout', '-b', repo.workBranch], options);
    return { summary: `Created ${repo.workBranch} from ${repo.baseBranch}`, note: null };
  }
  // Fetching into the remote-tracking ref first is what makes `checkout -B` land on the branch's
  // real tip rather than on whatever this workspace last saw.
  await fetchWorkBranch(repo.workBranch, deps, options);
  await gitOrThrow(
    deps.git,
    ['checkout', '-B', repo.workBranch, `origin/${repo.workBranch}`],
    options,
  );
  return { summary: `Checked out ${repo.workBranch}`, note: null };
}

/**
 * Lands on the work branch this workspace already has, exactly where the last turn left it.
 *
 * A plain `checkout` is the whole point: it moves HEAD and nothing else, so commits the previous
 * turn made and edits it never committed are both still there when the agent starts.
 *
 * @param branch - Work branch of the turn.
 * @param onRemote - Whether the remote publishes it as well.
 * @param deps - Preparation dependencies.
 * @param options - Working directory and environment for git.
 * @returns What happened, for the progress messages.
 */
async function resumeWorkBranch(
  branch: string,
  onRemote: boolean,
  deps: PrepareDeps,
  options: GitRunOptions,
): Promise<WorkBranchOutcome> {
  await gitOrThrow(deps.git, ['checkout', branch], options);
  const summary = `Resumed ${branch}`;
  if (!onRemote) {
    return { summary, note: null };
  }
  await fetchWorkBranch(branch, deps, options);
  return { summary, note: divergenceNote(branch, await measureDivergence(branch, deps, options)) };
}

/**
 * Puts the work branch in place, wherever it already exists.
 *
 * The branch can be in three states and they are not symmetric. It exists only in this workspace
 * when an earlier turn created it and nothing has been pushed — the workspace outlives a turn, so
 * that is the ordinary second turn of a chat. It exists only on the remote when the workspace is
 * fresh or was rebuilt from the persisted history. It exists in both places once a turn has
 * pushed, and then the two tips can hold different commits.
 *
 * Only the first state may create it. Once the branch is local, preparation checks it out and
 * moves no ref: `checkout -B` would reset it to whatever it was pointed at and discard commits the
 * previous turn made, which are exactly the commits this turn is meant to build on. Reconciling a
 * divergence is reported and left to the agent, which has git and can be told what it is looking
 * at, rather than performed here — a merge preparation does on its own is a merge nobody asked
 * for, it fails on a work tree the previous turn left dirty, and refusing outright would strand
 * every later turn of the chat on the one workspace holding the unpushed commits.
 *
 * @param repo - Repository section of the turn request.
 * @param deps - Preparation dependencies.
 * @param options - Working directory and environment for git.
 * @returns What happened, for the progress messages.
 */
async function switchToWorkBranch(
  repo: TurnRequest['repo'],
  deps: PrepareDeps,
  options: GitRunOptions,
): Promise<WorkBranchOutcome> {
  if (repo.workBranch === repo.baseBranch) {
    await gitOrThrow(deps.git, ['checkout', repo.baseBranch], options);
    return { summary: `On ${repo.baseBranch}`, note: null };
  }
  const local = await hasLocalBranch(repo.workBranch, deps, options);
  const onRemote = await hasRemoteBranch(repo.workBranch, deps, options);
  return local
    ? resumeWorkBranch(repo.workBranch, onRemote, deps, options)
    : createWorkBranch(repo, onRemote, deps, options);
}

/**
 * Checks out the branch the agent should commit to and reports where it landed.
 *
 * @param repo - Repository section of the turn request.
 * @param deps - Preparation dependencies.
 * @returns The note the checkout produced, or `null` when there was nothing to report.
 */
async function checkoutWorkBranch(
  repo: TurnRequest['repo'],
  deps: PrepareDeps,
): Promise<string | null> {
  const options = { cwd: deps.workspaceRoot, env: deps.env };
  const outcome = await switchToWorkBranch(repo, deps, options);
  const sha = await gitOrThrow(deps.git, ['rev-parse', 'HEAD'], options);
  await deps.emit({ type: 'prepare.progress', message: `${outcome.summary} at ${short(sha)}` });
  if (outcome.note !== null) {
    await deps.emit({ type: 'prepare.progress', message: outcome.note });
  }
  return outcome.note;
}

/**
 * Reads where the checkout landed and warns when it is not where the host expected.
 *
 * A mismatch is a warning rather than a failure: the branch legitimately moves between an archive
 * and a restore, and the agent can still work — it just needs to know the ground shifted.
 *
 * @param repo - Repository section of the turn request.
 * @param deps - Preparation dependencies.
 * @returns The commit and branch the turn starts from, and the mismatch when there was one.
 */
async function verifyHead(repo: TurnRequest['repo'], deps: PrepareDeps): Promise<PrepareOutcome> {
  const options = { cwd: deps.workspaceRoot, env: deps.env };
  const headSha = await gitOrThrow(deps.git, ['rev-parse', 'HEAD'], options);
  const branch = await gitOrThrow(deps.git, ['rev-parse', '--abbrev-ref', 'HEAD'], options);
  if (repo.expectedHeadSha === undefined || repo.expectedHeadSha === headSha) {
    return { headSha, branch, notes: [] };
  }
  const note = prepareWarningText(
    `expected HEAD ${short(repo.expectedHeadSha)} but found ${short(headSha)}; the branch moved since the last snapshot`,
  );
  await deps.emit({ type: 'prepare.progress', message: note });
  return { headSha, branch, notes: [note] };
}

/**
 * Brings the workspace to the commit the turn should start from.
 *
 * @param repo - Repository section of the turn request.
 * @param prepareOptions - Preparation section of the turn request.
 * @param deps - Preparation dependencies.
 * @returns The commit and branch the turn starts from, with everything preparation found.
 * @throws PrepareError when the URL is refused, the workspace is unusable, or git fails.
 */
export async function prepare(
  repo: TurnRequest['repo'],
  prepareOptions: TurnRequest['prepare'],
  deps: PrepareDeps,
): Promise<PrepareOutcome> {
  const url = resolveRepoUrl(repo.url, deps.urlPolicy);
  assertBranchName(repo.baseBranch, 'baseBranch');
  assertBranchName(repo.workBranch, 'workBranch');
  try {
    await cloneOrFetch({ url, baseBranch: repo.baseBranch }, prepareOptions, deps);
    const checkoutNote = await checkoutWorkBranch(repo, deps);
    const verified = await verifyHead(repo, deps);
    // `prepare.done` is spelled out rather than spread: the event contract carries the head and
    // the branch and nothing else, and a spread would put the notes on the wire the day one is
    // added to this type without anybody deciding to publish them.
    await deps.emit({
      type: 'prepare.done',
      headSha: verified.headSha,
      branch: verified.branch,
    });
    return {
      headSha: verified.headSha,
      branch: verified.branch,
      notes: checkoutNote === null ? verified.notes : [checkoutNote, ...verified.notes],
    };
  } catch (error) {
    throw error instanceof GitError ? new PrepareError(error.message) : error;
  }
}
