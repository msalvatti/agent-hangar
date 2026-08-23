/** @vitest-environment node */
/**
 * Unit tests for the GitHub REST client.
 *
 * Layer: unit.
 * Goal: the stored token authenticates the call and never appears anywhere else, a listing covers
 * more than its first page without following a link off the configured API, and every failure mode
 * becomes a typed error rather than an echo of GitHub's own text.
 * Mocks: an injected `fetch`, an in-memory secrets service, and a logger writing into an array.
 */
import { branchSummary, createLogger, createRedactor, repoSummary } from '@agent-hangar/core';
import { assertNoCanary, CANARY_MARKER, GITHUB_CANARY } from '@agent-hangar/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { ApiHttpError, GithubApiError, ValidationError } from './errors';
import { createGithubClient, GITHUB_MAX_PAGES, GITHUB_PAGE_SIZE } from './github';
import type { GithubClientDeps } from './github';
import { FakeSecretsService } from './testing/fake-secrets';

/** Base URL every harness in this file is built against. */
const BASE_URL = 'https://api.github.com';

/**
 * A token belonging to no family the redactor's shape patterns describe.
 *
 * A GitHub Enterprise deployment issues tokens whose spelling this repository has never seen, so
 * masking by shape cannot help: only the exact value, registered at the moment it is revealed,
 * keeps it out of a log line. Assembled at runtime and carrying the canary marker, so no
 * credential-shaped literal is written to this file.
 */
const ENTERPRISE_TOKEN = `enterprise${CANARY_MARKER}${'0'.repeat(24)}`;

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
      baseUrl: BASE_URL,
      fetch: fetchSpy,
    },
  };
}

/**
 * Builds a JSON response.
 *
 * @param body - Value to encode.
 * @param status - HTTP status.
 * @param headers - Extra headers merged over the content type.
 * @returns The response.
 */
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * Builds a `Link` header pointing at one more page of the same listing.
 *
 * @param url - URL of the next page.
 * @returns The header value, with the `last` relation GitHub also sends.
 */
function nextLink(url: string): Record<string, string> {
  return { link: `<${url}>; rel="next", <${url}>; rel="last"` };
}

/**
 * Scripts one response per call, in order.
 *
 * @param responses - Builders, one per expected call.
 * @returns A responder that hands out the next one each time it is called.
 */
function inOrder(responses: (() => Response)[]): () => Response {
  let index = 0;
  return () => {
    const next = responses[index];
    index += 1;
    return next === undefined ? jsonResponse([]) : next();
  };
}

describe('listRepos', () => {
  /**
   * The happy path: the listing maps onto the contract's own field names, so the route can hand
   * the result straight to `repoSummary` without a second translation.
   */
  it('maps a listing onto the repository contract', async () => {
    const { deps, fetchSpy } = harness(() => jsonResponse([GITHUB_REPO]));
    const { repos } = await createGithubClient(deps).listRepos('');
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
    expect((await client.listRepos('  WIDG ')).repos).toHaveLength(1);
    expect((await client.listRepos('nothing')).repos).toHaveLength(0);
  });

  /**
   * The token authenticates the call and identifies the API version, which is what GitHub's REST
   * API requires of a client that wants a stable response shape.
   */
  it('sends the documented headers', async () => {
    const { deps, fetchSpy } = harness(() => jsonResponse([]));
    await createGithubClient(deps).listRepos('');
    // Most recently updated first, and every affiliation the token can reach: the picker shows one
    // page and the sort is what decides which repositories a user finds in it.
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('sort=updated');
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
   * The revealed value is registered with the redactor, so a token whose shape no pattern knows —
   * a GitHub Enterprise one, for instance — is still removed from anything this process logs
   * afterwards. Shape matching alone would let this exact value through untouched.
   */
  it('registers the revealed token so an unknown token shape is still redacted', async () => {
    const { deps, logOutput } = harness(() => jsonResponse([GITHUB_REPO]), ENTERPRISE_TOKEN);
    await createGithubClient(deps).listRepos('');

    deps.logger.warn({ note: `upstream said ${ENTERPRISE_TOKEN}` }, 'after the listing');

    expect(logOutput()).toContain('after the listing');
    expect(logOutput()).not.toContain(ENTERPRISE_TOKEN);
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
      // The sentence sends the user to Settings; a conflict with no words is a dialog that says
      // only that something is wrong.
      message: 'GitHub token is not configured',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('pagination', () => {
  /**
   * A token reaching more than one page of repositories must see all of them: reading only the
   * first page would hide every repository past the hundredth from the picker for good.
   */
  it('follows the next link and combines the pages', async () => {
    const second = `${BASE_URL}/user/repos?page=2`;
    const other = { ...GITHUB_REPO, full_name: 'acme/gadgets' };
    const { deps, fetchSpy } = harness(
      inOrder([
        () => jsonResponse([GITHUB_REPO], 200, nextLink(second)),
        () => jsonResponse([other]),
      ]),
    );

    const { repos } = await createGithubClient(deps).listRepos('');

    expect(repos.map((repo) => repo.fullName)).toEqual(['acme/widgets', 'acme/gadgets']);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[1]?.[0])).toBe(second);
  });

  /**
   * Branches paginate the same way, so a repository with more than a hundred branches does not
   * silently hide the rest of them from the picker.
   */
  it('follows the next link for branches too', async () => {
    const second = `${BASE_URL}/repos/acme/widgets/branches?page=2`;
    const { deps } = harness(
      inOrder([
        () => jsonResponse([GITHUB_BRANCH], 200, nextLink(second)),
        () => jsonResponse([{ ...GITHUB_BRANCH, name: 'next' }]),
      ]),
    );

    const branches = await createGithubClient(deps).listBranches('acme/widgets');

    expect(branches.map((branch) => branch.name)).toEqual(['main', 'next']);
  });

  /**
   * An upstream that keeps offering one more page — a hostile or simply enormous account — must
   * not turn one picker request into unbounded work, so the walk stops at a fixed page count.
   */
  it('stops after the maximum number of pages', async () => {
    const { deps, fetchSpy, logOutput } = harness(() =>
      jsonResponse([GITHUB_REPO], 200, nextLink(`${BASE_URL}/user/repos?page=next`)),
    );

    const { repos, truncated } = await createGithubClient(deps).listRepos('');

    expect(fetchSpy).toHaveBeenCalledTimes(GITHUB_MAX_PAGES);
    expect(repos).toHaveLength(GITHUB_MAX_PAGES);
    expect(truncated).toBe(true);
    // The endpoint and how far the walk got: the path carries no credential, and the pair is what
    // tells an operator whether a picker's list is short because of this limit or because of the
    // token's own reach.
    expect(
      logOutput()
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    ).toContainEqual(
      expect.objectContaining({
        msg: 'github listing stopped at the page limit',
        path: expect.stringContaining('/user/repos') as unknown,
        pages: GITHUB_MAX_PAGES,
      }),
    );
  });

  /**
   * A walk that ends because the last page offered no further one is complete. Reported as
   * truncated, the picker would carry a warning on every ordinary listing; and a `Link` header
   * whose `next` element is written with the spacing the RFC allows is still a next page.
   */
  it.each([
    ['no spacing', `<${BASE_URL}/user/repos?page=2>;rel="next"`],
    ['extra spacing', `<${BASE_URL}/user/repos?page=2>  ;   rel="next"`],
  ])('follows a next link written with %s', async (_label, link) => {
    let calls = 0;
    const { deps, fetchSpy } = harness(() => {
      calls += 1;
      return calls === 1
        ? jsonResponse([GITHUB_REPO], 200, { link })
        : jsonResponse([GITHUB_REPO], 200);
    });

    const { repos, truncated } = await createGithubClient(deps).listRepos('');

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(repos).toHaveLength(2);
    expect(truncated).toBe(false);
  });

  /**
   * The next URL comes from the upstream and the request that follows it carries the token, so a
   * link pointing anywhere but the configured API ends the walk instead of being followed. The
   * separator is part of the comparison: a look-alike host must not pass as a prefix match.
   */
  it.each([
    ['another host', 'https://api.github.com.example.net/user/repos?page=2'],
    ['an unrelated origin', 'https://example.net/user/repos?page=2'],
  ])('does not follow a next link that leaves the API (%s)', async (_label, link) => {
    const { deps, fetchSpy } = harness(() => jsonResponse([GITHUB_REPO], 200, nextLink(link)));

    const { repos, truncated } = await createGithubClient(deps).listRepos('');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(repos).toHaveLength(1);
    // A page was offered and this client declined to follow it, so the listing is incomplete for a
    // different reason than the page limit — and just as incomplete. Reporting `false` here would
    // let the picker claim it shows everything the token can reach.
    expect(truncated).toBe(true);
  });

  /**
   * The last page still carries a `Link` header, only without a `next` relation; that is the
   * ordinary end of a walk rather than a failure.
   */
  it('stops on a link header that offers no next page', async () => {
    const { deps, fetchSpy } = harness(() =>
      jsonResponse([GITHUB_REPO], 200, { link: `<${BASE_URL}/user/repos?page=1>; rel="prev"` }),
    );

    await createGithubClient(deps).listRepos('');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
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
      `${BASE_URL}/repos/acme/widgets/branches?per_page=${String(GITHUB_PAGE_SIZE)}`,
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
      await expect(client.listBranches(slug)).rejects.toThrow(
        'Repository must be given as "owner/name"',
      );
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /**
   * Only a segment made *entirely* of dots is refused. A name that merely begins or ends with one
   * is an ordinary repository — `.github` is the conventional one every organisation has — and a
   * check that read part of the segment would refuse to list its branches.
   */
  it.each(['acme/.github', 'acme/widgets.', '.acme/widgets'])(
    'accepts %s, which is a name rather than a path segment',
    async (slug) => {
      const { deps, fetchSpy } = harness(() => jsonResponse([]));

      await createGithubClient(deps).listBranches(slug);

      expect(String(fetchSpy.mock.calls[0]?.[0])).toContain(`/repos/${slug}/branches`);
    },
  );

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
    // The status travels in the message as well as on the error: it is the only thing this client
    // is willing to repeat about a failed call, and it is what tells an expired token from an
    // outage.
    await expect(rejection).rejects.toMatchObject({
      status: 401,
      message: 'GitHub answered 401',
    });
  });

  /**
   * The body of a failed response is never read. A forge repeats what it was sent, so its text can
   * carry the very token this module put in the request header; the status alone is what reaches
   * the log and the error, and masking is not relied on to make the body safe.
   */
  it('never reads or logs the body of a failed response', async () => {
    const body = { message: `rejected Authorization: Bearer ${GITHUB_CANARY}` };
    const response = jsonResponse(body, 403);
    const { deps, logOutput } = harness(() => response);

    await expect(createGithubClient(deps).listRepos('')).rejects.toBeInstanceOf(GithubApiError);

    expect(response.bodyUsed).toBe(false);
    assertNoCanary(logOutput());
    // The status is the one thing repeated about a failed call, and it is the thing that tells an
    // expired token from an outage — a line without it reports only that something went wrong.
    expect(
      logOutput()
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    ).toContainEqual(expect.objectContaining({ msg: 'github request failed', status: 403 }));
    expect(logOutput()).not.toContain('rejected');
  });

  /**
   * A 2xx whose body is not JSON is a broken upstream, not a broken request; it maps to the same
   * typed error so the route answers 502 rather than 500.
   */
  it('reports a successful response with an unreadable body', async () => {
    const { deps } = harness(() => new Response('<html>', { status: 200 }));
    await expect(createGithubClient(deps).listRepos('')).rejects.toMatchObject({
      message: 'GitHub returned a body that is not JSON',
    });
  });

  /**
   * Valid JSON of the wrong shape is a failed call, not a listing of `undefined`: without the
   * boundary schema an object where an array belongs, or a repository missing `full_name`, would
   * reach the caller and surface as an internal 500 far from where it went wrong.
   */
  it.each([
    ['an object where a list belongs', {}],
    ['a repository missing a field', [{ html_url: 'https://github.com/acme/widgets' }]],
    ['a repository with a field of the wrong type', [{ ...GITHUB_REPO, private: 'yes' }]],
  ])('rejects a body of an unexpected shape (%s)', async (_label, body) => {
    const { deps } = harness(() => jsonResponse(body));
    const rejection = createGithubClient(deps).listRepos('');
    await expect(rejection).rejects.toBeInstanceOf(GithubApiError);
    await expect(rejection).rejects.toMatchObject({ status: 200 });
  });

  /**
   * The branches endpoint is parsed just as strictly, including the nested commit object the sha
   * is read out of.
   */
  it('rejects a branch listing of an unexpected shape', async () => {
    const { deps } = harness(() => jsonResponse([{ name: 'main', protected: true }]));
    // Told apart from a body that was not JSON at all: one is a forge answering something else,
    // the other is a contract that has moved, and only the sentence says which.
    await expect(createGithubClient(deps).listBranches('acme/widgets')).rejects.toMatchObject({
      message: 'GitHub returned a body of an unexpected shape',
    });
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

describe('repository access', () => {
  /**
   * Telling a repository the agent could push to from one it could only read is the whole point of
   * the picker's badge, so the two fields that decide it are parsed rather than discarded — and
   * the result still satisfies the API contract the route hands the listing straight to.
   */
  it('maps permissions and the archived flag onto the contract', async () => {
    const { deps } = harness(() =>
      jsonResponse([
        { ...GITHUB_REPO, permissions: { push: true, pull: true }, archived: false },
        {
          ...GITHUB_REPO,
          full_name: 'acme/legacy',
          permissions: { push: false, pull: true },
          archived: true,
        },
      ]),
    );

    const { repos } = await createGithubClient(deps).listRepos('');

    expect(repos.map((repo) => [repo.canPush, repo.archived])).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(repos.every((repo) => repoSummary.safeParse(repo).success)).toBe(true);
  });

  /**
   * The two facts go missing independently, so they are carried independently. Bundling them into
   * one answer loses information in both directions: a forge stating `archived` but not
   * `permissions` would have its archived flag thrown away, and one stating `permissions` but not
   * `archived` would have an unstated `archived: false` invented — which reports an archived
   * repository as ready to push to, the exact failure these fields exist to prevent.
   */
  it.each([
    ['only the push permission', { permissions: { push: false } }, { canPush: false }],
    ['only the archived flag', { archived: true }, { archived: true }],
  ])('keeps a partially reported repository partial (%s)', async (_label, upstream, expected) => {
    const { deps } = harness(() => jsonResponse([{ ...GITHUB_REPO, ...upstream }]));

    const { repos } = await createGithubClient(deps).listRepos('');

    const [repo] = repos;
    expect(repo).toMatchObject(expected);
    // The unstated half is absent, not invented. `toMatchObject` would pass with an extra key
    // present, so the absence is asserted separately.
    expect(Object.hasOwn(repo ?? {}, 'canPush')).toBe(Object.hasOwn(expected, 'canPush'));
    expect(Object.hasOwn(repo ?? {}, 'archived')).toBe(Object.hasOwn(expected, 'archived'));
  });

  /**
   * `permissions` is required on the repository schema GitHub documents for `/user/repos` but
   * optional on the minimal-repository schema sibling listings return, and the API base URL is
   * configurable — so a forge that says nothing must be reported as having said nothing. The
   * listing still succeeds, and the one thing that must never happen is a fabricated `canPush`.
   */
  it.each([
    ['no permissions object at all', {}],
    ['a permissions object without push', { permissions: { pull: true } }],
  ])('reports an unstated push permission as unknown, not as writable (%s)', async (_l, extra) => {
    const { deps } = harness(() =>
      jsonResponse([
        { ...GITHUB_REPO, permissions: { push: true } },
        { ...GITHUB_REPO, full_name: 'acme/silent', ...extra },
      ]),
    );

    const { repos } = await createGithubClient(deps).listRepos('');

    // The stated one is answered, so the silent one's absence is the absence of a claim rather
    // than a client that reads no permissions at all.
    expect(repos[0]?.canPush).toBe(true);
    expect(repos[1]?.canPush).toBeUndefined();
    expect(Object.hasOwn(repos[1] ?? {}, 'canPush')).toBe(false);
  });

  /**
   * An unreported `archived` is reported as unreported. Defaulting it to `false` — which GitHub
   * does document as the default — would state on a lean forge's behalf something it never said,
   * and the value it would state is the permissive one.
   */
  it('reports an unstated archived flag as unknown, not as not-archived', async () => {
    const { deps } = harness(() => jsonResponse([{ ...GITHUB_REPO, permissions: { push: true } }]));

    const { repos } = await createGithubClient(deps).listRepos('');

    expect(repos[0]?.archived).toBeUndefined();
    expect(Object.hasOwn(repos[0] ?? {}, 'archived')).toBe(false);
  });

  /**
   * Guard for the field that reads as proof and is not: GitHub reports the configured default
   * branch name from the moment a repository is created and only creates the ref on the first
   * push, so a repository with no commits is indistinguishable here from one with a hundred.
   * Nothing may infer from this field that a repository can be cloned.
   */
  it('reports a default branch name without vouching for the ref', async () => {
    const { deps } = harness(() =>
      jsonResponse([{ ...GITHUB_REPO, permissions: { push: true }, default_branch: 'main' }]),
    );

    const { repos } = await createGithubClient(deps).listRepos('');

    expect(repos[0]?.defaultBranch).toBe('main');
  });
});

describe('truncation', () => {
  /**
   * A walk that reached the end of the account is complete and says so. This is the value the
   * picker's note depends on before it may claim the list is the token's whole reach.
   */
  it('reports a completed walk as not truncated', async () => {
    const { deps, logOutput } = harness(() => jsonResponse([GITHUB_REPO]));

    const { truncated } = await createGithubClient(deps).listRepos('');

    expect(truncated).toBe(false);
    // And says nothing about a limit it never reached. The warning is what an operator reads as
    // "this account has more repositories than the picker shows"; written after every ordinary
    // listing, it would say that of every account.
    expect(logOutput()).not.toContain('github listing stopped at the page limit');
  });

  /**
   * Truncation travels with the result rather than only reaching the log, because the search runs
   * over what was read: a repository past the limit is reported as no match, and no caller could
   * tell that from an empty array. The query here filters everything away precisely to show the
   * filter cannot mask the flag.
   */
  it('reports truncation even when the query filters every repository away', async () => {
    const { deps } = harness(() =>
      jsonResponse([GITHUB_REPO], 200, nextLink(`${BASE_URL}/user/repos?page=next`)),
    );

    const { repos, truncated } = await createGithubClient(deps).listRepos('nothing-matches-this');

    expect(repos).toHaveLength(0);
    expect(truncated).toBe(true);
  });

  /**
   * Branches paginate through the same walk but do not surface truncation: it would mean a
   * repository with more than a thousand branches, and the branch picker makes no claim about its
   * own completeness for a flag to correct. The walk still stops, and still returns what it read.
   */
  it('still returns branches from a walk that stopped at the page limit', async () => {
    const { deps } = harness(() =>
      jsonResponse([GITHUB_BRANCH], 200, nextLink(`${BASE_URL}/repos/acme/widgets/branches?p=2`)),
    );

    const branches = await createGithubClient(deps).listBranches('acme/widgets');

    expect(branches).toHaveLength(GITHUB_MAX_PAGES);
  });
});
