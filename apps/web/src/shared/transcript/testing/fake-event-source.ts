/**
 * `EventSource` test double for the SSE hooks.
 *
 * Layer: shared (test double).
 *
 * Real `EventSource` cannot be driven deterministically in jsdom: this class exposes `open()`,
 * `emit()` and `fail()` so a test can script a stream frame by frame with fake timers.
 */

/** Minimal listener signature the hooks register. */
export type FakeEventSourceListener = (event: MessageEvent<string>) => void;

/** Injectable factory signature matching `createEventSource` from `@/shared/api/client`. */
export type EventSourceFactory = (url: string, init?: { lastEventId?: string }) => EventSource;

/**
 * `EventSource`-compatible test double, driven manually instead of by a real network stream.
 *
 * Deliberately not declared `implements EventSource`: the DOM lib's `addEventListener` carries
 * three mutually-narrowing overloads that no single hand-written implementation signature can
 * satisfy under `strict`. Call sites that need the nominal type use {@link createFakeEventSourceFactory},
 * which casts once, at the boundary, instead of weakening every method's parameter types here.
 */
export class FakeEventSource {
  static readonly CONNECTING = 0 as const;
  static readonly OPEN = 1 as const;
  static readonly CLOSED = 2 as const;
  readonly CONNECTING = FakeEventSource.CONNECTING;
  readonly OPEN = FakeEventSource.OPEN;
  readonly CLOSED = FakeEventSource.CLOSED;

  readyState: 0 | 1 | 2 = FakeEventSource.CONNECTING;
  readonly url: string;
  readonly withCredentials = false;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  /** Number of times {@link close} was called. */
  closeCount = 0;
  /** Listeners registered via {@link addEventListener}, keyed by event type. */
  readonly listeners = new Map<string, Set<FakeEventSourceListener>>();
  /** Resume point the factory was called with, when any. */
  readonly lastEventId: string | undefined;

  constructor(url: string, init: { lastEventId?: string } = {}) {
    this.url = url;
    this.lastEventId = init.lastEventId;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (listener === null) {
      return;
    }
    const bound = typeof listener === 'function' ? listener : listener.handleEvent.bind(listener);
    const set = this.listeners.get(type) ?? new Set<FakeEventSourceListener>();
    set.add(bound);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (listener === null) {
      return;
    }
    const bound = typeof listener === 'function' ? listener : listener.handleEvent.bind(listener);
    this.listeners.get(type)?.delete(bound);
  }

  dispatchEvent(event: Event): boolean {
    const set = this.listeners.get(event.type);
    if (set !== undefined) {
      for (const listener of set) {
        listener(event as MessageEvent<string>);
      }
    }
    return true;
  }

  close(): void {
    this.closeCount += 1;
    this.readyState = FakeEventSource.CLOSED;
  }

  /** Transitions to `OPEN` and fires `onopen` plus any `open` listeners. */
  open(): void {
    this.readyState = FakeEventSource.OPEN;
    const event = new Event('open');
    this.onopen?.(event);
    this.dispatchEvent(event);
  }

  /**
   * Delivers one server-sent event.
   *
   * @param type - SSE event name.
   * @param data - Payload. Strings are sent verbatim (useful for malformed-JSON scenarios);
   *   anything else is `JSON.stringify`d first, matching a real server.
   * @param id - Value the browser would report as `event.lastEventId`.
   */
  emit(type: string, data: unknown, id?: string): void {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    const event = new MessageEvent<string>(type, { data: payload, lastEventId: id ?? '' });
    if (type === 'message') {
      this.onmessage?.(event);
    }
    this.dispatchEvent(event);
  }

  /**
   * Simulates a connection error.
   *
   * @param options - `reconnecting: true` leaves `readyState` at `CONNECTING` (the browser is
   *   about to retry on its own); `false` moves it to `CLOSED` (retries exhausted).
   */
  fail({ reconnecting }: { reconnecting: boolean }): void {
    this.readyState = reconnecting ? FakeEventSource.CONNECTING : FakeEventSource.CLOSED;
    const event = new Event('error');
    this.onerror?.(event);
    this.dispatchEvent(event);
  }
}

/**
 * Builds an {@link EventSourceFactory} that records every instance it creates, for injection into
 * {@link useTurnEvents}.
 *
 * @returns The factory and the list of instances it has created so far (live, in creation order).
 */
export function createFakeEventSourceFactory(): {
  factory: EventSourceFactory;
  instances: FakeEventSource[];
} {
  const instances: FakeEventSource[] = [];
  const factory: EventSourceFactory = (url, init) => {
    const instance = new FakeEventSource(url, init);
    instances.push(instance);
    return instance as unknown as EventSource;
  };
  return { factory, instances };
}
