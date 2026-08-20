/**
 * A consumer factory that records instead of consuming.
 *
 * Layer: test double.
 *
 * The drain of each worker is resolvable by hand, which is what makes the shutdown grace period
 * testable: a worker that never stops is exactly the case the forced close exists for.
 *
 * `close` caches its first promise and answers every later call with it, exactly as BullMQ's
 * `Worker.close` does. That fidelity is the point: a shutdown that closes gracefully and then
 * tries to force the same worker rejoins the wait it meant to override, and against a double that
 * answered each call separately the mistake would be invisible.
 */
import type { QueueName } from '@agent-hangar/core';

import type { CreateWorkerOptions, WorkerLike } from '../app.js';
import type { ProcessorJob } from '../processors/types.js';

/** A recorded consumer. */
export class FakeWorker implements WorkerLike {
  /** Every `close` call, in order, with the force flag it carried. */
  readonly closes: boolean[] = [];

  /** How many times a drain was asked for. */
  pauses = 0;

  /** Event names the application subscribed to. */
  readonly events: string[] = [];

  private readonly listeners = new Map<string, (...args: never[]) => void>();
  private closing: Promise<void> | undefined;
  private settleClose: (() => void) | undefined;
  private settlePause: { resolve: () => void; reject: (error: Error) => void } | undefined;

  /**
   * @param name - Queue this consumer reads.
   * @param processor - Handler the application registered.
   * @param options - Connection, concurrency and stalled-job settings.
   * @param blocking - Whether a drain and a graceful close wait to be settled by hand.
   */
  constructor(
    readonly name: QueueName,
    readonly processor: (job: ProcessorJob<never>) => Promise<unknown>,
    readonly options: CreateWorkerOptions<unknown>,
    private readonly blocking = false,
  ) {}

  /**
   * Records a drain request.
   *
   * @returns A promise that resolves at once, unless this worker holds its jobs.
   */
  pause(): Promise<void> {
    this.pauses += 1;
    if (!this.blocking) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.settlePause = { resolve, reject };
    });
  }

  /**
   * Records a close, answering every call after the first with the promise the first produced.
   *
   * @param force - Whether jobs in flight were abandoned.
   * @returns The one close promise of this worker.
   */
  close(force = false): Promise<void> {
    this.closes.push(force);
    this.closing ??=
      this.blocking && !force
        ? new Promise<void>((resolve) => {
            this.settleClose = resolve;
          })
        : Promise.resolve();
    return this.closing;
  }

  /**
   * Records a subscription.
   *
   * @param event - Event name.
   * @param listener - Handler the application registered.
   * @returns This worker.
   */
  on(event: string, listener: (...args: never[]) => void): unknown {
    this.events.push(event);
    this.listeners.set(event, listener);
    return this;
  }

  /**
   * Delivers an event to the handler the application registered.
   *
   * @param event - Event name.
   * @param args - Arguments BullMQ would pass.
   */
  emit(event: string, ...args: unknown[]): void {
    this.listeners.get(event)?.(...(args as never[]));
  }

  /** Lets a blocked graceful close finish. */
  resolveClose(): void {
    this.settleClose?.();
  }

  /** Reports that the jobs in flight finished within the grace period. */
  resolvePause(): void {
    this.settlePause?.resolve();
  }

  /**
   * Reports that the drain itself failed, as a consumer whose connection is already gone does.
   *
   * @param error - What `pause` rejects with.
   */
  rejectPause(error: Error): void {
    this.settlePause?.reject(error);
  }
}

/** A factory plus the workers it produced. */
export interface FakeWorkerFactory {
  createWorker<TData>(
    name: QueueName,
    processor: (job: ProcessorJob<TData>) => Promise<unknown>,
    options: CreateWorkerOptions<unknown>,
  ): WorkerLike;
  /** Every worker created, in the order the application created them. */
  workers: FakeWorker[];
}

/**
 * Builds a recording consumer factory.
 *
 * @param options - Whether graceful closes block until they are resolved by hand.
 * @returns The factory and the workers it produced.
 */
export function createFakeWorkerFactory(options: { blocking?: boolean } = {}): FakeWorkerFactory {
  const workers: FakeWorker[] = [];
  return {
    workers,
    createWorker(name, processor, workerOptions) {
      const worker = new FakeWorker(name, processor, workerOptions, options.blocking ?? false);
      workers.push(worker);
      return worker;
    },
  };
}
