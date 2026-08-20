/**
 * Test doubles of the transcript data layer, published under a `testing` subpath so production
 * code never imports them.
 *
 * Layer: shared (test double barrel).
 */
export type { EventSourceFactory, FakeEventSourceListener } from './fake-event-source';
export { FakeEventSource, createFakeEventSourceFactory } from './fake-event-source';
