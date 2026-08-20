/**
 * `@db` integration suite for `PrismaScheduledJobRepository`, against a real Postgres.
 *
 * Layer: integration.
 * Goal: CRUD round-trips every field; `update` changes only the given keys; a canary in `prompt`
 * never reaches the stored row, on `create` or on `update`; `listEnabled` excludes disabled jobs;
 * `delete` cascades its `JobRun`s; unknown ids resolve per the port.
 * Mocks: none — a real compose Postgres.
 */
import { beforeEach, expect, it } from 'vitest';

import type { Redactor } from '../../secrets/types.ts';
import { GITHUB_CANARY, assertNoCanary } from '../../testing/canaries.ts';
import type { PrismaClient } from '../generated/client.ts';
import {
  connectTestDb,
  countRows,
  describeDb,
  rawSelect,
  sqlTemplate,
  truncateAll,
} from '../testing/db.ts';

import { NotFoundError } from './errors.ts';
import { PrismaScheduledJobRepository } from './scheduled-job.repository.ts';

const baseInput = {
  name: 'Nightly report',
  cron: '0 0 * * *',
  timezone: 'UTC',
  prompt: 'print date',
  repoUrl: 'https://github.com/acme/repo',
  branch: 'main',
  enabled: true,
};

const testRedactor: Redactor = {
  register: () => undefined,
  redact: (input: string) => input.replaceAll(GITHUB_CANARY, '[REDACTED]'),
  redactJson: (input: unknown) => input,
};

let client: PrismaClient;

describeDb('PrismaScheduledJobRepository', () => {
  beforeEach(async () => {
    client = connectTestDb();
    await truncateAll(client);
  });

  /** create() then get() round-trip every field. */
  it('create() then get() round-trip every field', async () => {
    const repo = new PrismaScheduledJobRepository(client, testRedactor);
    const job = await repo.create(baseInput);
    const fetched = await repo.get(job.id);
    expect(fetched).toEqual(job);
  });

  /** update() changes only the given keys, leaving the rest untouched. */
  it('update() changes only the given keys', async () => {
    const repo = new PrismaScheduledJobRepository(client, testRedactor);
    const job = await repo.create(baseInput);
    const updated = await repo.update(job.id, { name: 'Renamed' });
    expect(updated.name).toBe('Renamed');
    expect(updated.cron).toBe(baseInput.cron);
    expect(updated.prompt).toBe(baseInput.prompt);
  });

  /** listEnabled() excludes disabled jobs. */
  it('listEnabled() excludes disabled jobs', async () => {
    const repo = new PrismaScheduledJobRepository(client, testRedactor);
    const enabled = await repo.create(baseInput);
    const disabled = await repo.create({ ...baseInput, name: 'Off', enabled: false });
    const listed = await repo.listEnabled();
    const ids = listed.map((j) => j.id);
    expect(ids).toContain(enabled.id);
    expect(ids).not.toContain(disabled.id);
  });

  /** setRunTimes() sets both fields when both are present. */
  it('setRunTimes() sets lastRunAt and nextRunAt', async () => {
    const repo = new PrismaScheduledJobRepository(client, testRedactor);
    const job = await repo.create(baseInput);
    const lastRunAt = new Date('2026-01-01T00:00:00.000Z');
    const nextRunAt = new Date('2026-01-02T00:00:00.000Z');
    const updated = await repo.setRunTimes(job.id, { lastRunAt, nextRunAt });
    expect(updated.lastRunAt).toEqual(lastRunAt);
    expect(updated.nextRunAt).toEqual(nextRunAt);
  });

  /** A canary in the prompt never reaches the stored row, on create or on update. */
  it('never stores a canary in prompt', async () => {
    const repo = new PrismaScheduledJobRepository(client, testRedactor);
    const job = await repo.create({ ...baseInput, prompt: `deploy with ${GITHUB_CANARY}` });
    const created = await rawSelect<{ prompt: string }>(
      client,
      sqlTemplate('SELECT prompt FROM "ScheduledJob" WHERE id = '),
      job.id,
    );
    const createdPrompt = created[0]?.prompt ?? '';
    expect(createdPrompt).toContain('[REDACTED]');
    assertNoCanary(createdPrompt);

    await repo.update(job.id, { prompt: `rerun with ${GITHUB_CANARY}` });
    const updated = await rawSelect<{ prompt: string }>(
      client,
      sqlTemplate('SELECT prompt FROM "ScheduledJob" WHERE id = '),
      job.id,
    );
    const updatedPrompt = updated[0]?.prompt ?? '';
    expect(updatedPrompt).toContain('[REDACTED]');
    assertNoCanary(updatedPrompt);
  });

  /** delete() cascades its JobRuns. */
  it('delete() cascades JobRuns', async () => {
    const repo = new PrismaScheduledJobRepository(client, testRedactor);
    const job = await repo.create(baseInput);
    await client.jobRun.create({
      data: { jobId: job.id, trigger: 'MANUAL', model: 'gpt-5.6-sol', scheduledFor: new Date() },
    });
    await repo.delete(job.id);
    expect(await countRows(client, 'JobRun')).toBe(0);
  });

  /** get() returns null and update()/delete() throw NotFoundError for an unknown id. */
  it('get() returns null and update()/delete() throw NotFoundError for an unknown id', async () => {
    const repo = new PrismaScheduledJobRepository(client, testRedactor);
    expect(await repo.get('missing')).toBeNull();
    await expect(repo.update('missing', { name: 'x' })).rejects.toBeInstanceOf(NotFoundError);
    await expect(repo.delete('missing')).rejects.toBeInstanceOf(NotFoundError);
  });
});
