/**
 * The SYSTEM messages that tell the model what happened to its workspace.
 *
 * Layer: domain (pure).
 *
 * A restored chat looks identical to a continued one from the model's point of view, which is
 * exactly the problem: the filesystem it remembers writing to is gone. These notices are the only
 * thing that keeps it honest, so their wording is normative (spec 02 §4, spec 04 (b)).
 */

/** Opening of every restoration notice; used to detect one that a previous step already wrote. */
export const RESTORATION_NOTICE_PREFIX = 'Workspace recreated from history at ';

/** Second half of the notice when pushed work was found. */
export const RESTORATION_NOTICE_WITH_BRANCH =
  'Uncommitted changes from the previous workspace are gone; pushed work on `%s` is checked out.';

/** Second half of the notice when no pushed work was found. */
export const RESTORATION_NOTICE_WITHOUT_BRANCH =
  'Uncommitted changes from the previous workspace are gone; no pushed work was found, so the base branch is checked out.';

/**
 * Builds the notice inserted when a workspace is recreated from history.
 *
 * @param input - When the workspace was recreated and the branch the agent pushes to, if any.
 * @returns The SYSTEM message text.
 */
export function restorationNotice(input: { at: Date; workBranch: string | null }): string {
  const tail =
    input.workBranch === null
      ? RESTORATION_NOTICE_WITHOUT_BRANCH
      : RESTORATION_NOTICE_WITH_BRANCH.replace('%s', input.workBranch);
  return `${RESTORATION_NOTICE_PREFIX}${input.at.toISOString()}. ${tail}`;
}

/**
 * Builds the notice recorded when a chat is archived and its workspace destroyed.
 *
 * @param input - How many uncommitted changes the snapshot found.
 * @returns The SYSTEM message text, with the noun agreeing with the count; this is shown verbatim
 *   in the transcript, so `1 uncommitted changes` would be read as a bug by the user.
 */
export function archivedNotice(input: { uncommittedChanges: number }): string {
  if (input.uncommittedChanges === 0) {
    return 'Workspace archived; no uncommitted changes.';
  }
  const noun = input.uncommittedChanges === 1 ? 'change' : 'changes';
  return `Workspace archived; ${input.uncommittedChanges} uncommitted ${noun} discarded.`;
}
