/**
 * Workspace preparation: bring `/workspace` to the commit the turn should start from.
 *
 * Layer: domain.
 *
 * The repository URL is validated before git ever sees it. `GIT_ASKPASS` releases the PAT for
 * github.com over https, so a URL naming another host — or carrying its own credentials — is the
 * one input that could turn preparation into an exfiltration step. It is refused here as well as
 * in the helper, because two independent checks are what keeps a change to either one honest.
 */
import { mkdir } from 'node:fs/promises';

import type { AgentEvent, TurnRequest } from '@agent-hangar/core';

import { GitError, gitOrThrow } from './git.js';
import type { GitRunner } from './git.js';

/** Characters of a sha shown in a progress message. */
const SHORT_SHA_LENGTH = 7;

/** The only forge the product supports; the askpass helper enforces the same host. */
const ALLOWED_HOST = 'github.com';

/** Owner and repository name, with an optional `.git` suffix and nothing else. */
const REPOSITORY_PATH = /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\.git)?$/;

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

/** How strictly the repository URL is checked. */
export type RepositoryUrlPolicy = 'github-https' | 'any';

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
  /** Defaults to `github-https`; tests use `any` for a local `file://` remote. */
  urlPolicy?: RepositoryUrlPolicy;
}

/** Where preparation left the workspace. */
export interface PrepareResult {
  /** Commit the turn starts from. */
  headSha: string;
  /** Branch that is checked out. */
  branch: string;
}

/**
 * Rejects any repository URL that is not a credential-free GitHub https URL.
 *
 * @param url - URL from the turn request.
 * @throws PrepareError when the URL names another host or scheme, carries credentials, or is not
 *   a plain owner/repository path.
 */
export function assertGithubHttpsUrl(url: string): void {
  const parsed = URL.parse(url);
  const acceptable =
    parsed !== null &&
    parsed.protocol === 'https:' &&
    parsed.hostname === ALLOWED_HOST &&
    parsed.host === ALLOWED_HOST &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.search === '' &&
    parsed.hash === '' &&
    REPOSITORY_PATH.test(parsed.pathname);
  if (!acceptable) {
    throw new PrepareError(
      `repository URL must be https://${ALLOWED_HOST}/<owner>/<repo> without credentials`,
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
 * @param repo - Repository section of the turn request.
 * @param prepareOptions - Preparation section of the turn request.
 * @param deps - Preparation dependencies.
 * @throws PrepareError when cloning was not requested and the workspace holds no repository.
 */
async function cloneOrFetch(
  repo: TurnRequest['repo'],
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

/**
 * Puts the work branch in place, whether it exists on the remote or not.
 *
 * @param repo - Repository section of the turn request.
 * @param deps - Preparation dependencies.
 * @param options - Working directory and environment for git.
 * @returns What happened, for the progress message.
 */
async function switchToWorkBranch(
  repo: TurnRequest['repo'],
  deps: PrepareDeps,
  options: { cwd: string; env: Record<string, string> },
): Promise<string> {
  if (repo.workBranch === repo.baseBranch) {
    await gitOrThrow(deps.git, ['checkout', repo.baseBranch], options);
    return `On ${repo.baseBranch}`;
  }
  const remote = await deps.git.run(['ls-remote', '--heads', 'origin', repo.workBranch], options);
  if (remote.stdout.trim() === '') {
    await gitOrThrow(deps.git, ['checkout', '-b', repo.workBranch], options);
    return `Created ${repo.workBranch} from ${repo.baseBranch}`;
  }
  // Fetching into the remote-tracking ref first is what makes `checkout -B` land on the branch's
  // real tip rather than on whatever this workspace last saw.
  const ref = `refs/remotes/origin/${repo.workBranch}`;
  await gitOrThrow(deps.git, ['fetch', 'origin', `${repo.workBranch}:${ref}`], options);
  await gitOrThrow(
    deps.git,
    ['checkout', '-B', repo.workBranch, `origin/${repo.workBranch}`],
    options,
  );
  return `Checked out ${repo.workBranch}`;
}

/**
 * Checks out the branch the agent should commit to and reports where it landed.
 *
 * @param repo - Repository section of the turn request.
 * @param deps - Preparation dependencies.
 */
async function checkoutWorkBranch(repo: TurnRequest['repo'], deps: PrepareDeps): Promise<void> {
  const options = { cwd: deps.workspaceRoot, env: deps.env };
  const what = await switchToWorkBranch(repo, deps, options);
  const sha = await gitOrThrow(deps.git, ['rev-parse', 'HEAD'], options);
  await deps.emit({ type: 'prepare.progress', message: `${what} at ${short(sha)}` });
}

/**
 * Reads where the checkout landed and warns when it is not where the host expected.
 *
 * A mismatch is a warning rather than a failure: the branch legitimately moves between an archive
 * and a restore, and the agent can still work — it just needs to know the ground shifted.
 *
 * @param repo - Repository section of the turn request.
 * @param deps - Preparation dependencies.
 * @returns The commit and branch the turn starts from.
 */
async function verifyHead(repo: TurnRequest['repo'], deps: PrepareDeps): Promise<PrepareResult> {
  const options = { cwd: deps.workspaceRoot, env: deps.env };
  const headSha = await gitOrThrow(deps.git, ['rev-parse', 'HEAD'], options);
  const branch = await gitOrThrow(deps.git, ['rev-parse', '--abbrev-ref', 'HEAD'], options);
  if (repo.expectedHeadSha !== undefined && repo.expectedHeadSha !== headSha) {
    await deps.emit({
      type: 'prepare.progress',
      message: `Warning: expected HEAD ${short(repo.expectedHeadSha)} but found ${short(headSha)}; the branch moved since the last snapshot`,
    });
  }
  return { headSha, branch };
}

/**
 * Brings the workspace to the commit the turn should start from.
 *
 * @param repo - Repository section of the turn request.
 * @param prepareOptions - Preparation section of the turn request.
 * @param deps - Preparation dependencies.
 * @returns The commit and branch the turn starts from.
 * @throws PrepareError when the URL is refused, the workspace is unusable, or git fails.
 */
export async function prepare(
  repo: TurnRequest['repo'],
  prepareOptions: TurnRequest['prepare'],
  deps: PrepareDeps,
): Promise<PrepareResult> {
  if ((deps.urlPolicy ?? 'github-https') === 'github-https') {
    assertGithubHttpsUrl(repo.url);
  }
  try {
    await cloneOrFetch(repo, prepareOptions, deps);
    await checkoutWorkBranch(repo, deps);
    const result = await verifyHead(repo, deps);
    await deps.emit({ type: 'prepare.done', ...result });
    return result;
  } catch (error) {
    throw error instanceof GitError ? new PrepareError(error.message) : error;
  }
}
