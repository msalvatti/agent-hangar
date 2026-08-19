/**
 * `@db` integration suite for `PrismaScheduledJobRepository`, against a real Postgres.
 *
 * Layer: integration.
 * Goal: CRUD round-trips every field; `update` changes only the given keys; `listEnabled`
 * excludes disabled jobs; `delete` cascades its `JobRun`s; unknown ids resolve per the port.
 * Mocks: none — a real compose Postgres.
 */
import { beforeEach, expect, it } from 'vitest';

import type { PrismaClient } from '../generated/client.js';
import { connectTestDb, countRows, describeDb, truncateAll } from '../testing/db.js';

import { NotFoundError } from './errors.js';
import { PrismaScheduledJobRepository } from './scheduled-job.repository.js';

const baseInput = {
  name: 'Nightly report',
  cron: '0 0 * * *',
  timezone: 'UTC',
  prompt: 'print date',
  repoUrl: 'https://github.com/acme/repo',
  branch: 'main',
  enabled: true,
};

let client: PrismaClient;

describeDb('PrismaScheduledJobRepository', () => {
  beforeEach(async () => {
    client = connectTestDb();
    await truncateAll(client);
  });

  /** create() then get() round-trip every field. */
  it('create() then get() round-trip every field', async () => {
    const repo = new PrismaScheduledJobRepository(client);
    const job = await repo.create(baseInput);
    const fetched = await repo.get(job.id);
    expect(fetched).toEqual(job);
  });

  /** update() changes only the given keys, leaving the rest untouched. */
  it('update() changes only the given keys', async () => {
    const repo = new PrismaScheduledJobRepository(client);
    const job = await repo.create(baseInput);
    const updated = await repo.update(job.id, { name: 'Renamed' });
    expect(updated.name).toBe('Renamed');
    expect(updated.cron).toBe(baseInput.cron);
    expect(updated.prompt).toBe(baseInput.prompt);
  });

  /** listEnabled() excludes disabled jobs. */
  it('listEnabled() excludes disabled jobs', async () => {
    const repo = new PrismaScheduledJobRepository(client);
    const enabled = await repo.create(baseInput);
    const disabled = await repo.create({ ...baseInput, name: 'Off', enabled: false });
    const listed = await repo.listEnabled();
    const ids = listed.map((j) => j.id);
    expect(ids).toContain(enabled.id);
    expect(ids).not.toContain(disabled.id);
  });

  /** setRunTimes() sets both fields when both are present. */
  it('setRunTimes() sets lastRunAt and nextRunAt', async () => {
    const repo = new PrismaScheduledJobRepository(client);
    const job = await repo.create(baseInput);
    const lastRunAt = new Date('2026-01-01T00:00:00.000Z');
    const nextRunAt = new Date('2026-01-02T00:00:00.000Z');
    const updated = await repo.setRunTimes(job.id, { lastRunAt, nextRunAt });
    expect(updated.lastRunAt).toEqual(lastRunAt);
    expect(updated.nextRunAt).toEqual(nextRunAt);
  });

  /** delete() cascades its JobRuns. */
  it('delete() cascades JobRuns', async () => {
    const repo = new PrismaScheduledJobRepository(client);
    const job = await repo.create(baseInput);
    await client.jobRun.create({
      data: { jobId: job.id, trigger: 'MANUAL', model: 'gpt-5.6-sol', scheduledFor: new Date() },
    });
    await repo.delete(job.id);
    expect(await countRows(client, 'JobRun')).toBe(0);
  });

  /** get() returns null and update()/delete() throw NotFoundError for an unknown id. */
  it('get() returns null and update()/delete() throw NotFoundError for an unknown id', async () => {
    const repo = new PrismaScheduledJobRepository(client);
    expect(await repo.get('missing')).toBeNull();
    await expect(repo.update('missing', { name: 'x' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(repo.delete('missing')).rejects.toBeInstanceOf(NotFoundError);
  });
});
