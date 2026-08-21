/**
 * Public API of the shared transcript module: the domain-free model of a rendered turn, its
 * reducer, the SSE and elapsed-time hooks, display formatting, and the rendering components.
 *
 * Layer: shared (barrel).
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
  prepareNoticeId,
  STALL_TIMEOUT_MS,
  TOOL_OUTPUT_DISPLAY_LIMIT_BYTES,
  TURN_CANCELLED_NOTICE,
  createInitialState,
} from './types';

export { AGENT_EVENT_TYPES, compareStreamIds, isTerminalPhase, transcriptReducer } from './reducer';

export type {
  CreateEventSource,
  ReconnectOptions,
  UseTurnEventsOptions,
  UseTurnEventsResult,
} from './hooks/useTurnEvents';
export { useTurnEvents } from './hooks/useTurnEvents';
export { useElapsed } from './hooks/useElapsed';

export {
  formatBytes,
  formatDuration,
  formatElapsed,
  formatTimestamp,
  formatTokens,
  relativeTime,
  utf8ByteLength,
} from './lib/format';
export { assertPresent } from './lib/assert';
export { maskSecretShapes, toDisplayJson } from './lib/redact-display';
export { summarizeArgs } from './lib/summarize-args';

export type { AssistantMarkdownProps } from './components/AssistantMarkdown';
export { AssistantMarkdown } from './components/AssistantMarkdown';
export type { CopyButtonProps } from './components/CopyButton';
export { CopyButton } from './components/CopyButton';
export type { JumpToLatestProps } from './components/JumpToLatest';
export { JumpToLatest } from './components/JumpToLatest';
export type { StatusPillProps } from './components/StatusPill';
export { StatusPill } from './components/StatusPill';
export type { StreamCursorProps } from './components/StreamCursor';
export { StreamCursor } from './components/StreamCursor';
export type { SystemNoticeProps } from './components/SystemNotice';
export { SystemNotice } from './components/SystemNotice';
export type { ToolCallRowProps } from './components/ToolCallRow';
export { ToolCallRow } from './components/ToolCallRow';
export type { TranscriptProps } from './components/Transcript';
export { Transcript } from './components/Transcript';
export type { UserMessageProps } from './components/UserMessage';
export { UserMessage } from './components/UserMessage';
