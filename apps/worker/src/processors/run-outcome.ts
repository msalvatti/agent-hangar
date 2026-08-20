/**
 * What a chat turn and a scheduled run do identically when they end.
 *
 * Layer: service.
 *
 * The two write different rows — a `Turn`, a `JobRun` — but they end the same event stream, in the
 * same shape, with the same error text. Keeping that here means the UI reads one vocabulary
 * whichever kind of run it is watching, and a failure code cannot drift between the two.
 */
import type { AgentEvent } from '@agent-hangar/core';

import { redactAgentEvent } from './turn-executor.js';
import type { ProcessorDeps } from './types.js';

/**
 * Renders a failure as the text an `error` column carries.
 *
 * @param code - Machine-readable failure code.
 * @param message - Human-readable detail.
 * @returns The combined text.
 */
export function formatRunError(code: string, message: string): string {
  return `${code}: ${message}`;
}

/**
 * Ends a run's event stream with the failure the runtime did not report itself.
 *
 * @param deps - Publisher and redactor.
 * @param runId - `Turn.id` or `JobRun.id`.
 * @param code - Machine-readable failure code.
 * @param message - Human-readable detail.
 */
export async function publishFailure(
  deps: ProcessorDeps,
  runId: string,
  code: string,
  message: string,
): Promise<void> {
  const event: AgentEvent = { type: 'turn.failed', error: { code, message } };
  await deps.publisher.publish(runId, redactAgentEvent(deps.redactor, event));
}

/**
 * Ends a run's event stream with a cancellation the runtime never acknowledged.
 *
 * @param deps - Publisher and redactor.
 * @param runId - `Turn.id` or `JobRun.id`.
 */
export async function publishCancellation(deps: ProcessorDeps, runId: string): Promise<void> {
  const event: AgentEvent = { type: 'turn.cancelled' };
  await deps.publisher.publish(runId, redactAgentEvent(deps.redactor, event));
}
