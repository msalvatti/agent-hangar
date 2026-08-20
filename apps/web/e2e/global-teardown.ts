/**
 * Global teardown: stops the GitHub stub and, unless the stack is being kept, the worker and the
 * git server.
 *
 * Layer: test support (Playwright global hook).
 *
 * `E2E_KEEP_STACK=1` leaves the git server container running so a developer iterating on one spec
 * does not pay for a rebuild and a reseed on every run; `startGitServer` reuses it.
 */
import { resolveE2eEnv } from './support/env';
import { stopGitServer } from './support/gitserver';
import { clearActiveGithubStub, takeActiveGithubStub } from './support/stack';
import { readStackState } from './support/stack-state';
import { stopWorker } from './support/worker';

export default async function globalTeardown(): Promise<void> {
  const env = resolveE2eEnv();
  const stub = takeActiveGithubStub();
  if (stub !== undefined) {
    await stub.close();
    clearActiveGithubStub();
  }
  if (env.mode === 'mock' || process.env.E2E_KEEP_STACK === '1') {
    return;
  }
  const { gitServer, workerPid } = readStackState(env);
  if (workerPid !== undefined) {
    await stopWorker(workerPid);
  }
  if (gitServer !== undefined) {
    await stopGitServer(gitServer);
  }
}
