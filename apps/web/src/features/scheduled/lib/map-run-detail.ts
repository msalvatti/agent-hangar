/**
 * Maps a `RunDetail` (plus its job, for the prompt) onto the shared transcript model.
 *
 * Layer: service (adapter).
 */
import type {
  JobRunStatus,
  JobSummary,
  RunDetail,
  ToolCallView,
  ToolName,
} from '@agent-hangar/core';

import type { ToolCallStatus, TranscriptItem, TurnPhase } from '@/shared/transcript';

/** Result of {@link mapRunDetail}. */
export interface MappedRun {
  items: TranscriptItem[];
  phase: TurnPhase;
  startedAt: number | null;
  finishedAt: number | null;
}

const PHASE_BY_STATUS: Record<JobRunStatus, TurnPhase> = {
  QUEUED: 'queued',
  PREPARING: 'preparing',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

const TOOL_STATUS_BY_CONTRACT_STATUS: Record<ToolCallView['status'], ToolCallStatus> = {
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  TIMED_OUT: 'timed_out',
};

function toDate(iso: string | null): number | null {
  return iso === null ? null : Date.parse(iso);
}

function toToolItem(call: ToolCallView): TranscriptItem {
  const shownBytes = call.resultBytes ?? 0;
  return {
    kind: 'tool',
    id: call.id,
    callId: call.callId,
    name: call.toolName as ToolName,
    args: call.args,
    seq: call.seq,
    status: TOOL_STATUS_BY_CONTRACT_STATUS[call.status],
    stdout: call.resultHead ?? '',
    stderr: '',
    shownBytes,
    totalBytes: call.resultBytes,
    exitCode: call.exitCode,
    durationMs: call.durationMs,
    // `ToolCallView.startedAt` is a required (non-nullable) timestamp, unlike the run-level
    // instants `toDate` exists for.
    startedAt: Date.parse(call.startedAt),
  };
}

const OVERLAP_ERROR = 'previous run still running';

/**
 * Folds a run's persisted history (prompt, tool calls, output, error) into the shared transcript
 * model, in field-name and status-vocabulary order defined by the contract.
 *
 * @param detail - The run detail (run summary, output, tool calls).
 * @param job - The owning job, for the run's prompt (the contract does not store it per-run).
 * @returns The transcript items, phase and start/finish instants.
 */
export function mapRunDetail(detail: RunDetail, job?: JobSummary): MappedRun {
  const items: TranscriptItem[] = [];

  if (job !== undefined) {
    items.push({ kind: 'user', id: 'prompt', text: job.prompt });
  }

  for (const call of detail.toolCalls) {
    items.push(toToolItem(call));
  }

  if (detail.output !== null) {
    items.push({ kind: 'assistant', id: 'output', text: detail.output, streaming: false });
  }

  if (detail.run.error !== null) {
    if (detail.run.error === OVERLAP_ERROR) {
      items.push({
        kind: 'notice',
        id: 'run-error',
        tone: 'warning',
        text: `Skipped: ${OVERLAP_ERROR}`,
      });
    } else {
      items.push({
        kind: 'error',
        id: 'run-error',
        code: 'RUN_FAILED',
        message: detail.run.error,
      });
    }
  }

  return {
    items,
    phase: PHASE_BY_STATUS[detail.run.status],
    startedAt: toDate(detail.run.startedAt),
    finishedAt: toDate(detail.run.finishedAt),
  };
}
