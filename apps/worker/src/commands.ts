/**
 * The command channel a running turn listens on (currently only `cancel`).
 *
 * Layer: infrastructure.
 *
 * Commands travel over Redis pub/sub rather than the job queue because they must reach the worker
 * that is *already* executing the turn, not the next one free to pick a job up. One subscriber
 * connection serves every concurrent turn: ioredis delivers messages per connection, so the
 * channel name is the routing key and a `Map` does the dispatch.
 *
 * Security: the payload arrives from the web app but is treated as untrusted input. It is matched
 * against a closed vocabulary and never echoed — an unrecognised payload is reported by channel
 * name and nothing else.
 */
import { turnCommand, turnCommandChannel } from '@agent-hangar/core';
import type { Logger } from 'pino';

/** The Redis surface {@link createCommandListener} needs; ioredis' `Redis` satisfies it. */
export interface CommandRedis {
  /** Registers the single message handler of the shared subscriber connection. */
  on(event: 'message', listener: (channel: string, payload: string) => void): unknown;
  /** Starts receiving messages published on a channel. */
  subscribe(channel: string): Promise<unknown>;
  /** Stops receiving messages published on a channel. */
  unsubscribe(channel: string): Promise<unknown>;
}

/** Bare payload accepted as a cancellation, alongside the JSON form of {@link turnCommand}. */
export const CANCEL_PAYLOAD = 'cancel';

/** What a subscriber does when a command arrives. */
export interface CommandHandlers {
  /** Called once per received cancellation; must not throw. */
  onCancel(): void;
}

/** Subscribes running turns to their command channel. */
export interface CommandListener {
  /**
   * Listens for the commands of one turn.
   *
   * @param turnId - `Turn.id` or `JobRun.id`.
   * @param handlers - Callbacks invoked per command.
   * @returns A function that stops the subscription; safe to call once, in a `finally`.
   */
  subscribe(turnId: string, handlers: CommandHandlers): Promise<() => Promise<void>>;
}

/**
 * Reports whether a raw payload asks for cancellation.
 *
 * Both spellings are accepted because both are cheap to produce: `redis-cli publish … cancel` is
 * what an operator types, and the JSON object is what the API route sends.
 *
 * @param payload - Raw message body.
 * @returns `true` for the bare word or for the JSON command object.
 */
export function isCancelPayload(payload: string): boolean {
  if (payload === CANCEL_PAYLOAD) {
    return true;
  }
  try {
    return turnCommand.safeParse(JSON.parse(payload)).success;
  } catch {
    // A payload that is not JSON is simply not a command; the parse error quotes its input and
    // must not escape, because the channel is reachable by anything that can talk to Redis.
    return false;
  }
}

/**
 * Builds the listener over one shared subscriber connection.
 *
 * The message handler is installed on the first `subscribe` rather than eagerly, so a worker that
 * never runs a turn never registers a listener on the connection.
 *
 * @param subscriber - A connection dedicated to pub/sub (ioredis forbids other commands on it).
 * @param logger - Logger for payloads that are not commands.
 * @returns The listener.
 */
export function createCommandListener(subscriber: CommandRedis, logger: Logger): CommandListener {
  const handlersByChannel = new Map<string, CommandHandlers>();
  let installed = false;

  const dispatch = (channel: string, payload: string): void => {
    const handlers = handlersByChannel.get(channel);
    if (handlers === undefined) {
      return;
    }
    if (!isCancelPayload(payload)) {
      logger.warn({ channel }, 'ignored unknown command');
      return;
    }
    try {
      handlers.onCancel();
    } catch (error) {
      // A throwing handler must not take the shared connection's listener down with it: every
      // other running turn depends on this one callback surviving.
      logger.warn({ channel, err: error }, 'cancel handler failed');
    }
  };

  return {
    async subscribe(turnId: string, handlers: CommandHandlers): Promise<() => Promise<void>> {
      if (!installed) {
        installed = true;
        subscriber.on('message', dispatch);
      }
      const channel = turnCommandChannel(turnId);
      handlersByChannel.set(channel, handlers);
      await subscriber.subscribe(channel);
      return async (): Promise<void> => {
        handlersByChannel.delete(channel);
        await subscriber.unsubscribe(channel);
      };
    },
  };
}
