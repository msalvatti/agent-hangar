/**
 * Tests for the health mock handler: contract shape and scenario-driven state.
 */
import { healthResponse } from '@agent-hangar/core';
import { describe, expect, it } from 'vitest';

import { setScenario } from './scenario';

describe('GET /api/health', () => {
  // The default response is healthy and satisfies the contract schema.
  it('returns a healthy response that satisfies healthResponse', async () => {
    const response = await fetch('/api/health');
    expect(response.status).toBe(200);
    const body = healthResponse.parse(await response.json());
    expect(body.ok).toBe(true);
    expect(body.checks.docker.ok).toBe(true);
  });

  // The infra-down scenario is reflected in the response.
  it('reflects the infra-down scenario', async () => {
    setScenario('infra-down');
    const response = await fetch('/api/health');
    const body = healthResponse.parse(await response.json());
    expect(body.ok).toBe(false);
    expect(body.checks.docker.ok).toBe(false);
    expect(body.checks.redis.ok).toBe(false);
  });
});
