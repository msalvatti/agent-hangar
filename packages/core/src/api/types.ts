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
} from './contracts.js';

export type ApiError = z.infer<typeof apiError>;
export type RepoSummary = z.infer<typeof repoSummary>;
export type BranchSummary = z.infer<typeof branchSummary>;
export type CreateChatRequest = z.infer<typeof createChatRequest>;
export type CreateChatResponse = z.infer<typeof createChatResponse>;
export type ChatSummary = z.infer<typeof chatSummary>;
export type ChatDetail = z.infer<typeof chatDetail>;
export type MessageView = z.infer<typeof messageView>;
export type TurnView = z.infer<typeof turnView>;
export type ToolCallView = z.infer<typeof toolCallView>;
export type WorkspaceView = z.infer<typeof workspaceView>;
export type RenameChatRequest = z.infer<typeof renameChatRequest>;
export type PostMessageRequest = z.infer<typeof postMessageRequest>;
export type PostMessageResponse = z.infer<typeof postMessageResponse>;
export type JobUpsertRequest = z.infer<typeof jobUpsertRequest>;
export type JobPatchRequest = z.infer<typeof jobPatchRequest>;
export type JobSummary = z.infer<typeof jobSummary>;
export type RunSummary = z.infer<typeof runSummary>;
export type RunDetail = z.infer<typeof runDetail>;
export type SettingsKeyParam = z.infer<typeof settingsKeyParam>;
export type SettingsStatus = z.infer<typeof settingsStatus>;
export type PutSecretRequest = z.infer<typeof putSecretRequest>;
export type PutSecretResponse = z.infer<typeof putSecretResponse>;
export type HealthResponse = z.infer<typeof healthResponse>;
