/**
 * Global setup: starts the GitHub REST stub for a real-stack run, and refuses to let the suite
 * begin until the worker is actually up.
 *
 * Layer: test support (Playwright global hook).
 *
 * Everything the managed servers read at boot is already up by the time this runs — see
 * `support/prepare-stack.ts` for why. In `mock` mode there is nothing to start: the MSW handlers
 * answer the repository endpoints inside the browser.
 *
 * The worker owns no port, so Playwright cannot wait for it: a `webServer` entry can only assert
 * an HTTP status, and every status the health route returns is 200 whatever the worker is doing.
 * What does distinguish a running worker is the content of that response — Docker and the image
 * are reported from the heartbeat the worker writes to Redis, so both are `ok` only once it has
 * reported. Waiting on the positive condition rather than on a message string means a silent
 * worker times out here, loudly, instead of every spec failing later for reasons that look
 * unrelated.
 */
import { createApi } from './support/api';
import type { E2eFetcher } from './support/api';
import { WORKER_READY_TIMEOUT_MS } from './support/constants';
import { resolveE2eEnv } from './support/env';
import { startGithubStub } from './support/github-stub';
import { createHealthHelper } from './support/health';
import { setActiveGithubStub } from './support/stack';
import { readStackState, writeStackState } from './support/stack-state';

/** Transport for the global hooks, which run outside a test and have no Playwright fixtures. */
const nodeFetcher: E2eFetcher = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    ...(init.body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) }),
  });
  return { status: response.status, text: await response.text() };
};

export default async function globalSetup(): Promise<void> {
  const env = resolveE2eEnv();
  if (env.mode === 'mock') {
    return;
  }
  const state = readStackState(env);
  const stub = await startGithubStub({
    port: env.githubStubPort,
    repoBaseUrl: `http://${env.gitServerHost}:${String(env.gitServerPort)}`,
  });
  setActiveGithubStub(stub);
  writeStackState(env, { ...state, githubStubBaseUrl: stub.baseUrl });

  const health = createHealthHelper(createApi(nodeFetcher, env.baseURL));
  await health.waitFor(
    (body) => body.checks.docker.ok && body.checks.image.ok,
    WORKER_READY_TIMEOUT_MS,
    'the worker to report Docker and the workspace image through GET /api/health',
  );
}
