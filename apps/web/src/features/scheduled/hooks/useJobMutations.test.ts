/**
 * Unit tests for `useJobMutations`.
 *
 * Layer: unit.
 * Goal: `save` creates without a `jobId`, updates with one, surfaces the server's error message
 * and returns `null` on failure, and clears the error on demand.
 * Mocks: MSW node server serving `src/mocks/scheduled.ts`, with a `server.use` override for the
 * failure case.
 */
import { act, renderHook } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';

import { resetScheduledStore } from '@/mocks/scheduled';
import { server } from '@/mocks/server';

import type { JobFormValues } from '../lib/job-form';

import { useJobMutations } from './useJobMutations';

afterEach(() => {
  resetScheduledStore();
});

const validValues: JobFormValues = {
  name: 'Weekly report',
  repoUrl: 'https://github.com/acme/api',
  branch: 'main',
  cron: '0 8 * * 1',
  timezone: 'UTC',
  prompt: 'Summarize the week.',
  enabled: true,
};

describe('useJobMutations', () => {
  /** Saving with no jobId creates a job and returns it. */
  it('creates a job', async () => {
    const { result } = renderHook(() => useJobMutations());
    let saved;
    await act(async () => {
      saved = await result.current.save(validValues);
    });
    expect(saved).toMatchObject({ name: 'Weekly report' });
    expect(result.current.error).toBeNull();
  });

  /** Saving with a jobId updates that job and returns it. */
  it('updates a job', async () => {
    const { result } = renderHook(() => useJobMutations());
    let saved;
    await act(async () => {
      saved = await result.current.save({ ...validValues, name: 'Renamed' }, 'job-dep-audit');
    });
    expect(saved).toMatchObject({ id: 'job-dep-audit', name: 'Renamed' });
  });

  /** A server error surfaces its message and the save resolves to null. */
  it('surfaces a server error', async () => {
    server.use(
      http.post('/api/jobs', () =>
        HttpResponse.json({ error: { code: 'SERVER_ERROR', message: 'boom' } }, { status: 500 }),
      ),
    );
    const { result } = renderHook(() => useJobMutations());
    let saved;
    await act(async () => {
      saved = await result.current.save(validValues);
    });
    expect(saved).toBeNull();
    expect(result.current.error).toBe('boom');
  });

  /** A network-level failure (not an `ApiClientError`) falls back to a generic message. */
  it('falls back to a generic message for a non-ApiClientError failure', async () => {
    server.use(http.post('/api/jobs', () => HttpResponse.error()));
    const { result } = renderHook(() => useJobMutations());
    let saved;
    await act(async () => {
      saved = await result.current.save(validValues);
    });
    expect(saved).toBeNull();
    expect(result.current.error).toBe('Could not save job');
  });

  /** clearError resets the error to null. */
  it('clears the error', async () => {
    server.use(
      http.post('/api/jobs', () =>
        HttpResponse.json({ error: { code: 'SERVER_ERROR', message: 'boom' } }, { status: 500 }),
      ),
    );
    const { result } = renderHook(() => useJobMutations());
    await act(async () => {
      await result.current.save(validValues);
    });
    expect(result.current.error).toBe('boom');
    act(() => {
      result.current.clearError();
    });
    expect(result.current.error).toBeNull();
  });
});
