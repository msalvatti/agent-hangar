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
 * The token is revealed once per listing into one local variable, spliced straight into the
 * `Authorization` header of every page and let go when the listing returns. Two rules keep it out
 * of everything else.
 *
 * The revealed value is handed to the redactor the moment it is read, so a later log line that
 * happens to carry it is scrubbed even when its shape is one the built-in patterns do not know — a
 * GitHub Enterprise token, for instance, which no pattern describes. That is a deliberate trade:
 * the redactor keeps the exact value in memory for the life of the process, because a scrubber can
 * only remove what it still recognises. It is the same bargain the worker makes after its own
 * reveal, and it moves nothing to a log, a response or a disk.
 *
 * The body of a failed response is never read at all: a forge repeats what it was sent, so its
 * text could echo the very header this module set, and masking a value is a weaker guarantee than
 * never reading it. A failure is therefore summarised by its status alone, in the log and in the
 * error.
 *
 * Every decoded body is parsed against the schema of the fields this client reads, because an
 * upstream answering valid JSON of the wrong shape is a failed call, not a listing of `undefined`.
 */
import type { Redactor, SecretsService } from '@agent-hangar/core';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { ZodType } from 'zod';

import { ApiHttpError, GithubApiError, ValidationError } from './errors';

/** One repository the stored token can reach. */
export interface RepoSummary {
  fullName: string;
  url: string;
  /**
   * The repository's configured default branch name.
   *
   * A name, not a promise that the ref exists: a repository with no commits reports `main` here
   * just like any other, because GitHub stores the setting from the moment the repository is
   * created and only creates the ref on the first push. Nothing may treat a present
   * `defaultBranch` as evidence that the repository can be cloned or worked in.
   */
  defaultBranch: string;
  private: boolean;
  description: string | null;
  /** Whether the token may push here, or absent when the upstream did not report it. */
  canPush?: boolean;
  /** Whether the forge has archived it, or absent when the upstream did not report it. */
  archived?: boolean;
}

/** One page of repositories, and whether the walk that produced it reached the end. */
export interface RepoListing {
  repos: RepoSummary[];
  /**
   * `true` when the walk stopped at {@link GITHUB_MAX_PAGES} with pages still on offer.
   *
   * The picker filters the listing it is given, so a truncated listing does not merely show fewer
   * repositories — it answers searches wrongly, reporting no match for a repository that exists
   * and is simply older than the limit. That is worth telling the user, and it is not something
   * they could deduce.
   */
  truncated: boolean;
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
  listRepos(query: string): Promise<RepoListing>;
  /** Branches of `owner/name`. */
  listBranches(repo: string): Promise<BranchSummary[]>;
}

/** Collaborators of {@link createGithubClient}. */
export interface GithubClientDeps {
  secrets: Pick<SecretsService, 'reveal'>;
  /**
   * Registers the revealed token, so the exact value is removed from anything this process logs
   * later — not only the values whose shape the redactor already recognises.
   */
  redactor: Pick<Redactor, 'register'>;
  logger: Logger;
  /** `GITHUB_API_BASE_URL`. */
  baseUrl: string;
  fetch: typeof fetch;
}

/** Page size requested for every listing; GitHub's own maximum. */
export const GITHUB_PAGE_SIZE = 100;

/**
 * How many pages one listing follows before it stops.
 *
 * A listing has to cover more than the first page — a token reaching two hundred repositories
 * would otherwise hide half of them from the picker — but following pages until an account runs
 * out is an unbounded amount of work driven by whatever the upstream reports. Ten pages is one
 * thousand repositories or branches, far past any account a single developer picks from by
 * scrolling, and it caps a listing at ten round trips however large the account is.
 */
export const GITHUB_MAX_PAGES = 10;

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

/**
 * The repository fields this client reads, as GitHub reports them.
 *
 * `permissions` and `archived` are the two optional members, and the optionality is deliberate
 * rather than defensive. GitHub documents both as required on the repository schema behind
 * `/user/repos`, but as optional on the minimal-repository schema several sibling listings return,
 * and `GITHUB_API_BASE_URL` is configurable — a GitHub Enterprise deployment or the local forge
 * the end-to-end suite serves may answer without them. Requiring them would turn "this forge says
 * less about permissions" into a failed listing and an empty picker; see {@link toAccess} for what
 * their absence means instead.
 */
const githubRepoPage = z.array(
  z.object({
    full_name: z.string().min(1),
    html_url: z.string().min(1),
    default_branch: z.string().min(1),
    private: z.boolean(),
    description: z.string().nullable(),
    permissions: z.object({ push: z.boolean().optional() }).optional(),
    archived: z.boolean().optional(),
  }),
);

/** One repository as {@link githubRepoPage} parses it. */
type GithubRepo = z.infer<typeof githubRepoPage>[number];

/**
 * Reads what the upstream stated about one repository, and only what it stated.
 *
 * The two facts are forwarded independently because they go missing independently. Bundling them
 * into one answer loses information in both directions: a forge reporting `archived` but not
 * `permissions` would have its archived flag discarded, and one reporting `permissions` but not
 * `archived` would have an unstated `archived: false` invented for it — which reports an archived
 * repository as ready to push to, the exact failure these fields exist to prevent.
 *
 * Neither is defaulted, for the same reason. A missing `push` must not read as "may push", and a
 * missing `archived` must not read as "not archived"; both silences are reported as silence and
 * the reader decides what to make of them.
 *
 * @param repo - One parsed repository from the listing.
 * @returns Whichever of the two facts the upstream stated, each omitted when it did not.
 */
function statedFacts(repo: GithubRepo): Pick<RepoSummary, 'canPush' | 'archived'> {
  const canPush = repo.permissions?.push;
  // Spread rather than assigned: under `exactOptionalPropertyTypes` an explicit `undefined` is a
  // different type from an absent key, and absent is what "the upstream did not say" means here.
  return {
    ...(canPush === undefined ? {} : { canPush }),
    ...(repo.archived === undefined ? {} : { archived: repo.archived }),
  };
}

/** The branch fields this client reads, as GitHub reports them. */
const githubBranchPage = z.array(
  z.object({
    name: z.string().min(1),
    commit: z.object({ sha: z.string().min(1) }),
    protected: z.boolean(),
  }),
);

/**
 * Creates the GitHub client.
 *
 * @param deps - Secrets service, redactor, logger, base URL and `fetch`.
 * @returns A client whose methods each reveal the token once and drop it again.
 */
export function createGithubClient(deps: GithubClientDeps): GithubClient {
  return {
    async listRepos(query: string): Promise<RepoListing> {
      const search = new URLSearchParams({
        per_page: String(GITHUB_PAGE_SIZE),
        sort: 'updated',
        affiliation: 'owner,collaborator,organization_member',
      });
      const page = await listPages(deps, `/user/repos?${search.toString()}`, githubRepoPage);
      const needle = query.trim().toLowerCase();
      return {
        // The filter runs over what was read, which is why truncation travels with the result: a
        // repository past the page limit is missing from every search, not only from the unfiltered
        // list, and no caller could work that out from an empty array.
        repos: page.items
          .filter((repo) => repo.full_name.toLowerCase().includes(needle))
          .map((repo) => ({
            fullName: repo.full_name,
            url: repo.html_url,
            defaultBranch: repo.default_branch,
            private: repo.private,
            description: repo.description,
            ...statedFacts(repo),
          })),
        truncated: page.truncated,
      };
    },

    async listBranches(repo: string): Promise<BranchSummary[]> {
      if (!isRepoSlug(repo)) {
        throw new ValidationError('Repository must be given as "owner/name"');
      }
      const path = `/repos/${repo}/branches?per_page=${String(GITHUB_PAGE_SIZE)}`;
      // Truncation is deliberately not surfaced here. It would mean a repository with more than a
      // thousand branches, and the branch picker has no claim about its own completeness to
      // correct — unlike the repository listing, whose note says what decides its contents.
      const { items } = await listPages(deps, path, githubBranchPage);
      return items.map((branch) => ({
        name: branch.name,
        sha: branch.commit.sha,
        protected: branch.protected,
      }));
    },
  };
}

/**
 * Reads one listing to its end, or to {@link GITHUB_MAX_PAGES}, whichever comes first.
 *
 * The token is revealed once for the whole listing rather than once per page: decrypting it again
 * for every round trip would multiply the number of moments it exists in plaintext without making
 * any of them shorter.
 *
 * @param deps - Client collaborators.
 * @param path - Path below the configured base URL, query included.
 * @param schema - Contract one page of results must satisfy.
 * @returns Every item of every page that was read, in order, and whether the walk stopped early.
 * @throws ApiHttpError 409 `SECRETS_MISSING` when no token is stored.
 * @throws GithubApiError When GitHub answers with a non-2xx status, an unreadable body or a body
 *   that does not match the schema.
 */
async function listPages<T>(
  deps: GithubClientDeps,
  path: string,
  schema: ZodType<T[]>,
): Promise<{ items: T[]; truncated: boolean }> {
  const revealed = await deps.secrets.reveal('GITHUB_PAT');
  if (revealed === null) {
    throw new ApiHttpError(409, 'SECRETS_MISSING', 'GitHub token is not configured');
  }
  deps.redactor.register([revealed]);
  const items: T[] = [];
  let next: string | null = `${deps.baseUrl}${path}`;
  let pages = 0;
  // Whether the last page read offered a further one. That, rather than `next`, is what says the
  // listing is incomplete: a walk also stops when the offered link points off the configured API,
  // and a listing cut short by this client's own refusal is every bit as partial as one cut short
  // by the page limit.
  // Stryker disable next-line BooleanLiteral: the loop below runs at least once — its first
  // cursor is never null and the page limit is never zero — so what this holds afterwards always
  // came from a page that was read.
  let offeredMore = false;
  while (next !== null && pages < GITHUB_MAX_PAGES) {
    const response = await request(deps, next, revealed);
    items.push(...(await decode(response, schema)));
    const page = nextPageUrl(deps.baseUrl, response.headers.get('link'));
    next = page.url;
    offeredMore = page.offered;
    pages += 1;
  }
  if (next !== null) {
    // The account holds more than one walk reads. The listing is still the most recently updated
    // thousand entries, but a picker that quietly shows a truncated list is worth being able to
    // recognise; the path carries no credential, only the endpoint and its page size.
    deps.logger.warn({ path, pages }, 'github listing stopped at the page limit');
  }
  return { items, truncated: offeredMore };
}

/**
 * Performs one authenticated GitHub request.
 *
 * @param deps - Client collaborators.
 * @param url - Absolute URL of the page to read.
 * @param token - The revealed token, used for this call only.
 * @returns The response, when GitHub answered with a 2xx status.
 * @throws GithubApiError When GitHub answers with a non-2xx status.
 */
async function request(deps: GithubClientDeps, url: string, token: string): Promise<Response> {
  const response = await deps.fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'agent-hangar',
    },
  });
  if (!response.ok) {
    // Only the status is read. The body is written by a server that was handed the token, so it
    // is neither logged nor quoted; the status is what tells an auth failure from an outage.
    deps.logger.warn({ status: response.status }, 'github request failed');
    throw new GithubApiError(response.status, `GitHub answered ${String(response.status)}`);
  }
  return response;
}

/**
 * Decodes and validates one page of results.
 *
 * @param response - A successful response.
 * @param schema - Contract the page must satisfy.
 * @returns The parsed items.
 * @throws GithubApiError When the body is not JSON, or is JSON of another shape.
 */
async function decode<T>(response: Response, schema: ZodType<T[]>): Promise<T[]> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new GithubApiError(response.status, 'GitHub returned a body that is not JSON');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    // The issues quote the offending values, which come from the upstream; the caller is told the
    // shape was wrong and nothing else.
    throw new GithubApiError(response.status, 'GitHub returned a body of an unexpected shape');
  }
  return parsed.data;
}

/** Matches the `<url>; rel="next"` element of a `Link` header. */
const NEXT_LINK_PATTERN = /<([^>]+)>\s*;\s*rel="next"/;

/** What a `Link` header offered, and what this client is willing to do about it. */
interface NextPage {
  /** The URL to read next, or `null` when there is none this client will follow. */
  url: string | null;
  /**
   * Whether the upstream offered a further page at all, followed or not.
   *
   * Kept apart from {@link NextPage.url} so a refused link is not mistaken for the end of the
   * account: the two produce the same `url` and mean opposite things about completeness.
   */
  offered: boolean;
}

/**
 * Reads the next page's URL out of a `Link` header.
 *
 * The URL is chosen by the upstream, and the request that follows it carries the `Authorization`
 * header, so a link that leaves the configured API is not followed: it would send the token to a
 * host the operator never configured. The comparison keeps the separator, so a base of
 * `https://api.github.com` does not accept `https://api.github.com.example.net/…`.
 *
 * @param baseUrl - The configured API base URL.
 * @param header - Value of the `Link` header, or `null` when there was none.
 * @returns The next page to read, and whether one was offered at all.
 */
function nextPageUrl(baseUrl: string, header: string | null): NextPage {
  // Stryker disable next-line ConditionalExpression: the null test narrows the type for `exec`,
  // which reads a missing header as the four letters of `null` and matches no link in it either.
  const candidate = (header === null ? null : NEXT_LINK_PATTERN.exec(header))?.[1];
  if (candidate === undefined) {
    return { url: null, offered: false };
  }
  return { url: candidate.startsWith(`${baseUrl}/`) ? candidate : null, offered: true };
}
