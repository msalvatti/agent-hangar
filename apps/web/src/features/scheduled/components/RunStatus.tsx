/**
 * Icon-plus-text status of one run: never colour alone.
 *
 * Layer: component.
 */
'use client';

import type { JobRunStatus } from '@agent-hangar/core';
import { useState } from 'react';

import { cn } from '@/shared/lib/cn';
import { relativeTime } from '@/shared/transcript';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip';

import { runStatusPresentation } from '../lib/status';

/** Props of {@link RunStatus}. */
export interface RunStatusProps {
  status: JobRunStatus;
  at?: string | null;
  error?: string | null;
  className?: string;
}

const TONE_CLASS: Record<string, string> = {
  success: 'text-primary',
  destructive: 'text-destructive',
  warning: 'text-warning',
  accent: 'text-accent-foreground',
  muted: 'text-muted-foreground',
};

/**
 * Renders a run's status as an icon plus label, with an optional relative time and an overlap
 * tooltip when the run was skipped because a previous one was still running.
 *
 * @param props - Status, optional relative time and error.
 */
export function RunStatus({ status, at, error, className }: RunStatusProps) {
  // Relative labels are anchored to a single instant captured when the row mounts: reading the
  // clock during render would make the output depend on when React happened to re-render.
  const [now] = useState(() => Date.now());
  const presentation = runStatusPresentation(status);
  const Icon = presentation.icon;
  const isOverlapSkip = error === 'previous run still running';
  const label = (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-[13px]',
        TONE_CLASS[presentation.tone],
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {presentation.label}
      {at !== undefined && at !== null && (
        <span className="text-muted-foreground tabular-nums">{relativeTime(at, now)}</span>
      )}
    </span>
  );
  if (!isOverlapSkip) {
    return label;
  }
  return (
    <Tooltip>
      <TooltipTrigger render={<span />}>{label}</TooltipTrigger>
      <TooltipContent>Skipped: the previous run was still running</TooltipContent>
    </Tooltip>
  );
}
