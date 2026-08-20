/**
 * Repository and branch pickers, backed by the GitHub REST API.
 *
 * Layer: service (server).
 *
 * Both routes are reads and neither takes a body; the stored token is used inside the GitHub
 * client and never reaches this module, so nothing here can log or echo it. The listing is cached
 * privately for half a minute: the picker refetches on every keystroke, and a user's repository
 * list is not something a shared cache may hold.
 */
import {
  listBranchesQuery,
  listBranchesResponse,
  listReposQuery,
  listReposResponse,
} from '@agent-hangar/core';

import type { ServerContainer } from '../container';
import { jsonResponse, parseQuery, withErrorHandling } from '../http';

/** Cache policy of the repository listing. */
export const REPOS_CACHE_CONTROL = 'private, max-age=30';

/**
 * `GET /api/repos?query=` — repositories the stored token can reach.
 *
 * @param container - The server container.
 * @param request - The incoming request.
 * @returns `200` with the matching repositories.
 */
export function listRepos(container: ServerContainer, request: Request): Promise<Response> {
  return withErrorHandling(container, async () => {
    const query = parseQuery(request.url, listReposQuery);
    const repos = await container.github.listRepos(query.query ?? '');
    return jsonResponse(
      listReposResponse,
      { repos },
      { headers: { 'Cache-Control': REPOS_CACHE_CONTROL } },
    );
  });
}

/**
 * `GET /api/repos/branches?repo=` — branches of one repository.
 *
 * @param container - The server container.
 * @param request - The incoming request.
 * @returns `200` with the branches.
 */
export function listBranches(container: ServerContainer, request: Request): Promise<Response> {
  return withErrorHandling(container, async () => {
    const query = parseQuery(request.url, listBranchesQuery);
    const branches = await container.github.listBranches(query.repo);
    return jsonResponse(
      listBranchesResponse,
      { branches },
      { headers: { 'Cache-Control': REPOS_CACHE_CONTROL } },
    );
  });
}
