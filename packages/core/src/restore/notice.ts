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
 * How the instant is spelled inside a notice: `Aug 21, 2026, 10:02 PM UTC`.
 *
 * The notice has two readers and the format has to serve both. It is shown verbatim in the
 * transcript, where an ISO-8601 string is a machine artefact the reader has to decode, and it is
 * handed to the model, which needs the instant to be unambiguous. Naming the zone satisfies the
 * second while the American spelling satisfies the first — the product's copy is English
 * throughout, so the locale is fixed rather than read from the machine, which also keeps the
 * string identical wherever the tests run. `dateStyle`/`timeStyle` are deliberately not used:
 * `Intl` rejects them alongside `timeZoneName`, and dropping the zone is what would make the
 * timestamp ambiguous.
 *
 * UTC rather than a local zone because this runs in the worker and the web server, neither of
 * which knows where the reader is.
 */
const NOTICE_TIME_FORMAT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
  timeZoneName: 'short',
};

/**
 * Spells an instant the way a notice states it.
 *
 * Not exported: the notices are the contract, and a second way to spell a timestamp is how two
 * spellings end up on one screen.
 *
 * @param at - The instant.
 * @returns The formatted timestamp, naming the zone.
 */
function noticeTimestamp(at: Date): string {
  return new Intl.DateTimeFormat('en-US', NOTICE_TIME_FORMAT).format(at);
}

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
  return `${RESTORATION_NOTICE_PREFIX}${noticeTimestamp(input.at)}. ${tail}`;
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
