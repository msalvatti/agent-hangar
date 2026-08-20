/**
 * GitHub REST client backing the repository and branch pickers.
 *
 * Layer: service (server).
 *
 * THIS IS THE ONLY MODULE IN `apps/web` PERMITTED TO CALL `SecretsService.reveal`. The spec marks
 * `reveal` as worker-only, and for everything that runs inside a workspace it stays that way;
 * routing the picker through the worker over BullMQ would buy nothing for a local single-user app.
 * The exception is confined here and enforced by a policy test that greps the whole web app.
 *
 * The token is read per request into one local variable, spliced straight into the `Authorization`
 * header and dropped when the call returns. It is never stored on the client object, never put in
 * a log or an error, and GitHub's own response text never reaches the caller: the body of a failed
 * response is written by a server that was handed the token, so it is summarised by status only.
 */
import type { Redactor, SecretsService } from '@agent-hangar/core';
import type { Logger } from 'pino';

import { ApiHttpError, GithubApiError, ValidationError } from './errors';

/** One repository the stored token can reach. */
export interface RepoSummary {
  fullName: string;
  url: string;
  defaultBranch: string;
  private: boolean;
  description: string | null;
}

/** One branch of a repository. */
export interface BranchSummary {
  name: string;
  sha: string;
  protected: boolean;
}

/** Reads repositories and branches from the configured GitHub API. */
export interface GithubClient {
  /** Repositories the token can reach, filtered by a case-insensitive substring of `full_name`. */
  listRepos(query: string): Promise<RepoSummary[]>;
  /** Branches of `owner/name`. */
  listBranches(repo: string): Promise<BranchSummary[]>;
}

/** Collaborators of {@link createGithubClient}. */
export interface GithubClientDeps {
  secrets: Pick<SecretsService, 'reveal'>;
  redactor: Pick<Redactor, 'redact'>;
  logger: Logger;
  /** `GITHUB_API_BASE_URL`. */
  baseUrl: string;
  fetch: typeof fetch;
}

/** Page size used for every listing; the picker never paginates. */
export const GITHUB_PAGE_SIZE = 100;

/** How much of a failed response body is inspected before it is discarded. */
const ERROR_BODY_SAMPLE = 200;

/** Characters a repository owner or name may contain. */
const REPO_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;

/** A segment made only of dots, which `URL` resolves away rather than treating as a name. */
const DOT_SEGMENT_PATTERN = /^\.+$/;

/**
 * Whether a value is the `owner/name` slug the branches endpoint accepts.
 *
 * The dot check is the load-bearing half. The slug is interpolated into a URL path, and `URL`
 * resolves `.` and `..` before the request goes out, so `../..` — which is two perfectly ordinary
 * segments as far as the character class is concerned — would climb out of `/repos/` and send the
 * request, `Authorization` header and all, to a path the caller never named.
 *
 * @param repo - Value received from the client.
 * @returns `true` when it names exactly one owner and one repository.
 */
function isRepoSlug(repo: string): boolean {
  const segments = repo.split('/');
  return (
    segments.length === 2 &&
    segments.every(
      (segment) => REPO_SEGMENT_PATTERN.test(segment) && !DOT_SEGMENT_PATTERN.test(segment),
    )
  );
}

/** Shape of the repository fields this client reads. */
interface GithubRepo {
  full_name: string;
  html_url: string;
  default_branch: string;
  private: boolean;
  description: string | null;
}

/** Shape of the branch fields this client reads. */
interface GithubBranch {
  name: string;
  commit: { sha: string };
  protected: boolean;
}

/**
 * Creates the GitHub client.
 *
 * @param deps - Secrets service, redactor, logger, base URL and `fetch`.
 * @returns A client whose methods each reveal the token once and drop it again.
 */
export function createGithubClient(deps: GithubClientDeps): GithubClient {
  return {
    async listRepos(query: string): Promise<RepoSummary[]> {
      const search = new URLSearchParams({
        per_page: String(GITHUB_PAGE_SIZE),
        sort: 'updated',
        affiliation: 'owner,collaborator,organization_member',
      });
      const repos = await request<GithubRepo[]>(deps, `/user/repos?${search.toString()}`);
      const needle = query.trim().toLowerCase();
      return repos
        .filter((repo) => repo.full_name.toLowerCase().includes(needle))
        .map((repo) => ({
          fullName: repo.full_name,
          url: repo.html_url,
          defaultBranch: repo.default_branch,
          private: repo.private,
          description: repo.description,
        }));
    },

    async listBranches(repo: string): Promise<BranchSummary[]> {
      if (!isRepoSlug(repo)) {
        throw new ValidationError('Repository must be given as "owner/name"');
      }
      const path = `/repos/${repo}/branches?per_page=${String(GITHUB_PAGE_SIZE)}`;
      const branches = await request<GithubBranch[]>(deps, path);
      return branches.map((branch) => ({
        name: branch.name,
        sha: branch.commit.sha,
        protected: branch.protected,
      }));
    },
  };
}

/**
 * Performs one authenticated GitHub request.
 *
 * @param deps - Client collaborators.
 * @param path - Path below the configured base URL, query included.
 * @returns The decoded JSON body.
 * @throws ApiHttpError 409 `SECRETS_MISSING` when no token is stored.
 * @throws GithubApiError When GitHub answers with a non-2xx status or an unreadable body.
 */
async function request<T>(deps: GithubClientDeps, path: string): Promise<T> {
  const revealed = await deps.secrets.reveal('GITHUB_PAT');
  if (revealed === null) {
    throw new ApiHttpError(409, 'SECRETS_MISSING', 'GitHub token is not configured');
  }
  const response = await deps.fetch(`${deps.baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${revealed}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'agent-hangar',
    },
  });
  if (!response.ok) {
    await reportFailure(deps, response);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new GithubApiError(response.status, 'GitHub returned a body that is not JSON');
  }
}

/**
 * Logs a failed GitHub response and raises the typed error for it.
 *
 * The body is sampled and redacted only so an operator can see it in the log; it never becomes the
 * error message, because a forge repeats what it was sent.
 *
 * @param deps - Client collaborators.
 * @param response - The non-2xx response.
 * @throws GithubApiError Always.
 */
async function reportFailure(deps: GithubClientDeps, response: Response): Promise<never> {
  const body = await response.text().catch(() => '');
  deps.logger.warn(
    { status: response.status, sample: deps.redactor.redact(body.slice(0, ERROR_BODY_SAMPLE)) },
    'github request failed',
  );
  throw new GithubApiError(response.status, `GitHub answered ${String(response.status)}`);
}
