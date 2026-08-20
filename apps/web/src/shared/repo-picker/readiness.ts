/**
 * One answer to a single question — can the agent actually work in this repository? — shared by
 * the repository and branch pickers.
 *
 * Layer: shared (lib).
 *
 * Three separate facts make a repository less than fully usable, and they are deliberately
 * funnelled through one function rather than three conditions spread over two components: the
 * token has no write access, the forge has archived the repository, or the repository has no
 * commits at all. Each of them ends the same way today — a turn that cannot push, or a send button
 * that never enables — and a user only ever needs to be told which one it is and what changes it.
 *
 * The three facts do not all arrive at the same moment, which is why {@link RepoFacts} lets a
 * caller supply only what it knows. Write access and the archived flag come from the repository
 * listing. Whether any commit exists does not, and cannot: measured against the live API, a
 * repository with no refs at all and a repository with one branch both report a `size` of 0, a
 * non-null `pushed_at` one second after `created_at`, and a `default_branch` of `main`. Neither
 * `size` nor `pushed_at` separates them, so no field of the listing can stand in for the evidence,
 * and asking the branches endpoint per row would turn one listing into one request per repository.
 * The direct evidence is an empty branch listing, which the branch picker already fetches for the
 * chosen repository — so emptiness is answered there, at no extra request, one click after the
 * repository is chosen instead of one turn later.
 */
import type { RepoSummary } from '@agent-hangar/core';

/** Everything a caller knows about one repository at the moment it asks. */
export interface RepoFacts {
  /** `repoSummary.access`: what the token may do, or absent when the forge did not report it. */
  access?: RepoSummary['access'];
  /**
   * Whether the repository has at least one branch, or absent before a branch listing has
   * answered. Only the branch listing can supply this — see the module note.
   */
  hasBranches?: boolean | undefined;
}

/**
 * What the agent can do with a repository.
 *
 * `ready` and `unknown` are kept apart on purpose: the first is a forge that said the token may
 * push, the second is a forge that said nothing. Both render without a warning — a badge on every
 * row would be read as decoration — but nothing here may turn that silence into permission.
 */
export type RepoReadinessLevel = 'ready' | 'unknown' | 'limited' | 'blocked';

/** What the agent can do with one repository, and how to say so. */
export interface RepoReadiness {
  /** `ready`/`unknown` need no warning; `limited` cannot be pushed to; `blocked` cannot be used. */
  level: RepoReadinessLevel;
  /** Badge text, or `null` when there is nothing to warn about. */
  label: string | null;
  /** One sentence: what is wrong and what changes it, or `null` when nothing is. */
  reason: string | null;
}

/** Nothing to say: the token may push, or the forge did not say either way. */
const NO_WARNING = { label: null, reason: null } as const;

/** A repository with no commits, and so no ref any clone could name. */
const NO_COMMITS: RepoReadiness = {
  level: 'blocked',
  label: 'No commits yet',
  reason:
    'This repository has no commits, so it has no branches to work from. Push a first commit, then choose it here.',
};

/** A repository the forge has archived, which rejects every write from everybody. */
const ARCHIVED: RepoReadiness = {
  level: 'limited',
  label: 'Archived',
  reason:
    'This repository is archived. The agent can read it and answer questions about it, but nothing can be pushed back until it is unarchived on the forge.',
};

/** A repository the stored token may read but not write. */
const READ_ONLY: RepoReadiness = {
  level: 'limited',
  label: 'Read-only',
  reason:
    'The stored token has read access only. The agent can read this repository and answer questions about it, but cannot push a branch back — widen the token’s repository access in Settings to allow that.',
};

/**
 * What determines which repositories are listed at all, shown beneath every listing.
 *
 * A picker that answers "no results" to somebody who is certain the repository exists tells them
 * nothing they can act on. The list is the token's reach, so the sentence names the token.
 */
export const REPO_LIST_SCOPE_NOTE =
  'This list is exactly what the stored GitHub token can reach. A fine-grained token only reports the repositories it was granted, so a repository that is missing has to be added to the token’s repository access in Settings.';

/**
 * Decides what the agent can do with one repository, from whatever is known about it.
 *
 * The order is the order the answers matter in. A repository with no commits cannot be worked in
 * at all, whatever the token may do with it, so it is answered first; being archived is reported
 * ahead of a read-only token because unarchiving is what would change it and a wider token would
 * not.
 *
 * @param facts - What the caller knows: the reported access, and whether any branch exists.
 * @returns The readiness, carrying a badge label and a one-sentence reason when there is one.
 */
export function repoReadiness(facts: RepoFacts): RepoReadiness {
  if (facts.hasBranches === false) {
    return NO_COMMITS;
  }
  if (facts.access === undefined) {
    return { level: 'unknown', ...NO_WARNING };
  }
  if (facts.access.archived) {
    return ARCHIVED;
  }
  if (!facts.access.canPush) {
    return READ_ONLY;
  }
  return { level: 'ready', ...NO_WARNING };
}
