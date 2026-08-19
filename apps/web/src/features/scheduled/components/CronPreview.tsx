/**
 * Live, plain-language preview of a cron expression: valid schedule + next run, or the reason
 * it's invalid.
 *
 * Layer: component.
 */
'use client';

import { Clock, TriangleAlert } from 'lucide-react';
import { useMemo } from 'react';

import { describeCron, nextRunAt, validateCron } from '../lib/cron';
import { formatNextRun } from '../lib/timezones';

/** Props of {@link CronPreview}. */
export interface CronPreviewProps {
  cron: string;
  timezone: string;
}

/**
 * Renders the live preview of a cron field: description + next run when valid, the validation
 * reason when not, or a hint when empty.
 *
 * @param props - The (debounced) cron expression and its timezone.
 */
export function CronPreview({ cron, timezone }: CronPreviewProps) {
  const validation = useMemo(() => validateCron(cron), [cron]);

  if (cron.trim().length === 0) {
    return (
      <p aria-live="polite" className="text-muted-foreground text-[13px]">
        Enter a cron expression (5 fields).
      </p>
    );
  }

  if (!validation.ok) {
    return (
      <p
        aria-live="polite"
        className="text-destructive inline-flex items-center gap-1.5 text-[13px]"
      >
        <TriangleAlert className="size-3.5" aria-hidden="true" />
        Invalid cron expression: {validation.reason}
      </p>
    );
  }

  const next = nextRunAt({ cron, timezone });
  const nextLabel = next === null ? '' : ` (next: ${formatNextRun(next, timezone)})`;

  return (
    <p
      aria-live="polite"
      className="text-muted-foreground inline-flex items-center gap-1.5 text-[13px]"
    >
      <Clock className="size-3.5" aria-hidden="true" />
      {describeCron(cron, timezone)}
      {nextLabel}
    </p>
  );
}
