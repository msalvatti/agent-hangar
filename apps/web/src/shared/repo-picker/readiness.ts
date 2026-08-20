/**
 * One answer to a single question — can the agent actually work in this repository? — shared by
 * the repository and branch pickers.
 *
 * Layer: shared (lib).
 *
 * Three separate facts make a repository less than fully usable, and they are deliberately
 * funnelled through one function rather than three conditions spread over two components: the
 * token has no write access, the forge has archived the repository, or the repository has no
 * branch to work from. Each of them ends the same way today — a turn that cannot push, or a send
 * button that never enables — and a user only ever needs to be told which one it is and what
 * changes it.
 *
 * Every fact is optional and independent, and an absent one is never defaulted. Bundling any two
 * of them into a single answer loses information in both directions: a forge that states one and
 * not the other would have the stated one discarded, and the unstated one invented. So a fact the
 * forge did not report stays unreported all the way to the reader, which reports `unknown` rather
 * than guessing — including the case where the token may push but nothing said whether the
 * repository is archived.
 *
 * The facts also do not all arrive at the same moment. Write access and the archived flag come
 * from the repository listing. Whether a branch exists does not, and cannot: measured against the
 * live API, a repository with no refs at all and a repository with one branch both report a `size`
 * of 0, a non-null `pushed_at` one second after `created_at`, and a `default_branch` of `main`.
 * Neither `size` nor `pushed_at` separates them, so no field of the listing can stand in for the
 * evidence, and asking the branches endpoint per row would turn one listing into one request per
 * repository. The direct evidence is an empty branch listing, which the branch picker already
 * fetches for the chosen repository — so it is answered there, at no extra request, one click
 * after the repository is chosen instead of one turn later.
 */

/** Everything a caller knows about one repository at the moment it asks. */
export interface RepoFacts {
  /** Whether the token may push, or absent when the forge did not say. */
  canPush?: boolean | undefined;
  /** Whether the forge has archived the repository, or absent when it did not say. */
  archived?: boolean | undefined;
  /**
   * Whether the repository has at least one branch, or absent before a branch listing has
   * answered. Only the branch listing can supply this — see the module note.
   */
  hasBranches?: boolean | undefined;
}

/**
 * What the agent can do with a repository.
 *
 * `ready` and `unknown` are kept apart on purpose: the first is a forge that stated both facts and
 * stated them favourably, the second is a forge that left either one unsaid. Both render without a
 * warning — a badge on every row would be read as decoration — but nothing here may turn that
 * silence into permission.
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

/** Nothing to say: every fact needed was stated, and none of them warns. */
const NO_WARNING = { label: null, reason: null } as const;

/**
 * A repository with no branch to clone.
 *
 * Worded as what was observed rather than what it implies. An empty branch listing proves there is
 * no branch ref; it does not prove there is no commit, because a repository whose commits are
 * reachable only through tags has both. That repository is just as unusable by a branch-based
 * flow, so the outcome is right either way — but "no commits yet" would be a claim the evidence
 * does not support.
 */
const NO_BRANCHES: RepoReadiness = {
  level: 'blocked',
  label: 'No branches',
  reason: 'This repository has no branches to work from. Push a branch to it, then choose it here.',
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
 * What determines which repositories are listed, when the listing reached the end of the account.
 *
 * A picker that answers "no results" to somebody who is certain the repository exists tells them
 * nothing they can act on. The list is the token's reach, so the sentence names the token.
 */
const COMPLETE_LIST_NOTE =
  'This list is exactly what the stored GitHub token can reach. A fine-grained token only reports the repositories it was granted, so a repository that is missing has to be added to the token’s repository access in Settings.';

/**
 * The same explanation when the listing stopped at the client's page limit.
 *
 * Deliberately says nothing about the token: sending somebody to widen a token that was never the
 * problem is worse than saying nothing at all. The search runs over what was read, so an older
 * repository is unreachable however it is spelt — and that is the part a user cannot deduce from
 * an empty result. No count is named, so the sentence cannot drift out of step with the limit.
 */
const TRUNCATED_LIST_NOTE =
  'This account has more repositories than one listing reads, so only the most recently updated ones are here — and the search only covers those, so an older repository will not appear however it is spelt.';

/**
 * The sentence shown beneath a listing, saying what decides its contents.
 *
 * @param truncated - Whether the listing stopped at the client's page limit.
 * @returns The note to render.
 */
export function repoListNote(truncated: boolean): string {
  return truncated ? TRUNCATED_LIST_NOTE : COMPLETE_LIST_NOTE;
}

/**
 * Decides what the agent can do with one repository, from whatever is known about it.
 *
 * The order is the order the answers matter in. No branch to work from outranks everything, since
 * nothing can be cloned whatever the token may do; being archived is reported ahead of a read-only
 * token because unarchiving is what would change it and a wider token would not.
 *
 * `ready` is only reached when both access facts were stated and both are favourable. A stated
 * `canPush: true` beside an unstated `archived` is `unknown`, not `ready` — the repository may
 * well be archived, and nobody said it was not.
 *
 * @param facts - Whichever of the three facts the caller knows.
 * @returns The readiness, carrying a badge label and a one-sentence reason when there is one.
 */
export function repoReadiness(facts: RepoFacts): RepoReadiness {
  if (facts.hasBranches === false) {
    return NO_BRANCHES;
  }
  if (facts.archived === true) {
    return ARCHIVED;
  }
  if (facts.canPush === false) {
    return READ_ONLY;
  }
  if (facts.canPush === true && facts.archived === false) {
    return { level: 'ready', ...NO_WARNING };
  }
  return { level: 'unknown', ...NO_WARNING };
}
