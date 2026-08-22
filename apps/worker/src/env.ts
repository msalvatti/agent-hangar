/**
 * Worker-local environment variables, validated with Zod at boot.
 *
 * Layer: config.
 *
 * Everything the whole application shares lives in core's `loadConfig`. This module holds only
 * what no other process reads: which `WorkspaceRunner` implementation the worker instantiates,
 * and where the scripted provider's script is read from. Keeping them here means the web app's
 * configuration surface does not grow variables it can do nothing with, and a typo still fails at
 * boot rather than at the first job.
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
 *
 * `FAKE_PROVIDER_SCRIPT_PATH` names a file of scripted model responses. It is read only when
 * `AGENT_MODEL_PROVIDER` selects the scripted provider, and it is absent in every other run; a
 * blank value is a mistake rather than a way of unsetting it, so it is refused here.
 */
export const workerEnvSchema = z.object({
  WORKSPACE_RUNNER: z.enum(WORKSPACE_RUNNERS).default('docker'),
  FAKE_PROVIDER_SCRIPT_PATH: z.string().min(1).optional(),
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
    // The separator falls between the segments of a nested path, and this schema is flat: every
    // issue names one variable and nothing under it, so it is written for the schema this may
    // grow into rather than for the one it is.
    .map(
      (issue) =>
        `  - ${issue.path.join(
          // Stryker disable next-line StringLiteral: no issue path here has a second segment.
          '.',
        )}: ${issue.message}`,
    )
    .join('\n');
  throw new ConfigError(`Invalid worker environment:\n${problems}`);
}
