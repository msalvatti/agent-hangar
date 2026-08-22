/**
 * Typed error raised by the Docker workspace runner.
 *
 * Layer: service (adapter).
 *
 * Everything that goes wrong while talking to the Docker daemon and is not already covered by a
 * shared domain error (`WorkspaceImageMissing`, `ProtocolError`) surfaces as this class, so callers
 * branch on `code` instead of matching daemon message strings. Messages are built from container
 * names, image references and environment variable KEYS only: `WorkspaceSpec.env` carries the
 * GitHub PAT and the OpenAI key, and a value must never reach an error, a log or a stack trace.
 */
import { AgentHangarError } from '../../errors.ts';
import type { AgentHangarErrorOptions } from '../../errors.ts';

/** The Docker daemon refused an operation, or the workspace could not be driven to a usable state. */
export class DockerRunnerError extends AgentHangarError {
  declare readonly code: 'DOCKER_RUNNER';

  /**
   * @param message - What failed, described with ids and names only — never a secret value.
   * @param options - Optional `cause` (the underlying daemon or stream error).
   */
  constructor(message: string, options?: AgentHangarErrorOptions) {
    super('DOCKER_RUNNER', message, options);
  }
}
