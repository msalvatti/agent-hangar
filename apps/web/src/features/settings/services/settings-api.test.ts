/**
 * Unit tests for the settings service layer.
 *
 * Layer: unit.
 * Goal: every function calls the right route with the right shape and returns the unwrapped
 * payload the mock handlers produce; a saved secret's last4 comes back from `putSecret`, and
 * `deleteSecret` resolves without a body.
 * Mocks: MSW node server serving `src/mocks/{settings,settings-status,health}.ts`.
 */
import { GITHUB_CANARY, OPENAI_CANARY } from '@agent-hangar/core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { setScenario } from '@/mocks/scenario';
import { resetStore } from '@/mocks/store';

import { deleteSecret, getHealth, getSettings, putSecret } from './settings-api';

afterEach(() => {
  resetStore();
});

describe('getSettings', () => {
  /** The seeded instance already holds both credentials, masked down to their last four. */
  it('returns the masked status of both seeded secrets', async () => {
    const settings = await getSettings();
    expect(settings.githubPat).toMatchObject({ set: true, last4: 'ab12' });
    expect(settings.openaiKey).toMatchObject({ set: true, last4: 'cd34' });
  });

  /** A fresh instance has neither credential, which is what the onboarding notice keys off. */
  it('reports both secrets unset on an instance with none', async () => {
    setScenario('missing-settings');
    const settings = await getSettings();
    expect(settings.githubPat.set).toBe(false);
    expect(settings.openaiKey.set).toBe(false);
  });

  /** Forwards an abort signal to the underlying fetch. */
  it('honours an abort signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(getSettings(controller.signal)).rejects.toThrow();
  });
});

describe('putSecret', () => {
  /** Saves a secret and returns its last4. */
  it('saves the GitHub token and returns its last4', async () => {
    const last4 = await putSecret('GITHUB_PAT', GITHUB_CANARY);
    expect(last4).toBe(GITHUB_CANARY.slice(-4));
  });
});

describe('deleteSecret', () => {
  /** Removes a previously saved secret. */
  it('removes a saved secret', async () => {
    await putSecret('OPENAI_API_KEY', OPENAI_CANARY);
    await deleteSecret('OPENAI_API_KEY');
    const settings = await getSettings();
    expect(settings.openaiKey.set).toBe(false);
  });
});

describe('getHealth', () => {
  /** Returns the health response. */
  it('returns a healthy response by default', async () => {
    const health = await getHealth();
    expect(health.ok).toBe(true);
  });
});
