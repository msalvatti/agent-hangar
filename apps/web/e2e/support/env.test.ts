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
  instanceForPortBase,
  repoRoot,
  resolveE2eEnv,
  resolveWorkspaceImage,
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
      `http://${DEFAULT_GITSERVER_HOST}:${String(DEFAULT_PORT_BASE + 7)}/e2e/sample.git`,
    );
    // A whole origin, not a bare host: a bare entry would stand for the scheme's default port.
    expect(env.allowedRepoOrigins).toEqual([
      'github.com',
      `http://${DEFAULT_GITSERVER_HOST}:${String(DEFAULT_PORT_BASE + 7)}`,
    ]);
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
    expect(env.repoUrl).toBe('http://172.17.0.1:4107/e2e/sample.git');
    expect(env.allowedRepoOrigins).toEqual(['github.com', 'http://172.17.0.1:4107']);
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

  /**
   * A repository URL always names an owner and a repository. The fixture has to serve that shape,
   * because the schemas that accept a repository URL require it whatever host it names.
   */
  it('names an owner and a repository in the clone URL', () => {
    const { pathname } = new URL(resolveE2eEnv({ E2E_MODE: 'real' }).repoUrl);
    expect(pathname.split('/').filter((segment) => segment.length > 0)).toEqual([
      'e2e',
      'sample.git',
    ]);
  });

  /** The script and key paths are absolute and inside the suite's own folder. */
  it('resolves absolute paths inside the suite', () => {
    const env = resolveE2eEnv({ E2E_MODE: 'mock' });
    expect(env.fakeScriptPath.endsWith('/e2e/fake-provider/script.json')).toBe(true);
    expect(env.masterKeyPath.endsWith('/e2e/.tmp/master.key')).toBe(true);
    expect(env.tmpDir.endsWith('/e2e/.tmp')).toBe(true);
  });
});

describe('instanceForPortBase', () => {
  /** The ordinary run keeps the plain instance name everything else in the project expects. */
  it('keeps the plain name on the default port block', () => {
    expect(instanceForPortBase(DEFAULT_PORT_BASE)).toBe(TEST_INSTANCE);
  });

  /**
   * Moving the port block has to move everything named after the instance with it — database,
   * compose project, workspace prefix, git-server container — or two runs on different ports still
   * reset and reap each other.
   */
  it('takes an instance of its own on any other port block', () => {
    expect(instanceForPortBase(4100)).toBe('test-4100');
  });

  /**
   * The destructive database helpers refuse anything whose instance does not carry `test` as a
   * whole underscore-delimited word, so a derived name has to keep that property.
   */
  it('keeps a name the destructive helpers accept', () => {
    const { postgresDb } = resolveE2eEnv({
      E2E_MODE: 'real',
      E2E_PORT_BASE: '4100',
      WORKSPACE_IMAGE: 'agent-hangar/workspace:test-4100',
    });
    expect(postgresDb).toBe('agent_hangar_test_4100');
    expect(postgresDb.replace('agent_hangar_', '').split('_')).toContain('test');
  });

  /**
   * Everything a concurrent run could collide on has to differ, not just the ports. This is the
   * claim the port-base knob makes, and it was false while the instance stayed fixed.
   */
  it('isolates every named resource when only the port base moves', () => {
    const one = resolveE2eEnv({ E2E_MODE: 'real' });
    const other = resolveE2eEnv({
      E2E_MODE: 'real',
      E2E_PORT_BASE: '4100',
      WORKSPACE_IMAGE: 'agent-hangar/workspace:test-4100',
    });
    expect(other.instance).not.toBe(one.instance);
    expect(other.postgresDb).not.toBe(one.postgresDb);
    expect(other.composeProjectName).not.toBe(one.composeProjectName);
    expect(other.workspaceNamePrefix).not.toBe(one.workspaceNamePrefix);
    expect(other.tmpDir).toBe(one.tmpDir);
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

  /**
   * A wildcard is an IPv4 literal and would otherwise be bound directly, publishing an anonymously
   * writable git endpoint on every interface. It is refused rather than quietly mapped to
   * loopback, because it was asked for explicitly.
   */
  it('refuses an address naming every interface', () => {
    for (const wildcard of ['0.0.0.0', '::', '[::]']) {
      expect(() => gitServerBindAddress(wildcard)).toThrow(/must name one interface/);
    }
  });

  /** The refusal has to reach a real run, not just the helper. */
  it('refuses a wildcard through the resolved environment', () => {
    expect(() => resolveE2eEnv({ E2E_MODE: 'real', E2E_GITSERVER_HOST: '0.0.0.0' })).toThrow(
      /must name one interface/,
    );
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
    // A whole origin, not a bare host: a bare entry stands for the scheme's default port.
    expect(block.ALLOWED_REPO_HOSTS).toBe(env.allowedRepoOrigins.join(','));
    expect(block.ALLOWED_REPO_HOSTS).toContain(
      `http://${env.gitServerHost}:${String(env.gitServerPort)}`,
    );
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

describe('resolveWorkspaceImage', () => {
  /** An explicit tag is what the caller asked for, whatever the port block. */
  it('uses an explicit image whenever one is named', () => {
    const image = resolveWorkspaceImage({
      mode: 'real',
      portBase: 4200,
      instance: 'test-4200',
      override: 'agent-hangar/workspace:w2c',
    });
    expect(image).toBe('agent-hangar/workspace:w2c');
  });

  /** The default port block is the single-checkout case, where the shared tag is nobody else's. */
  it('falls back to the shared image on the default port block', () => {
    const image = resolveWorkspaceImage({
      mode: 'real',
      portBase: DEFAULT_PORT_BASE,
      instance: TEST_INSTANCE,
      override: undefined,
    });
    expect(image).toBe(DEFAULT_WORKSPACE_IMAGE);
  });

  /**
   * Moving the port block isolates ports, database and containers but not the image tag, which no
   * instance name reaches: another checkout rebuilding it changes what these containers execute
   * mid-run. The refusal names the command that builds a private tag rather than failing later
   * with a measurement nobody can trust.
   */
  it('refuses a real run on a moved port block that named no image', () => {
    expect(() =>
      resolveWorkspaceImage({
        mode: 'real',
        portBase: 4200,
        instance: 'test-4200',
        override: undefined,
      }),
    ).toThrow(/WORKSPACE_IMAGE=agent-hangar\/workspace:test-4200 pnpm infra:image/);
  });

  /** A mock run starts no container, so the image it would have used is not a fact about it. */
  it('allows a mock run on a moved port block without an image', () => {
    const image = resolveWorkspaceImage({
      mode: 'mock',
      portBase: 4200,
      instance: 'test-4200',
      override: undefined,
    });
    expect(image).toBe(DEFAULT_WORKSPACE_IMAGE);
  });
});
