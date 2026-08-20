/**
 * A consumer factory that records instead of consuming.
 *
 * Layer: test double.
 *
 * The close of each worker is resolvable by hand, which is what makes the shutdown grace period
 * testable: a worker that never stops is exactly the case the forced close exists for.
 */
import type { QueueName } from '@agent-hangar/core';

import type { CreateWorkerOptions, WorkerLike } from '../app.js';
import type { ProcessorJob } from '../processors/types.js';

/** A recorded consumer. */
export class FakeWorker implements WorkerLike {
  /** Every `close` call, in order, with the force flag it carried. */
  readonly closes: boolean[] = [];

  /** Event names the application subscribed to. */
  readonly events: string[] = [];

  private readonly listeners = new Map<string, (...args: never[]) => void>();
  private settle: (() => void) | undefined;

  /**
   * @param name - Queue this consumer reads.
   * @param processor - Handler the application registered.
   * @param options - Connection, concurrency and stalled-job settings.
   * @param blocking - Whether a graceful close waits to be resolved by hand.
   */
  constructor(
    readonly name: QueueName,
    readonly processor: (job: ProcessorJob<never>) => Promise<unknown>,
    readonly options: CreateWorkerOptions<unknown>,
    private readonly blocking = false,
  ) {}

  /**
   * Records a close.
   *
   * @param force - Whether jobs in flight were abandoned.
   * @returns A promise that resolves at once, unless this worker blocks its graceful close.
   */
  close(force = false): Promise<void> {
    this.closes.push(force);
    if (!this.blocking || force) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.settle = resolve;
    });
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
    this.settle?.();
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
