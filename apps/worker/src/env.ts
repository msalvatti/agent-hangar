/**
 * Worker-local environment variables, validated with Zod at boot.
 *
 * Layer: config.
 *
 * Everything the whole application shares lives in core's `loadConfig`. This module holds only
 * what no other process reads: which `WorkspaceRunner` implementation the worker instantiates.
 * Keeping it here means the web app's configuration surface does not grow a variable it can do
 * nothing with, and a typo still fails at boot rather than at the first job.
 */
import { ConfigError } from '@agent-hangar/core';
import { z } from 'zod';

/** Runner implementations the worker can instantiate. */
export const WORKSPACE_RUNNERS = ['docker', 'fake'] as const;

/** One of {@link WORKSPACE_RUNNERS}. */
export type WorkspaceRunnerKind = (typeof WORKSPACE_RUNNERS)[number];

/**
 * Schema of the worker-local environment.
 *
 * `docker` is the default: the fake runner executes nothing, so a worker that silently fell back
 * to it would accept turns and produce scripted output that looks real.
 */
export const workerEnvSchema = z.object({
  WORKSPACE_RUNNER: z.enum(WORKSPACE_RUNNERS).default('docker'),
});

/** Validated worker-local environment. */
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/**
 * Reads and validates the worker-local environment.
 *
 * @param env - Environment to read (defaults to `process.env`).
 * @returns The validated values.
 * @throws ConfigError listing every invalid variable.
 */
export function parseWorkerEnv(env: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const result = workerEnvSchema.safeParse(env);
  if (result.success) {
    return result.data;
  }
  const problems = result.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  throw new ConfigError(`Invalid worker environment:\n${problems}`);
}
