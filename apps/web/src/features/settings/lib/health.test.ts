/**
 * Unit tests for `lib/health.ts`.
 *
 * Layer: unit.
 * Goal: maps every check to its label in the shared display order, `allOk` mirrors the response's
 * `ok`, and a check's `detail` carries through when present.
 * Mocks: none.
 */
import type { HealthResponse } from '@agent-hangar/core';
import { describe, expect, it } from 'vitest';

import { summarizeHealth } from './health';

const healthy: HealthResponse = {
  ok: true,
  instance: 'default',
  checks: {
    db: { ok: true },
    redis: { ok: true },
    docker: { ok: true },
    image: { ok: true },
    worker: { ok: true, lastSeenAt: '2026-08-20T10:00:00.000Z' },
  },
};

describe('summarizeHealth', () => {
  /**
   * Every check maps to its labelled summary. The worker sits above Docker and the image because
   * it is what measures them: a silent worker leaves those two unknown, so it is named first.
   */
  it('maps every check with its label, in order', () => {
    const summary = summarizeHealth(healthy);
    expect(summary.instance).toBe('default');
    expect(summary.checks.map((check) => [check.id, check.label])).toEqual([
      ['db', 'Postgres'],
      ['redis', 'Redis'],
      ['worker', 'Worker'],
      ['docker', 'Docker'],
      ['image', 'Workspace image'],
    ]);
  });

  /** `allOk` mirrors the response's top-level `ok`. */
  it('sets allOk from the response ok flag', () => {
    expect(summarizeHealth(healthy).allOk).toBe(true);
    expect(summarizeHealth({ ...healthy, ok: false }).allOk).toBe(false);
  });

  /** A check's `detail`, when present, carries through to its summary. */
  it('carries a check detail through when present', () => {
    const withDetail: HealthResponse = {
      ...healthy,
      checks: { ...healthy.checks, db: { ok: false, detail: 'connection refused' } },
    };
    const summary = summarizeHealth(withDetail);
    expect(summary.checks[0]?.detail).toBe('connection refused');
  });

  /** A check with no `detail` carries `undefined` through. */
  it('carries an absent detail through as undefined', () => {
    const summary = summarizeHealth(healthy);
    expect(summary.checks[0]?.detail).toBeUndefined();
  });
});
