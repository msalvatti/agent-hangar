/**
 * Unit tests for the run-status presentation mapping.
 *
 * Layer: unit.
 * Goal: every `JobRunStatus` maps to a distinct label/icon/tone, and the two activity
 * predicates — one over statuses, one over the phases they map to — agree on every value.
 * Mocks: none — pure functions.
 */
import type { JobRunStatus } from '@agent-hangar/core';
import { describe, expect, it } from 'vitest';

import { PHASE_BY_STATUS, isActivePhase, isRunActive, runStatusPresentation } from './status';

describe('runStatusPresentation', () => {
  /**
   * Every status the contract defines has its own row, written out. The label is the word on the
   * badge and the tone is the colour behind it, and a tone read as nothing leaves a badge with no
   * colour at all — which is how a queued run and a running one become the same badge. The colour
   * never carries the meaning alone, which is why the word is pinned beside it.
   */
  it.each([
    ['QUEUED', 'queued', 'muted'],
    ['PREPARING', 'running', 'accent'],
    ['RUNNING', 'running', 'accent'],
    ['SUCCEEDED', 'ok', 'success'],
    ['FAILED', 'fail', 'destructive'],
    ['CANCELLED', 'cancelled', 'muted'],
  ] as const)('presents %s as a %s badge in the %s tone', (status: JobRunStatus, label, tone) => {
    const presentation = runStatusPresentation(status);

    expect(presentation.label).toBe(label);
    expect(presentation.tone).toBe(tone);
    expect(presentation.icon).toBeDefined();
  });
});

describe('isRunActive', () => {
  /** QUEUED, PREPARING and RUNNING are active. */
  it('treats QUEUED, PREPARING and RUNNING as active', () => {
    expect(isRunActive('QUEUED')).toBe(true);
    expect(isRunActive('PREPARING')).toBe(true);
    expect(isRunActive('RUNNING')).toBe(true);
  });

  /** SUCCEEDED, FAILED and CANCELLED are not active. */
  it('treats terminal statuses as not active', () => {
    expect(isRunActive('SUCCEEDED')).toBe(false);
    expect(isRunActive('FAILED')).toBe(false);
    expect(isRunActive('CANCELLED')).toBe(false);
  });
});

describe('isActivePhase', () => {
  /**
   * The phase predicate is the same answer as the status predicate, for callers that already hold
   * a phase. Two answers to "is this run active" is the defect this pins down: a queued run has to
   * count as active on both sides, or the drawer stops streaming and hides Stop for it.
   */
  it('agrees with isRunActive for every status', () => {
    const statuses: JobRunStatus[] = [
      'QUEUED',
      'PREPARING',
      'RUNNING',
      'SUCCEEDED',
      'FAILED',
      'CANCELLED',
    ];
    for (const status of statuses) {
      expect(isActivePhase(PHASE_BY_STATUS[status])).toBe(isRunActive(status));
    }
  });

  /** The transcript's own `idle` phase belongs to no run and is not active. */
  it('treats the idle phase as not active', () => {
    expect(isActivePhase('idle')).toBe(false);
  });
});
