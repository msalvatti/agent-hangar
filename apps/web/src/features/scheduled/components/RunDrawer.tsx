/**
 * Run drawer: transcript (live while active) and raw-output tabs for one run.
 *
 * Layer: component.
 *
 * An `expired` frame (the server's replay window lapsed) closes the stream; the drawer recovers
 * by refetching the persisted run, reseeding the transcript from that fresh snapshot, and — if
 * the run is still active — explicitly reconnecting, since the events URL is keyed on the run id
 * alone and does not change just because the same run is still going.
 */
'use client';

import type { JobSummary } from '@agent-hangar/core';
import { Copy, Square } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

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
import { isActivePhase } from '../lib/status';

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
  const seededRunId = useRef<string | null>(null);
  // Set once an `expired` frame closes the stream, cleared once the resulting refetch has been
  // folded back in (or the drawer closes). Distinguishes "waiting on the refetch this expiry
  // triggered" from any other render that happens to see a fresh `mapped`.
  const recoveringFromExpiry = useRef(false);

  const loadErrorMessage = runQuery.error?.message ?? '';
  const runDetail = runQuery.data;
  // Memoized so its identity changes only when the persisted run (or job) actually changes —
  // never on a re-render triggered by something else, like `stopDialogOpen`. The recovery effect
  // below relies on that: it reacts to `mapped` changing, and an unmemoized `mapped` would change
  // on every render, firing for reasons that have nothing to do with a refetch completing.
  const mapped = useMemo(
    () => (runDetail === undefined ? null : mapRunDetail(runDetail, job)),
    [runDetail, job],
  );
  const wasActiveOnLoad = mapped !== null && isActivePhase(mapped.phase);
  const eventsUrl = wasActiveOnLoad && runId !== null ? `/api/runs/${runId}/events` : null;

  const { state, dispatch, reconnect } = useTurnEvents({
    url: eventsUrl,
    initialItems: mapped?.items ?? [],
    initialPhase: mapped?.phase ?? 'idle',
    createEventSource,
  });

  // Seeding is keyed on the drawer being open, not only on the run changing: the run query is
  // disabled while the drawer is closed and the stream is disconnected, so anything that happened
  // in the meantime lives only in the run detail fetched on reopen. Forgetting the seed on close
  // is what makes reopening the same run pick that up instead of redisplaying a stale transcript.
  useEffect(() => {
    if (!open) {
      seededRunId.current = null;
      recoveringFromExpiry.current = false;
      return;
    }
    if (mapped !== null && runId !== seededRunId.current) {
      seededRunId.current = runId;
      dispatch({ type: 'reset', items: mapped.items, phase: mapped.phase });
    }
  }, [open, mapped, runId, dispatch]);

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
    if (state.connection === 'expired' && !recoveringFromExpiry.current) {
      recoveringFromExpiry.current = true;
      void refetch();
    }
  }, [state.connection, refetch]);

  // Reconciles the drawer with the record the expiry-triggered refetch above just reloaded.
  // Fires once that refetch actually lands — `mapped` changing identity is how a memoized value
  // signals a new persisted snapshot — and only while `recoveringFromExpiry` marks that the
  // change is the one this recovery is waiting for, not some unrelated refetch.
  //
  // Reseeding is necessary but not sufficient: `eventsUrl` is built from the run id, which has
  // not changed, so it stays the same string and the connection effect never reopens on its own.
  // `reconnect()` is what actually asks for a new stream, resuming from the cursor the fresh
  // reducer state now carries — without it the run would sit fully caught up on history but with
  // no way to receive whatever happens next.
  useEffect(() => {
    if (!recoveringFromExpiry.current || mapped === null) {
      return;
    }
    recoveringFromExpiry.current = false;
    dispatch({ type: 'reset', items: mapped.items, phase: mapped.phase });
    if (isActivePhase(mapped.phase)) {
      reconnect();
    }
  }, [mapped, dispatch, reconnect]);

  const isActiveNow = isActivePhase(displayPhase);
  const lastAssistantText =
    displayItems
      .filter((item) => item.kind === 'assistant')
      .map((item) => item.text)
      .at(-1) ?? null;
  const persistedOutput = runQuery.data?.output ?? null;
  const outputText = persistedOutput ?? lastAssistantText;
  const startedAt = runQuery.data?.run.startedAt;
  const startedAtMs = startedAt == null ? null : Date.parse(startedAt);

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
            <StatusPill phase={displayPhase} startedAt={startedAtMs} />
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
