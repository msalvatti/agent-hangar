/**
 * Presentation mapping for a job run's status: icon, label and tone (icon + text, never colour
 * alone).
 *
 * Layer: presentation.
 */
import type { JobRunStatus } from '@agent-hangar/core';
import { Ban, CircleCheck, CircleDot, CircleX, Clock } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

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

/**
 * Whether a run status means the run is still executing (and should be polled/ticked live).
 *
 * @param status - The run's status.
 * @returns `true` for `QUEUED`, `PREPARING` or `RUNNING`.
 */
export function isRunActive(status: JobRunStatus): boolean {
  return status === 'QUEUED' || status === 'PREPARING' || status === 'RUNNING';
}
