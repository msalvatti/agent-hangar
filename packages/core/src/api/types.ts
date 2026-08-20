/**
 * TypeScript types of the HTTP API, derived from the Zod schemas in `./contracts.ts`.
 *
 * Layer: contract.
 */
import type { z } from 'zod';

import type {
  apiError,
  branchSummary,
  chatDetail,
  chatSummary,
  createChatRequest,
  createChatResponse,
  healthResponse,
  jobPatchRequest,
  jobSummary,
  jobUpsertRequest,
  messageView,
  postMessageRequest,
  postMessageResponse,
  putSecretRequest,
  putSecretResponse,
  renameChatRequest,
  repoSummary,
  runDetail,
  runSummary,
  settingsKeyParam,
  settingsStatus,
  toolCallView,
  turnView,
  workspaceView,
} from './contracts.ts';

/** Parsed `apiError`. */
export type ApiError = z.infer<typeof apiError>;
/** Parsed `repoSummary`. */
export type RepoSummary = z.infer<typeof repoSummary>;
/** Parsed `branchSummary`. */
export type BranchSummary = z.infer<typeof branchSummary>;
/** Parsed `createChatRequest`. */
export type CreateChatRequest = z.infer<typeof createChatRequest>;
/** Parsed `createChatResponse`. */
export type CreateChatResponse = z.infer<typeof createChatResponse>;
/** Parsed `chatSummary`. */
export type ChatSummary = z.infer<typeof chatSummary>;
/** Parsed `chatDetail`. */
export type ChatDetail = z.infer<typeof chatDetail>;
/** Parsed `messageView`. */
export type MessageView = z.infer<typeof messageView>;
/** Parsed `turnView`. */
export type TurnView = z.infer<typeof turnView>;
/** Parsed `toolCallView`. */
export type ToolCallView = z.infer<typeof toolCallView>;
/** Parsed `workspaceView`. */
export type WorkspaceView = z.infer<typeof workspaceView>;
/** Parsed `renameChatRequest`. */
export type RenameChatRequest = z.infer<typeof renameChatRequest>;
/** Parsed `postMessageRequest`. */
export type PostMessageRequest = z.infer<typeof postMessageRequest>;
/** Parsed `postMessageResponse`. */
export type PostMessageResponse = z.infer<typeof postMessageResponse>;
/** Parsed `jobUpsertRequest`. */
export type JobUpsertRequest = z.infer<typeof jobUpsertRequest>;
/** Parsed `jobPatchRequest`. */
export type JobPatchRequest = z.infer<typeof jobPatchRequest>;
/** Parsed `jobSummary`. */
export type JobSummary = z.infer<typeof jobSummary>;
/** Parsed `runSummary`. */
export type RunSummary = z.infer<typeof runSummary>;
/** Parsed `runDetail`. */
export type RunDetail = z.infer<typeof runDetail>;
/** Parsed `settingsKeyParam`. */
export type SettingsKeyParam = z.infer<typeof settingsKeyParam>;
/** Parsed `settingsStatus`. */
export type SettingsStatus = z.infer<typeof settingsStatus>;
/** Parsed `putSecretRequest`. */
export type PutSecretRequest = z.infer<typeof putSecretRequest>;
/** Parsed `putSecretResponse`. */
export type PutSecretResponse = z.infer<typeof putSecretResponse>;
/** Parsed `healthResponse`. */
export type HealthResponse = z.infer<typeof healthResponse>;
