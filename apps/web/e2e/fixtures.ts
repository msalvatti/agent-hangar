/**
 * Playwright fixtures: the resolved environment, an API client, a health poller, seeded
 * credentials and a per-test reset.
 *
 * Layer: test support (Playwright).
 *
 * ## Real-stack matrix
 *
 * Every spec runs its whole user-interface path in `mock` mode. The assertions listed here need
 * the worker, Docker, Postgres, Redis and the local git server, so in `mock` mode the test stops
 * at that point with `needs real stack: …` in the report. Setting `E2E_MODE` to `real` is what
 * turns them green.
 *
 * - `chat-create-run` — turn reaches `SUCCEEDED` through `GET /api/chats/:id`; the two scripted
 *   tool calls are persisted; the workspace stays `READY` after the turn.
 * - `chat-archive-restore` — the workspace is gone after archiving; restoring keeps the history;
 *   the follow-up turn clones again and reaches `SUCCEEDED`.
 * - `cancel-turn` — the turn reaches `CANCELLED` within the cancel budget and the workspace
 *   survives the cancellation.
 * - `scheduled-job-run` — a manually triggered run reaches `SUCCEEDED`, its output and its
 *   `run_shell` tool call are persisted, and the job workspace is torn down.
 * - `settings-save-mask` — credentials survive a reload; `GET /api/settings` carries no
 *   plaintext; a tool call whose arguments contain a credential is stored redacted.
 * - `settings-missing` — `POST /api/chats` is refused with `409 SECRETS_MISSING` while no
 *   credentials are stored.
 */
import {
  chatDetail,
  listChatsResponse,
  listJobsResponse,
  listRunsResponse,
  putSecretResponse,
} from '@agent-hangar/core';
import { GITHUB_CANARY, OPENAI_CANARY } from '@agent-hangar/core/testing';
import { expect as baseExpect, test as base } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

import { createApi } from './support/api';
import type { E2eApi, E2eFetcher } from './support/api';
import { JOB_RUN_TIMEOUT_MS, TURN_SETTLE_TIMEOUT_MS } from './support/constants';
import { resetDatabase } from './support/db';
import { reapWorkspaces } from './support/docker';
import { resolveE2eEnv } from './support/env';
import type { E2eEnv } from './support/env';
import { createHealthHelper } from './support/health';
import type { HealthHelper } from './support/health';
import type { E2eMode } from './support/mode';

/**
 * Wraps Playwright's request context as the transport the API client expects.
 *
 * Every request carries an `Origin` naming the application's own origin. The API refuses a
 * state-changing request that cannot be shown to come from itself — it has no session and no
 * login, so "same origin" is the whole of its authorisation — and a non-browser client sends no
 * `Origin` unless it is told to. Without this every write is answered 403, which is the API
 * behaving correctly and the suite asking wrongly.
 *
 * @param request - Playwright's request context.
 * @param origin - The application's origin, which is also its base URL.
 * @returns The transport.
 */
function playwrightFetcher(request: APIRequestContext, origin: string): E2eFetcher {
  return async (url, init) => {
    const response = await request.fetch(url, {
      method: init.method,
      headers: { origin },
      ...(init.body === undefined ? {} : { data: init.body }),
    });
    return { status: response.status(), text: await response.text() };
  };
}

/** Turn and run statuses that mean work is under way. */
const LIVE_STATUSES: readonly string[] = ['QUEUED', 'PREPARING', 'RUNNING'];

/**
 * Cancels whatever is still running and waits for it to settle.
 *
 * Without this the reset cannot recover from the state it exists to clear, and the two ways it
 * fails are different. A chat with a live turn is refused outright — `DELETE /api/chats/:id`
 * answers `409 TURN_IN_PROGRESS` — so the reset would throw and take every later test down with
 * it. A job with a live run is worse, because deleting it is *allowed*: the run row cascades away
 * while the worker still owns the workspace, and the truncation and container reap that follow
 * pull the ground from under a processor that is still writing.
 *
 * The cancel is best-effort: something that settled on its own between the read and the request is
 * exactly the state being aimed at, and the API is entitled to refuse a second cancellation. The
 * wait is what carries the guarantee, and it fails by name.
 *
 * @param api - Client for the running API.
 * @param options - How to read what is still live, what to call it, and how long to allow.
 */
async function settleLive(
  api: E2eApi,
  options: { readLive: () => Promise<string[]>; describe: string; timeoutMs: number },
): Promise<void> {
  const live = await options.readLive();
  if (live.length === 0) {
    return;
  }
  for (const id of live) {
    await api.raw(`/api/turns/${id}/cancel`, { method: 'POST' });
  }
  await baseExpect
    .poll(async () => (await options.readLive()).length, {
      timeout: options.timeoutMs,
      message: `${options.describe} stayed live after being cancelled`,
    })
    .toBe(0);
}

/**
 * Removes every scheduled job through the API, settling anything still running first.
 *
 * Deleting the rows underneath the API would leave the BullMQ repeatable schedulers in Redis with
 * nothing to run, and the next spec would then see runs appear for a job it never created. The
 * delete endpoint is what removes both.
 *
 * @param api - Client for the running API.
 */
async function deleteAllJobsViaApi(api: E2eApi): Promise<void> {
  const { jobs } = await api.get('/api/jobs', listJobsResponse);
  for (const job of jobs) {
    await settleLive(api, {
      describe: `a run of job ${job.id}`,
      timeoutMs: JOB_RUN_TIMEOUT_MS,
      readLive: async () => {
        const { runs } = await api.get(`/api/jobs/${job.id}/runs`, listRunsResponse);
        return runs.filter((run) => LIVE_STATUSES.includes(run.status)).map((run) => run.id);
      },
    });
    await api.del(`/api/jobs/${job.id}`);
  }
}

/**
 * Removes every chat through the API, settling anything still running first, so the worker sees
 * the cancellations and tears down the workspaces it owns instead of having its rows pulled from
 * under it.
 *
 * @param api - Client for the running API.
 */
async function deleteAllChatsViaApi(api: E2eApi): Promise<void> {
  for (const status of ['ACTIVE', 'ARCHIVED'] as const) {
    const { chats } = await api.get(`/api/chats?status=${status}`, listChatsResponse);
    for (const chat of chats) {
      await settleLive(api, {
        describe: `a turn of chat ${chat.id}`,
        timeoutMs: TURN_SETTLE_TIMEOUT_MS,
        readLive: async () => {
          const detail = await api.get(`/api/chats/${chat.id}`, chatDetail);
          return detail.turns
            .filter((turn) => LIVE_STATUSES.includes(turn.status))
            .map((t) => t.id);
        },
      });
      await api.del(`/api/chats/${chat.id}`);
    }
  }
}

/** Fixtures every spec receives. */
export interface E2eFixtures {
  /** Everything resolved for this run. */
  env: E2eEnv;
  /** Whether the real stack is behind the interface. */
  mode: E2eMode;
  /** Typed API client bound to the run's base URL. */
  api: E2eApi;
  /** Poller over `GET /api/health`. */
  health: HealthHelper;
  /** Stores the canary credentials, so a turn can start. No-op in `mock` mode. */
  seedSettings: () => Promise<void>;
  /** Clone URL of the seed repository. */
  gitServer: { repoUrl: string };
  /**
   * Automatic per-test reset; nothing to do in `mock` mode. Its value is never read — the fixture
   * exists for its effect — so it carries `undefined`.
   */
  resetDb: undefined;
}

/**
 * `test` with the harness fixtures applied.
 *
 * Playwright's second argument to a fixture is named `provide` here rather than the conventional
 * `use`: a function literally called `use` reads to the React lint rules as React's own `use`
 * hook, and the name has no meaning to Playwright, which passes it positionally.
 */
export const test = base.extend<E2eFixtures>({
  env: async ({}, provide) => {
    await provide(resolveE2eEnv());
  },
  mode: async ({ env }, provide) => {
    await provide(env.mode);
  },
  api: async ({ request, env }, provide) => {
    await provide(createApi(playwrightFetcher(request, env.baseURL), env.baseURL));
  },
  health: async ({ api }, provide) => {
    await provide(createHealthHelper(api));
  },
  gitServer: async ({ env }, provide) => {
    await provide({ repoUrl: env.repoUrl });
  },
  seedSettings: async ({ api, mode }, provide) => {
    await provide(async () => {
      if (mode === 'mock') {
        return;
      }
      // `put`, not `raw`: a refused write must fail the test that depended on it. Swallowing the
      // status here would leave the credentials unset and blame whatever assertion noticed first.
      await api.put('/api/settings/GITHUB_PAT', { value: GITHUB_CANARY }, putSecretResponse);
      await api.put('/api/settings/OPENAI_API_KEY', { value: OPENAI_CANARY }, putSecretResponse);
    });
  },
  resetDb: [
    async ({ api, env, mode }, provide) => {
      if (mode === 'real') {
        await deleteAllJobsViaApi(api);
        await deleteAllChatsViaApi(api);
        await resetDatabase(env);
        await reapWorkspaces(env.workspaceNamePrefix);
      }
      await provide(undefined);
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
