/**
 * Typed wrappers over the chat, turn and settings operations of the API contract.
 *
 * Layer: feature (service).
 *
 * Every call goes through `apiFetch`, which validates request and response against the frozen
 * Zod schemas; these wrappers exist so components name an intent rather than an operation key.
 */
import type { ApiResponse } from '@agent-hangar/core';

import { apiFetch } from '@/shared/api/client';

/** Chat lifecycle state used to filter the sidebar list. */
export type ChatStatusFilter = 'ACTIVE' | 'ARCHIVED';

/**
 * Lists chats in one lifecycle state.
 *
 * @param status - `ACTIVE` or `ARCHIVED`.
 * @param signal - Aborts the request.
 * @returns The chat summaries, newest activity first.
 */
export function listChats(
  status: ChatStatusFilter,
  signal: AbortSignal,
): Promise<ApiResponse<'listChats'>> {
  return apiFetch('listChats', { query: { status }, signal });
}

/**
 * Reads one chat with its messages, turns and tool calls.
 *
 * @param id - Chat id.
 * @param signal - Aborts the request.
 * @returns The chat detail.
 */
export function getChat(id: string, signal: AbortSignal): Promise<ApiResponse<'getChat'>> {
  return apiFetch('getChat', { params: { id }, signal });
}

/**
 * Creates a chat and its first turn.
 *
 * @param body - Repository URL, base branch and the first prompt.
 * @returns The new chat and turn ids.
 */
export function createChat(body: {
  repoUrl: string;
  baseBranch: string;
  prompt: string;
}): Promise<ApiResponse<'createChat'>> {
  return apiFetch('createChat', { body });
}

/**
 * Appends a follow-up prompt to a chat, queueing a new turn.
 *
 * @param id - Chat id.
 * @param prompt - The follow-up prompt.
 * @returns The queued turn id.
 */
export function postMessage(id: string, prompt: string): Promise<ApiResponse<'postMessage'>> {
  return apiFetch('postMessage', { params: { id }, body: { prompt } });
}

/**
 * Renames a chat.
 *
 * @param id - Chat id.
 * @param title - The new title.
 * @returns The updated chat summary.
 */
export function renameChat(id: string, title: string): Promise<ApiResponse<'renameChat'>> {
  return apiFetch('renameChat', { params: { id }, body: { title } });
}

/**
 * Archives a chat and destroys its workspace.
 *
 * @param id - Chat id.
 * @returns The updated chat summary.
 */
export function archiveChat(id: string): Promise<ApiResponse<'archiveChat'>> {
  return apiFetch('archiveChat', { params: { id } });
}

/**
 * Restores an archived chat.
 *
 * @param id - Chat id.
 * @returns The updated chat summary.
 */
export function restoreChat(id: string): Promise<ApiResponse<'restoreChat'>> {
  return apiFetch('restoreChat', { params: { id } });
}

/**
 * Deletes a chat and everything attached to it.
 *
 * @param id - Chat id.
 */
export function deleteChat(id: string): Promise<ApiResponse<'deleteChat'>> {
  return apiFetch('deleteChat', { params: { id } });
}

/**
 * Cancels a running turn.
 *
 * @param turnId - Turn id.
 * @returns The acknowledgement body.
 */
export function cancelTurn(turnId: string): Promise<ApiResponse<'cancelTurn'>> {
  return apiFetch('cancelTurn', { params: { id: turnId } });
}

/**
 * Runs a failed turn again, against the prompt already attached to it.
 *
 * Sends no prompt: the one the turn ran on is already persisted, so the retry adds nothing to the
 * chat's history.
 *
 * @param turnId - Turn id.
 * @returns The acknowledgement body.
 */
export function retryTurn(turnId: string): Promise<ApiResponse<'retryTurn'>> {
  return apiFetch('retryTurn', { params: { id: turnId } });
}

/**
 * Reads which credentials are configured and which model is in use. Never carries plaintext.
 *
 * @param signal - Aborts the request.
 * @returns The settings status.
 */
export function getSettingsStatus(signal: AbortSignal): Promise<ApiResponse<'getSettings'>> {
  return apiFetch('getSettings', { signal });
}
