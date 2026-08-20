/**
 * The cancellation a turn listens for, from the moment it is picked up to the moment it ends.
 *
 * Layer: service.
 *
 * Stop is offered while a turn is queued and while it is preparing, not only while it runs, and the
 * request travels over Redis pub/sub — which keeps nothing for a subscriber that is not there yet.
 * A subscription opened when the exec starts would therefore drop every cancellation sent while the
 * container was being created and the repository cloned, which is exactly the slow part the user is
 * watching. The watch is opened before that work and closed after it, so the window in which Stop
 * does nothing is the window in which there is no turn.
 *
 * One watch per turn: the command channel holds one handler per key, so a second subscription to
 * the same turn would displace the first.
 */
import type { ProcessorDeps } from './types.js';

/** A cancellation subscription that spans preparation as well as execution. */
export interface CancellationWatch {
  /** The turn or run being watched; also the stream its events are published to. */
  readonly key: string;
  /**
   * Reports whether a cancellation has arrived since the watch was opened.
   *
   * @returns `true` once the user has asked for this turn to stop.
   */
  requested(): boolean;
  /**
   * Registers what to do when a cancellation arrives, replacing any previous listener.
   *
   * A cancellation that arrived before the listener was registered is not replayed to it: the
   * caller reads {@link CancellationWatch.requested} for that, at the point where it can still act
   * on it.
   *
   * @param listener - Invoked once per cancellation received from now on; must not throw.
   */
  onCancel(listener: () => void): void;
  /**
   * Ends the subscription; safe to call once, in a `finally`.
   */
  close(): Promise<void>;
}

/**
 * Opens the cancellation watch of one turn.
 *
 * @param deps - The command listener the subscription is taken on.
 * @param key - `Turn.id` or `JobRun.id`.
 * @returns The watch, already receiving.
 */
export async function openCancellationWatch(
  deps: ProcessorDeps,
  key: string,
): Promise<CancellationWatch> {
  let requested = false;
  let listener: (() => void) | undefined;
  const unsubscribe = await deps.commands.subscribe(key, {
    onCancel: () => {
      requested = true;
      listener?.();
    },
  });
  return {
    key,
    requested: () => requested,
    onCancel: (next) => {
      listener = next;
    },
    close: unsubscribe,
  };
}
