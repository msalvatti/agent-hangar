/**
 * Cron expression + timezone cell, with a human-readable tooltip.
 *
 * Layer: component.
 */
'use client';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip';

import { describeCron } from '../lib/cron';

/** Props of {@link ScheduleCell}. */
export interface ScheduleCellProps {
  cron: string;
  timezone: string;
}

/**
 * Renders a cron expression in mono type with its timezone, and a tooltip describing it in
 * plain language.
 *
 * @param props - Cron expression and IANA timezone.
 */
export function ScheduleCell({ cron, timezone }: ScheduleCellProps) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex items-center gap-1.5" />}>
        <span className="font-mono text-[13px]">{cron}</span>
        <span className="text-muted-foreground text-[12px]">({timezone})</span>
      </TooltipTrigger>
      <TooltipContent>{describeCron(cron, timezone)}</TooltipContent>
    </Tooltip>
  );
}
