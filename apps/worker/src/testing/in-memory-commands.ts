/**
 * A `CommandListener` a test drives directly instead of through Redis pub/sub.
 *
 * Layer: test double.
 */
import type { CommandHandlers, CommandListener } from '../commands.js';

/** Delivers commands to subscribed turns on demand. */
export class InMemoryCommandListener implements CommandListener {
  private readonly handlers = new Map<string, CommandHandlers>();

  /** How many subscriptions are currently open; must be zero once a processor has returned. */
  get subscriptions(): number {
    return this.handlers.size;
  }

  /**
   * Subscribes a turn.
   *
   * @param turnId - `Turn.id` or `JobRun.id`.
   * @param handlers - Callbacks invoked per command.
   * @returns The unsubscribe function.
   */
  subscribe(turnId: string, handlers: CommandHandlers): Promise<() => Promise<void>> {
    this.handlers.set(turnId, handlers);
    return Promise.resolve(() => {
      this.handlers.delete(turnId);
      return Promise.resolve();
    });
  }

  /**
   * Delivers a cancellation, as the web app's `POST /api/turns/:id/cancel` would.
   *
   * @param turnId - `Turn.id` or `JobRun.id`.
   * @returns `true` when a subscriber received it.
   */
  emitCancel(turnId: string): boolean {
    const handlers = this.handlers.get(turnId);
    if (handlers === undefined) {
      return false;
    }
    handlers.onCancel();
    return true;
  }
}
