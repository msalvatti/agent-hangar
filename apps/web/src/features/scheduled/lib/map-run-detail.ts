/**
 * Maps a `RunDetail` (plus its job, for the prompt) onto the shared transcript model.
 *
 * Layer: service (adapter).
 */
import { toolNameSchema } from '@agent-hangar/core';
import type { JobSummary, RunDetail, ToolCallView } from '@agent-hangar/core';

import { TURN_CANCELLED_NOTICE, utf8ByteLength } from '@/shared/transcript';
import type { ToolCallStatus, TranscriptItem, TurnPhase } from '@/shared/transcript';

import { PHASE_BY_STATUS } from './status';

/** Result of {@link mapRunDetail}. */
export interface MappedRun {
  items: TranscriptItem[];
  phase: TurnPhase;
  startedAt: number | null;
  finishedAt: number | null;
}

const TOOL_STATUS_BY_CONTRACT_STATUS: Record<ToolCallView['status'], ToolCallStatus> = {
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  TIMED_OUT: 'timed_out',
};

function toDate(iso: string | null): number | null {
  return iso === null ? null : Date.parse(iso);
}

/**
 * Converts one persisted tool-call log into a transcript item.
 *
 * The contract types `toolName` as a free string while the transcript renders a known tool, so the
 * name is parsed rather than asserted; a tool this build does not know falls back to `run_shell`,
 * whose summary is a plain command line.
 *
 * @param call - The persisted log row.
 * @returns The tool item.
 */
function toToolItem(call: ToolCallView): TranscriptItem {
  const head = call.resultHead ?? '';
  const name = toolNameSchema.safeParse(call.toolName);
  return {
    kind: 'tool',
    id: call.id,
    callId: call.callId,
    name: name.success ? name.data : 'run_shell',
    args: call.args,
    seq: call.seq,
    status: TOOL_STATUS_BY_CONTRACT_STATUS[call.status],
    stdout: head,
    stderr: '',
    // What is on screen, not what the tool produced: reporting the full size as "shown" is what
    // told the row it had nothing left to admit, so a cut result never said it was cut.
    shownBytes: utf8ByteLength(head),
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
 * Converts a run's recorded error into the row that reports it.
 *
 * A run the scheduler skipped because the previous one was still going is not a failure — nothing
 * ran, and nothing is wrong — so it reads as a notice instead of an error.
 *
 * @param error - The run's error, already redacted.
 * @returns The item that reports it.
 */
function toErrorItem(error: string): TranscriptItem {
  if (error === OVERLAP_ERROR) {
    return { kind: 'notice', id: 'run-error', tone: 'warning', text: `Skipped: ${OVERLAP_ERROR}` };
  }
  return { kind: 'error', id: 'run-error', code: 'RUN_FAILED', message: error };
}

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

  // The stream says a run was stopped and nothing persists that line, but the status the API
  // returns is the same fact, so the reloaded drawer rebuilds it from there.
  if (detail.run.status === 'CANCELLED') {
    items.push({
      kind: 'notice',
      id: 'run-cancelled',
      tone: 'warning',
      text: TURN_CANCELLED_NOTICE,
    });
  }

  if (detail.run.error !== null) {
    items.push(toErrorItem(detail.run.error));
  }

  return {
    items,
    phase: PHASE_BY_STATUS[detail.run.status],
    startedAt: toDate(detail.run.startedAt),
    finishedAt: toDate(detail.run.finishedAt),
  };
}
