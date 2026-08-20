/**
 * The two API reads the app shell needs: the chat lists and the environment health.
 *
 * Layer: feature (service).
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

/**
 * Reads the environment health shown in the sidebar footer.
 *
 * @param signal - Aborts the request.
 * @returns The health report.
 */
export function getHealth(signal: AbortSignal): Promise<ApiResponse<'getHealth'>> {
  return apiFetch('getHealth', { signal });
}
