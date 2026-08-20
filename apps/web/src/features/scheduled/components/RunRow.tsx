/**
 * One row of the runs table: started, duration, trigger, status, tokens.
 *
 * Layer: component.
 */
'use client';

import type { RunSummary } from '@agent-hangar/core';
import { useEffect, useState } from 'react';

import { formatDuration, formatTokens, relativeTime } from '@/shared/transcript';
import { Badge } from '@/shared/ui/badge';
import { TableCell, TableRow } from '@/shared/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip';

import { isRunActive } from '../lib/status';

import { RunStatus } from './RunStatus';

const TICK_MS = 1000;

/**
 * Duration text for a run: the finished span, or a live-ticking elapsed clock while active.
 *
 * @param run - The run to time.
 * @returns The formatted duration, or an em dash before the run has started.
 */
function useRunDuration(run: RunSummary): string {
  const [now, setNow] = useState(() => Date.now());
  const active = isRunActive(run.status);

  useEffect(() => {
    if (!active) {
      return;
    }
    const interval = setInterval(() => {
      setNow(Date.now());
    }, TICK_MS);
    return () => {
      clearInterval(interval);
    };
  }, [active]);

  if (run.startedAt === null) {
    return '—';
  }
  const start = Date.parse(run.startedAt);
  const end = run.finishedAt === null ? now : Date.parse(run.finishedAt);
  return formatDuration(end - start);
}

/** Props of {@link RunRow}. */
export interface RunRowProps {
  run: RunSummary;
  onOpen: (runId: string) => void;
}

/**
 * One clickable row of the runs table.
 *
 * @param props - The run and its open callback.
 */
export function RunRow({ run, onOpen }: RunRowProps) {
  // Relative labels are anchored to a single instant captured when the row mounts: reading the
  // clock during render would make the output depend on when React happened to re-render.
  const [now] = useState(() => Date.now());
  const duration = useRunDuration(run);
  const totalTokens = (run.usage.inputTokens ?? 0) + (run.usage.outputTokens ?? 0);
  const hasTokens = run.usage.inputTokens !== null || run.usage.outputTokens !== null;

  return (
    <TableRow
      className="h-11 cursor-pointer"
      onClick={() => {
        onOpen(run.id);
      }}
    >
      <TableCell>
        <Tooltip>
          <TooltipTrigger render={<span />}>
            {new Date(run.queuedAt).toLocaleString()}
          </TooltipTrigger>
          <TooltipContent>{relativeTime(run.queuedAt, now)}</TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell className="font-mono text-[13px] tabular-nums">{duration}</TableCell>
      <TableCell>
        <Badge variant="outline">{run.trigger === 'SCHEDULE' ? 'Scheduled' : 'Manual'}</Badge>
      </TableCell>
      <TableCell>
        <RunStatus status={run.status} error={run.error} />
      </TableCell>
      <TableCell className="tabular-nums">{hasTokens ? formatTokens(totalTokens) : '—'}</TableCell>
    </TableRow>
  );
}
