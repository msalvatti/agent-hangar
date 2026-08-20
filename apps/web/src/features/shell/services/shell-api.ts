/**
 * The API read the app shell owns: the sidebar's chat lists.
 *
 * Layer: feature (service).
 *
 * The environment health the footer pill draws is not here: the chat composer needs the same
 * report, and features do not import each other, so it lives in `shared/health`.
 */
import type { ApiResponse } from '@agent-hangar/core';

import { apiFetch } from '@/shared/api/client';

/** Lifecycle state a chat list is filtered by. */
export type ShellChatStatus = 'ACTIVE' | 'ARCHIVED';

/**
 * Lists chats in one lifecycle state for the sidebar.
 *
 * @param status - `ACTIVE` or `ARCHIVED`.
 * @param signal - Aborts the request.
 * @returns The chat summaries.
 */
export function listChats(
  status: ShellChatStatus,
  signal: AbortSignal,
): Promise<ApiResponse<'listChats'>> {
  return apiFetch('listChats', { query: { status }, signal });
}
