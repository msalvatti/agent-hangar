/**
 * Polling helper over `GET /api/health`.
 *
 * Layer: test support (pure).
 *
 * Specs never sleep waiting for the stack to settle: they state the condition they are waiting
 * for and a budget, so a timeout message says what never became true.
 */
import { healthResponse } from '@agent-hangar/core';
import type { z } from 'zod';

import type { E2eApi } from './api';
import { HEALTH_POLL_MS } from './constants';

/** Parsed `GET /api/health` body. */
export type HealthView = z.infer<typeof healthResponse>;

/** Waits for the health endpoint to satisfy a predicate. */
export interface HealthHelper {
  /** Reads the endpoint once. */
  read(): Promise<HealthView>;
  /**
   * Polls until `predicate` holds.
   *
   * @param predicate - Condition on the health body.
   * @param timeoutMs - Budget.
   * @param description - What is being waited for, used in the failure message.
   */
  waitFor(
    predicate: (health: HealthView) => boolean,
    timeoutMs: number,
    description: string,
  ): Promise<HealthView>;
}

/**
 * Builds the helper.
 *
 * @param api - Client to read the endpoint with.
 * @param pollMs - Interval between reads.
 * @returns The helper.
 */
export function createHealthHelper(api: E2eApi, pollMs: number = HEALTH_POLL_MS): HealthHelper {
  const read = async (): Promise<HealthView> => api.get('/api/health', healthResponse);
  return {
    read,
    waitFor: async (predicate, timeoutMs, description) => {
      const deadline = Date.now() + timeoutMs;
      let last = await read();
      for (;;) {
        if (predicate(last)) {
          return last;
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `Timed out after ${String(timeoutMs)} ms waiting for ${description}; last health was ${JSON.stringify(last)}`,
          );
        }
        await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
        last = await read();
      }
    },
  };
}
