/**
 * Handle of the GitHub stub, shared between the global setup and the global teardown.
 *
 * Layer: test support (process-local state).
 *
 * Playwright runs both global hooks in the same process, so a module variable is enough to hand
 * the running server from one to the other; the state file carries only what a different process
 * — the pre-step, or a spec — has to know.
 */
import type { GithubStub } from './github-stub';

let activeStub: GithubStub | undefined;

/** Records the stub the global setup started. */
export function setActiveGithubStub(stub: GithubStub): void {
  activeStub = stub;
}

/** The stub started for this run, or `undefined` when none is. */
export function takeActiveGithubStub(): GithubStub | undefined {
  return activeStub;
}

/** Forgets the stub after it has been closed. */
export function clearActiveGithubStub(): void {
  activeStub = undefined;
}
