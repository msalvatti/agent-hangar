/**
 * Stub of the GitHub REST endpoints the repository picker calls, answering with repositories that
 * live on the local git server.
 *
 * Layer: test support.
 *
 * The suite must never reach github.com: a run would then depend on a network, on a real token
 * and on somebody else's rate limit. The stub answers the three endpoints the picker uses and
 * rewrites every repository URL to the git server the workspace containers can actually clone
 * from, so choosing a repository in the UI and cloning it in a container describe the same thing.
 *
 * Routing is a pure function over already-parsed request parts, which is what the unit tests
 * exercise; the HTTP wrapper around it only translates between sockets and that function.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { LOOPBACK } from './constants';

/** Statuses the stub answers with, named so a reply reads as an outcome rather than a number. */
const STATUS = { ok: 200, unauthorized: 401, notFound: 404 } as const;

/** Token shape the stub accepts, matching a GitHub classic PAT. */
const BEARER_TOKEN = /^Bearer ghp_[A-Za-z0-9]+$/u;

/** `/repos/<owner>/<repo>` and `/repos/<owner>/<repo>/branches`. */
const REPO_PATH = /^\/repos\/([^/]+)\/([^/]+)(\/branches)?$/u;

/** Path listing the repositories the token can see. */
const USER_REPOS_PATH = '/user/repos';

/** Suffix a clone URL carries. */
const GIT_SUFFIX = '.git';

/** GitHub repository payload, narrowed to the fields the web maps. */
const githubRepo = z.object({
  id: z.number().int(),
  name: z.string().min(1),
  full_name: z.string().min(1),
  private: z.boolean(),
  html_url: z.string().min(1),
  clone_url: z.string().min(1),
  default_branch: z.string().min(1),
  description: z.string().nullable(),
  pushed_at: z.string().min(1),
  owner: z.object({ login: z.string().min(1) }),
});

/** One repository as the stub serves it. */
export type GithubRepo = z.infer<typeof githubRepo>;

/** GitHub branch payload. */
const githubBranch = z.object({
  name: z.string().min(1),
  commit: z.object({ sha: z.string().min(1) }),
  protected: z.boolean(),
});

/** One branch as the stub serves it. */
export type GithubBranch = z.infer<typeof githubBranch>;

/** Fixture files, before their URLs are pointed at the git server. */
const githubFixtures = z.object({
  repos: z.array(githubRepo),
  branches: z.record(z.string(), z.array(githubBranch)),
});

/** Repositories and their branches, keyed by `owner/name`. */
export type GithubFixtures = z.infer<typeof githubFixtures>;

/** What {@link routeGithubRequest} decided. */
export interface StubReply {
  status: number;
  body: unknown;
}

/**
 * Reads the fixture files.
 *
 * Branch SHAs are the ones the seed script produces today; nothing verifies them against the
 * repository, they only have to be stable so the picker renders the same rows on every run.
 *
 * @param directory - Folder holding `repos.json` and `branches.json`.
 * @returns The parsed fixtures.
 * @throws Error when a file is missing or does not match the expected shape.
 */
export function loadGithubFixtures(directory: string): GithubFixtures {
  const read = (name: string): unknown => JSON.parse(readFileSync(`${directory}/${name}`, 'utf8'));
  return githubFixtures.parse({ repos: read('repos.json'), branches: read('branches.json') });
}

/**
 * Folder holding the fixtures shipped with the suite.
 *
 * Derived from this file's location with `node:path` rather than a `new URL` against
 * `import.meta.url`, which the bundler rewrites as an asset reference.
 */
export function defaultFixturesDirectory(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'github');
}

/**
 * Points every repository URL at the local git server.
 *
 * @param fixtures - Fixtures as read from disk.
 * @param repoBaseUrl - Origin of the git server, without a trailing slash.
 * @returns Fixtures whose `html_url` and `clone_url` name the git server.
 */
export function rewriteRepoUrls(fixtures: GithubFixtures, repoBaseUrl: string): GithubFixtures {
  const base = repoBaseUrl.replace(/\/+$/u, '');
  return {
    branches: fixtures.branches,
    repos: fixtures.repos.map((repo) => ({
      ...repo,
      // `full_name`, not `name`: a repository URL carries its owner, and the git server serves
      // the same owner-and-repository path.
      html_url: `${base}/${repo.full_name}${GIT_SUFFIX}`,
      clone_url: `${base}/${repo.full_name}${GIT_SUFFIX}`,
    })),
  };
}

/**
 * Answers one request.
 *
 * @param method - HTTP method.
 * @param pathname - Path without its query string.
 * @param authorization - Value of the `Authorization` header, or `undefined`.
 * @param fixtures - Fixtures with URLs already rewritten.
 * @returns The status and JSON body to send.
 */
export function routeGithubRequest(
  method: string,
  pathname: string,
  authorization: string | undefined,
  fixtures: GithubFixtures,
): StubReply {
  if (authorization === undefined || !BEARER_TOKEN.test(authorization)) {
    return { status: STATUS.unauthorized, body: { message: 'Bad credentials' } };
  }
  const notFound: StubReply = { status: STATUS.notFound, body: { message: 'Not Found' } };
  if (method !== 'GET') {
    return notFound;
  }
  if (pathname === USER_REPOS_PATH) {
    return { status: STATUS.ok, body: fixtures.repos };
  }
  const match = REPO_PATH.exec(pathname);
  if (match === null) {
    return notFound;
  }
  const fullName = `${String(match[1])}/${String(match[2])}`;
  const repo = fixtures.repos.find((candidate) => candidate.full_name === fullName);
  if (repo === undefined) {
    return notFound;
  }
  if (match[3] === undefined) {
    return { status: STATUS.ok, body: repo };
  }
  const branches = fixtures.branches[fullName];
  return branches === undefined ? notFound : { status: STATUS.ok, body: branches };
}

/** One request the stub answered, for assertions on what the web actually called. */
export interface RecordedRequest {
  method: string;
  path: string;
  authorized: boolean;
}

/** A running stub. */
export interface GithubStub {
  /** Origin the web server should use as its GitHub API base URL. */
  baseUrl: string;
  /** Every request answered, in order. */
  requests: RecordedRequest[];
  /** Stops listening. */
  close(): Promise<void>;
}

/** Options of {@link startGithubStub}. */
export interface GithubStubOptions {
  /** Port to listen on; `0` picks a free one, which the returned `baseUrl` names. */
  port: number;
  /** Origin of the git server every repository URL is rewritten to. */
  repoBaseUrl: string;
  /** Folder holding the fixtures; defaults to the suite's own. */
  fixturesDirectory?: string;
}

/**
 * Normalises the parts of an incoming request the router needs.
 *
 * Node types both fields as optional, so the defaults are real code paths rather than decoration.
 *
 * @param method - `request.method`.
 * @param url - `request.url`, path and query together.
 * @returns The method and the path without its query string.
 */
export function stubRequestParts(
  method: string | undefined,
  url: string | undefined,
): { method: string; pathname: string } {
  const target = url ?? '/';
  const [pathname = '/'] = target.split('?', 1);
  return { method: method ?? 'GET', pathname };
}

/**
 * Port a listening server ended up on.
 *
 * `address()` also answers with a pipe name or `null`, neither of which names a port; the port the
 * caller asked for is then the best available answer.
 *
 * @param address - Value of `server.address()`.
 * @param fallback - Port the server was asked to listen on.
 * @returns The port to build the base URL from.
 */
export function resolvePort(address: ReturnType<Server['address']>, fallback: number): number {
  return address === null || typeof address === 'string' ? fallback : address.port;
}

function handle(
  request: IncomingMessage,
  response: ServerResponse,
  fixtures: GithubFixtures,
  requests: RecordedRequest[],
): void {
  const { method, pathname } = stubRequestParts(request.method, request.url);
  const reply = routeGithubRequest(method, pathname, request.headers.authorization, fixtures);
  requests.push({ method, path: pathname, authorized: reply.status !== STATUS.unauthorized });
  response.writeHead(reply.status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(reply.body));
}

/**
 * Starts the stub.
 *
 * @param options - Port, git-server origin and optional fixture folder.
 * @returns A handle carrying the base URL, the recorded requests and a `close`.
 */
export async function startGithubStub(options: GithubStubOptions): Promise<GithubStub> {
  const fixtures = rewriteRepoUrls(
    loadGithubFixtures(options.fixturesDirectory ?? defaultFixturesDirectory()),
    options.repoBaseUrl,
  );
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    handle(request, response, fixtures, requests);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, LOOPBACK, resolve);
  });
  return {
    baseUrl: `http://${LOOPBACK}:${String(resolvePort(server.address(), options.port))}`,
    requests,
    close: async (): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
            return;
          }
          reject(error);
        });
      });
    },
  };
}
