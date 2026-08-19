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
}

/**
 * Row actions menu: run now, edit, delete.
 *
 * @param props - The job and its action callbacks.
 */
export function JobRowMenu({ job, onEdit, onRunNow, onDelete }: JobRowMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${job.name}`} />}
      >
        <Ellipsis />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem
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
