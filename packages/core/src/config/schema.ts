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

import { ConfigError } from '../errors.js';

import { resolveInstance } from './instance.js';
import type { InstanceInfo } from './instance.js';

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
  MASTER_KEY_PATH: z.string().min(1),
  WORKSPACE_IMAGE: z.string().min(1).default(DEFAULT_WORKSPACE_IMAGE),
  WORKSPACE_NAME_PREFIX: z.string().min(1),
  WORKSPACE_IDLE_TTL_MIN: positiveInt.default(30),
  WORKER_TURN_CONCURRENCY: positiveInt.max(32).default(2),
  OPENAI_MODEL: z.string().min(1).default(DEFAULT_OPENAI_MODEL),
  OPENAI_BASE_URL: z.url().optional(),
  AGENT_MODEL_PROVIDER: z.enum(MODEL_PROVIDERS).default('openai'),
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
