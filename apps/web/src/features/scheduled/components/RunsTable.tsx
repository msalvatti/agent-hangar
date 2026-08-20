/**
 * A job's runs table: started, duration, trigger, status, tokens — newest first.
 *
 * Layer: component.
 */
'use client';

import type { RunSummary } from '@agent-hangar/core';

import {
  Table,
  TableBody,
  TableCaption,
  TableHead,
  TableHeader,
  TableRow,
} from '@/shared/ui/table';

import { RunRow } from './RunRow';

/** Props of {@link RunsTable}. */
export interface RunsTableProps {
  runs: readonly RunSummary[];
  onOpen: (runId: string) => void;
}

const HEADERS = ['Started', 'Duration', 'Trigger', 'Status', 'Tokens'] as const;

/**
 * Renders a job's runs, one row per run.
 *
 * @param props - The runs and the row-open callback.
 */
export function RunsTable({ runs, onOpen }: RunsTableProps) {
  return (
    <div className="border-border overflow-x-auto rounded-[10px] border">
      <Table>
        <TableCaption className="sr-only">Runs</TableCaption>
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
          {runs.map((run) => (
            <RunRow key={run.id} run={run} onOpen={onOpen} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
