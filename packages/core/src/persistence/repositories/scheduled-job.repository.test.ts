/**
 * Unit tests for `PrismaScheduledJobRepository`.
 *
 * Layer: unit.
 * Goal: every method builds the right Prisma call and maps the result; `setRunTimes` changes only
 * the fields explicitly present; `update`/`delete`/`setRunTimes` failures translate through
 * `translatePrismaError`. Nothing here is redacted (see the file header of the repository).
 * Mocks: a Prisma client double exposing only `scheduledJob.*` — no database.
 */
import { describe, expect, it, vi } from 'vitest';

import type { PrismaClient } from '../generated/client.js';

import { NotFoundError } from './errors.js';
import { PrismaScheduledJobRepository } from './scheduled-job.repository.js';

/** Builds a P2025 (record not found) error shaped like `PrismaClientKnownRequestError`. */
function p2025(): Error & { code: string } {
  return Object.assign(new Error('Record not found'), { code: 'P2025' });
}

const NOW = new Date('2026-01-01T00:00:00.000Z');

const jobRow = {
  id: 'job-1',
  name: 'Nightly report',
  cron: '0 0 * * *',
  timezone: 'UTC',
  prompt: 'print date',
  repoUrl: 'https://github.com/acme/repo',
  branch: 'main',
  enabled: true,
  lastRunAt: null,
  nextRunAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function fakePrisma(
  overrides: { update?: ReturnType<typeof vi.fn>; delete?: ReturnType<typeof vi.fn> } = {},
) {
  const scheduledJob = {
    create: vi.fn(() => Promise.resolve(jobRow)),
    findUnique: vi.fn((): Promise<typeof jobRow | null> => Promise.resolve(jobRow)),
    findMany: vi.fn(() => Promise.resolve([jobRow])),
    update: overrides.update ?? vi.fn(() => Promise.resolve(jobRow)),
    delete: overrides.delete ?? vi.fn(() => Promise.resolve(jobRow)),
  };
  return { client: { scheduledJob } as unknown as PrismaClient, scheduledJob };
}

describe('PrismaScheduledJobRepository', () => {
  /** create() inserts every field, defaulting nextRunAt to null when omitted. */
  it('create() inserts the job, defaulting nextRunAt to null', async () => {
    const { client, scheduledJob } = fakePrisma();
    const repo = new PrismaScheduledJobRepository(client);
    await repo.create({
      name: 'Nightly report',
      cron: '0 0 * * *',
      timezone: 'UTC',
      prompt: 'print date',
      repoUrl: 'https://github.com/acme/repo',
      branch: 'main',
      enabled: true,
    });
    expect(scheduledJob.create).toHaveBeenCalledWith({
      data: {
        name: 'Nightly report',
        cron: '0 0 * * *',
        timezone: 'UTC',
        prompt: 'print date',
        repoUrl: 'https://github.com/acme/repo',
        branch: 'main',
        enabled: true,
        nextRunAt: null,
      },
    });
  });

  /** get() maps a found row and returns null when absent. */
  it('get() returns the mapped job or null', async () => {
    const { client, scheduledJob } = fakePrisma();
    const repo = new PrismaScheduledJobRepository(client);
    expect((await repo.get('job-1'))?.id).toBe('job-1');
    scheduledJob.findUnique = vi.fn(() => Promise.resolve(null));
    expect(await repo.get('missing')).toBeNull();
  });

  /** list() orders newest first. */
  it('list() orders createdAt desc', async () => {
    const { client, scheduledJob } = fakePrisma();
    const repo = new PrismaScheduledJobRepository(client);
    await repo.list();
    expect(scheduledJob.findMany).toHaveBeenCalledWith({ orderBy: { createdAt: 'desc' } });
  });

  /** update() forwards the partial patch and explicitly bumps updatedAt. */
  it('update() forwards the patch and bumps updatedAt', async () => {
    const { client, scheduledJob } = fakePrisma();
    const repo = new PrismaScheduledJobRepository(client);
    await repo.update('job-1', { enabled: false });
    expect(scheduledJob.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: { enabled: false, updatedAt: expect.any(Date) as Date },
    });
  });

  /** update() on a missing row translates P2025 to NotFoundError. */
  it('update() translates a missing row to NotFoundError', async () => {
    const { client } = fakePrisma({ update: vi.fn(() => Promise.reject(p2025())) });
    const repo = new PrismaScheduledJobRepository(client);
    await expect(repo.update('missing', { enabled: false })).rejects.toBeInstanceOf(NotFoundError);
  });

  /** delete() removes the row. */
  it('delete() removes the job', async () => {
    const { client, scheduledJob } = fakePrisma();
    const repo = new PrismaScheduledJobRepository(client);
    await repo.delete('job-1');
    expect(scheduledJob.delete).toHaveBeenCalledWith({ where: { id: 'job-1' } });
  });

  /** delete() on a missing row translates P2025 to NotFoundError. */
  it('delete() translates a missing row to NotFoundError', async () => {
    const { client } = fakePrisma({ delete: vi.fn(() => Promise.reject(p2025())) });
    const repo = new PrismaScheduledJobRepository(client);
    await expect(repo.delete('missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  /** listEnabled() filters enabled jobs ordered by nextRunAt asc. */
  it('listEnabled() filters enabled jobs', async () => {
    const { client, scheduledJob } = fakePrisma();
    const repo = new PrismaScheduledJobRepository(client);
    await repo.listEnabled();
    expect(scheduledJob.findMany).toHaveBeenCalledWith({
      where: { enabled: true },
      orderBy: { nextRunAt: 'asc' },
    });
  });

  /** setRunTimes() sets both fields when both are present. */
  it('setRunTimes() sets both fields when both are present', async () => {
    const { client, scheduledJob } = fakePrisma();
    const repo = new PrismaScheduledJobRepository(client);
    const lastRunAt = new Date('2026-01-02T00:00:00.000Z');
    const nextRunAt = new Date('2026-01-03T00:00:00.000Z');
    await repo.setRunTimes('job-1', { lastRunAt, nextRunAt });
    expect(scheduledJob.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: { lastRunAt, nextRunAt, updatedAt: expect.any(Date) as Date },
    });
  });

  /** setRunTimes() with only one field present leaves the other untouched. */
  it('setRunTimes() sets only the field present in the input', async () => {
    const { client, scheduledJob } = fakePrisma();
    const repo = new PrismaScheduledJobRepository(client);
    const lastRunAt = new Date('2026-01-02T00:00:00.000Z');
    await repo.setRunTimes('job-1', { lastRunAt });
    expect(scheduledJob.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: { lastRunAt, updatedAt: expect.any(Date) as Date },
    });
  });

  /** setRunTimes() on a missing row translates P2025 to NotFoundError. */
  it('setRunTimes() translates a missing row to NotFoundError', async () => {
    const { client } = fakePrisma({ update: vi.fn(() => Promise.reject(p2025())) });
    const repo = new PrismaScheduledJobRepository(client);
    await expect(repo.setRunTimes('missing', {})).rejects.toBeInstanceOf(NotFoundError);
  });
});
