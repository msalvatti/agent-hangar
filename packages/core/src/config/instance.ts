/**
 * Instance resolution: derives ports, database name, compose project and container prefix from
 * `AH_INSTANCE` / `AH_PORT_BASE` (or the Conductor equivalents) so two checkouts never collide.
 *
 * Layer: config.
 *
 * `infra/scripts/env.sh` implements the same derivation for shell consumers; a test compares both.
 */
import { ConfigError } from '../errors.ts';

/** Instance name used when nothing is configured. */
export const DEFAULT_INSTANCE = 'default';

/** Port base used when nothing is configured. */
export const DEFAULT_PORT_BASE = 3000;

/** Maximum length of an instance slug. */
export const INSTANCE_SLUG_MAX_LENGTH = 30;

/** Lowest port base accepted (ports below are privileged or reserved). */
export const MIN_PORT_BASE = 1024;

/** Highest port base accepted so that `base + 9` still fits the 10-port block. */
export const MAX_PORT_BASE = 65_000;

/** Environment keys read by {@link resolveInstance}. */
export interface InstanceEnv {
  AH_INSTANCE?: string | undefined;
  AH_PORT_BASE?: string | undefined;
  CONDUCTOR_WORKSPACE_NAME?: string | undefined;
  CONDUCTOR_PORT?: string | undefined;
}

/** Everything derived from the instance name and port base. */
export interface InstanceInfo {
  /** Slugified instance name (`[a-z0-9-]`, max 30). */
  instance: string;
  /** Base of the 10-port block. */
  portBase: number;
  /** `portBase + 0`. */
  webPort: number;
  /** `portBase + 1`. */
  postgresPort: number;
  /** `portBase + 2`. */
  redisPort: number;
  /** `agent_hangar_<instance>` with `-` → `_`. */
  postgresDb: string;
  /** `agent-hangar-<instance>`. */
  composeProjectName: string;
  /** `ah-ws-<instance>-`. */
  workspaceNamePrefix: string;
}

/**
 * Slugifies an instance name: lowercase, anything outside `[a-z0-9-]` becomes `-`, runs of `-`
 * collapse, leading/trailing `-` are trimmed, and the result is capped at 30 characters.
 *
 * @param raw - Any user- or Conductor-provided name.
 * @returns The slug, or {@link DEFAULT_INSTANCE} when nothing usable remains.
 */
export function slugifyInstance(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, INSTANCE_SLUG_MAX_LENGTH)
    .replace(/-$/, '');
  return slug.length === 0 ? DEFAULT_INSTANCE : slug;
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value.trim().length > 0)?.trim();
}

function parsePortBase(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_PORT_BASE;
  }
  const port = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(port) || port < MIN_PORT_BASE || port > MAX_PORT_BASE) {
    throw new ConfigError(
      `AH_PORT_BASE must be an integer between ${MIN_PORT_BASE} and ${MAX_PORT_BASE}, got "${raw}"`,
    );
  }
  return port;
}

/**
 * Resolves the instance from the environment with precedence
 * `AH_INSTANCE` → `CONDUCTOR_WORKSPACE_NAME` → `default` and
 * `AH_PORT_BASE` → `CONDUCTOR_PORT` → `3000`.
 *
 * @param options - `env` to read from (defaults to `process.env`).
 * @returns The derived instance values.
 * @throws ConfigError when the port base is not a valid integer in range.
 */
export function resolveInstance(options: { env?: InstanceEnv } = {}): InstanceInfo {
  const env = options.env ?? process.env;
  const instance = slugifyInstance(
    firstNonEmpty(env.AH_INSTANCE, env.CONDUCTOR_WORKSPACE_NAME) ?? DEFAULT_INSTANCE,
  );
  const portBase = parsePortBase(firstNonEmpty(env.AH_PORT_BASE, env.CONDUCTOR_PORT));
  return {
    instance,
    portBase,
    webPort: portBase,
    postgresPort: portBase + 1,
    redisPort: portBase + 2,
    postgresDb: `agent_hangar_${instance.replaceAll('-', '_')}`,
    composeProjectName: `agent-hangar-${instance}`,
    workspaceNamePrefix: `ah-ws-${instance}-`,
  };
}
