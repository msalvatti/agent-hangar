/**
 * Unit tests for the resolved end-to-end environment.
 *
 * Layer: unit test.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_PORT_BASE, PORT_OFFSETS, PROMPTS, TEST_INSTANCE } from './constants';
import {
  DEFAULT_GITSERVER_HOST,
  DEFAULT_WORKSPACE_IMAGE,
  gitServerBindAddress,
  repoRoot,
  resolveE2eEnv,
  serverEnv,
  webRoot,
} from './env';

describe('resolveE2eEnv', () => {
  /** With nothing configured the suite addresses the `test` instance on its default port block. */
  it('derives the test instance and its port block by default', () => {
    const env = resolveE2eEnv({ E2E_MODE: 'mock' });
    expect(env.mode).toBe('mock');
    expect(env.instance).toBe(TEST_INSTANCE);
    expect(env.portBase).toBe(DEFAULT_PORT_BASE);
    expect(env.webPort).toBe(DEFAULT_PORT_BASE + PORT_OFFSETS.web);
    expect(env.postgresPort).toBe(DEFAULT_PORT_BASE + PORT_OFFSETS.postgres);
    expect(env.redisPort).toBe(DEFAULT_PORT_BASE + PORT_OFFSETS.redis);
    expect(env.gitServerPort).toBe(DEFAULT_PORT_BASE + PORT_OFFSETS.gitserver);
    expect(env.githubStubPort).toBe(DEFAULT_PORT_BASE + PORT_OFFSETS.githubStub);
    expect(env.baseURL).toBe(`http://127.0.0.1:${String(DEFAULT_PORT_BASE)}`);
    expect(env.postgresDb).toBe('agent_hangar_test');
    expect(env.composeProjectName).toBe('agent-hangar-test');
    expect(env.workspaceNamePrefix).toBe('ah-ws-test-');
    expect(env.databaseUrl).toContain('/agent_hangar_test');
    expect(env.redisUrl).toBe(`redis://127.0.0.1:${String(DEFAULT_PORT_BASE + 2)}`);
    expect(env.gitServerHost).toBe(DEFAULT_GITSERVER_HOST);
    expect(env.gitServerBindAddress).toBe('127.0.0.1');
    expect(env.workspaceImage).toBe(DEFAULT_WORKSPACE_IMAGE);
    expect(env.repoUrl).toBe(
      `http://${DEFAULT_GITSERVER_HOST}:${String(DEFAULT_PORT_BASE + 7)}/sample.git`,
    );
    expect(env.allowedRepoHosts).toEqual(['github.com', DEFAULT_GITSERVER_HOST]);
    expect(env.githubApiBaseUrl).toBe(`http://127.0.0.1:${String(DEFAULT_PORT_BASE + 8)}`);
  });

  /** Moving the port block lets two checkouts run the suite at the same time. */
  it('honours every override', () => {
    const env = resolveE2eEnv({
      E2E_MODE: 'real',
      E2E_INSTANCE: 'w2c-test',
      E2E_PORT_BASE: '4100',
      E2E_GITSERVER_HOST: '172.17.0.1',
      WORKSPACE_IMAGE: 'agent-hangar/workspace:ci',
    });
    expect(env.mode).toBe('real');
    expect(env.instance).toBe('w2c-test');
    expect(env.portBase).toBe(4100);
    expect(env.postgresDb).toBe('agent_hangar_w2c_test');
    expect(env.gitServerHost).toBe('172.17.0.1');
    expect(env.gitServerBindAddress).toBe('172.17.0.1');
    expect(env.repoUrl).toBe('http://172.17.0.1:4107/sample.git');
    expect(env.allowedRepoHosts).toEqual(['github.com', '172.17.0.1']);
    expect(env.workspaceImage).toBe('agent-hangar/workspace:ci');
  });

  /** A blank override is the same as no override at all. */
  it('ignores blank overrides', () => {
    const env = resolveE2eEnv({ E2E_MODE: 'mock', E2E_INSTANCE: '  ', E2E_PORT_BASE: '  ' });
    expect(env.instance).toBe(TEST_INSTANCE);
    expect(env.portBase).toBe(DEFAULT_PORT_BASE);
  });

  /** A port base that is not an integer must fail the run, not silently become NaN. */
  it('rejects a non-integer port base', () => {
    expect(() => resolveE2eEnv({ E2E_PORT_BASE: '39xx' })).toThrow(/must be an integer/);
  });

  /** The script and key paths are absolute and inside the suite's own folder. */
  it('resolves absolute paths inside the suite', () => {
    const env = resolveE2eEnv({ E2E_MODE: 'mock' });
    expect(env.fakeScriptPath.endsWith('/e2e/fake-provider/script.json')).toBe(true);
    expect(env.masterKeyPath.endsWith('/e2e/.tmp/master.key')).toBe(true);
    expect(env.tmpDir.endsWith('/e2e/.tmp')).toBe(true);
  });
});

describe('gitServerBindAddress', () => {
  /**
   * The git server accepts anonymous pushes, so its port must never be published on every
   * interface. A container-side alias has no address here, and loopback is reachable through it.
   */
  it('publishes on loopback for a named host', () => {
    expect(gitServerBindAddress('host.docker.internal')).toBe('127.0.0.1');
  });

  /** On a bridge gateway address loopback is not reachable from a container, so bind it directly. */
  it('publishes on an IPv4 host directly', () => {
    expect(gitServerBindAddress('172.17.0.1')).toBe('172.17.0.1');
  });
});

describe('serverEnv', () => {
  /** The managed servers must be told the mock API is on, and never told to use a real model. */
  it('turns the mock flag on in mock mode', () => {
    const block = serverEnv(resolveE2eEnv({ E2E_MODE: 'mock' }));
    expect(block.NEXT_PUBLIC_API_MOCK).toBe('1');
    expect(block.AGENT_MODEL_PROVIDER).toBe('fake');
  });

  /** In real mode the mock flag is off and every address points at the test instance. */
  it('addresses the test stack in real mode', () => {
    const env = resolveE2eEnv({ E2E_MODE: 'real' });
    const block = serverEnv(env);
    expect(block.NEXT_PUBLIC_API_MOCK).toBe('0');
    expect(block.DATABASE_URL).toBe(env.databaseUrl);
    expect(block.REDIS_URL).toBe(env.redisUrl);
    expect(block.MASTER_KEY_PATH).toBe(env.masterKeyPath);
    expect(block.FAKE_PROVIDER_SCRIPT_PATH).toBe(env.fakeScriptPath);
    expect(block.ALLOWED_REPO_HOSTS).toBe(`github.com,${env.gitServerHost}`);
    expect(block.GITHUB_API_BASE_URL).toBe(env.githubApiBaseUrl);
    expect(block.WORKSPACE_NAME_PREFIX).toBe('ah-ws-test-');
    expect(block.WORKSPACE_IDLE_TTL_MIN).toBe('30');
    expect(block.LOG_LEVEL).toBe('info');
    expect(block.COMPOSE_PROJECT_NAME).toBe('agent-hangar-test');
    expect(block.WEB_PORT).toBe(String(env.webPort));
    expect(block.POSTGRES_PORT).toBe(String(env.postgresPort));
    expect(block.POSTGRES_DB).toBe(env.postgresDb);
    expect(block.AH_INSTANCE).toBe(env.instance);
    expect(block.AH_PORT_BASE).toBe(String(env.portBase));
    expect(block.REDIS_PORT).toBe(String(env.redisPort));
    expect(block.WORKSPACE_IMAGE).toBe(env.workspaceImage);
  });
});

describe('repository paths', () => {
  /** The managed worker is started from the repository root and the web server from its own. */
  it('resolves the repository and web roots', () => {
    expect(webRoot().endsWith('/apps/web')).toBe(true);
    expect(webRoot().startsWith(`${repoRoot()}/`)).toBe(true);
    expect(repoRoot().endsWith('/apps')).toBe(false);
  });
});

describe('prompts', () => {
  /** Every scripted prompt is distinct; the fake provider keys its script by the exact text. */
  it('keeps every prompt distinct', () => {
    const prompts = Object.values(PROMPTS);
    expect(new Set(prompts).size).toBe(prompts.length);
  });
});
