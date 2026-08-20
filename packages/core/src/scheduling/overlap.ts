/**
 * Overlap policy for scheduled jobs.
 *
 * Layer: domain (pure).
 *
 * A tick that fires while the previous run of the same job is still executing is skipped rather
 * than queued: each run gets its own container, so queueing would let a slow job accumulate
 * workspaces until the machine runs out of memory. The skipped run is still recorded, as a
 * failure carrying {@link OVERLAP_SKIP_REASON}, so the UI can show that a tick was dropped.
 */
import type { OverlapPolicy } from './types.ts';

/** The policy this application implements. */
export const OVERLAP_POLICY: OverlapPolicy = 'skip';

/** Error text recorded on a run that was skipped because its predecessor was still executing. */
export const OVERLAP_SKIP_REASON = 'previous run still running';

/** What the worker does with a tick. */
export type OverlapDecision =
  { action: 'run' } | { action: 'skip'; reason: typeof OVERLAP_SKIP_REASON };

/** What {@link decideOverlap} needs to know about a job's current state. */
export interface OverlapInput {
  /** The job's run that is still executing, or `null` when none is. */
  runningRun: { id: string } | null;
}

/**
 * Decides whether a tick may start a run.
 *
 * @param input - The job's currently executing run, if any.
 * @returns `run` when the job is idle, `skip` with the recorded reason otherwise.
 */
export function decideOverlap(input: OverlapInput): OverlapDecision {
  if (input.runningRun === null) {
    return { action: 'run' };
  }
  return { action: 'skip', reason: OVERLAP_SKIP_REASON };
}
