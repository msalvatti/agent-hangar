/**
 * Public API of the Docker workspace runner (`@agent-hangar/core/runner/docker`).
 *
 * Layer: service (adapter).
 *
 * Exposed as its own subpath so dockerode stays out of the package's main barrel: the web app and
 * the agent-runtime bundle import `@agent-hangar/core` and must never pull a Docker client into
 * their graph. Only the worker imports this entry point.
 */
import Dockerode from 'dockerode';

import type { Clock } from '../../config/clock.ts';

import { resolveDockerSocket } from './docker-socket.ts';
import { DockerWorkspaceRunner } from './docker-workspace-runner.ts';

export {
  buildContainerCreateOptions,
  COMPOSE_PROJECT_SUFFIX,
  LABEL_CHAT,
  LABEL_COMPOSE_PROJECT,
  LABEL_COMPOSE_SERVICE,
  LABEL_INSTANCE,
  LABEL_JOB_RUN,
  LABEL_KIND,
  LABEL_WORKSPACE,
  toEnvArray,
  WORKSPACE_DIR,
  WORKSPACE_HANDOFF_DIR,
  WORKSPACE_USER,
} from './container-spec.ts';
export type { ContainerSpecOptions } from './container-spec.ts';
export { isDockerConflict, isDockerNotFound, isDockerNotModified } from './docker-api.ts';
export type {
  DockerApi,
  DockerContainerApi,
  DockerContainerState,
  DockerExecApi,
  DockerExecCreateOptions,
  DockerExecStartOptions,
  DockerExecStream,
} from './docker-api.ts';
export { resolveDockerSocket } from './docker-socket.ts';
export type {
  DockerodeOptions,
  DockerSocketResolution,
  DockerSocketSource,
  ResolveDockerSocketDeps,
} from './docker-socket.ts';
export { DockerWorkspaceRunner } from './docker-workspace-runner.ts';
export type { DockerWorkspaceRunnerOptions, Sleep } from './docker-workspace-runner.ts';
export { DockerRunnerError } from './errors.ts';
export {
  EXEC_PID_DIR,
  execWrapperCommand,
  killCommand,
  systemScheduleTimeout,
} from './exec-stream.ts';
export type { ExecTermination, ScheduleTimeout } from './exec-stream.ts';
export { parseAheadBehind, truncateSummary } from './git-snapshot.ts';
export type { CaptureExec, CaptureResult } from './git-snapshot.ts';

/** Inputs for wiring the runner against a real Docker daemon. */
export interface CreateDockerWorkspaceRunnerConfig {
  /** Instance name; scopes container labels and every discovery query. */
  instance: string;
  /** Container name prefix of this instance. */
  namePrefix: string;
  /** Environment to resolve the daemon endpoint from; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Time source; defaults to the system clock. */
  clock?: Clock | undefined;
}

/**
 * Builds a runner backed by the real Docker daemon.
 *
 * This is the only place in the repository that constructs a dockerode client; everything else
 * depends on the `DockerApi` interface, which keeps the runner unit-testable and the SDK out of
 * every other module's import graph.
 *
 * @param config - Instance naming plus optional environment and clock overrides.
 * @returns A runner connected to the endpoint `resolveDockerSocket` selected.
 * @throws DockerRunnerError when `DOCKER_HOST` is unsupported or requires TLS.
 */
export function createDockerWorkspaceRunner(
  config: CreateDockerWorkspaceRunnerConfig,
): DockerWorkspaceRunner {
  const { options } = resolveDockerSocket({ env: config.env });
  return new DockerWorkspaceRunner({
    docker: new Dockerode(options),
    instance: config.instance,
    namePrefix: config.namePrefix,
    clock: config.clock,
  });
}
