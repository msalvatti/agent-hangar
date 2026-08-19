/**
 * Tests for the shell's two API reads.
 */
import { healthResponse, listChatsResponse } from '@agent-hangar/core';
import { describe, expect, it } from 'vitest';

import { setScenario } from '@/mocks/scenario';

import { getHealth, listChats } from './shell-api';

describe('shell-api', () => {
  // The sidebar reads both lists through the same wrapper, filtered by lifecycle state.
  it.each(['ACTIVE', 'ARCHIVED'] as const)('lists %s chats', async (status) => {
    const result = await listChats(status, new AbortController().signal);
    expect(listChatsResponse.parse(result).chats.every((chat) => chat.status === status)).toBe(
      true,
    );
  });

  // A healthy environment reports every probe as passing.
  it('reads a healthy environment', async () => {
    const result = healthResponse.parse(await getHealth(new AbortController().signal));
    expect(result.ok).toBe(true);
    expect(result.checks.docker.ok).toBe(true);
  });

  // The infra-down scenario is what the destructive pill renders from.
  it('reads a degraded environment', async () => {
    setScenario('infra-down');
    const result = healthResponse.parse(await getHealth(new AbortController().signal));
    expect(result.checks.docker.ok).toBe(false);
  });
});
