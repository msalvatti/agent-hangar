/**
 * Unit tests for the settings mock handlers.
 *
 * Layer: unit.
 * Goal: `PUT` stores only `last4`/`updatedAt` (never plaintext) and validates the body; `DELETE`
 * clears a secret and answers 204; both reject an unknown key with 404.
 * Mocks: MSW node server; the canaries from `@agent-hangar/core/testing` stand in for real
 * credentials.
 */
import { GITHUB_CANARY } from '@agent-hangar/core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { apiFetch } from '@/shared/api/client';

import { resetStore, store } from './store';

afterEach(() => {
  resetStore();
});

describe('PUT /api/settings/:key', () => {
  /** A valid secret is stored as last4/updatedAt only; the plaintext never reaches the store. */
  it('stores last4 and updatedAt, never the plaintext', async () => {
    const result = await apiFetch('putSecret', {
      params: { key: 'GITHUB_PAT' },
      body: { value: GITHUB_CANARY },
    });
    expect(result).toEqual({ set: true, last4: GITHUB_CANARY.slice(-4) });
    expect(store.secrets.GITHUB_PAT?.last4).toBe(GITHUB_CANARY.slice(-4));
    expect(JSON.stringify(store.secrets)).not.toContain(GITHUB_CANARY);
  });

  /** An unknown key answers 404. */
  it('answers 404 for an unknown key', async () => {
    await expect(
      apiFetch('putSecret', {
        params: { key: 'AWS_KEY' },
        body: { value: 'x'.repeat(20) },
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  /**
   * A value shorter than the schema minimum answers 400. Sent with a raw `fetch` (rather than
   * `apiFetch`) so the request reaches the handler's own schema check instead of being rejected
   * client-side first.
   */
  it('rejects a value shorter than the schema minimum', async () => {
    const response = await fetch('/api/settings/OPENAI_API_KEY', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'short' }),
    });
    expect(response.status).toBe(400);
  });

  /** A value that is only whitespace trims to empty and answers 400. */
  it('rejects a whitespace-only value', async () => {
    await expect(
      apiFetch('putSecret', { params: { key: 'OPENAI_API_KEY' }, body: { value: '        ' } }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('DELETE /api/settings/:key', () => {
  /** Deleting a set secret clears it; the response resolves to undefined (204). */
  it('clears a stored secret', async () => {
    await apiFetch('putSecret', {
      params: { key: 'GITHUB_PAT' },
      body: { value: GITHUB_CANARY },
    });
    await expect(
      apiFetch('deleteSecret', { params: { key: 'GITHUB_PAT' } }),
    ).resolves.toBeUndefined();
    expect(store.secrets.GITHUB_PAT).toBeUndefined();
  });

  /** An unknown key answers 404. */
  it('answers 404 for an unknown key', async () => {
    await expect(apiFetch('deleteSecret', { params: { key: 'AWS_KEY' } })).rejects.toMatchObject({
      status: 404,
    });
  });
});
