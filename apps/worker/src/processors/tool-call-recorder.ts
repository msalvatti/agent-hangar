/**
 * Turning the runtime's tool events into `ToolCallLog` rows and, at the end, into the one-line
 * summaries a later turn reads instead of replaying megabytes of output.
 *
 * Layer: service.
 *
 * Shared by chat turns and scheduled runs, which differ only in whether the row points at a turn
 * or at a job run. The output head is bounded here rather than at the repository: keeping the
 * whole of a `cat` of a large file in worker memory for the length of a turn is the leak, and it
 * happens long before the row is written.
 */
import { toolSummaryText } from '@agent-hangar/core';
import type { AgentEventOf, ToolCallSummaryInput } from '@agent-hangar/core';

import { TOOL_OUTPUT_HEAD_BYTES } from './constants.js';
import type { ProcessorDeps } from './types.js';

/** Which run a tool call belongs to; exactly one of the two ids is set. */
export interface ToolCallTarget {
  workspaceId: string;
  turnId?: string;
  jobRunId?: string;
}

/** Records tool calls and hands back their summaries. */
export interface ToolCallRecorder {
  /**
   * Records a call that has started.
   *
   * @param event - The `tool.call` event, already redacted.
   */
  start(event: AgentEventOf<'tool.call'>): Promise<void>;
  /**
   * Accumulates a chunk of a call's output, up to the head budget.
   *
   * @param event - The `tool.output.delta` event, already redacted.
   */
  append(event: AgentEventOf<'tool.output.delta'>): void;
  /**
   * Records a call's outcome.
   *
   * @param event - The `tool.result` event, already redacted.
   */
  finish(event: AgentEventOf<'tool.result'>): Promise<void>;
  /**
   * The summary lines of every finished call, in the order the agent made them.
   *
   * @returns One line per finished call.
   */
  summaries(): string[];
}

/** What the recorder remembers about one call between its start and its result. */
interface CallState {
  /** `ToolCallLog.id`. */
  logId: string;
  /** Position within the turn, used to order the summaries. */
  seq: number;
  /** The tool the agent called. */
  toolName: ToolCallSummaryInput['toolName'];
  /** Arguments as logged; treated as untrusted and read defensively. */
  args: unknown;
  /** First {@link TOOL_OUTPUT_HEAD_BYTES} of the output. */
  head: string;
  /**
   * What the call ended as, present only once a result has arrived.
   *
   * Its absence is what "still running" means here, rather than a placeholder outcome standing in
   * until a real one replaces it: a call with no result has no exit code, no duration and no
   * status to report, and a summary rendered from invented ones would read like a call that ended.
   */
  outcome?: ToolCallSummaryInput;
}

/**
 * Appends as much of a chunk as the byte budget still allows.
 *
 * Characters are measured one at a time near the boundary so the head never ends mid-character:
 * cutting the byte array instead would write a replacement character into the transcript.
 *
 * @param head - What has been kept so far.
 * @param text - The new chunk.
 * @param maxBytes - Total budget in UTF-8 bytes.
 * @returns The head, extended by as much of the chunk as fits.
 */
export function appendWithinBudget(head: string, text: string, maxBytes: number): string {
  // One loop and no fast paths. A chunk that fits whole is the loop running to the end, and a head
  // that has already spent the budget is the loop stopping at its first character — so a shortcut
  // for either would be a branch no input could tell apart from the path it skips.
  const budget = maxBytes - Buffer.byteLength(head);
  let taken = '';
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > budget) {
      break;
    }
    bytes += size;
    taken += character;
  }
  return head + taken;
}

/**
 * Builds a recorder for one run.
 *
 * @param deps - Repositories and logger.
 * @param target - The workspace and the run the rows belong to.
 * @returns The recorder.
 */
export function createToolCallRecorder(
  deps: ProcessorDeps,
  target: ToolCallTarget,
): ToolCallRecorder {
  const calls = new Map<string, CallState>();

  const lookup = (callId: string, what: string): CallState | undefined => {
    const state = calls.get(callId);
    if (state === undefined) {
      deps.logger.warn({ callId, event: what }, 'tool event for an unknown call');
    }
    return state;
  };

  return {
    async start(event): Promise<void> {
      const log = await deps.repos.toolCalls.start({
        workspaceId: target.workspaceId,
        // Spread conditionally because these are optional properties this project may not hand an
        // explicit `undefined`, and a row belongs to a turn or to a run and never to both. The
        // repository writes the absent one as `null` either way, so no caller can tell the two
        // spellings apart.
        // Stryker disable next-line ConditionalExpression
        ...(target.turnId === undefined ? {} : { turnId: target.turnId }),
        // Stryker disable next-line ConditionalExpression
        ...(target.jobRunId === undefined ? {} : { jobRunId: target.jobRunId }),
        callId: event.callId,
        seq: event.seq,
        toolName: event.name,
        args: event.args,
      });
      calls.set(event.callId, {
        logId: log.id,
        seq: event.seq,
        toolName: event.name,
        args: event.args,
        head: '',
      });
    },

    append(event): void {
      const state = lookup(event.callId, event.type);
      if (state !== undefined) {
        state.head = appendWithinBudget(state.head, event.text, TOOL_OUTPUT_HEAD_BYTES);
      }
    },

    async finish(event): Promise<void> {
      const state = lookup(event.callId, event.type);
      if (state === undefined) {
        return;
      }
      state.outcome = {
        toolName: state.toolName,
        args: state.args,
        status: event.status,
        exitCode: event.exitCode,
        durationMs: event.durationMs,
        resultBytes: event.bytes,
      };
      await deps.repos.toolCalls.finish(state.logId, {
        status: event.status,
        exitCode: event.exitCode,
        resultHead: state.head === '' ? null : state.head,
        resultBytes: event.bytes,
        durationMs: event.durationMs,
      });
    },

    summaries(): string[] {
      return [...calls.values()]
        .toSorted((left, right) => left.seq - right.seq)
        .flatMap((state) => (state.outcome === undefined ? [] : [toolSummaryText(state.outcome)]));
    },
  };
}
