/** @vitest-environment node */
/**
 * Unit tests for the GitHub REST client.
 *
 * Layer: unit.
 * Goal: the stored token authenticates the call and never appears anywhere else, and every
 * failure mode becomes a typed error rather than an echo of GitHub's own text.
 * Mocks: an injected `fetch`, an in-memory secrets service, and a logger writing into an array.
 */
import { branchSummary, createLogger, createRedactor, repoSummary } from '@agent-hangar/core';
import { assertNoCanary, GITHUB_CANARY } from '@agent-hangar/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { ApiHttpError, GithubApiError, ValidationError } from './errors';
import { createGithubClient, GITHUB_PAGE_SIZE } from './github';
import type { GithubClientDeps } from './github';
import { FakeSecretsService } from './testing/fake-secrets';

/** One repository as GitHub's REST API reports it. */
const GITHUB_REPO = {
  full_name: 'acme/widgets',
  html_url: 'https://github.com/acme/widgets',
  default_branch: 'main',
  private: true,
  description: 'Widget factory',
};

/** One branch as GitHub's REST API reports it. */
const GITHUB_BRANCH = { name: 'main', commit: { sha: 'a'.repeat(40) }, protected: true };

/** A test harness: the client, the fetch spy and everything the logger wrote. */
interface Harness {
  deps: GithubClientDeps;
  fetchSpy: ReturnType<typeof vi.fn>;
  logOutput: () => string;
  secrets: FakeSecretsService;
}

/**
 * Builds a client over a scripted `fetch`.
 *
 * The response is produced per call rather than shared, because a `Response` body can only be
 * read once and a test that lists twice would otherwise fail on a consumed stream.
 *
 * @param respond - Builds what `fetch` resolves with, once per call.
 * @param stored - Token stored in the secrets service, or none.
 * @returns The harness.
 */
function harness(respond: () => Response, stored: string | null = GITHUB_CANARY): Harness {
  const lines: string[] = [];
  const redactor = createRedactor();
  const secrets = new FakeSecretsService(stored === null ? {} : { GITHUB_PAT: stored });
  const fetchSpy = vi.fn(() => Promise.resolve(respond()));
  return {
    fetchSpy,
    secrets,
    logOutput: () => lines.join(''),
    deps: {
      secrets,
      redactor,
      logger: createLogger({
        level: 'info',
        redactor,
        destination: {
          write(line: string): void {
            lines.push(line);
          },
        },
      }),
      baseUrl: 'https://api.github.com',
      fetch: fetchSpy,
    },
  };
}

/**
 * Builds a JSON response.
 *
 * @param body - Value to encode.
 * @param status - HTTP status.
 * @returns The response.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('listRepos', () => {
  /**
   * The happy path: the listing maps onto the contract's own field names, so the route can hand
   * the result straight to `repoSummary` without a second translation.
   */
  it('maps a listing onto the repository contract', async () => {
    const { deps, fetchSpy } = harness(() => jsonResponse([GITHUB_REPO]));
    const repos = await createGithubClient(deps).listRepos('');
    expect(repos).toEqual([
      {
        fullName: 'acme/widgets',
        url: 'https://github.com/acme/widgets',
        defaultBranch: 'main',
        private: true,
        description: 'Widget factory',
      },
    ]);
    expect(repoSummary.safeParse(repos[0]).success).toBe(true);
    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain(`per_page=${String(GITHUB_PAGE_SIZE)}`);
    expect(url).toContain('affiliation=owner%2Ccollaborator%2Corganization_member');
  });

  /**
   * The picker filters as the user types; doing it here rather than through GitHub's search API
   * keeps one request per session instead of one per keystroke.
   */
  it('filters by a case-insensitive substring and ignores surrounding space', async () => {
    const other = { ...GITHUB_REPO, full_name: 'other/thing' };
    const { deps } = harness(() => jsonResponse([GITHUB_REPO, other]));
    const client = createGithubClient(deps);
    expect(await client.listRepos('  WIDG ')).toHaveLength(1);
    expect(await client.listRepos('nothing')).toHaveLength(0);
  });

  /**
   * The token authenticates the call and identifies the API version, which is what GitHub's REST
   * API requires of a client that wants a stable response shape.
   */
  it('sends the documented headers', async () => {
    const { deps, fetchSpy } = harness(() => jsonResponse([]));
    await createGithubClient(deps).listRepos('');
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${GITHUB_CANARY}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'agent-hangar',
    });
  });

  /**
   * Canary regression: the token is spliced into one header and nothing else. Every line the
   * module logged is checked, because a credential that reaches a log file has left the process
   * just as surely as one that reaches a response.
   */
  it('never writes the token to a log', async () => {
    const { deps, logOutput } = harness(() => jsonResponse([GITHUB_REPO]));
    await createGithubClient(deps).listRepos('');
    assertNoCanary(logOutput());
  });

  /**
   * With no token stored there is nothing to authenticate with, and the UI has a Settings page to
   * send the user to; a 409 says "the state is wrong", not "you got it wrong".
   */
  it('reports a missing token as a conflict', async () => {
    const { deps, fetchSpy } = harness(() => jsonResponse([]), null);
    await expect(createGithubClient(deps).listRepos('')).rejects.toMatchObject({
      status: 409,
      code: 'SECRETS_MISSING',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('listBranches', () => {
  /**
   * Branch mapping matches the contract, `protected` included: the picker greys out a protected
   * branch rather than letting a task target one.
   */
  it('maps branches onto the branch contract', async () => {
    const { deps, fetchSpy } = harness(() => jsonResponse([GITHUB_BRANCH]));
    const branches = await createGithubClient(deps).listBranches('acme/widgets');
    expect(branches).toEqual([{ name: 'main', sha: 'a'.repeat(40), protected: true }]);
    expect(branchSummary.safeParse(branches[0]).success).toBe(true);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      `https://api.github.com/repos/acme/widgets/branches?per_page=${String(GITHUB_PAGE_SIZE)}`,
    );
  });

  /**
   * The repository name is interpolated into a URL path, so it is checked against a strict shape
   * first: anything else could reach an endpoint the caller did not name.
   */
  it('rejects anything that is not owner/name', async () => {
    const { deps, fetchSpy } = harness(() => jsonResponse([]));
    const client = createGithubClient(deps);
    for (const slug of ['acme', 'acme/widgets/extra', '../../user', 'acme/widgets?x=1', 'a b/c']) {
      await expect(client.listBranches(slug)).rejects.toThrow(ValidationError);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /**
   * Regression: a segment made only of dots passes any character-class check — `..` is as ordinary
   * as `acme` to `[A-Za-z0-9_.-]+` — but `URL` resolves it before the request goes out, so
   * `../..` would climb out of `/repos/` and send the request, `Authorization` header included, to
   * a path the caller never named.
   */
  it('rejects a slug whose segments resolve out of the repository path', async () => {
    const { deps, fetchSpy } = harness(() => jsonResponse([]));
    const client = createGithubClient(deps);
    for (const slug of ['../..', './.', '../x', 'a/..', '.../..']) {
      await expect(client.listBranches(slug)).rejects.toThrow(ValidationError);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('failures', () => {
  /**
   * A non-2xx response becomes a typed error carrying the status, which is what the response
   * mapper branches on to tell an auth problem from an upstream one.
   */
  it('turns a non-2xx response into a typed error', async () => {
    const { deps } = harness(() => jsonResponse({ message: 'Bad credentials' }, 401));
    const rejection = createGithubClient(deps).listRepos('');
    await expect(rejection).rejects.toBeInstanceOf(GithubApiError);
    await expect(rejection).rejects.toMatchObject({ status: 401 });
  });

  /**
   * The failing body is logged so an operator can diagnose it, but it goes through the redactor
   * first: GitHub repeats what it was sent, and what it was sent included a bearer token.
   */
  it('redacts the sampled body before logging it', async () => {
    const body = { message: `rejected Authorization: Bearer ${GITHUB_CANARY}` };
    const { deps, logOutput } = harness(() => jsonResponse(body, 403));
    await expect(createGithubClient(deps).listRepos('')).rejects.toBeInstanceOf(GithubApiError);
    assertNoCanary(logOutput());
    expect(logOutput()).toContain('github request failed');
  });

  /**
   * A body that cannot even be read is still reported as a failed GitHub call rather than
   * crashing the request with a text-decoding error.
   */
  it('survives a failing response whose body cannot be read', async () => {
    const response = new Response(null, { status: 500 });
    Object.defineProperty(response, 'text', { value: () => Promise.reject(new Error('torn')) });
    const { deps } = harness(() => response);
    await expect(createGithubClient(deps).listRepos('')).rejects.toMatchObject({ status: 500 });
  });

  /**
   * A 2xx whose body is not JSON is a broken upstream, not a broken request; it maps to the same
   * typed error so the route answers 502 rather than 500.
   */
  it('reports a successful response with an unreadable body', async () => {
    const { deps } = harness(() => new Response('<html>', { status: 200 }));
    await expect(createGithubClient(deps).listRepos('')).rejects.toBeInstanceOf(GithubApiError);
  });

  /**
   * A missing token short-circuits the branches call too, so the guard is on the request rather
   * than on one method.
   */
  it('reports a missing token on the branches call', async () => {
    const { deps } = harness(() => jsonResponse([]), null);
    await expect(createGithubClient(deps).listBranches('acme/widgets')).rejects.toBeInstanceOf(
      ApiHttpError,
    );
  });
});
