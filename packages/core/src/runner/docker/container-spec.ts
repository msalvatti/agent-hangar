/**
 * Translation of a {@link WorkspaceSpec} into Docker `createContainer` options.
 *
 * Layer: service (adapter).
 *
 * Pure: no daemon call, no clock, no randomness — the security posture of every workspace is one
 * function that a unit test can pin exactly. The hardening is not optional and not configurable:
 * non-root user, every capability dropped, `no-new-privileges`, a tmpfs `/tmp`, resource ceilings,
 * and no bind mount, no volume and above all no Docker socket, because the container runs code an
 * untrusted repository and a language model chose.
 */
import type Dockerode from 'dockerode';

import type { WorkspaceSpec } from '../types.js';

import { DockerRunnerError } from './errors.js';

/** Unprivileged user baked into the workspace image (uid 1001). */
export const WORKSPACE_USER = 'agent';

/** Directory the repository is checked out into, and the default working directory. */
export const WORKSPACE_DIR = '/workspace';

/** Label carrying the instance name; every GC and reap query is scoped by it. */
export const LABEL_INSTANCE = 'ah.instance';

/** Label carrying the `Workspace` row id. */
export const LABEL_WORKSPACE = 'ah.workspace';

/** Label carrying the workspace kind (`CHAT` or `JOB`). */
export const LABEL_KIND = 'ah.kind';

/** Label callers set on a chat workspace, carrying the chat id. */
export const LABEL_CHAT = 'ah.chat';

/** Label callers set on a scheduled-run workspace, carrying the job run id. */
export const LABEL_JOB_RUN = 'ah.jobRun';

/**
 * Compose project label, set purely so Docker Desktop groups an instance's workspaces together.
 *
 * The value deliberately does NOT match the stack's own compose project: `infra/scripts/archive.sh`
 * runs `docker compose down -v --remove-orphans`, and compose destroys every container carrying
 * its project label that is absent from the compose file. Sharing the name would make a live chat
 * container an "orphan" and let a routine teardown kill it mid-turn.
 */
export const LABEL_COMPOSE_PROJECT = 'com.docker.compose.project';

/** Compose service label; groups an instance's workspaces by kind inside the project. */
export const LABEL_COMPOSE_SERVICE = 'com.docker.compose.service';

/** Suffix that keeps the workspace compose project distinct from the stack's own project. */
export const COMPOSE_PROJECT_SUFFIX = '-ws';

/** Nanoseconds of CPU time per second, the unit Docker's `NanoCpus` is expressed in. */
const NANO_CPUS_PER_CPU = 1_000_000_000;

/** Characters Docker accepts in a container name after the instance prefix. */
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** POSIX environment variable name. */
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Naming and scoping inputs the spec itself does not carry. */
export interface ContainerSpecOptions {
  /** Container name prefix of this instance, e.g. `ah-ws-default-`. */
  namePrefix: string;
  /** Instance name, written to the `ah.instance` label. */
  instance: string;
}

/**
 * Encodes an environment map as Docker's `KEY=VALUE` array.
 *
 * Keys are validated because they end up in the container's process environment verbatim; values
 * are never validated, never logged and never echoed in an error — they carry the GitHub PAT and
 * the OpenAI key.
 *
 * @param env - Environment to encode.
 * @returns One `KEY=VALUE` entry per key, in insertion order.
 * @throws DockerRunnerError naming the offending key (never its value) when a key is not a valid
 *   POSIX environment variable name.
 */
export function toEnvArray(env: Readonly<Record<string, string>>): string[] {
  return Object.entries(env).map(([key, value]) => {
    if (!ENV_KEY_PATTERN.test(key)) {
      throw new DockerRunnerError(`invalid environment variable name "${key}"`);
    }
    return `${key}=${value}`;
  });
}

/**
 * Rejects a spec Docker would either refuse or accept with no ceiling at all.
 *
 * A zero or negative limit is the dangerous case: Docker reads it as "unlimited", so a typo would
 * silently hand a workspace the whole host instead of failing.
 *
 * @param spec - Workspace to validate.
 * @throws DockerRunnerError when the id is not a legal container-name segment or a limit is not
 *   strictly positive.
 */
function assertSpecIsUsable(spec: WorkspaceSpec): void {
  if (!WORKSPACE_ID_PATTERN.test(spec.workspaceId)) {
    throw new DockerRunnerError(`invalid workspace id "${spec.workspaceId}"`);
  }

  const { cpus, memoryBytes, pids } = spec.limits;
  if (cpus <= 0 || memoryBytes <= 0 || pids <= 0) {
    throw new DockerRunnerError(
      `workspace ${spec.workspaceId} must have positive cpus, memoryBytes and pids limits`,
    );
  }
}

/**
 * Builds the `createContainer` options for a workspace.
 *
 * `limits.diskBytes` is accepted by the contract but ignored here: Docker Desktop's default
 * storage driver enforces no per-container quota, so honouring it would only be theatre. The tmpfs
 * `/tmp` and the absence of any mount keep the container's writable state inside its own layer,
 * which `destroy` removes with `{ v: true }`.
 *
 * @param spec - Workspace to create, including the secrets that go into its environment.
 * @param opts - Instance naming and scoping.
 * @returns Options ready for `docker.createContainer`.
 * @throws DockerRunnerError when the id, a limit or an environment key is invalid.
 */
export function buildContainerCreateOptions(
  spec: WorkspaceSpec,
  opts: ContainerSpecOptions,
): Dockerode.ContainerCreateOptions {
  assertSpecIsUsable(spec);

  return {
    name: `${opts.namePrefix}${spec.workspaceId}`,
    Image: spec.image,
    Env: toEnvArray(spec.env),
    User: WORKSPACE_USER,
    WorkingDir: WORKSPACE_DIR,
    Tty: false,
    OpenStdin: false,
    // Fixed labels are spread last: discovery, reaping and the Docker Desktop grouping must hold
    // even when a caller passes a label of the same name.
    Labels: {
      ...spec.labels,
      [LABEL_INSTANCE]: opts.instance,
      [LABEL_WORKSPACE]: spec.workspaceId,
      [LABEL_KIND]: spec.kind,
      [LABEL_COMPOSE_PROJECT]: `agent-hangar-${opts.instance}${COMPOSE_PROJECT_SUFFIX}`,
      [LABEL_COMPOSE_SERVICE]: spec.kind.toLowerCase(),
    },
    HostConfig: {
      Memory: spec.limits.memoryBytes,
      NanoCpus: Math.round(spec.limits.cpus * NANO_CPUS_PER_CPU),
      PidsLimit: spec.limits.pids,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      Tmpfs: { '/tmp': '' },
      NetworkMode: 'bridge',
    },
  };
}
