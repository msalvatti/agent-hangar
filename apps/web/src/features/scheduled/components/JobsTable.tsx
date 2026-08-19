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

import { JobRow } from './JobRow';

/** Props of {@link JobsTable}. */
export interface JobsTableProps {
  jobs: readonly JobSummary[];
  overrides: Readonly<Record<string, boolean>>;
  pending: Readonly<Record<string, boolean>>;
  onToggle: (job: JobSummary, enabled: boolean) => void;
  onEdit: (job: JobSummary) => void;
  onRunNow: (job: JobSummary) => void;
  onDelete: (job: JobSummary) => void;
}

const HEADERS = [
  'Name',
  'Schedule',
  'Repo · Branch',
  'Last run',
  'Next run',
  'Enabled',
  '',
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
              <TableHead key={header} className="text-muted-foreground text-[11px] uppercase">
                {header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              enabled={overrides[job.id] ?? job.enabled}
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
