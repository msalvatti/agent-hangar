/**
 * Run drawer: transcript (live while active) and raw-output tabs for one run.
 *
 * Layer: component.
 */
'use client';

import type { JobSummary } from '@agent-hangar/core';
import { Copy, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { invalidateQueries } from '@/shared/api/use-api-query';
import { ErrorCard } from '@/shared/feedback';
import {
  StatusPill,
  Transcript,
  createInitialState,
  isTerminalPhase,
  useTurnEvents,
} from '@/shared/transcript';
import type { CreateEventSource } from '@/shared/transcript';
import { Button } from '@/shared/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/shared/ui/sheet';
import { Skeleton } from '@/shared/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/ui/tabs';

import { useRun } from '../hooks/useRun';
import { useRunActions } from '../hooks/useRunActions';
import { mapRunDetail } from '../lib/map-run-detail';

import { RunRawOutput } from './RunRawOutput';
import { StopRunDialog } from './StopRunDialog';

/** Props of {@link RunDrawer}. */
export interface RunDrawerProps {
  runId: string | null;
  job: JobSummary | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `EventSource` factory, injectable for tests. */
  createEventSource?: CreateEventSource;
}

const ACTIVE_PHASES = new Set(['preparing', 'running']);

/**
 * The run detail drawer: a `Transcript` (streaming live via SSE while the run is active) and a
 * raw-output tab.
 *
 * @param props - The run/job being shown, open state, and a test-only `EventSource` factory.
 */
export function RunDrawer({ runId, job, open, onOpenChange, createEventSource }: RunDrawerProps) {
  const runQuery = useRun(open ? runId : null);
  const { stop, copyId } = useRunActions();
  const [stopDialogOpen, setStopDialogOpen] = useState(false);
  const lastLoadedRunId = useRef<string | null>(null);

  const loadErrorMessage = runQuery.error?.message ?? '';
  const mapped = runQuery.data === undefined ? null : mapRunDetail(runQuery.data, job);
  const wasActiveOnLoad = mapped !== null && ACTIVE_PHASES.has(mapped.phase);
  const eventsUrl = wasActiveOnLoad && runId !== null ? `/api/runs/${runId}/events` : null;

  const { state, dispatch } = useTurnEvents({
    url: eventsUrl,
    initialItems: mapped?.items ?? [],
    initialPhase: mapped?.phase ?? 'idle',
    createEventSource,
  });

  useEffect(() => {
    if (mapped !== null && runId !== lastLoadedRunId.current) {
      lastLoadedRunId.current = runId;
      dispatch({ type: 'reset', items: mapped.items, phase: mapped.phase });
    }
  }, [mapped, runId, dispatch]);

  const liveState = wasActiveOnLoad ? state : createInitialState({ items: mapped?.items ?? [] });
  const displayItems = wasActiveOnLoad ? state.items : (mapped?.items ?? []);
  const displayPhase = wasActiveOnLoad ? state.phase : (mapped?.phase ?? 'idle');

  useEffect(() => {
    if (wasActiveOnLoad && isTerminalPhase(state.phase) && job !== undefined) {
      invalidateQueries(['runs', job.id]);
    }
  }, [wasActiveOnLoad, state.phase, job]);

  const { refetch } = runQuery;
  useEffect(() => {
    if (state.connection === 'expired') {
      void refetch();
    }
  }, [state.connection, refetch]);

  const isActiveNow = ACTIVE_PHASES.has(displayPhase);
  const lastAssistantText =
    displayItems
      .filter((item) => item.kind === 'assistant')
      .map((item) => item.text)
      .at(-1) ?? null;
  const persistedOutput = runQuery.data?.output ?? null;
  const outputText = persistedOutput ?? lastAssistantText;
  const startedAt = runQuery.data?.run.startedAt;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full p-0 sm:max-w-[720px]" side="right">
        <SheetHeader className="flex-row items-center justify-between border-b">
          <div className="flex flex-col gap-0.5">
            <SheetTitle>{job?.name ?? 'Run'}</SheetTitle>
            {startedAt != null && (
              <p className="text-muted-foreground text-xs">
                Started {new Date(startedAt).toLocaleString()}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <StatusPill phase={displayPhase} />
            {isActiveNow && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Stop run"
                onClick={() => {
                  setStopDialogOpen(true);
                }}
              >
                <Square />
              </Button>
            )}
            {runId !== null && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Copy run id"
                onClick={() => {
                  void copyId(runId);
                }}
              >
                <Copy />
              </Button>
            )}
          </div>
        </SheetHeader>
        {runQuery.status === 'loading' && (
          <div className="flex flex-col gap-2 p-4">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        )}
        {runQuery.status === 'error' && (
          <ErrorCard
            variant="compact"
            className="m-4"
            title="Could not load the run"
            message={loadErrorMessage}
          />
        )}
        {runQuery.status === 'success' && (
          <Tabs defaultValue="transcript" className="min-h-0 flex-1">
            <TabsList className="mx-4 mt-2 w-fit">
              <TabsTrigger value="transcript">Transcript</TabsTrigger>
              <TabsTrigger value="raw">Raw output</TabsTrigger>
            </TabsList>
            <TabsContent value="transcript" className="min-h-0 flex-1 overflow-y-auto">
              {liveState.connection === 'reconnecting' && (
                <p className="text-muted-foreground bg-muted px-4 py-1 text-center text-xs">
                  Reconnecting…
                </p>
              )}
              <Transcript
                items={displayItems}
                phase={displayPhase}
                readOnly
                emptyText="No activity yet."
              />
            </TabsContent>
            <TabsContent value="raw">
              <RunRawOutput output={outputText} />
            </TabsContent>
          </Tabs>
        )}
      </SheetContent>
      {runId !== null && (
        <StopRunDialog
          open={stopDialogOpen}
          onOpenChange={setStopDialogOpen}
          onConfirm={() => {
            setStopDialogOpen(false);
            void stop(runId);
          }}
        />
      )}
    </Sheet>
  );
}
