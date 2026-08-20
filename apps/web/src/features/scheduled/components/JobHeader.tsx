/**
 * Job detail header: back link, name, schedule, enabled toggle, run now, and overflow actions.
 *
 * Layer: component.
 */
'use client';

import type { JobSummary } from '@agent-hangar/core';
import { ArrowLeft, Ellipsis, Loader2, Pencil, Play, Trash2 } from 'lucide-react';
import Link from 'next/link';

import { PageHeader } from '@/shared/shell/PageHeader';
import { Button } from '@/shared/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import { Switch } from '@/shared/ui/switch';

import { ScheduleCell } from './ScheduleCell';

/** Props of {@link JobHeader}. */
export interface JobHeaderProps {
  job: JobSummary;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: (enabled: boolean) => void;
  onRunNow: () => void;
  busy: boolean;
  /** `true` while an enable/disable request for this job is in flight. */
  toggling: boolean;
}

/**
 * The job detail page's header: back link, name, schedule, enabled toggle, run now, and an
 * overflow menu (edit/delete).
 *
 * @param props - The job and its action callbacks.
 */
export function JobHeader({
  job,
  onEdit,
  onDelete,
  onToggle,
  onRunNow,
  busy,
  toggling,
}: JobHeaderProps) {
  return (
    <PageHeader
      title={job.name}
      leading={
        <Link
          href="/scheduled"
          aria-label="Back to scheduled jobs"
          className="text-muted-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
        </Link>
      }
      actions={
        <div className="flex items-center gap-2">
          <ScheduleCell cron={job.cron} timezone={job.timezone} />
          <Switch
            aria-label={`Enable ${job.name}`}
            checked={job.enabled}
            disabled={toggling}
            onCheckedChange={onToggle}
          />
          <Button onClick={onRunNow} disabled={busy}>
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Play className="size-3.5" aria-hidden="true" />
            )}
            Run now
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon-sm" aria-label="Job actions" />}
            >
              <Ellipsis />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={onEdit}>
                <Pencil /> Edit
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2 /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      }
    />
  );
}
