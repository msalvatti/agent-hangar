/**
 * Unit tests for `useJobForm`.
 *
 * Layer: unit.
 * Goal: starts blank (create) or prefilled (edit), `setField`/`touch` update state, `isValid`
 * reflects validation, and `reset` restores the initial values.
 * Mocks: none.
 */
import type { JobSummary } from '@agent-hangar/core';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useJobForm } from './useJobForm';

const job: JobSummary = {
  id: 'job-1',
  name: 'Nightly tests',
  cron: '0 2 * * *',
  timezone: 'UTC',
  prompt: 'Run tests.',
  repoUrl: 'https://github.com/acme/api',
  branch: 'main',
  enabled: true,
  lastRunAt: null,
  nextRunAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastRunStatus: null,
};

describe('useJobForm', () => {
  /** With no initial job, the form starts blank and enabled. */
  it('starts blank for create', () => {
    const { result } = renderHook(() => useJobForm());
    expect(result.current.values.name).toBe('');
    expect(result.current.values.enabled).toBe(true);
    expect(result.current.isValid).toBe(false);
  });

  /** With an initial job, the form starts prefilled and valid. */
  it('starts prefilled for edit', () => {
    const { result } = renderHook(() => useJobForm(job));
    expect(result.current.values.name).toBe('Nightly tests');
    expect(result.current.isValid).toBe(true);
  });

  /** setField updates one value without touching the others. */
  it('updates a single field', () => {
    const { result } = renderHook(() => useJobForm(job));
    act(() => {
      result.current.setField('name', 'Renamed');
    });
    expect(result.current.values.name).toBe('Renamed');
    expect(result.current.values.cron).toBe(job.cron);
  });

  /** touch marks a field as touched. */
  it('marks a field touched', () => {
    const { result } = renderHook(() => useJobForm(job));
    act(() => {
      result.current.touch('name');
    });
    expect(result.current.touched.name).toBe(true);
  });

  /** reset restores the initial values and clears touched state. */
  it('resets to the initial values', () => {
    const { result } = renderHook(() => useJobForm(job));
    act(() => {
      result.current.setField('name', 'Renamed');
      result.current.touch('name');
    });
    act(() => {
      result.current.reset();
    });
    expect(result.current.values.name).toBe('Nightly tests');
    expect(result.current.touched.name).toBeUndefined();
  });
});
