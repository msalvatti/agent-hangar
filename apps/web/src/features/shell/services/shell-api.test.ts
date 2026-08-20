/**
 * Tests for the shell's chat-list read.
 */
import { listChatsResponse } from '@agent-hangar/core';
import { describe, expect, it } from 'vitest';

import { listChats } from './shell-api';

describe('shell-api', () => {
  // The sidebar reads both lists through the same wrapper, filtered by lifecycle state.
  it.each(['ACTIVE', 'ARCHIVED'] as const)('lists %s chats', async (status) => {
    const result = await listChats(status, new AbortController().signal);
    expect(listChatsResponse.parse(result).chats.every((chat) => chat.status === status)).toBe(
      true,
    );
  });
});
