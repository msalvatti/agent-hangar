/**
 * The bit of state the pre-step, the global setup and the specs have to agree on, written to a
 * git-ignored file because each of them runs in a different process.
 *
 * Layer: test support (reads and writes one file).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { z } from 'zod';

import type { E2eEnv } from './env';

/** What the pre-step and the global setup record for the run. */
const stackState = z.object({
  gitServer: z.object({ url: z.string().min(1), containerName: z.string().min(1) }).optional(),
  githubStubBaseUrl: z.string().min(1).optional(),
  workerPid: z.number().int().positive().optional(),
});

/** State of the running stack. */
export type StackState = z.infer<typeof stackState>;

/** Path of the state file inside the run's temporary directory. */
function stackStatePath(env: E2eEnv): string {
  return `${env.tmpDir}/state.json`;
}

/**
 * Reads the recorded state.
 *
 * @param env - The resolved environment.
 * @returns The state, or an empty object when nothing has been recorded yet.
 */
export function readStackState(env: E2eEnv): StackState {
  const path = stackStatePath(env);
  if (!existsSync(path)) {
    return {};
  }
  return stackState.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/**
 * Records the state, creating the temporary directory when needed.
 *
 * @param env - The resolved environment.
 * @param state - State to write.
 */
export function writeStackState(env: E2eEnv, state: StackState): void {
  mkdirSync(env.tmpDir, { recursive: true });
  writeFileSync(stackStatePath(env), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
