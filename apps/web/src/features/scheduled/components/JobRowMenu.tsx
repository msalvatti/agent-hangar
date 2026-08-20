/**
 * Row overflow menu: run now, edit, delete.
 *
 * Layer: component.
 */
'use client';

import type { JobSummary } from '@agent-hangar/core';
import { Ellipsis, Pencil, Play, Trash2 } from 'lucide-react';

import { Button } from '@/shared/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';

/** Props of {@link JobRowMenu}. */
export interface JobRowMenuProps {
  job: JobSummary;
  onEdit: (job: JobSummary) => void;
  onRunNow: (job: JobSummary) => void;
  onDelete: (job: JobSummary) => void;
  /** `true` while a mutation for this job is in flight; disables the entries that mutate. */
  busy: boolean;
}

/**
 * Row actions menu: run now, edit, delete.
 *
 * Run now and Delete mutate the moment they are chosen, so a request already in flight disables
 * them — otherwise latency is long enough to start a second run, or a deletion, for the same job.
 * Edit only opens a dialog and stays available.
 *
 * @param props - The job, its action callbacks, and whether a mutation is in flight.
 */
export function JobRowMenu({ job, onEdit, onRunNow, onDelete, busy }: JobRowMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${job.name}`} />}
      >
        <Ellipsis />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem
          disabled={busy}
          onClick={() => {
            onRunNow(job);
          }}
        >
          <Play /> Run now
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            onEdit(job);
          }}
        >
          <Pencil /> Edit
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={busy}
          onClick={() => {
            onDelete(job);
          }}
        >
          <Trash2 /> Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
