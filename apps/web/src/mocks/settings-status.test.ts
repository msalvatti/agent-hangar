/**
 * Tests for the settings-status mock handler: contract shape and the missing-settings scenario.
 */
import { settingsStatus } from '@agent-hangar/core';
import { describe, expect, it } from 'vitest';

import { setScenario } from './scenario';

describe('GET /api/settings', () => {
  // Both secrets are set by default, with only last4 exposed (never a plaintext value).
  it('returns both secrets set, satisfying settingsStatus', async () => {
    const response = await fetch('/api/settings');
    expect(response.status).toBe(200);
    const body = settingsStatus.parse(await response.json());
    expect(body.githubPat.set).toBe(true);
    expect(body.githubPat.last4).toHaveLength(4);
    expect(body.openaiKey.set).toBe(true);
    expect(body.model).toBe('gpt-5.6-sol');
  });

  // The missing-settings scenario reports both secrets unset.
  it('reflects the missing-settings scenario', async () => {
    setScenario('missing-settings');
    const response = await fetch('/api/settings');
    const body = settingsStatus.parse(await response.json());
    expect(body.githubPat.set).toBe(false);
    expect(body.githubPat.last4).toBeUndefined();
    expect(body.openaiKey.set).toBe(false);
  });
});
