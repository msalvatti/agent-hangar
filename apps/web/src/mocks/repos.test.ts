/**
 * Tests for the repo/branch picker mock handlers: response shapes, filtering, and error paths.
 */
import { branchSummary, listBranchesResponse, listReposResponse } from '@agent-hangar/core';
import { describe, expect, it } from 'vitest';

describe('GET /api/repos', () => {
  // The response satisfies the contract schema.
  it('returns a response that satisfies listReposResponse', async () => {
    const response = await fetch('/api/repos');
    expect(response.status).toBe(200);
    const body = listReposResponse.parse(await response.json());
    expect(body.repos.map((repo) => repo.fullName)).toContain('acme/api');
  });

  /**
   * Rule this protects: the fixture set must span more than one forge. Which origins the listing
   * may report is the operator's `ALLOWED_REPO_HOSTS`, so a mock that only ever answers with
   * github.com URLs cannot catch a client that rebuilds the clone URL against a hard-coded host.
   */
  it('reports a repository hosted somewhere other than github.com', async () => {
    const response = await fetch('/api/repos');
    const body = listReposResponse.parse(await response.json());
    const origins = new Set(body.repos.map((repo) => new URL(repo.url).origin));
    expect(origins.size).toBeGreaterThan(1);
    expect(body.repos.map((repo) => repo.url)).toContain('https://git.acme.test/acme/infra');
  });

  // A query filters repos by a case-insensitive substring of fullName.
  it('filters by a case-insensitive substring of the query', async () => {
    const response = await fetch('/api/repos?query=WEB');
    const body = listReposResponse.parse(await response.json());
    expect(body.repos).toHaveLength(1);
    expect(body.repos[0]?.fullName).toBe('acme/web');
  });

  // A query matching nothing returns an empty list, not an error.
  it('returns an empty list when nothing matches', async () => {
    const response = await fetch('/api/repos?query=nonexistent');
    const body = listReposResponse.parse(await response.json());
    expect(body.repos).toHaveLength(0);
  });

  // A query over the contract's max length is a 400 validation error.
  it('400s when the query exceeds the max length', async () => {
    const response = await fetch(`/api/repos?query=${'a'.repeat(201)}`);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION');
  });
});

describe('GET /api/repos/branches', () => {
  /**
   * Rule this protects: the double answers with the forge's own order and sorts nothing.
   *
   * The real route hands back whatever the GitHub client read, and GitHub lists branches
   * alphabetically — so `agent/k3x9` comes before `main` and the repository's default branch is
   * last. A double that lifted the default to the front would let anything reading position zero
   * look correct here and pin a schedule to a throwaway work branch in production, which is the
   * defect this fixture exists to be able to reproduce.
   */
  it('returns branches in the forge order, default branch not first', async () => {
    const response = await fetch('/api/repos/branches?repo=acme/api');
    expect(response.status).toBe(200);
    const body = listBranchesResponse.parse(await response.json());
    expect(body.branches.map((branch) => branch.name)).toEqual(['agent/k3x9', 'develop', 'main']);
  });

  // Every branch satisfies branchSummary on its own too (defence against a partial mock shape).
  it('every branch satisfies branchSummary', async () => {
    const response = await fetch('/api/repos/branches?repo=acme/api');
    const body = listBranchesResponse.parse(await response.json());
    for (const branch of body.branches) {
      expect(() => branchSummary.parse(branch)).not.toThrow();
    }
  });

  // Missing the required repo query param is a 400.
  it('400s when repo is missing', async () => {
    const response = await fetch('/api/repos/branches');
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION');
  });

  // An unknown repo is a 404.
  it('404s for an unknown repo', async () => {
    const response = await fetch('/api/repos/branches?repo=acme/ghost');
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });
});
