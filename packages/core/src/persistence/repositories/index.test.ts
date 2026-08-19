/**
 * Unit tests for `createRepositories`.
 *
 * Layer: unit.
 * Goal: the factory wires one instance of the right class per port, sharing the same client and
 * redactor, and its property names match `createInMemoryRepositories` — the invariant W2-A/W2-B
 * rely on to swap the fake for the real implementation without touching any caller.
 * Mocks: a minimal Prisma client double (no database) and a no-op Redactor.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Redactor } from '../../secrets/types.js';
import type { PrismaClient } from '../generated/client.js';

import {
  createRepositories,
  PrismaChatRepository,
  PrismaJobRunRepository,
  PrismaMessageRepository,
  PrismaScheduledJobRepository,
  PrismaSecretRepository,
  PrismaToolCallLogRepository,
  PrismaTurnRepository,
  PrismaWorkspaceRepository,
} from './index.js';

const fakeRedactor: Redactor = {
  register: vi.fn(),
  redact: vi.fn((value: string) => value),
  redactJson: vi.fn((value: unknown) => value),
};

describe('createRepositories', () => {
  /** Every property is an instance of the matching Prisma repository class. */
  it('wires one instance of each Prisma repository class', () => {
    const prisma = {} as unknown as PrismaClient;
    const repositories = createRepositories(prisma, fakeRedactor);
    expect(repositories.chats).toBeInstanceOf(PrismaChatRepository);
    expect(repositories.messages).toBeInstanceOf(PrismaMessageRepository);
    expect(repositories.turns).toBeInstanceOf(PrismaTurnRepository);
    expect(repositories.workspaces).toBeInstanceOf(PrismaWorkspaceRepository);
    expect(repositories.scheduledJobs).toBeInstanceOf(PrismaScheduledJobRepository);
    expect(repositories.jobRuns).toBeInstanceOf(PrismaJobRunRepository);
    expect(repositories.toolCalls).toBeInstanceOf(PrismaToolCallLogRepository);
    expect(repositories.secrets).toBeInstanceOf(PrismaSecretRepository);
  });

  /** The property names match the in-memory factory's shape (minus its `store` escape hatch). */
  it('exposes exactly the eight Repositories keys', () => {
    const prisma = {} as unknown as PrismaClient;
    const repositories = createRepositories(prisma, fakeRedactor);
    expect(Object.keys(repositories).sort()).toEqual(
      [
        'chats',
        'jobRuns',
        'messages',
        'scheduledJobs',
        'secrets',
        'toolCalls',
        'turns',
        'workspaces',
      ].sort(),
    );
  });
});
