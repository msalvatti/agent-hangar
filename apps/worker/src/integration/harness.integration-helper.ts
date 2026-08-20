/**
 * The real-infrastructure harness of the `@docker @db @redis` suite.
 *
 * Layer: test double (integration).
 *
 * Everything here is the production wiring: the real container, the real Docker runner, the real
 * repositories and the real secrets service over a throwaway master key. Only the model is fake,
 * because a scheduled turn against a paid API is not a test. Credentials are the canaries, so the
 * suite can assert they reach the container environment and nothing else.
 */
import {
  createQueueConnection,
  createSecretsService,
  loadConfig,
  MasterKeyFile,
  turnEventsStreamKey,
} from '@agent-hangar/core';
import type { AppConfig, WorkspaceHandle } from '@agent-hangar/core';
import { GITHUB_CANARY, OPENAI_CANARY, truncateAll } from '@agent-hangar/core/testing';
import type { Redis } from 'ioredis';

import { defaultWorkerFactories, startWorker } from '../app.js';
import { createContainer, defaultContainerFactories } from '../container.js';
import type { WorkerContainer } from '../container.js';
import { LABELS } from '../processors/constants.js';

/** Repository the suite works against; small, public, and cloneable without a token. */
export const TEST_REPO_URL = process.env.TEST_REPO_URL ?? 'https://github.com/octocat/Hello-World';

/** Default branch of {@link TEST_REPO_URL}. */
export const TEST_REPO_BRANCH = process.env.TEST_REPO_BRANCH ?? 'master';

/** One entry of a turn's event stream, as Redis returns it. */
export interface StreamEntry {
  /** Stream id, which is also the SSE event id. */
  id: string;
  /** The `AgentEvent` discriminator. */
  type: string;
  /** The whole event, as JSON text. */
  data: string;
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
    const values = new Map<string, string>();
    for (let index = 0; index + 1 < fields.length; index += 2) {
      values.set(fields[index] ?? '', fields[index + 1] ?? '');
    }
    return { id, type: values.get('type') ?? '', data: values.get('data') ?? '' };
  });
}

/**
 * Builds the harness against the running compose instance and Docker daemon.
 *
 * @param options - Where the throwaway master key lives.
 * @returns The harness, with the workers already consuming.
 */
export async function createIntegrationHarness(options: {
  masterKeyPath: string;
}): Promise<IntegrationHarness> {
  const config = loadConfig({
    ...process.env,
    MASTER_KEY_PATH: options.masterKeyPath,
    AGENT_MODEL_PROVIDER: 'fake',
  });
  const container = await createContainer({
    config,
    env: { WORKSPACE_RUNNER: 'docker' },
    factories: defaultContainerFactories,
  });
  const inspect = createQueueConnection(config.REDIS_URL);

  await truncateAll(container.prisma);
  await inspect.flushdb();

  const secrets = createSecretsService({
    repository: container.repos.secrets,
    masterKey: new MasterKeyFile({ path: options.masterKeyPath }),
  });
  await secrets.set('GITHUB_PAT', GITHUB_CANARY);
  await secrets.set('OPENAI_API_KEY', OPENAI_CANARY);

  const app = await startWorker(container, defaultWorkerFactories);
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
        await new Promise((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS));
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
