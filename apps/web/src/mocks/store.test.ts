/**
 * Tests for the in-memory mock store: reset, seeding, id/timestamp generation, and the absence of
 * secret-looking literals.
 */
import { describe, expect, it } from 'vitest';

import { nextId, nowIso, seedChat, store } from './store';

describe('store', () => {
  // The seed carries the three ACTIVE + one ARCHIVED chats the acceptance criteria describe.
  it('seeds three ACTIVE chats and one ARCHIVED chat', () => {
    const active = store.chats.filter((entry) => entry.chat.status === 'ACTIVE');
    const archived = store.chats.filter((entry) => entry.chat.status === 'ARCHIVED');
    expect(active).toHaveLength(3);
    expect(archived).toHaveLength(1);
  });

  // Both secrets are set by default, and only last4/updatedAt are ever stored.
  it('seeds both secrets with only last4 and updatedAt', () => {
    expect(store.secrets.GITHUB_PAT?.last4).toEqual(expect.any(String));
    expect(store.secrets.OPENAI_API_KEY?.last4).toEqual(expect.any(String));
    expect(Object.keys(store.secrets.GITHUB_PAT ?? {}).sort()).toEqual(['last4', 'updatedAt']);
  });

  // No secret-shaped literal (a real GitHub PAT / OpenAI key prefix) ever appears in the store.
  it('never stores a secret-shaped literal', () => {
    const serialized = JSON.stringify(store);
    expect(serialized).not.toMatch(/ghp_[A-Za-z0-9]{10,}/);
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9_-]{10,}/);
  });

  function extraChat(title: string) {
    return {
      chat: {
        id: 'chat-extra',
        title,
        status: 'ACTIVE' as const,
        repoUrl: 'https://github.com/acme/api',
        baseBranch: 'main',
        workBranch: null,
        lastPushedSha: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        archivedAt: null,
        lastTurnStatus: null,
      },
      messages: [],
      turns: [],
      toolCalls: [],
      workspace: null,
    };
  }

  // seedChat() adds a new chat when its id is not already present, and replaces it in place
  // (rather than duplicating it) on a second call with the same id.
  it('seedChat() adds a new chat by id, then replaces it in place', () => {
    const before = store.chats.length;
    seedChat(extraChat('Extra'));
    expect(store.chats).toHaveLength(before + 1);
    expect(store.chats.find((entry) => entry.chat.id === 'chat-extra')?.chat.title).toBe('Extra');

    seedChat(extraChat('Replaced'));
    expect(store.chats).toHaveLength(before + 1);
    expect(store.chats.find((entry) => entry.chat.id === 'chat-extra')?.chat.title).toBe(
      'Replaced',
    );
  });

  // nextId() produces distinct ids.
  it('nextId() produces distinct ids', () => {
    expect(nextId()).not.toBe(nextId());
  });

  // nowIso() produces a valid, parseable ISO timestamp.
  it('nowIso() produces a parseable ISO timestamp', () => {
    expect(Number.isNaN(Date.parse(nowIso()))).toBe(false);
  });
});
