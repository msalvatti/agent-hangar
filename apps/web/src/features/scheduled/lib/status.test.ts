/**
 * Unit tests for the run-status presentation mapping.
 *
 * Layer: unit.
 * Goal: every `JobRunStatus` maps to a distinct label/icon/tone, and `isRunActive` distinguishes
 * in-flight statuses from terminal ones.
 * Mocks: none — pure functions.
 */
import type { JobRunStatus } from '@agent-hangar/core';
import { describe, expect, it } from 'vitest';

import { isRunActive, runStatusPresentation } from './status';

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
