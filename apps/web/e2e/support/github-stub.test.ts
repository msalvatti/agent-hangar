/**
 * Unit tests for the GitHub REST stub: its routing table, its fixtures and one live round trip.
 *
 * Layer: unit test.
 */
import { GITHUB_CANARY } from '@agent-hangar/core/testing';
import { http, passthrough } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { server } from '@/mocks/server';

import {
  defaultFixturesDirectory,
  loadGithubFixtures,
  rewriteRepoUrls,
  resolvePort,
  routeGithubRequest,
  startGithubStub,
  stubRequestParts,
} from './github-stub';
import type { GithubStub } from './github-stub';

/** Authorisation header the stub accepts; the canary is the only credential-shaped
 * string allowed anywhere in the repository. */
const TOKEN = `Bearer ${GITHUB_CANARY}`;
const GIT_SERVER = 'http://host.docker.internal:3907';

/** Any loopback origin, whatever port the stub was given. */
const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:\d+\//u;

const fixtures = rewriteRepoUrls(loadGithubFixtures(defaultFixturesDirectory()), GIT_SERVER);

describe('loadGithubFixtures', () => {
  /** Both repositories are present, with the fields the web maps into its own contract. */
  it('reads both repositories and their branches', () => {
    expect(fixtures.repos.map((repo) => repo.full_name)).toEqual(['e2e/sample', 'e2e/other']);
    expect(fixtures.branches['e2e/sample']?.map((branch) => branch.name)).toEqual([
      'main',
      'feature/docs',
    ]);
  });

  /** A missing fixture folder must fail loudly rather than serve an empty picker. */
  it('throws when the fixtures are missing', () => {
    expect(() => loadGithubFixtures('/nonexistent/github')).toThrow();
  });
});

describe('rewriteRepoUrls', () => {
  /** Every repository URL points at the git server, which is what a container can clone. */
  it('points every repository at the git server', () => {
    for (const repo of fixtures.repos) {
      expect(repo.clone_url).toBe(`${GIT_SERVER}/${repo.name}.git`);
      expect(repo.html_url).toBe(`${GIT_SERVER}/${repo.name}.git`);
    }
  });

  /** A trailing slash on the base URL must not produce a double slash in the clone URL. */
  it('tolerates a trailing slash on the base URL', () => {
    const rewritten = rewriteRepoUrls(fixtures, `${GIT_SERVER}/`);
    expect(rewritten.repos[0]?.clone_url).toBe(`${GIT_SERVER}/sample.git`);
  });
});

describe('routeGithubRequest', () => {
  /** Without a token the stub answers as GitHub does, so the failure path is exercisable. */
  it('refuses a request with no Authorization header', () => {
    expect(routeGithubRequest('GET', '/user/repos', undefined, fixtures)).toEqual({
      status: 401,
      body: { message: 'Bad credentials' },
    });
  });

  /** A token that is not a GitHub personal access token is refused too. */
  it('refuses a token of the wrong shape', () => {
    expect(routeGithubRequest('GET', '/user/repos', 'Bearer not-a-token', fixtures).status).toBe(
      401,
    );
    expect(
      routeGithubRequest('GET', '/user/repos', `token ${GITHUB_CANARY}`, fixtures).status,
    ).toBe(401);
  });

  /** The repository list is what the picker renders. */
  it('lists the repositories', () => {
    const reply = routeGithubRequest('GET', '/user/repos', TOKEN, fixtures);
    expect(reply.status).toBe(200);
    expect(reply.body).toBe(fixtures.repos);
  });

  /** The repository detail carries the default branch the picker preselects. */
  it('returns one repository', () => {
    const reply = routeGithubRequest('GET', '/repos/e2e/sample', TOKEN, fixtures);
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ full_name: 'e2e/sample', default_branch: 'main' });
  });

  /** The branch list is what the branch picker renders. */
  it('returns the branches of one repository', () => {
    const reply = routeGithubRequest('GET', '/repos/e2e/sample/branches', TOKEN, fixtures);
    expect(reply.status).toBe(200);
    expect(reply.body).toBe(fixtures.branches['e2e/sample']);
  });

  /** An unknown repository is a 404, not an empty list that reads like success. */
  it('answers 404 for an unknown repository', () => {
    expect(routeGithubRequest('GET', '/repos/e2e/ghost', TOKEN, fixtures).status).toBe(404);
    expect(routeGithubRequest('GET', '/repos/e2e/ghost/branches', TOKEN, fixtures).status).toBe(
      404,
    );
  });

  /** A repository with no branch fixture is a 404 rather than an undefined body. */
  it('answers 404 when a known repository has no branch fixture', () => {
    const withoutBranches = { repos: fixtures.repos, branches: {} };
    expect(
      routeGithubRequest('GET', '/repos/e2e/sample/branches', TOKEN, withoutBranches).status,
    ).toBe(404);
  });

  /** Any other path, and any write, is refused. */
  it('answers 404 for anything else', () => {
    expect(routeGithubRequest('GET', '/user', TOKEN, fixtures).status).toBe(404);
    expect(routeGithubRequest('POST', '/user/repos', TOKEN, fixtures).status).toBe(404);
  });
});

describe('startGithubStub', () => {
  let stub: GithubStub | undefined;

  beforeEach(() => {
    // The suite-wide mock server rejects any request it has no handler for; the stub under test
    // listens on a real loopback port and must be reached, not intercepted. A pattern rather than
    // a path string, because the port is chosen at listen time and a wildcard port is not a valid
    // path template.
    server.use(http.all(LOOPBACK_ORIGIN, () => passthrough()));
  });

  afterEach(async () => {
    await stub?.close();
    stub = undefined;
  });

  /**
   * Proves the stub really listens: an authorised request over HTTP returns the rewritten
   * repositories, an unauthorised one is refused, and both are recorded with their outcome.
   */
  it('answers over HTTP and records every request', async () => {
    stub = await startGithubStub({ port: 0, repoBaseUrl: GIT_SERVER });

    const authorized = await fetch(`${stub.baseUrl}/user/repos`, {
      headers: { authorization: TOKEN },
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual(fixtures.repos);

    const refused = await fetch(`${stub.baseUrl}/user/repos`);
    expect(refused.status).toBe(401);

    const unknown = await fetch(`${stub.baseUrl}/nope?x=1`, { headers: { authorization: TOKEN } });
    expect(unknown.status).toBe(404);

    expect(stub.requests).toEqual([
      { method: 'GET', path: '/user/repos', authorized: true },
      { method: 'GET', path: '/user/repos', authorized: false },
      { method: 'GET', path: '/nope', authorized: true },
    ]);
  });
});

describe('stubRequestParts', () => {
  /** A path with a query string routes on the path alone. */
  it('drops the query string', () => {
    expect(stubRequestParts('GET', '/user/repos?page=2')).toEqual({
      method: 'GET',
      pathname: '/user/repos',
    });
  });

  /** Node types both fields as optional; the defaults keep the router from seeing `undefined`. */
  it('defaults a missing method and URL', () => {
    expect(stubRequestParts(undefined, undefined)).toEqual({ method: 'GET', pathname: '/' });
  });
});

describe('resolvePort', () => {
  /** A TCP server reports the port it settled on, which is what an ephemeral port needs. */
  it('reads the port from a TCP address', () => {
    expect(resolvePort({ address: '127.0.0.1', family: 'IPv4', port: 4321 }, 1)).toBe(4321);
  });

  /** Neither a pipe name nor a missing address names a port; the requested one stands in. */
  it('falls back when the address names no port', () => {
    expect(resolvePort(null, 7)).toBe(7);
    expect(resolvePort('/tmp/sock', 7)).toBe(7);
  });
});

describe('startGithubStub failure paths', () => {
  /** A caller may point the stub at its own fixtures; a missing folder must fail the start. */
  it('fails to start when the fixture folder does not exist', async () => {
    await expect(
      startGithubStub({ port: 0, repoBaseUrl: GIT_SERVER, fixturesDirectory: '/nonexistent' }),
    ).rejects.toThrow();
  });

  /** A port already in use must reject rather than leave the caller with a dead base URL. */
  it('rejects when the port is already taken', async () => {
    const first = await startGithubStub({ port: 0, repoBaseUrl: GIT_SERVER });
    const port = Number(new URL(first.baseUrl).port);
    try {
      await expect(startGithubStub({ port, repoBaseUrl: GIT_SERVER })).rejects.toThrow();
    } finally {
      await first.close();
    }
  });

  /** Closing twice surfaces the second failure rather than resolving as if it had worked. */
  it('rejects when the server is already closed', async () => {
    const stub = await startGithubStub({ port: 0, repoBaseUrl: GIT_SERVER });
    await stub.close();
    await expect(stub.close()).rejects.toThrow();
  });
});
