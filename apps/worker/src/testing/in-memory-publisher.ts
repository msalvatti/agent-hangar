/**
 * A `TurnEventPublisher` that records instead of writing to Redis.
 *
 * Layer: test double.
 *
 * Recording the events in publication order is what lets a test assert both the content of the
 * stream and the ordering guarantee the SSE route depends on — publish before persist, and never
 * an event the redactor has not seen.
 */
import type { AgentEvent } from '@agent-hangar/core';

import type { TurnEventPublisher } from '../events.js';

/** One recorded publication. */
export interface PublishedEvent {
  turnId: string;
  event: AgentEvent;
}

/** Collects published events in order. */
export class InMemoryTurnEventPublisher implements TurnEventPublisher {
  /** Every publication, in order. */
  readonly records: PublishedEvent[] = [];

  private sequence = 0;

  /**
   * Records one publication.
   *
   * @param turnId - `Turn.id` or `JobRun.id`.
   * @param event - The already-redacted event.
   * @returns A synthetic stream entry id, shaped like the ones Redis returns.
   */
  publish(turnId: string, event: AgentEvent): Promise<string> {
    this.records.push({ turnId, event });
    this.sequence += 1;
    return Promise.resolve(`0-${String(this.sequence)}`);
  }

  /**
   * The events published for one turn.
   *
   * @param turnId - `Turn.id` or `JobRun.id`.
   * @returns Its events, in order.
   */
  eventsFor(turnId: string): AgentEvent[] {
    return this.records.filter((record) => record.turnId === turnId).map((record) => record.event);
  }
}
