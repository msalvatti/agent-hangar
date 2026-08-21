/**
 * MSW handlers for the repository/branch picker routes.
 *
 * Layer: mock (handler).
 */
import { apiError, listBranchesQuery, listReposQuery, routes } from '@agent-hangar/core';
import { http, HttpResponse } from 'msw';

import { store } from './store';

/** `GET /api/repos?query=` — repos the PAT can access, filtered by a case-insensitive substring. */
const listRepos = http.get(routes.repos, ({ request }) => {
  const url = new URL(request.url);
  const parsed = listReposQuery.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return HttpResponse.json(
      apiError.parse({ error: { code: 'VALIDATION', message: parsed.error.message } }),
      { status: 400 },
    );
  }
  const query = parsed.data.query?.trim().toLowerCase();
  const repos =
    query === undefined || query.length === 0
      ? store.repos
      : store.repos.filter((repo) => repo.fullName.toLowerCase().includes(query));
  return HttpResponse.json({ repos });
});

/** `GET /api/repos/branches?repo=` — branches of one repo, in the forge's own order. */
const listBranches = http.get(routes.repoBranches, ({ request }) => {
  const url = new URL(request.url);
  const parsed = listBranchesQuery.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return HttpResponse.json(
      apiError.parse({ error: { code: 'VALIDATION', message: parsed.error.message } }),
      { status: 400 },
    );
  }
  const { repo: repoName } = parsed.data;
  const repo = store.repos.find((entry) => entry.fullName === repoName);
  const branches = store.branches[repoName];
  if (repo === undefined || branches === undefined) {
    return HttpResponse.json(
      apiError.parse({ error: { code: 'NOT_FOUND', message: 'Unknown repository' } }),
      {
        status: 404,
      },
    );
  }
  // Handed back exactly as the store holds it. The real route forwards whatever the forge sent and
  // sorts nothing, so a double that lifted the default branch to the front would answer a question
  // production never answers that way — and every caller tested against it would be tested against
  // a listing that cannot go wrong.
  return HttpResponse.json({ branches });
});

/** Handlers for `GET /api/repos` and `GET /api/repos/branches`. */
export const repoHandlers = [listRepos, listBranches];
