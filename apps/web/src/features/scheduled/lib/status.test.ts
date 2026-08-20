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
  /** Every status the contract defines has a presentation entry with a non-empty label. */
  it('maps every status to a label and icon', () => {
    const statuses: JobRunStatus[] = [
      'QUEUED',
      'PREPARING',
      'RUNNING',
      'SUCCEEDED',
      'FAILED',
      'CANCELLED',
    ];
    for (const status of statuses) {
      const presentation = runStatusPresentation(status);
      expect(presentation.label.length).toBeGreaterThan(0);
      expect(presentation.icon).toBeDefined();
    }
  });

  /** SUCCEEDED renders with the success tone. */
  it('renders SUCCEEDED with the success tone', () => {
    expect(runStatusPresentation('SUCCEEDED').tone).toBe('success');
  });

  /** FAILED renders with the destructive tone. */
  it('renders FAILED with the destructive tone', () => {
    expect(runStatusPresentation('FAILED').tone).toBe('destructive');
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
