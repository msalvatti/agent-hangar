/**
 * Public API of the shared transcript module: the domain-free model of a rendered turn, its
 * reducer, the SSE and elapsed-time hooks, and display formatting.
 *
 * Layer: shared (barrel).
 *
 * Components (`Transcript`, `UserMessage`, `AssistantMarkdown`, `ToolCallRow`, `SystemNotice`,
 * `StreamCursor`, `StatusPill`) are added to this barrel by a later task; only the data layer is
 * exported so far.
 */
export type {
  AssistantTranscriptItem,
  ConnectionState,
  ErrorTranscriptItem,
  InitialStateOverrides,
  NoticeTone,
  NoticeTranscriptItem,
  ToolCallStatus,
  ToolTranscriptItem,
  TranscriptAction,
  TranscriptError,
  TranscriptItem,
  TranscriptState,
  TranscriptStopReason,
  TranscriptUsage,
  TurnPhase,
  UserTranscriptItem,
} from './types';
export {
  PREPARE_NOTICE_ID,
  STALL_TIMEOUT_MS,
  TOOL_OUTPUT_DISPLAY_LIMIT_BYTES,
  createInitialState,
} from './types';

export { AGENT_EVENT_TYPES, compareStreamIds, isTerminalPhase, transcriptReducer } from './reducer';

export type {
  CreateEventSource,
  UseTurnEventsOptions,
  UseTurnEventsResult,
} from './hooks/useTurnEvents';
export { useTurnEvents } from './hooks/useTurnEvents';
export { useElapsed } from './hooks/useElapsed';

export {
  formatBytes,
  formatDuration,
  formatElapsed,
  formatTokens,
  relativeTime,
  shortSha,
} from './lib/format';
export { maskSecretShapes, toDisplayJson } from './lib/redact-display';
