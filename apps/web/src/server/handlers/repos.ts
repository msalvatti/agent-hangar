/**
 * Repository and branch pickers, backed by the GitHub REST API.
 *
 * Layer: service (server).
 *
 * Both routes are reads and neither takes a body; the stored token is used inside the GitHub
 * client and never reaches this module, so nothing here can log or echo it. The listing is cached
 * privately for half a minute: the picker refetches on every keystroke, and a user's repository
 * list is not something a shared cache may hold.
 *
 * These are the two reads that carry an origin guard, and the reason is not confidentiality. Every
 * call here spends the user's forge rate limit — several times over, because each listing follows
 * the upstream's pagination — and same-origin policy stops a hostile page reading the answer, not
 * issuing the request. Without the guard a page the user merely visits could fire `no-cors` reads
 * with unique query values and drain the budget their own token is paying for, costing them access
 * to the forge from the app itself. The browser cache does not help: distinct query values are
 * distinct entries, and it is the user's own cache in any case.
 *
 * The guard is {@link assertNoForeignOrigin}, which refuses a request that names another origin or
 * site rather than demanding proof of this one; a same-origin `GET` is not obliged to send either
 * header, so the stricter guard the writes carry would refuse the picker's own requests. A caller
 * that labels nothing therefore still reaches the forge, and nothing here bounds how often — the
 * limit is stated in `../same-origin.ts` rather than implied.
 */
import {
  listBranchesQuery,
  listBranchesResponse,
  listReposQuery,
  listReposResponse,
} from '@agent-hangar/core';

import type { ServerContainer } from '../container';
import { jsonResponse, parseQuery, withErrorHandling } from '../http';
import { assertNoForeignOrigin } from '../same-origin';

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
    assertNoForeignOrigin(request);
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
    assertNoForeignOrigin(request);
    const query = parseQuery(request.url, listBranchesQuery);
    const branches = await container.github.listBranches(query.repo);
    return jsonResponse(
      listBranchesResponse,
      { branches },
      { headers: { 'Cache-Control': REPOS_CACHE_CONTROL } },
    );
  });
}
