/**
 * Global setup: starts the GitHub REST stub for a real-stack run and records where it listens.
 *
 * Layer: test support (Playwright global hook).
 *
 * Everything the managed servers read at boot is already up by the time this runs — see
 * `support/prepare-stack.ts` for why. In `mock` mode there is nothing to start: the MSW handlers
 * answer the repository endpoints inside the browser.
 */
import { resolveE2eEnv } from './support/env';
import { startGithubStub } from './support/github-stub';
import { setActiveGithubStub } from './support/stack';
import { readStackState, writeStackState } from './support/stack-state';

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
}
