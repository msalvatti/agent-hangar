/**
 * Scheduled-jobs table: name, schedule, repo/branch, last/next run, enabled switch, row menu.
 *
 * Layer: component.
 */
'use client';

import type { JobSummary } from '@agent-hangar/core';

import {
  Table,
  TableBody,
  TableCaption,
  TableHead,
  TableHeader,
  TableRow,
} from '@/shared/ui/table';

import { resolveEnabled } from '../hooks/useJobActions';
import type { EnabledOverrides } from '../hooks/useJobActions';

import { JobRow } from './JobRow';

/** Props of {@link JobsTable}. */
export interface JobsTableProps {
  jobs: readonly JobSummary[];
  overrides: EnabledOverrides;
  pending: Readonly<Record<string, boolean>>;
  onToggle: (job: JobSummary, enabled: boolean) => void;
  onEdit: (job: JobSummary) => void;
  onRunNow: (job: JobSummary) => void;
  onDelete: (job: JobSummary) => void;
}

/**
 * Column headers, in order. The row-menu column is named too — an empty header leaves its data
 * cells with no header to associate with, which assistive technology reports as an unlabelled
 * cell — and hidden visually, because the menu button already reads as an action.
 */
const HEADERS = [
  { label: 'Name', visible: true },
  { label: 'Schedule', visible: true },
  { label: 'Repo · Branch', visible: true },
  { label: 'Last run', visible: true },
  { label: 'Next run', visible: true },
  { label: 'Enabled', visible: true },
  { label: 'Actions', visible: false },
] as const;

/**
 * Renders the jobs table, one row per job.
 *
 * @param props - Jobs plus optimistic/pending state and row action callbacks.
 */
export function JobsTable({
  jobs,
  overrides,
  pending,
  onToggle,
  onEdit,
  onRunNow,
  onDelete,
}: JobsTableProps) {
  return (
    <div className="border-border overflow-x-auto rounded-[10px] border">
      <Table>
        <TableCaption className="sr-only">Scheduled jobs</TableCaption>
        <TableHeader>
          <TableRow>
            {HEADERS.map((header) => (
              <TableHead key={header.label} className="text-muted-foreground text-[11px] uppercase">
                {header.visible ? header.label : <span className="sr-only">{header.label}</span>}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              enabled={resolveEnabled(job, overrides)}
              busy={pending[job.id] === true}
              onToggle={onToggle}
              onEdit={onEdit}
              onRunNow={onRunNow}
              onDelete={onDelete}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
