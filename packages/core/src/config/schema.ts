/**
 * Environment schema and loader: every variable the app reads, validated with Zod at boot.
 *
 * Layer: config.
 *
 * `loadConfig` first resolves the instance (ports, db, compose project, prefix), fills the
 * instance-derived defaults, then validates the whole environment and throws a `ConfigError`
 * listing every problem. Secrets (PAT, OpenAI key) are deliberately not environment variables.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { ConfigError } from '../errors.ts';
import { parseAllowedRepoOrigin } from '../repo-url.ts';

import { resolveInstance } from './instance.ts';
import type { InstanceInfo } from './instance.ts';

/** pino log levels. */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** Model provider implementations. */
export const MODEL_PROVIDERS = ['openai', 'fake'] as const;

/** Default workspace image reference. */
export const DEFAULT_WORKSPACE_IMAGE = 'agent-hangar/workspace:dev';

/** Default OpenAI model id. */
export const DEFAULT_OPENAI_MODEL = 'gpt-5.6-sol';

/**
 * `user:password` of the local compose Postgres. Not a secret: the database only listens on the
 * loopback interface of the developer machine and holds ciphertext for real credentials.
 */
export const COMPOSE_DB_CREDENTIALS = 'ah:ah';

/**
 * Expands a leading `~/` to the home directory so `.env` files may use the shell convention.
 *
 * @param value - A filesystem path.
 * @returns The path with `~` expanded.
 */
export function expandHomePrefix(value: string): string {
  return value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
}

/** Upper bound of `WORKER_TURN_CONCURRENCY` (one container per turn; more would starve a laptop). */
export const MAX_WORKER_TURN_CONCURRENCY = 32;

/** Hosts a repository may be cloned from when `ALLOWED_REPO_HOSTS` is not set. */
export const DEFAULT_ALLOWED_REPO_HOSTS = 'github.com';

/** GitHub REST base URL used by the repository picker when `GITHUB_API_BASE_URL` is not set. */
export const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com';

/**
 * Splits the configured host allow-list into its entries.
 *
 * This is the whole of the forge policy: the request contracts describe the shape of a repository
 * URL, and this list decides which origins that shape may name. An entry is
 * `[http://|https://]host[:port]`, so an operator who points the app at another forge — or who
 * wants the default forge refused outright — has one place to say so.
 *
 * A list that yields no entries admits nothing; it never falls back to a built-in forge.
 *
 * @param value - Comma-separated host list.
 * @returns The entries, trimmed, lower-cased and free of empty ones.
 */
export function parseAllowedRepoHosts(value: string): string[] {
  return value
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0);
}

/**
 * Hostnames that address the machine the process runs on, in every spelling `URL` produces.
 *
 * `URL` canonicalises before this is consulted — `127.1` and `0x7f.1` both arrive as `127.0.0.1`,
 * `LOCALHOST` as `localhost`, and an IPv6 literal in its compressed bracketed form — so the set
 * below is closed rather than heuristic. Anything outside it (a trailing-dot `localhost.`, a
 * `.localhost` subdomain, `0.0.0.0`) is treated as remote, which refuses a plaintext URL instead
 * of admitting one: the failure direction of an unrecognised spelling has to be refusal.
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '[::1]']);

/** IPv4 loopback block `127.0.0.0/8`, as `URL` serialises it. */
const LOOPBACK_IPV4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u;

/**
 * The same block written as an IPv4-mapped IPv6 address, as `URL` serialises it: `127.0.0.1`
 * becomes `[::ffff:7f00:1]` and the whole of `127.0.0.0/8` is `7f00`–`7fff` in the first group.
 */
const LOOPBACK_IPV4_MAPPED = /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/u;

/**
 * Whether a hostname addresses the local machine.
 *
 * @param hostname - A hostname as `URL` serialises it.
 * @returns `true` for `localhost`, `127.0.0.0/8`, `[::1]` and the IPv4-mapped loopback range.
 */
export function isLoopbackHostname(hostname: string): boolean {
  return (
    LOOPBACK_HOSTNAMES.has(hostname) ||
    LOOPBACK_IPV4.test(hostname) ||
    LOOPBACK_IPV4_MAPPED.test(hostname)
  );
}

/**
 * Whether a base URL may carry a credential: `https` anywhere, `http` only to the local machine.
 *
 * The GitHub PAT is sent to this base URL on every request, so plaintext to a remote host would
 * hand the token to anything on the path — which is what pinning the scheme to `https` prevented.
 * A loopback origin never leaves the machine, and it is the only way to point the app at a stub
 * or a proxy running beside it, which is what makes the variable configurable at all.
 *
 * @param value - A URL string.
 * @returns `true` when sending a credential to the URL cannot expose it on the wire.
 */
export function isCredentialSafeBaseUrl(value: string): boolean {
  const parsed = URL.parse(value);
  if (parsed === null) {
    return false;
  }
  if (parsed.protocol === 'https:') {
    return true;
  }
  return parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname);
}

const port = z.coerce.number().int().min(1).max(65_535);
const positiveInt = z.coerce.number().int().positive();

/**
 * Every environment variable, after instance defaults have been applied.
 *
 * Values arrive as strings; coercions produce numbers/booleans in the inferred type.
 */
export const envSchema = z.object({
  AH_INSTANCE: z.string().min(1),
  AH_PORT_BASE: port,
  WEB_PORT: port,
  POSTGRES_PORT: port,
  REDIS_PORT: port,
  POSTGRES_DB: z.string().min(1),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  COMPOSE_PROJECT_NAME: z.string().min(1),
  MASTER_KEY_PATH: z.string().min(1).transform(expandHomePrefix),
  WORKSPACE_IMAGE: z.string().min(1).default(DEFAULT_WORKSPACE_IMAGE),
  WORKSPACE_NAME_PREFIX: z.string().min(1),
  WORKSPACE_IDLE_TTL_MIN: positiveInt.default(30),
  WORKER_TURN_CONCURRENCY: positiveInt.max(MAX_WORKER_TURN_CONCURRENCY).default(2),
  OPENAI_MODEL: z.string().min(1).default(DEFAULT_OPENAI_MODEL),
  OPENAI_BASE_URL: z.url().optional(),
  AGENT_MODEL_PROVIDER: z.enum(MODEL_PROVIDERS).default('openai'),
  ALLOWED_REPO_HOSTS: z
    .string()
    .min(1)
    .refine(
      (value) =>
        parseAllowedRepoHosts(value).every((entry) => parseAllowedRepoOrigin(entry) !== null),
      { message: 'each entry must be [http://|https://]host[:port]' },
    )
    .default(DEFAULT_ALLOWED_REPO_HOSTS),
  GITHUB_API_BASE_URL: z
    .url({ protocol: /^https?$/ })
    .refine(isCredentialSafeBaseUrl, {
      message: 'must use https, or http with a loopback host',
    })
    .default(DEFAULT_GITHUB_API_BASE_URL),
  DOCKER_HOST: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  NEXT_PUBLIC_API_MOCK: z.stringbool().default(false),
});

/** Validated configuration. */
export type AppConfig = z.infer<typeof envSchema>;

/** Raw environment as read from the process. */
export type RawEnv = Readonly<Record<string, string | undefined>>;

/** Default master key location: `~/.agent-hangar/master.key`. */
export function defaultMasterKeyPath(): string {
  return join(homedir(), '.agent-hangar', 'master.key');
}

/**
 * Builds the instance-derived defaults of the environment.
 *
 * @param instance - Resolved instance values.
 * @returns Variables that only apply when the environment does not set them.
 */
export function instanceDefaults(instance: InstanceInfo): Record<string, string> {
  return {
    AH_INSTANCE: instance.instance,
    AH_PORT_BASE: String(instance.portBase),
    WEB_PORT: String(instance.webPort),
    POSTGRES_PORT: String(instance.postgresPort),
    REDIS_PORT: String(instance.redisPort),
    POSTGRES_DB: instance.postgresDb,
    DATABASE_URL: `postgresql://${COMPOSE_DB_CREDENTIALS}@127.0.0.1:${instance.postgresPort}/${instance.postgresDb}`,
    REDIS_URL: `redis://127.0.0.1:${instance.redisPort}`,
    COMPOSE_PROJECT_NAME: instance.composeProjectName,
    WORKSPACE_NAME_PREFIX: instance.workspaceNamePrefix,
    MASTER_KEY_PATH: defaultMasterKeyPath(),
  };
}

function withoutEmptyValues(env: RawEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.trim().length > 0) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Loads and validates the configuration from the environment.
 *
 * Precedence for every variable: explicit environment value → instance-derived default →
 * static default. Empty strings count as unset.
 *
 * @param env - Environment to read (defaults to `process.env`).
 * @returns The validated configuration.
 * @throws ConfigError listing every invalid variable.
 */
export function loadConfig(env: RawEnv = process.env): AppConfig {
  const present = withoutEmptyValues(env);
  const instance = resolveInstance({ env: present });
  const candidate = { ...instanceDefaults(instance), ...present };
  const result = envSchema.safeParse(candidate);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Invalid configuration:\n${problems}`);
  }
  return result.data;
}
