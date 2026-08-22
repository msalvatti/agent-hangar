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
  DEFAULT_ALLOWED_REPO_HOSTS,
  defaultMasterKeyPath,
  envSchema,
  expandHomePrefix,
  instanceDefaults,
  isCredentialSafeBaseUrl,
  isLoopbackHostname,
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
      WORKSPACE_IMAGE: 'agent-hangar/workspace:default',
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
   * The identity variables are overridable here on purpose, and this pins that decision rather
   * than merely recording today's behaviour.
   *
   * `infra/scripts/env.sh` derives the same values and ignores whatever the shell exported, which
   * looks like a contradiction and is not: that script *writes* an environment, and is the one
   * place a name and a set of ports get paired, so no shell can pair one instance's name with
   * another's database. This function *reads* an environment somebody else composed. It cannot
   * tell a derived one from a deployment pointing the app at a database elsewhere — which is what
   * this repository's own integration job is: instance `test` against a Postgres published on
   * 5432, a port no derivation produces. Sealing the block here would refuse that outright.
   */
  it('lets an explicit identity variable win, which is how a foreign database is addressed', () => {
    const derived = loadConfig({ AH_INSTANCE: 'test' });
    const foreign = `postgresql://${COMPOSE_DB_CREDENTIALS}@127.0.0.1:5432/agent_hangar_test`;

    const config = loadConfig({
      AH_INSTANCE: 'test',
      POSTGRES_PORT: '5432',
      DATABASE_URL: foreign,
    });

    expect(derived.POSTGRES_PORT).toBe(3001);
    expect(config.POSTGRES_PORT).toBe(5432);
    expect(config.DATABASE_URL).toBe(foreign);
    // The instance itself is still derived, so the name and the database keep their convention.
    expect(config.AH_INSTANCE).toBe('test');
    expect(config.POSTGRES_DB).toBe('agent_hangar_test');
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
        'WORKSPACE_IMAGE',
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
   * Both variables are overridable, and the GitHub base URL keeps requiring https for a remote
   * host: the PAT travels in its `Authorization` header, so a plaintext scheme to anywhere but
   * this machine would put the token on the wire.
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

  /**
   * A stub or proxy running beside the app is the reason the base URL is configurable at all, and
   * it is reached over plaintext. Traffic to a loopback origin never leaves the machine, so the
   * token cannot be observed on the wire there.
   */
  it.each([
    'http://127.0.0.1:3908',
    'http://localhost:3908/api/v3',
    'http://[::1]:3908',
    'http://127.1',
  ])('loads a loopback http GitHub base URL (%s)', (value) => {
    expect(loadConfig({ GITHUB_API_BASE_URL: value }).GITHUB_API_BASE_URL).toBe(value);
  });

  /**
   * Every spelling that is not provably this machine is refused rather than guessed at: a host
   * that merely reads like loopback, the unspecified address, and a scheme that is neither http
   * nor https.
   */
  it.each([
    'http://127.0.0.1.evil.test/api',
    'http://localhost.evil.test/api',
    'http://0.0.0.0:3908',
    'ftp://127.0.0.1',
    'not a url',
  ])('refuses the GitHub base URL %s', (value) => {
    expect(() => loadConfig({ GITHUB_API_BASE_URL: value })).toThrow(ConfigError);
  });

  /**
   * An allow-list entry that is not a bare authority can never match a URL, so it would silently
   * disable the forge the operator thought they had configured. Boot is where that must surface.
   */
  it('refuses an allow-list entry that is not an origin', () => {
    expect(() => loadConfig({ ALLOWED_REPO_HOSTS: 'github.com/acme' })).toThrow(ConfigError);
    expect(() => loadConfig({ ALLOWED_REPO_HOSTS: 'user@github.com' })).toThrow(ConfigError);
  });

  /**
   * A list whose entries are all blank is a valid way to say "no forge at all"; it loads, and it
   * admits nothing. That statement has to be spelled out, which is why the variable is not simply
   * left empty: the two are different instructions and the next test pins the other one.
   */
  it('loads a list that names no host, and that list allows nothing', () => {
    const config = loadConfig({ ALLOWED_REPO_HOSTS: ',,' });
    expect(parseAllowedRepoHosts(config.ALLOWED_REPO_HOSTS)).toEqual([]);
  });

  /**
   * An absent variable and a blank one are the same instruction — `loadConfig` treats an empty
   * string as unset — and both resolve to the product's own forge, never to an empty list. An
   * operator reading the documentation has to find that here, because the difference decides
   * whether an unconfigured install clones from `github.com` or from nowhere.
   */
  it.each([
    ['absent', {}],
    ['blank', { ALLOWED_REPO_HOSTS: '' }],
    ['whitespace', { ALLOWED_REPO_HOSTS: '   ' }],
  ])('falls back to the default forge when the list is %s', (_name, env) => {
    const config = loadConfig(env);
    expect(config.ALLOWED_REPO_HOSTS).toBe(DEFAULT_ALLOWED_REPO_HOSTS);
    expect(parseAllowedRepoHosts(config.ALLOWED_REPO_HOSTS)).toEqual(['github.com']);
  });

  /**
   * An entry may pin the scheme and the port, which is how a local forge over plaintext is
   * authorised without opening every other daemon on the same host.
   */
  it('loads an allow-list entry that pins scheme and port', () => {
    const config = loadConfig({ ALLOWED_REPO_HOSTS: 'github.com,http://127.0.0.1:3907' });
    expect(parseAllowedRepoHosts(config.ALLOWED_REPO_HOSTS)).toEqual([
      'github.com',
      'http://127.0.0.1:3907',
    ]);
  });
});

describe('the loopback rules', () => {
  /**
   * `URL` canonicalises before the predicate is consulted, so the set only has to cover the
   * spellings it produces — both address families included.
   */
  it.each([
    'localhost',
    '127.0.0.1',
    '127.0.0.53',
    // Every group of the block, not just the last: the range is 127.0.0.0/8, so a second or third
    // group of more than one digit is as much this machine as a third of one.
    '127.10.0.1',
    '127.0.10.1',
    '127.255.255.255',
    '[::1]',
    '[::ffff:7f00:1]',
    '[::ffff:7fff:ffff]',
  ])('treats %s as this machine', (hostname) => {
    expect(isLoopbackHostname(hostname)).toBe(true);
  });

  /**
   * Anything unrecognised is remote, which refuses a plaintext URL rather than admitting one: a
   * name that merely contains a loopback address must not inherit its trust.
   */
  it.each([
    'github.com',
    '127.0.0.1.evil.test',
    'localhost.',
    'app.localhost',
    '0.0.0.0',
    '[::ffff:c000:201]',
    // A name that merely ends with a loopback address is not one: the patterns are anchored at
    // both ends, and either anchor removed lets a host somebody else controls inherit the trust
    // that allows plaintext.
    'evil.127.0.0.1',
    'x[::ffff:7f00:1]',
    '[::ffff:7f00:1]x',
  ])('treats %s as remote', (hostname) => {
    expect(isLoopbackHostname(hostname)).toBe(false);
  });

  /**
   * The predicate is exported so a caller can apply the rule without Zod, and it has to answer
   * for a string that is not a URL at all rather than throw.
   */
  it('answers for an unparseable value', () => {
    expect(isCredentialSafeBaseUrl('https://api.github.com')).toBe(true);
    expect(isCredentialSafeBaseUrl('http://127.0.0.1:3908')).toBe(true);
    expect(isCredentialSafeBaseUrl('http://api.github.com')).toBe(false);
    expect(isCredentialSafeBaseUrl('not a url')).toBe(false);
    // A scheme that is neither of the two is not made safe by pointing at this machine: the rule
    // is https anywhere, or http here, and nothing else.
    expect(isCredentialSafeBaseUrl('ftp://127.0.0.1')).toBe(false);
  });
});

describe('what the environment schema refuses, and what it says', () => {
  /**
   * Each of these variables is narrowed to the scheme its client actually speaks, and the refusal
   * says so. A pattern that lost an anchor accepts a scheme that merely ends or begins with the
   * right one — `postgresx://` for the database, `redisx://` for the queue — and the process then
   * fails at the first connection instead of at start-up.
   */
  it.each([
    ['DATABASE_URL', 'postgresx://localhost:5432/db'],
    ['DATABASE_URL', 'xpostgres://localhost:5432/db'],
    ['REDIS_URL', 'redissx://localhost:6379'],
    ['REDIS_URL', 'xredis://localhost:6379'],
    ['GITHUB_API_BASE_URL', 'httpsx://api.github.com'],
    ['GITHUB_API_BASE_URL', 'xhttps://api.github.com'],
  ])('refuses %s of %s, by the scheme', (name, value) => {
    let message = '';

    try {
      loadConfig({ [name]: value });
    } catch (error) {
      message = (error as Error).message;
    }

    // Refused for its scheme rather than by whatever rule sits behind it: the two refusals read
    // differently, and a person told the wrong one goes looking for the wrong problem.
    expect(message).toContain(`  - ${name}: Invalid URL`);
  });

  /**
   * The two refusals a person is most likely to meet say what to do about them: an allow-list
   * entry that is not an origin, and a GitHub base URL that would send the token over plaintext to
   * somewhere that is not this machine.
   */
  it.each([
    [
      { ALLOWED_REPO_HOSTS: 'https://github.com/acme' },
      'each entry must be [http://|https://]host[:port]',
    ],
    [
      { GITHUB_API_BASE_URL: 'http://api.github.com' },
      'must use https, or http with a loopback host',
    ],
  ])('says why it refused %p', (env, message) => {
    expect(() => loadConfig(env)).toThrow(message);
  });

  /**
   * The problems are listed one per line, and every one of them is listed. Run together they are a
   * single unreadable line, and an operator fixing the first of five never sees the other four.
   */
  it('lists every problem on a line of its own', () => {
    let message = '';

    try {
      loadConfig({ WEB_PORT: '99999', LOG_LEVEL: 'loud' });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message.split('\n').filter((line) => line.startsWith('  - '))).toHaveLength(2);
  });

  /**
   * A variable that is present and undefined is a variable the shell never set; asked to measure
   * its length the loader would throw before any schema ran, and the operator would be shown a
   * type error rather than a configuration one.
   */
  it('treats a variable set to nothing at all as unset', () => {
    expect(loadConfig({ OPENAI_MODEL: undefined }).OPENAI_MODEL.length).toBeGreaterThan(0);
  });

  /**
   * The compose credentials are a value the compose file and the derived DATABASE_URL have to
   * agree on; nothing else in this package reads them back.
   */
  it('names the credentials the compose database is created with', () => {
    expect(COMPOSE_DB_CREDENTIALS).toBe('ah:ah');
  });
});
