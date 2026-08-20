/**
 * A fully in-memory `ProcessorDeps`, so every processor runs without Docker, Postgres or Redis.
 *
 * Layer: test double.
 *
 * The redactor is the real one: redaction is the property most worth testing, and a fake would
 * prove nothing. Everything else is a double whose state a test can read back — the runner's call
 * log, the repositories' tables, the published events and the captured log lines.
 */
import { createRedactor, loadConfig } from '@agent-hangar/core';
import type { AppConfig, RawEnv } from '@agent-hangar/core';
import {
  createInMemoryRepositories,
  FakeClock,
  FakeWorkspaceRunner,
  GITHUB_CANARY,
  OPENAI_CANARY,
} from '@agent-hangar/core/testing';
import type { InMemoryRepositories } from '@agent-hangar/core/testing';
import type { Logger } from 'pino';

import { createWorkspaceClaims } from '../claims.js';
import { createImageStatus } from '../image-status.js';
import { createLogger } from '../logger.js';
import type { ProcessorDeps } from '../processors/types.js';

import { createFakeQueues } from './fake-queues.js';
import type { FakeQueues } from './fake-queues.js';
import { FakeSecretsService } from './fake-secrets.js';
import { InMemoryCommandListener } from './in-memory-commands.js';
import { InMemoryTurnEventPublisher } from './in-memory-publisher.js';

/** Environment the test configuration is loaded from; nothing reads `process.env`. */
export const TEST_ENV: RawEnv = {
  AH_INSTANCE: 'w2b-unit',
  AH_PORT_BASE: '3300',
  WORKSPACE_IMAGE: 'agent-hangar/workspace:test',
  WORKSPACE_IDLE_TTL_MIN: '30',
  WORKER_TURN_CONCURRENCY: '2',
  OPENAI_MODEL: 'test-model',
  AGENT_MODEL_PROVIDER: 'fake',
  LOG_LEVEL: 'debug',
  MASTER_KEY_PATH: '/nonexistent/master.key',
};

/** An in-memory container plus the handles a test asserts on. */
export interface TestContainer extends ProcessorDeps {
  config: AppConfig;
  clock: FakeClock;
  repos: InMemoryRepositories;
  runner: FakeWorkspaceRunner;
  secrets: FakeSecretsService;
  publisher: InMemoryTurnEventPublisher;
  commands: InMemoryCommandListener;
  queues: FakeQueues;
  /** Every finished log line, as JSON text. */
  logs: string[];
}

/**
 * Builds the logger that records what the processors write.
 *
 * @param lines - Array the finished lines are appended to.
 * @param redactor - The container's redactor, so the capture proves redaction end to end.
 * @returns A pino logger writing into `lines`.
 */
function createCapturingLogger(
  lines: string[],
  redactor: ReturnType<typeof createRedactor>,
): Logger {
  return createLogger({
    level: 'debug',
    redactor,
    destination: {
      write(line: string): void {
        lines.push(line);
      },
    },
  });
}

/**
 * Builds an in-memory container.
 *
 * Both credentials are present by default; drop one through `secrets` to exercise the
 * missing-credential path.
 *
 * @param overrides - Collaborators to replace.
 * @returns The container.
 */
export function createTestContainer(overrides: Partial<TestContainer> = {}): TestContainer {
  const clock = overrides.clock ?? new FakeClock();
  const redactor = createRedactor();
  const logs = overrides.logs ?? [];
  const base: TestContainer = {
    config: loadConfig(TEST_ENV),
    logger: createCapturingLogger(logs, redactor),
    clock,
    repos: createInMemoryRepositories(clock),
    runner: new FakeWorkspaceRunner({ clock }),
    secrets: new FakeSecretsService({
      GITHUB_PAT: GITHUB_CANARY,
      OPENAI_API_KEY: OPENAI_CANARY,
    }),
    redactor,
    publisher: new InMemoryTurnEventPublisher(),
    commands: new InMemoryCommandListener(),
    queues: createFakeQueues(),
    imageStatus: createImageStatus(),
    claims: createWorkspaceClaims(),
    logs,
  };
  return { ...base, ...overrides };
}
