/**
 * Unit tests for the environment schema and `loadConfig`.
 *
 * Layer: unit.
 * Goal: instance-derived defaults, static defaults, explicit overrides, empty-string handling,
 * coercions, and a readable `ConfigError` listing every problem.
 * Mocks: none (the environment is passed explicitly).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ConfigError } from '../errors.ts';

import { resolveInstance } from './instance.ts';
import {
  COMPOSE_DB_CREDENTIALS,
  defaultMasterKeyPath,
  envSchema,
  expandHomePrefix,
  instanceDefaults,
  loadConfig,
  parseAllowedRepoHosts,
} from './schema.ts';

describe('loadConfig', () => {
  /**
   * Empty environment: every instance-derived and static default applies (spec 05 §3 table for
   * the `default` instance).
   */
  it('derives the full default configuration from an empty environment', () => {
    const config = loadConfig({});
    expect(config).toEqual({
      AH_INSTANCE: 'default',
      AH_PORT_BASE: 3000,
      WEB_PORT: 3000,
      POSTGRES_PORT: 3001,
      REDIS_PORT: 3002,
      POSTGRES_DB: 'agent_hangar_default',
      DATABASE_URL: `postgresql://${COMPOSE_DB_CREDENTIALS}@127.0.0.1:3001/agent_hangar_default`,
      REDIS_URL: 'redis://127.0.0.1:3002',
      COMPOSE_PROJECT_NAME: 'agent-hangar-default',
      MASTER_KEY_PATH: join(homedir(), '.agent-hangar', 'master.key'),
      WORKSPACE_IMAGE: 'agent-hangar/workspace:dev',
      WORKSPACE_NAME_PREFIX: 'ah-ws-default-',
      WORKSPACE_IDLE_TTL_MIN: 30,
      WORKER_TURN_CONCURRENCY: 2,
      OPENAI_MODEL: 'gpt-5.6-sol',
      AGENT_MODEL_PROVIDER: 'openai',
      ALLOWED_REPO_HOSTS: 'github.com',
      GITHUB_API_BASE_URL: 'https://api.github.com',
      LOG_LEVEL: 'info',
      NEXT_PUBLIC_API_MOCK: false,
    });
  });

  /**
   * Instance-derived defaults follow `AH_INSTANCE`/`AH_PORT_BASE`, and the Conductor fallbacks
   * flow through the same path.
   */
  it('derives ports, db, compose project and prefix from the instance', () => {
    const config = loadConfig({ CONDUCTOR_WORKSPACE_NAME: 'Feat X', CONDUCTOR_PORT: '4100' });
    expect(config.AH_INSTANCE).toBe('feat-x');
    expect(config.WEB_PORT).toBe(4100);
    expect(config.POSTGRES_PORT).toBe(4101);
    expect(config.REDIS_PORT).toBe(4102);
    expect(config.POSTGRES_DB).toBe('agent_hangar_feat_x');
    expect(config.DATABASE_URL).toBe(
      `postgresql://${COMPOSE_DB_CREDENTIALS}@127.0.0.1:4101/agent_hangar_feat_x`,
    );
    expect(config.REDIS_URL).toBe('redis://127.0.0.1:4102');
    expect(config.COMPOSE_PROJECT_NAME).toBe('agent-hangar-feat-x');
    expect(config.WORKSPACE_NAME_PREFIX).toBe('ah-ws-feat-x-');
  });

  /**
   * Explicit values win over derived ones and are coerced to their typed form (numbers,
   * booleans, enums).
   */
  it('honours explicit overrides with coercion', () => {
    const config = loadConfig({
      AH_INSTANCE: 'ci',
      WEB_PORT: '8080',
      DATABASE_URL: 'postgres://ci:ci@db:5432/ci',
      REDIS_URL: 'rediss://cache:6380',
      WORKSPACE_IDLE_TTL_MIN: '5',
      WORKER_TURN_CONCURRENCY: '4',
      OPENAI_MODEL: 'gpt-test',
      OPENAI_BASE_URL: 'http://127.0.0.1:9999/v1',
      AGENT_MODEL_PROVIDER: 'fake',
      DOCKER_HOST: 'unix:///tmp/docker.sock',
      LOG_LEVEL: 'debug',
      NEXT_PUBLIC_API_MOCK: 'true',
      MASTER_KEY_PATH: '/keys/master.key',
    });
    expect(config.WEB_PORT).toBe(8080);
    expect(config.POSTGRES_PORT).toBe(3001);
    expect(config.DATABASE_URL).toBe('postgres://ci:ci@db:5432/ci');
    expect(config.REDIS_URL).toBe('rediss://cache:6380');
    expect(config.WORKSPACE_IDLE_TTL_MIN).toBe(5);
    expect(config.WORKER_TURN_CONCURRENCY).toBe(4);
    expect(config.OPENAI_MODEL).toBe('gpt-test');
    expect(config.OPENAI_BASE_URL).toBe('http://127.0.0.1:9999/v1');
    expect(config.AGENT_MODEL_PROVIDER).toBe('fake');
    expect(config.DOCKER_HOST).toBe('unix:///tmp/docker.sock');
    expect(config.LOG_LEVEL).toBe('debug');
    expect(config.NEXT_PUBLIC_API_MOCK).toBe(true);
    expect(config.MASTER_KEY_PATH).toBe('/keys/master.key');
  });

  /**
   * Empty strings (as produced by `.env` files with `KEY=`) count as unset, so defaults apply
   * instead of failing validation.
   */
  it('treats empty strings as unset', () => {
    const config = loadConfig({
      OPENAI_BASE_URL: '',
      WORKSPACE_IDLE_TTL_MIN: '  ',
      AH_INSTANCE: '',
    });
    expect(config.OPENAI_BASE_URL).toBeUndefined();
    expect(config.WORKSPACE_IDLE_TTL_MIN).toBe(30);
    expect(config.AH_INSTANCE).toBe('default');
  });

  /**
   * Invalid values: the error is a `ConfigError` whose message lists every offending variable,
   * so an operator fixes them all in one pass.
   */
  it('throws a ConfigError listing every invalid variable', () => {
    const attempt = () =>
      loadConfig({
        WEB_PORT: '99999',
        DATABASE_URL: 'mysql://x',
        REDIS_URL: 'not a url',
        WORKER_TURN_CONCURRENCY: '0',
        AGENT_MODEL_PROVIDER: 'anthropic',
        LOG_LEVEL: 'loud',
        NEXT_PUBLIC_API_MOCK: 'maybe',
      });
    expect(attempt).toThrow(ConfigError);
    let message = '';
    try {
      attempt();
    } catch (error) {
      message = (error as Error).message;
    }
    for (const name of [
      'WEB_PORT',
      'DATABASE_URL',
      'REDIS_URL',
      'WORKER_TURN_CONCURRENCY',
      'AGENT_MODEL_PROVIDER',
      'LOG_LEVEL',
      'NEXT_PUBLIC_API_MOCK',
    ]) {
      expect(message).toContain(`- ${name}: `);
    }
  });

  /**
   * Instance problems surface as the same error type before schema validation runs.
   */
  it('propagates instance resolution errors', () => {
    expect(() => loadConfig({ AH_PORT_BASE: 'x' })).toThrow(ConfigError);
  });

  /**
   * Default env source: with no argument the loader reads `process.env` (pinned to a known
   * instance so the assertion is deterministic).
   */
  it('reads process.env by default', () => {
    const saved = { ...process.env };
    process.env = { ...saved, AH_INSTANCE: 'proc-env', AH_PORT_BASE: '7100' };
    try {
      expect(loadConfig().COMPOSE_PROJECT_NAME).toBe('agent-hangar-proc-env');
    } finally {
      process.env = saved;
    }
  });
});

describe('helpers', () => {
  /**
   * `~/` in `MASTER_KEY_PATH` (the shell convention used by .env.example) expands to the home
   * directory; absolute paths pass through unchanged.
   */
  it('expands a leading ~/ in MASTER_KEY_PATH', () => {
    expect(loadConfig({ MASTER_KEY_PATH: '~/.agent-hangar/master.key' }).MASTER_KEY_PATH).toBe(
      join(homedir(), '.agent-hangar', 'master.key'),
    );
    expect(loadConfig({ MASTER_KEY_PATH: '/keys/k' }).MASTER_KEY_PATH).toBe('/keys/k');
    expect(expandHomePrefix('~')).toBe('~');
  });

  /**
   * `defaultMasterKeyPath` points into the user's home directory (outside the repository).
   */
  it('places the default master key under ~/.agent-hangar', () => {
    expect(defaultMasterKeyPath()).toBe(join(homedir(), '.agent-hangar', 'master.key'));
  });

  /**
   * `instanceDefaults` returns string values only (they are fed back into the env schema) and
   * covers every instance-derived variable.
   */
  it('builds string defaults for every instance-derived variable', () => {
    const defaults = instanceDefaults(resolveInstance({ env: { AH_INSTANCE: 'z' } }));
    expect(Object.keys(defaults).sort()).toEqual(
      [
        'AH_INSTANCE',
        'AH_PORT_BASE',
        'COMPOSE_PROJECT_NAME',
        'DATABASE_URL',
        'MASTER_KEY_PATH',
        'POSTGRES_DB',
        'POSTGRES_PORT',
        'REDIS_PORT',
        'REDIS_URL',
        'WEB_PORT',
        'WORKSPACE_NAME_PREFIX',
      ].sort(),
    );
    expect(Object.values(defaults).every((value) => typeof value === 'string')).toBe(true);
  });

  /**
   * The schema itself is exported for reuse (e.g. by the doctor script) and rejects an empty
   * object, because instance defaults are applied by `loadConfig`, not by the schema.
   */
  it('exports a schema that requires the derived variables', () => {
    expect(envSchema.safeParse({}).success).toBe(false);
  });

  /**
   * The repository host allow-list is written as a comma-separated string, so parsing has to be
   * forgiving about spacing and casing and strict about empty entries — an empty host would
   * otherwise match nothing while looking like a configured value.
   */
  it('parses the repository host allow-list', () => {
    expect(parseAllowedRepoHosts('github.com')).toEqual(['github.com']);
    expect(parseAllowedRepoHosts(' GitHub.com , git.example.org ')).toEqual([
      'github.com',
      'git.example.org',
    ]);
    expect(parseAllowedRepoHosts(',,')).toEqual([]);
  });

  /**
   * Both new variables are overridable, and the GitHub base URL is narrowed to https: the PAT
   * travels in its `Authorization` header, so a plaintext scheme would put it on the wire.
   */
  it('accepts overrides for the repository host list and the GitHub base URL', () => {
    const config = loadConfig({
      ALLOWED_REPO_HOSTS: 'github.com,git.example.org',
      GITHUB_API_BASE_URL: 'https://ghe.example.org/api/v3',
    });
    expect(parseAllowedRepoHosts(config.ALLOWED_REPO_HOSTS)).toEqual([
      'github.com',
      'git.example.org',
    ]);
    expect(config.GITHUB_API_BASE_URL).toBe('https://ghe.example.org/api/v3');
    expect(() => loadConfig({ GITHUB_API_BASE_URL: 'http://ghe.example.org' })).toThrow(
      ConfigError,
    );
  });
});
