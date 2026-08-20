/**
 * The run-status vocabulary of this feature: how a status is presented (icon, label and tone —
 * icon plus text, never colour alone), how it maps onto the transcript's phase, and whether it
 * means the run is still executing.
 *
 * Layer: presentation.
 *
 * Both activity predicates read one list of active statuses, so "is this run active" has a single
 * answer whether the caller holds a status or the phase derived from it.
 */
import type { JobRunStatus } from '@agent-hangar/core';
import { Ban, CircleCheck, CircleDot, CircleX, Clock } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { TurnPhase } from '@/shared/transcript';

/** Visual tone of a status, mapped to a token-based text/icon colour by the caller. */
export type StatusTone = 'success' | 'destructive' | 'warning' | 'accent' | 'muted';

/** Icon, label and tone for one {@link JobRunStatus}. */
export interface RunStatusPresentation {
  label: string;
  icon: LucideIcon;
  tone: StatusTone;
}

const PRESENTATION_BY_STATUS: Record<JobRunStatus, RunStatusPresentation> = {
  SUCCEEDED: { label: 'ok', icon: CircleCheck, tone: 'success' },
  FAILED: { label: 'fail', icon: CircleX, tone: 'destructive' },
  RUNNING: { label: 'running', icon: CircleDot, tone: 'accent' },
  PREPARING: { label: 'running', icon: CircleDot, tone: 'accent' },
  QUEUED: { label: 'queued', icon: Clock, tone: 'muted' },
  CANCELLED: { label: 'cancelled', icon: Ban, tone: 'muted' },
};

/**
 * Maps a job run status to its icon, label and tone.
 *
 * @param status - The run's status.
 * @returns The presentation to render (icon + text; tone drives colour only, never alone).
 */
export function runStatusPresentation(status: JobRunStatus): RunStatusPresentation {
  return PRESENTATION_BY_STATUS[status];
}

/** The transcript phase each run status is shown as. */
export const PHASE_BY_STATUS: Record<JobRunStatus, TurnPhase> = {
  QUEUED: 'queued',
  PREPARING: 'preparing',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

/** The statuses a run is still executing in. Everything else has settled. */
const ACTIVE_STATUSES: readonly JobRunStatus[] = ['QUEUED', 'PREPARING', 'RUNNING'];

/** The same set expressed as transcript phases, derived so the two can never drift apart. */
const ACTIVE_PHASES: ReadonlySet<TurnPhase> = new Set(
  ACTIVE_STATUSES.map((status) => PHASE_BY_STATUS[status]),
);

/**
 * Whether a run status means the run is still executing (and should be polled/ticked live).
 *
 * @param status - The run's status.
 * @returns `true` while the run is queued, preparing or running.
 */
export function isRunActive(status: JobRunStatus): boolean {
  return ACTIVE_PHASES.has(PHASE_BY_STATUS[status]);
}

/**
 * Whether a transcript phase means the run is still executing.
 *
 * The phase-side answer to {@link isRunActive}, for callers that have already mapped a status —
 * the run drawer works in phases because it also drives them from the live event stream.
 *
 * @param phase - The phase currently displayed.
 * @returns `true` while the run is queued, preparing or running.
 */
export function isActivePhase(phase: TurnPhase): boolean {
  return ACTIVE_PHASES.has(phase);
}
