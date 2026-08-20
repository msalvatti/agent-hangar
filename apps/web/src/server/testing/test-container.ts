/**
 * Assembles a {@link ServerContainer} out of test doubles, plus handles on those doubles.
 *
 * Layer: test double.
 *
 * Every handler is a function of the container, so a route test is "build one of these, call the
 * handler, read the doubles". The log sink is part of the bargain: a test that stores a credential
 * asserts against everything the process wrote, not only against the response.
 *
 * The queues are constructed through BullMQ's own `Queue` so the core producers stay under test; a
 * file using this helper installs the module double with
 * `vi.mock('bullmq', () => import('@/server/testing/fake-queue'))`.
 */
import { createLogger, createRedactor, loadConfig, QUEUE_NAMES } from '@agent-hangar/core';
import type {
  ApplicationQueues,
  DatabaseClient,
  Redactor,
  Repositories,
  SecretKey,
} from '@agent-hangar/core';
import {
  createInMemoryRepositories,
  FakeClock,
  GITHUB_CANARY,
  OPENAI_CANARY,
} from '@agent-hangar/core/testing';
import { Queue } from 'bullmq';
import type { Logger } from 'pino';

import type { ServerContainer, ServerContainerDeps } from '../container';
import type { BranchSummary, GithubClient, RepoListing, RepoSummary } from '../github';

import { fakeQueue, resetFakeQueues } from './fake-queue';
import type { FakeQueue } from './fake-queue';
import { FakeRedis } from './fake-redis';
import { FakeSecretsService } from './fake-secrets';

/** Heartbeat interval used by the tests; short enough that a timer test stays fast. */
export const TEST_HEARTBEAT_MS = 20;

/** Block duration used by the tests. */
export const TEST_BLOCK_MS = 20;

/**
 * Environment the test configuration is loaded from.
 *
 * Only the instance is named: the loader derives the ports and connection strings from it, so the
 * doubles run against the same values a real `test` instance would use, and no connection string
 * is written into the repository.
 */
export const TEST_ENV: Readonly<Record<string, string>> = {
  AH_INSTANCE: 'test',
  MASTER_KEY_PATH: '/nonexistent/key-file',
  LOG_LEVEL: 'info',
};

/** Scripted GitHub client; each method answers from the value set on it. */
export class StubGithubClient implements GithubClient {
  /** Repositories `listRepos` returns, before the query filter. */
  repos: RepoSummary[] = [];

  /** Branches `listBranches` returns. */
  branches: BranchSummary[] = [];

  /** Set to make both methods reject. */
  failure: Error | null = null;

  /** Whether `listRepos` reports that the listing stopped at the client's page limit. */
  truncated = false;

  /**
   * @param query - Case-insensitive substring of `fullName`.
   * @returns The matching repositories, and the scripted truncation flag.
   * @throws Error When {@link StubGithubClient.failure} is set; rejected, as a real client does.
   */
  listRepos(query: string): Promise<RepoListing> {
    if (this.failure !== null) {
      return Promise.reject(this.failure);
    }
    const needle = query.trim().toLowerCase();
    return Promise.resolve({
      repos: this.repos.filter((repo) => repo.fullName.toLowerCase().includes(needle)),
      truncated: this.truncated,
    });
  }

  /**
   * @returns The scripted branches.
   * @throws Error When {@link StubGithubClient.failure} is set; rejected, as a real client does.
   */
  listBranches(): Promise<BranchSummary[]> {
    return this.failure === null ? Promise.resolve(this.branches) : Promise.reject(this.failure);
  }
}

/** Database double: answers the health probe and records disconnection. */
export class FakeDatabase implements DatabaseClient {
  /** Whether `$disconnect` was called. */
  disconnected = false;

  /** Set to make the health probe reject. */
  queryFailure: Error | null = null;

  /** Set to make the health probe never settle, so the probe timeout is exercised. */
  shouldHang = false;

  /**
   * @returns An empty row set, which is what the probe query yields once mapped.
   * @throws Error When {@link FakeDatabase.queryFailure} is set.
   */
  async $queryRaw<T = unknown>(): Promise<T> {
    if (this.queryFailure !== null) {
      throw this.queryFailure;
    }
    if (this.shouldHang) {
      await new Promise(() => {
        // Never settles on purpose: the caller's timeout is what ends the wait.
      });
    }
    return [] as T;
  }

  /**
   * Records disconnection.
   *
   * @returns Resolves once recorded.
   */
  $disconnect(): Promise<void> {
    this.disconnected = true;
    return Promise.resolve();
  }
}

/** The doubles behind a test container. */
export interface TestDoubles {
  clock: FakeClock;
  repos: Repositories;
  redis: FakeRedis;
  secrets: FakeSecretsService;
  github: StubGithubClient;
  prisma: FakeDatabase;
  queues: { chatTurns: FakeQueue; scheduledJobs: FakeQueue; workspaceGc: FakeQueue };
  /** Everything the logger wrote during the test, as one string. */
  logOutput(): string;
}

/** A container together with the doubles it was built from. */
export interface TestContainer {
  container: ServerContainer;
  doubles: TestDoubles;
}

/** Options of {@link createTestContainer}. */
export interface TestContainerOptions {
  /** Seed both secrets with the canaries; defaults to `true`. */
  secretsSet?: boolean;
  /** Initial instant of the fake clock. */
  now?: Date;
  /** Collaborators to override after the doubles are assembled. */
  overrides?: Partial<ServerContainerDeps>;
}

/**
 * Builds a container over in-memory repositories, fake queues, a fake Redis and a stub GitHub.
 *
 * @param options - Seeding, clock and per-test overrides.
 * @returns The container and the doubles behind it.
 */
export function createTestContainer(options: TestContainerOptions = {}): TestContainer {
  resetFakeQueues();
  const clock = new FakeClock(options.now ?? new Date('2026-08-19T10:00:00.000Z'));
  const repos = createInMemoryRepositories(clock);
  const redis = new FakeRedis();
  const prisma = new FakeDatabase();
  const github = new StubGithubClient();
  const secrets = new FakeSecretsService(seedSecrets(options.secretsSet), clock.now());
  const redactor = createRedactor();
  const { logger, output } = createCapturingLogger(redactor);

  const container: ServerContainer = {
    config: loadConfig(TEST_ENV),
    logger,
    prisma,
    repos,
    redis,
    queues: createFakeQueues(),
    secrets,
    redactor,
    github,
    clock,
    sse: { heartbeatMs: TEST_HEARTBEAT_MS, blockMs: TEST_BLOCK_MS },
    dispose(): Promise<void> {
      redis.disconnect();
      return Promise.resolve();
    },
    ...options.overrides,
  };

  return {
    container,
    doubles: {
      clock,
      repos,
      redis,
      secrets,
      github,
      prisma,
      queues: {
        chatTurns: fakeQueue(QUEUE_NAMES.chatTurns),
        scheduledJobs: fakeQueue(QUEUE_NAMES.scheduledJobs),
        workspaceGc: fakeQueue(QUEUE_NAMES.workspaceGc),
      },
      logOutput: output,
    },
  };
}

/**
 * Chooses which credentials the container starts with.
 *
 * @param secretsSet - `false` for the "not configured yet" state; anything else seeds both.
 * @returns The values to seed the secrets service with.
 */
function seedSecrets(secretsSet: boolean | undefined): Partial<Record<SecretKey, string>> {
  return secretsSet === false ? {} : { GITHUB_PAT: GITHUB_CANARY, OPENAI_API_KEY: OPENAI_CANARY };
}

/**
 * Builds a redacting logger whose output the test can read back.
 *
 * @param redactor - Redactor the logger applies, the real one from core.
 * @returns The logger and a reader of everything it wrote.
 */
function createCapturingLogger(redactor: Redactor): { logger: Logger; output: () => string } {
  const lines: string[] = [];
  const logger = createLogger({
    level: 'info',
    redactor,
    destination: {
      write(line: string): void {
        lines.push(line);
      },
    },
  });
  return { logger, output: () => lines.join('') };
}

/**
 * Builds the three application queues.
 *
 * Constructed through BullMQ's own `Queue`, which the module double replaces, so the core
 * producers stay under test. The connection is an empty options object rather than a client: the
 * double ignores it, and BullMQ's own type accepts one.
 *
 * @returns The queues, keyed as the application expects them.
 */
function createFakeQueues(): ApplicationQueues {
  return {
    chatTurns: new Queue(QUEUE_NAMES.chatTurns, { connection: {} }),
    scheduledJobs: new Queue(QUEUE_NAMES.scheduledJobs, { connection: {} }),
    workspaceGc: new Queue(QUEUE_NAMES.workspaceGc, { connection: {} }),
  };
}
