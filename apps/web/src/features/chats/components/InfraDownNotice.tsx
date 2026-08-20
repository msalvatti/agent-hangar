/**
 * Explains, above a locked composer, which dependency is stopping a turn from running.
 *
 * Layer: feature (component).
 *
 * A turn needs the worker, the Docker daemon and the workspace image; none of them is something
 * the browser can repair, so the notice names the dependency and the command rather than offering
 * a retry. It states only the first failing check, in the order the health module lists them:
 * the worker measures Docker and the image, so a silent worker leaves the two below it unknown,
 * and naming all three would bury the one thing to do.
 *
 * Recovery needs no button. Running the command means leaving the browser for a terminal, and
 * coming back fires the window `focus` that refetches the report, so the composer unlocks as the
 * user returns rather than on the next poll.
 */
'use client';

import { PlugZap } from 'lucide-react';

import { HEALTH_CHECK_FIX, HEALTH_CHECK_LABELS } from '@/shared/health';
import type { HealthCheckName } from '@/shared/health';
import { cn } from '@/shared/lib/cn';
import { Card, CardContent } from '@/shared/ui/card';

/** Props of {@link InfraDownNotice}. */
export interface InfraDownNoticeProps {
  /** The failing probes, in display order; the first is the one reported. */
  failing: readonly HealthCheckName[];
  className?: string;
}

/**
 * A status card naming the dependency that is down and the command that brings it back.
 *
 * @param props - The failing probes and an optional class name.
 * @returns The card, or `null` when nothing is failing.
 */
export function InfraDownNotice({ failing, className }: InfraDownNoticeProps) {
  const [first] = failing;
  if (first === undefined) {
    return null;
  }
  return (
    <Card role="status" className={cn('w-full', className)}>
      <CardContent className="flex flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-3">
        <PlugZap aria-hidden="true" className="text-warning size-[18px] shrink-0" />
        <p className="flex-1 text-sm">
          {HEALTH_CHECK_LABELS[first]} is not available, so a turn cannot run.
        </p>
        <code className="text-muted-foreground font-mono text-xs">{HEALTH_CHECK_FIX[first]}</code>
      </CardContent>
    </Card>
  );
}
