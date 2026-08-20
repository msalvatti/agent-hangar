/**
 * Live, plain-language preview of a cron expression: valid schedule + next run, or the reason
 * it cannot be scheduled.
 *
 * Layer: component.
 */
'use client';

import { Clock, TriangleAlert } from 'lucide-react';

import { describeCron, nextRunAt } from '../lib/cron';
import { formatNextRun } from '../lib/timezones';

/** Props of {@link CronPreview}. */
export interface CronPreviewProps {
  cron: string;
  timezone: string;
}

/**
 * Renders the live preview of a cron field: description + next run when the schedule is usable,
 * the reason it is not when it isn't, or a hint while the field is still empty.
 *
 * A schedule with no next run is exactly a schedule the description could not be built for
 * either — a malformed expression or a timezone the runtime does not know — so both states are
 * driven by the same pair of calls rather than by a separate validation pass.
 *
 * @param props - The (debounced) cron expression and its timezone.
 */
export function CronPreview({ cron, timezone }: CronPreviewProps) {
  if (cron.trim().length === 0) {
    return (
      <p aria-live="polite" className="text-muted-foreground text-[13px]">
        Enter a cron expression (5 fields).
      </p>
    );
  }

  const description = describeCron(cron, timezone);
  const next = nextRunAt({ cron, timezone });

  if (next === null) {
    return (
      <p
        aria-live="polite"
        className="text-destructive inline-flex items-center gap-1.5 text-[13px]"
      >
        <TriangleAlert className="size-3.5" aria-hidden="true" />
        {description}
      </p>
    );
  }

  return (
    <p
      aria-live="polite"
      className="text-muted-foreground inline-flex items-center gap-1.5 text-[13px]"
    >
      <Clock className="size-3.5" aria-hidden="true" />
      Runs {description} (next: {formatNextRun(next, timezone)})
    </p>
  );
}
