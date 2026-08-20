/**
 * The real-infrastructure harness of the `@docker @db @redis` suite.
 *
 * Layer: test double (integration).
 *
 * Everything here is the production wiring: the real container, the real Docker runner, the real
 * repositories and the real secrets service over a throwaway master key. Only the model is fake,
 * because a scheduled turn against a paid API is not a test. Credentials are the canaries, so the
 * suite can assert they reach the container environment and nothing else. A scenario that needs
 * its own answers hands over a script file, which the worker resolves at boot exactly as it does
 * in production.
 */
import { setTimeout as delay } from 'node:timers/promises';

import {
  agentEventSchema,
  createQueueConnection,
  createSecretsService,
  loadConfig,
  MasterKeyFile,
  turnEventsStreamKey,
} from '@agent-hangar/core';
import type { AgentEvent, AppConfig, WorkspaceHandle } from '@agent-hangar/core';
import { GITHUB_CANARY, OPENAI_CANARY, truncateAll } from '@agent-hangar/core/testing';
import type { Redis } from 'ioredis';

import { defaultWorkerFactories, startWorker } from '../app.js';
import type { RunningWorker } from '../app.js';
import { createContainer, defaultContainerFactories } from '../container.js';
import type { WorkerContainer } from '../container.js';
import { TURN_EVENT_FIELD } from '../events.js';
import { LABELS } from '../processors/constants.js';

import { assertRedisErasable } from './redis-guard.js';

/** Repository the suite works against; small, public, and cloneable without a token. */
export const TEST_REPO_URL = process.env.TEST_REPO_URL ?? 'https://github.com/octocat/Hello-World';

/** Default branch of {@link TEST_REPO_URL}. */
export const TEST_REPO_BRANCH = process.env.TEST_REPO_BRANCH ?? 'master';

/** One entry of a turn's event stream, as Redis returns it. */
export interface StreamEntry {
  /** Stream id, which is also the SSE event id. */
  id: string;
  /** The event the entry carries, parsed. */
  event: AgentEvent;
}

/** How long a scenario waits for a turn to reach a terminal state. */
export const WAIT_TIMEOUT_MS = 180_000;

/** How often a scenario polls while waiting. */
export const WAIT_INTERVAL_MS = 500;

/** Everything a scenario drives. */
export interface IntegrationHarness {
  config: AppConfig;
  container: WorkerContainer;
  /** A separate connection for inspecting streams; the container's are owned by BullMQ. */
  inspect: Redis;
  /**
   * Polls until a predicate holds.
   *
   * @param what - Named in the failure message.
   * @param predicate - Checked every {@link WAIT_INTERVAL_MS}.
   */
  waitFor(what: string, predicate: () => Promise<boolean>): Promise<void>;
  /**
   * Reads a turn's whole event stream.
   *
   * @param turnId - `Turn.id` or `JobRun.id`.
   */
  readStream(turnId: string): Promise<StreamEntry[]>;
  /**
   * Reads the remaining lifetime of a turn's stream, in seconds.
   *
   * @param turnId - `Turn.id` or `JobRun.id`.
   */
  streamTtl(turnId: string): Promise<number>;
  /** Every container this instance still owns. */
  listInstanceHandles(): Promise<WorkspaceHandle[]>;
  /** Destroys every container this instance still owns. */
  destroyAllInstanceContainers(): Promise<void>;
  /** Stops the workers, releases the container and removes anything left behind. */
  close(): Promise<void>;
}

/**
 * Parses a Redis stream reply into entries.
 *
 * @param reply - What `XRANGE` returned.
 * @returns One entry per stream element.
 */
function toEntries(reply: [string, string[]][]): StreamEntry[] {
  return reply.map(([id, fields]) => {
    const at = fields.indexOf(TURN_EVENT_FIELD);
    // The suite asserts the exact wire shape the web app reads, so an entry that does not carry
    // one parseable event under that field fails here rather than in a vague assertion later.
    return { id, event: agentEventSchema.parse(JSON.parse(fields[at + 1] ?? 'null')) };
  });
}

/**
 * Stores the canaries through the real secrets service, over a throwaway master key.
 *
 * The suite asserts these exact values reach the container environment and nothing else, which is
 * only meaningful if they travelled the production encryption path to get there.
 *
 * @param container - The application container, for its secret repository.
 * @param masterKeyPath - Throwaway key file; created 0600 on first use.
 */
async function seedCanaryCredentials(
  container: WorkerContainer,
  masterKeyPath: string,
): Promise<void> {
  const secrets = createSecretsService({
    repository: container.repos.secrets,
    masterKey: new MasterKeyFile({ path: masterKeyPath }),
  });
  await secrets.set('GITHUB_PAT', GITHUB_CANARY);
  await secrets.set('OPENAI_API_KEY', OPENAI_CANARY);
}

/**
 * Builds the harness against the running compose instance and Docker daemon.
 *
 * @param options - Where the throwaway master key lives, and the script to answer from.
 * @returns The harness, with the workers already consuming.
 */
export async function createIntegrationHarness(options: {
  masterKeyPath: string;
  /** Script the containers answer from; absent leaves the runtime's built-in one in force. */
  fakeProviderScriptPath?: string;
}): Promise<IntegrationHarness> {
  const config = loadConfig({
    ...process.env,
    MASTER_KEY_PATH: options.masterKeyPath,
    AGENT_MODEL_PROVIDER: 'fake',
  });
  const container = await createContainer({
    config,
    env: {
      WORKSPACE_RUNNER: 'docker',
      ...(options.fakeProviderScriptPath === undefined
        ? {}
        : { FAKE_PROVIDER_SCRIPT_PATH: options.fakeProviderScriptPath }),
    },
    factories: defaultContainerFactories,
  });
  const inspect = createQueueConnection(config.REDIS_URL);

  await truncateAll(container.prisma);
  // The line above fails closed on the database; this one does the same for Redis, which no other
  // check in the suite covers and which `FLUSHDB` cannot narrow once it has run.
  assertRedisErasable(config);
  await inspect.flushdb();
  await seedCanaryCredentials(container, options.masterKeyPath);

  const app = await startWorker(container, defaultWorkerFactories);
  return assembleHarness(config, container, inspect, app);
}

/**
 * Wraps the built collaborators in the surface a scenario drives.
 *
 * @param config - Validated configuration of the test instance.
 * @param container - The application container.
 * @param inspect - Connection used for reading streams, kept out of BullMQ's way.
 * @param app - The running workers.
 * @returns The harness.
 */
function assembleHarness(
  config: AppConfig,
  container: WorkerContainer,
  inspect: Redis,
  app: RunningWorker,
): IntegrationHarness {
  const instanceLabel = { [LABELS.instance]: config.AH_INSTANCE };
  const listInstanceHandles = (): Promise<WorkspaceHandle[]> =>
    container.runner.list(instanceLabel);
  const destroyAllInstanceContainers = async (): Promise<void> => {
    for (const handle of await listInstanceHandles()) {
      await container.runner.destroy(handle);
    }
  };

  return {
    config,
    container,
    inspect,
    listInstanceHandles,
    destroyAllInstanceContainers,

    async waitFor(what, predicate): Promise<void> {
      const deadline = Date.now() + WAIT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (await predicate()) {
          return;
        }
        await delay(WAIT_INTERVAL_MS);
      }
      throw new Error(`timed out after ${WAIT_TIMEOUT_MS} ms waiting for ${what}`);
    },

    async readStream(turnId): Promise<StreamEntry[]> {
      const reply = await inspect.xrange(turnEventsStreamKey(turnId), '-', '+');
      return toEntries(reply);
    },

    streamTtl(turnId): Promise<number> {
      return inspect.ttl(turnEventsStreamKey(turnId));
    },

    async close(): Promise<void> {
      await destroyAllInstanceContainers();
      await app.shutdown();
      await inspect.quit();
    },
  };
}
