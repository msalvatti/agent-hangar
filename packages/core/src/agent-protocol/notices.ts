/**
 * The text a lifecycle event is shown as in a transcript, and how a stored one is read back.
 *
 * Layer: contract.
 *
 * A push notice is written twice for the same fact: once by the web reducer while the stream is
 * live, and once by the worker as the `SYSTEM` message that keeps the line after a reload. That is
 * only safe while the two readings are identical, which is the reason this vocabulary lives in one
 * module instead of at either end: both callers build the line here, so neither can drift away
 * from the other, and the transcript recognises a stored notice by the same prefix that wrote it.
 */

/** Characters of a commit sha a notice shows. */
const SHORT_SHA_LENGTH = 7;

/** Opening of the notice that reports a push, and what a stored one is recognised by. */
const PUSHED_NOTICE_PREFIX = 'Pushed ';

/** How a transcript renders a stored `SYSTEM` message. */
export type SystemNoticeTone = 'success' | 'warning';

/**
 * Shortens a commit sha to the length a notice shows.
 *
 * @param sha - Full or already-short sha.
 * @returns The first seven characters, or the whole string when it is shorter.
 */
export function shortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA_LENGTH);
}

/**
 * Builds the notice that reports where the agent pushed.
 *
 * @param branch - Branch the push landed on.
 * @param sha - Commit that is now at its head.
 * @returns The notice text, identical live and after a reload.
 */
export function pushedNoticeText(branch: string, sha: string): string {
  return `${PUSHED_NOTICE_PREFIX}${branch} @ ${shortSha(sha)}`;
}

/**
 * What the transcript says once a workspace is ready.
 *
 * Spelled here rather than where it is rendered because it is rendered twice: the live stream
 * builds it from `prepare.done`, and a reload builds it from what the turn recorded. Two copies of
 * one sentence drift, and a reader who reloads would be shown a different fact about the same
 * event.
 *
 * @param branch - Branch the workspace was put on.
 * @param headSha - Commit it was prepared at.
 * @returns The notice text.
 */
export function preparedNoticeText(branch: string, headSha: string): string {
  return `Prepared ${branch} at ${shortSha(headSha)}`;
}

/**
 * Reads the tone back out of a stored `SYSTEM` message.
 *
 * A push is the one stored notice that reports something going right; every other one — a
 * workspace recovered after a crash, a container torn down, a chat restored — reports something
 * the operator has to account for, and is shown as a warning.
 *
 * @param content - Content of the stored message.
 * @returns The tone the transcript renders it in.
 */
export function systemNoticeTone(content: string): SystemNoticeTone {
  return content.startsWith(PUSHED_NOTICE_PREFIX) ? 'success' : 'warning';
}

/**
 * Opening of a `prepare.progress` message that reports a state of the checkout rather than a step
 * of the preparation, and what such a message is recognised by.
 */
const PREPARE_WARNING_PREFIX = 'Warning: ';

/**
 * Marks a preparation message as a finding about the checkout rather than a step of it.
 *
 * The distinction is not decoration. Preparation progress collapses into one line — each message
 * replaces the last, and `prepare.done` replaces them all — because "Cloning…" is worth exactly as
 * long as it takes to stop being true. A finding is the opposite: the branch diverged from the
 * remote, or HEAD is not where the host expected, and that is still true when the turn ends. The
 * transcript keeps a marked message on its own line so the collapse cannot swallow it.
 *
 * @param message - What was found, in terms the operator can act on.
 * @returns The message with the marker the transcript recognises.
 */
export function prepareWarningText(message: string): string {
  return `${PREPARE_WARNING_PREFIX}${message}`;
}

/**
 * Reads back whether a `prepare.progress` message is a finding rather than a step.
 *
 * @param message - Message carried by the event.
 * @returns `true` when {@link prepareWarningText} built it.
 */
export function isPrepareWarning(message: string): boolean {
  return message.startsWith(PREPARE_WARNING_PREFIX);
}
