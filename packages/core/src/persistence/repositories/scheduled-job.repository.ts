/**
 * Prisma implementation of `ScheduledJobRepository`.
 *
 * Layer: service (persistence).
 *
 * Nothing here is redacted: `prompt` is user input echoed back to its author, and `name`, `cron`,
 * `timezone`, `repoUrl`, `branch` are identifiers, not agent/tool output.
 */
import type { ScheduledJob } from '../entities.js';
import type { PrismaClient } from '../generated/client.js';
import type {
  CreateScheduledJobInput,
  RunTimes,
  ScheduledJobRepository,
  UpdateScheduledJobInput,
} from '../ports.js';

import { toScheduledJob } from './mappers.js';
import { translatePrismaError } from './prisma-errors.js';

/** Scheduled job rows. */
export class PrismaScheduledJobRepository implements ScheduledJobRepository {
  /**
   * @param prisma - Connected Prisma client.
   */
  constructor(private readonly prisma: PrismaClient) {}

  /** @inheritDoc */
  async create(input: CreateScheduledJobInput): Promise<ScheduledJob> {
    const row = await this.prisma.scheduledJob.create({
      data: {
        name: input.name,
        cron: input.cron,
        timezone: input.timezone,
        prompt: input.prompt,
        repoUrl: input.repoUrl,
        branch: input.branch,
        enabled: input.enabled,
        nextRunAt: input.nextRunAt ?? null,
      },
    });
    return toScheduledJob(row);
  }

  /** @inheritDoc */
  async get(id: string): Promise<ScheduledJob | null> {
    const row = await this.prisma.scheduledJob.findUnique({ where: { id } });
    return row === null ? null : toScheduledJob(row);
  }

  /** @inheritDoc */
  async list(): Promise<ScheduledJob[]> {
    const rows = await this.prisma.scheduledJob.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map(toScheduledJob);
  }

  /** @inheritDoc */
  async update(id: string, patch: UpdateScheduledJobInput): Promise<ScheduledJob> {
    try {
      // `updatedAt` is set explicitly (see `setRunTimes` below for why an empty-otherwise patch
      // cannot rely on Prisma's `@updatedAt` directive alone).
      const row = await this.prisma.scheduledJob.update({
        where: { id },
        data: { ...patch, updatedAt: new Date() },
      });
      return toScheduledJob(row);
    } catch (error) {
      translatePrismaError(error, { entity: 'ScheduledJob', id });
    }
  }

  /** @inheritDoc */
  async delete(id: string): Promise<void> {
    try {
      await this.prisma.scheduledJob.delete({ where: { id } });
    } catch (error) {
      translatePrismaError(error, { entity: 'ScheduledJob', id });
    }
  }

  /** @inheritDoc */
  async listEnabled(): Promise<ScheduledJob[]> {
    const rows = await this.prisma.scheduledJob.findMany({
      where: { enabled: true },
      orderBy: { nextRunAt: 'asc' },
    });
    return rows.map(toScheduledJob);
  }

  /** @inheritDoc */
  async setRunTimes(id: string, times: RunTimes): Promise<ScheduledJob> {
    const data: { lastRunAt?: Date | null; nextRunAt?: Date | null; updatedAt: Date } = {
      updatedAt: new Date(),
    };
    if (times.lastRunAt !== undefined) {
      data.lastRunAt = times.lastRunAt;
    }
    if (times.nextRunAt !== undefined) {
      data.nextRunAt = times.nextRunAt;
    }
    try {
      const row = await this.prisma.scheduledJob.update({ where: { id }, data });
      return toScheduledJob(row);
    } catch (error) {
      translatePrismaError(error, { entity: 'ScheduledJob', id });
    }
  }
}
