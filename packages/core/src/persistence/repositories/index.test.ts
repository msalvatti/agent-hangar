/**
 * Unit tests for `createRepositories`.
 *
 * Layer: unit.
 * Goal: the factory wires one instance of the right class per port, sharing the same client and
 * redactor, and its property names match `createInMemoryRepositories` — the invariant W2-A/W2-B
 * rely on to swap the fake for the real implementation without touching any caller; and the
 * factory plus every class is reachable from the package root barrel, which is the import path
 * W2-A/W2-B are told to use.
 * Mocks: a minimal Prisma client double (no database) and a no-op Redactor.
 */
import { describe, expect, it, vi } from 'vitest';

import * as core from '../../index.ts';
import type { Redactor } from '../../secrets/types.ts';
import type { PrismaClient } from '../generated/client.ts';

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
} from './index.ts';

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

  /**
   * The composition root and the classes must leave the folder barrel: a caller outside
   * `src/persistence` imports them from `@agent-hangar/core`, not by deep path.
   */
  it('is reachable from the package root barrel together with every repository class', () => {
    expect(core.createRepositories).toBe(createRepositories);
    expect(core.PrismaChatRepository).toBe(PrismaChatRepository);
    expect(core.PrismaMessageRepository).toBe(PrismaMessageRepository);
    expect(core.PrismaTurnRepository).toBe(PrismaTurnRepository);
    expect(core.PrismaWorkspaceRepository).toBe(PrismaWorkspaceRepository);
    expect(core.PrismaScheduledJobRepository).toBe(PrismaScheduledJobRepository);
    expect(core.PrismaJobRunRepository).toBe(PrismaJobRunRepository);
    expect(core.PrismaToolCallLogRepository).toBe(PrismaToolCallLogRepository);
    expect(core.PrismaSecretRepository).toBe(PrismaSecretRepository);
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
