/**
 * Branch list for {@link BranchPicker}, enabled only once a repository is chosen.
 *
 * Layer: shared (hook).
 */
'use client';

import { apiFetch } from '@/shared/api/client';
import { useApiQuery } from '@/shared/api/use-api-query';
import type { UseApiQueryResult } from '@/shared/api/use-api-query';

function listBranchesCall(repo: string, signal: AbortSignal) {
  return apiFetch('listBranches', { query: { repo }, signal });
}

/**
 * Branches of `repo`, from `GET /api/repos/branches`. Disabled (stays `idle`) while `repo` is
 * `null`.
 *
 * @param repo - The repository's `fullName`, or `null` before one is chosen.
 * @returns The query result: status/data/error/refetch.
 */
export function useBranches(
  repo: string | null,
): UseApiQueryResult<Awaited<ReturnType<typeof listBranchesCall>>> {
  // The empty string stands in for a repository that has not been chosen, and the query is
  // disabled until one is — so it names a key nothing fetches under and reaches no request.
  // Stryker disable StringLiteral
  return useApiQuery(['branches', repo ?? ''], (signal) => listBranchesCall(repo ?? '', signal), {
    enabled: repo !== null,
  });
  // Stryker restore StringLiteral
}
