/** @vitest-environment node */
/**
 * Unit tests for the repository and branch pickers.
 *
 * Layer: unit.
 * Goal: the query reaches the GitHub client, the response satisfies its contract, and every
 * failure the client can raise maps to a status the picker can act on.
 * Mocks: the `bullmq` module; the GitHub client is the scripted stub of the test container.
 */
import { listBranchesResponse, listReposResponse } from '@agent-hangar/core';
import { describe, expect, it, vi } from 'vitest';

import { ApiHttpError, GithubApiError } from '../errors';
import { foreignReadRequest, readRequest } from '../testing/requests';
import { createTestContainer } from '../testing/test-container';

import { listBranches, listRepos, REPOS_CACHE_CONTROL } from './repos';

vi.mock('bullmq', () => import('../testing/fake-queue'));

/** One repository as the client reports it. */
const REPO = {
  fullName: 'acme/widgets',
  url: 'https://github.com/acme/widgets',
  defaultBranch: 'main',
  private: true,
  description: null,
};

describe('forge-backed reads and other origins', () => {
  /**
   * Every call to these routes spends the user's forge rate limit, several times over because the
   * listing follows the upstream's pagination. Same-origin policy stops a hostile page reading the
   * answer, not issuing the request, so a page the user merely visits could otherwise drain that
   * budget with `no-cors` reads. The rule this protects is that a request labelled as coming from
   * another site is refused before the token is spent — the assertion is on the forge not having
   * been called, not merely on the status.
   */
  it('refuses a labelled cross-site read without calling the forge', async () => {
    const { container, doubles } = createTestContainer();
    doubles.github.repos = [REPO];
    const listSpy = vi.spyOn(doubles.github, 'listRepos');
    const branchSpy = vi.spyOn(doubles.github, 'listBranches');

    const repos = await listRepos(container, foreignReadRequest('/api/repos?query=a'));
    const branches = await listBranches(
      container,
      foreignReadRequest('/api/repos/branches?repo=acme/widgets'),
    );

    expect(repos.status).toBe(403);
    expect(branches.status).toBe(403);
    expect(listSpy).not.toHaveBeenCalled();
    expect(branchSpy).not.toHaveBeenCalled();
  });

  /**
   * A request naming another origin outright is refused on that alone, so a caller that sets an
   * `Origin` but no `Sec-Fetch-Site` is covered too.
   */
  it('refuses a read that names another origin', async () => {
    const { container, doubles } = createTestContainer();
    const listSpy = vi.spyOn(doubles.github, 'listRepos');

    const response = await listRepos(
      container,
      new Request('http://127.0.0.1:3000/api/repos', {
        headers: { host: '127.0.0.1:3000', origin: 'http://evil.example' },
      }),
    );

    expect(response.status).toBe(403);
    expect(listSpy).not.toHaveBeenCalled();
  });

  /**
   * The guard refuses evidence of another site, not the absence of evidence. A same-origin `GET`
   * is not obliged to send either header, so the picker's own request — which carries neither —
   * has to keep working; demanding proof here would break the feature to close the hole.
   */
  it('serves a read that carries no origin headers at all', async () => {
    const { container, doubles } = createTestContainer();
    doubles.github.repos = [REPO];

    const response = await listRepos(container, readRequest('/api/repos'));

    expect(response.status).toBe(200);
  });
});

describe('listRepos', () => {
  /**
   * With no query every repository is returned, and the answer satisfies the contract the picker
   * parses it with.
   */
  it('lists every repository when no query is given', async () => {
    const { container, doubles } = createTestContainer();
    doubles.github.repos = [REPO, { ...REPO, fullName: 'other/thing' }];
    const response = await listRepos(container, readRequest('/api/repos'));
    expect(listReposResponse.parse(await response.json()).repos).toHaveLength(2);
  });

  /**
   * Whether the client reached the end of the account travels to the picker rather than stopping
   * at the server log. The picker's note claims the list is everything the token can reach, and a
   * listing that stopped at the page limit makes that claim false — and worse, sends the user to
   * change a token setting that would not bring the missing repository back.
   */
  it.each([
    ['a completed listing', false],
    ['a listing that stopped at the page limit', true],
  ])('forwards truncation to the picker for %s', async (_label, truncated) => {
    const { container, doubles } = createTestContainer();
    doubles.github.repos = [REPO];
    doubles.github.truncated = truncated;

    const response = await listRepos(container, readRequest('/api/repos'));

    expect(listReposResponse.parse(await response.json()).truncated).toBe(truncated);
  });

  /**
   * The query narrows the list, and the response is cached privately for a short while: the picker
   * refetches as the user types, and a user's repository list must never sit in a shared cache.
   */
  it('filters by the query and marks the response private', async () => {
    const { container, doubles } = createTestContainer();
    doubles.github.repos = [REPO, { ...REPO, fullName: 'other/thing' }];
    const response = await listRepos(container, readRequest('/api/repos?query=widg'));
    expect(response.headers.get('cache-control')).toBe(REPOS_CACHE_CONTROL);
    expect(listReposResponse.parse(await response.json()).repos).toHaveLength(1);
  });

  /**
   * With no token stored the client raises a conflict, which the UI turns into a link to Settings.
   */
  it('reports a missing token as a conflict', async () => {
    const { container, doubles } = createTestContainer();
    doubles.github.failure = new ApiHttpError(409, 'SECRETS_MISSING', 'not configured');
    const response = await listRepos(container, readRequest('/api/repos'));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'SECRETS_MISSING' } });
  });

  /**
   * A token GitHub rejects is an authentication problem the user can fix; anything else upstream is
   * a bad gateway, and neither response repeats GitHub's own text.
   */
  it('separates a rejected token from an upstream failure', async () => {
    const { container, doubles } = createTestContainer();
    doubles.github.failure = new GithubApiError(401, 'Bad credentials');
    const auth = await listRepos(container, readRequest('/api/repos'));
    expect(auth.status).toBe(401);
    expect(await auth.json()).toMatchObject({ error: { code: 'GITHUB_AUTH' } });

    doubles.github.failure = new GithubApiError(503, 'upstream text');
    const upstream = await listRepos(container, readRequest('/api/repos'));
    expect(upstream.status).toBe(502);
    expect(await upstream.text()).not.toContain('upstream text');
  });

  /**
   * A query longer than the contract allows is refused rather than forwarded.
   */
  it('rejects an over-long query', async () => {
    const { container } = createTestContainer();
    const response = await listRepos(container, readRequest(`/api/repos?query=${'x'.repeat(300)}`));
    expect(response.status).toBe(400);
  });
});

describe('listBranches', () => {
  /**
   * The branches of the named repository are returned in the contract's shape, `protected`
   * included, which is what lets the picker grey out a branch a task cannot target.
   */
  it('lists the branches of a repository', async () => {
    const { container, doubles } = createTestContainer();
    doubles.github.branches = [{ name: 'main', sha: 'a'.repeat(40), protected: true }];
    const response = await listBranches(
      container,
      readRequest('/api/repos/branches?repo=acme/widgets'),
    );
    const body = listBranchesResponse.parse(await response.json());
    expect(body.branches).toEqual([{ name: 'main', sha: 'a'.repeat(40), protected: true }]);
  });

  /**
   * The repository name is required: without it there is nothing to list, and a silent empty
   * answer would look like a repository with no branches.
   */
  it('requires the repo parameter', async () => {
    const { container } = createTestContainer();
    const response = await listBranches(container, readRequest('/api/repos/branches'));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });
});
