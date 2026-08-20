/**
 * One row of the scheduled-jobs table.
 *
 * Layer: component.
 */
'use client';

import type { JobSummary } from '@agent-hangar/core';
import { Box } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { repoLabel } from '@/shared/lib/repo-label';
import { relativeTime } from '@/shared/transcript';
import { Switch } from '@/shared/ui/switch';
import { TableCell, TableRow } from '@/shared/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip';

import { JobRowMenu } from './JobRowMenu';
import { RunStatus } from './RunStatus';
import { ScheduleCell } from './ScheduleCell';

/** Props of {@link JobRow}. */
export interface JobRowProps {
  job: JobSummary;
  enabled: boolean;
  busy: boolean;
  onToggle: (job: JobSummary, enabled: boolean) => void;
  onEdit: (job: JobSummary) => void;
  onRunNow: (job: JobSummary) => void;
  onDelete: (job: JobSummary) => void;
}

/**
 * One clickable row of the jobs table; interactive cells stop click propagation so they do not
 * also trigger row navigation.
 *
 * @param props - The job, its optimistic enabled state, and row action callbacks.
 */
export function JobRow({ job, enabled, busy, onToggle, onEdit, onRunNow, onDelete }: JobRowProps) {
  const router = useRouter();
  // Relative labels are anchored to a single instant captured when the row mounts: reading the
  // clock during render would make the output depend on when React happened to re-render.
  const [now] = useState(() => Date.now());

  return (
    <TableRow
      className="h-11 cursor-pointer"
      onClick={() => {
        router.push(`/scheduled/${job.id}`);
      }}
    >
      <TableCell>
        <Link
          href={`/scheduled/${job.id}`}
          className="font-medium"
          onClick={(event) => {
            event.stopPropagation();
          }}
        >
          {job.name}
        </Link>
      </TableCell>
      <TableCell>
        <ScheduleCell cron={job.cron} timezone={job.timezone} />
      </TableCell>
      <TableCell>
        <span className="inline-flex items-center gap-1 font-mono text-[12px]">
          <Box className="size-3.5" aria-hidden="true" />
          {repoLabel(job.repoUrl)} · {job.branch}
        </span>
      </TableCell>
      <TableCell>
        {job.lastRunStatus === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <RunStatus status={job.lastRunStatus} at={job.lastRunAt} />
        )}
      </TableCell>
      <TableCell>
        {job.nextRunAt === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <Tooltip>
            <TooltipTrigger render={<span className="tabular-nums" />}>
              {relativeTime(job.nextRunAt, now)}
            </TooltipTrigger>
            <TooltipContent>{new Date(job.nextRunAt).toLocaleString()}</TooltipContent>
          </Tooltip>
        )}
      </TableCell>
      <TableCell
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <Switch
          aria-label={`Enable ${job.name}`}
          checked={enabled}
          disabled={busy}
          onCheckedChange={(next) => {
            onToggle(job, next);
          }}
        />
      </TableCell>
      <TableCell
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <JobRowMenu job={job} busy={busy} onEdit={onEdit} onRunNow={onRunNow} onDelete={onDelete} />
      </TableCell>
    </TableRow>
  );
}
