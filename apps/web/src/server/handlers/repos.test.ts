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

/**
 * Builds a read request.
 *
 * @param path - Path below the API root, query included.
 * @returns The request.
 */
function read(path: string): Request {
  return new Request(`http://127.0.0.1:3000${path}`);
}

describe('listRepos', () => {
  /**
   * With no query every repository is returned, and the answer satisfies the contract the picker
   * parses it with.
   */
  it('lists every repository when no query is given', async () => {
    const { container, doubles } = createTestContainer();
    doubles.github.repos = [REPO, { ...REPO, fullName: 'other/thing' }];
    const response = await listRepos(container, read('/api/repos'));
    expect(listReposResponse.parse(await response.json()).repos).toHaveLength(2);
  });

  /**
   * The query narrows the list, and the response is cached privately for a short while: the picker
   * refetches as the user types, and a user's repository list must never sit in a shared cache.
   */
  it('filters by the query and marks the response private', async () => {
    const { container, doubles } = createTestContainer();
    doubles.github.repos = [REPO, { ...REPO, fullName: 'other/thing' }];
    const response = await listRepos(container, read('/api/repos?query=widg'));
    expect(response.headers.get('cache-control')).toBe(REPOS_CACHE_CONTROL);
    expect(listReposResponse.parse(await response.json()).repos).toHaveLength(1);
  });

  /**
   * With no token stored the client raises a conflict, which the UI turns into a link to Settings.
   */
  it('reports a missing token as a conflict', async () => {
    const { container, doubles } = createTestContainer();
    doubles.github.failure = new ApiHttpError(409, 'SECRETS_MISSING', 'not configured');
    const response = await listRepos(container, read('/api/repos'));
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
    const auth = await listRepos(container, read('/api/repos'));
    expect(auth.status).toBe(401);
    expect(await auth.json()).toMatchObject({ error: { code: 'GITHUB_AUTH' } });

    doubles.github.failure = new GithubApiError(503, 'upstream text');
    const upstream = await listRepos(container, read('/api/repos'));
    expect(upstream.status).toBe(502);
    expect(await upstream.text()).not.toContain('upstream text');
  });

  /**
   * A query longer than the contract allows is refused rather than forwarded.
   */
  it('rejects an over-long query', async () => {
    const { container } = createTestContainer();
    const response = await listRepos(container, read(`/api/repos?query=${'x'.repeat(300)}`));
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
    const response = await listBranches(container, read('/api/repos/branches?repo=acme/widgets'));
    const body = listBranchesResponse.parse(await response.json());
    expect(body.branches).toEqual([{ name: 'main', sha: 'a'.repeat(40), protected: true }]);
  });

  /**
   * The repository name is required: without it there is nothing to list, and a silent empty
   * answer would look like a repository with no branches.
   */
  it('requires the repo parameter', async () => {
    const { container } = createTestContainer();
    const response = await listBranches(container, read('/api/repos/branches'));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });
});
