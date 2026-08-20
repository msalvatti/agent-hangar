/**
 * Everything the end-to-end suite needs to address its own stack, derived from a handful of
 * environment variables and the project's instance rules.
 *
 * Layer: test support (pure).
 *
 * The harness never reads `.env.local`. Ports, database name, compose project and container
 * prefix all come from `resolveInstance` applied to the `test` instance, so a run cannot collide
 * with the stack a developer has up for everyday work, and two checkouts can run the suite at the
 * same time by moving `E2E_PORT_BASE`.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveInstance } from '@agent-hangar/core';

import { DEFAULT_PORT_BASE, LOOPBACK, PORT_OFFSETS, SAMPLE_REPO, TEST_INSTANCE } from './constants';
import type { E2eMode } from './mode';
import { readMode } from './mode';

/** Environment shape {@link resolveE2eEnv} reads. */
export type E2eProcessEnv = Readonly<Partial<Record<string, string>>>;

/** Host the git server is dialled by from inside a workspace container, unless overridden. */
export const DEFAULT_GITSERVER_HOST = 'host.docker.internal';

/** Workspace image the worker starts containers from, unless overridden. */
export const DEFAULT_WORKSPACE_IMAGE = 'agent-hangar/workspace:dev';

/** Compose Postgres credentials — a loopback-only test service, not a secret. */
const POSTGRES_CREDENTIALS = 'ah:ah';

/** Everything resolved for one end-to-end run. */
export interface E2eEnv {
  /** Whether the full stack is running behind the UI. */
  mode: E2eMode;
  /** Instance slug: database name, compose project and container prefix all derive from it. */
  instance: string;
  /** Base of the ten-port block. */
  portBase: number;
  /** Port the Next server listens on. */
  webPort: number;
  /** Base URL Playwright navigates and calls the API against. */
  baseURL: string;
  /** Postgres connection string of the test database. */
  databaseUrl: string;
  /** Redis connection string of the test instance. */
  redisUrl: string;
  /** Host port the local git server is published on. */
  gitServerPort: number;
  /** Host a workspace container reaches the git server by. */
  gitServerHost: string;
  /** Host address the git server's port is published on. */
  gitServerBindAddress: string;
  /** Host port the GitHub REST stub listens on. */
  githubStubPort: number;
  /** Base URL of the GitHub REST stub, as the web server should call it. */
  githubApiBaseUrl: string;
  /** Clone URL of the seed repository, as a workspace container must dial it. */
  repoUrl: string;
  /**
   * Origins the API may accept a repository URL for.
   *
   * Origins, not host names: a credential is delivered to a scheme, a host *and* a port, so that
   * triple is what an operator authorises. A bare entry stands for the scheme's default port, so
   * naming the git server without its port would authorise something else entirely. Passed
   * through `ALLOWED_REPO_HOSTS`, whose name predates the distinction.
   */
  allowedRepoOrigins: readonly string[];
  /** Absolute path of the fake provider's script file. */
  fakeScriptPath: string;
  /** Absolute path of the master key file written for this run. */
  masterKeyPath: string;
  /** Directory holding files a run generates (key, stub state); git-ignored. */
  tmpDir: string;
  /** Image the worker starts workspace containers from. */
  workspaceImage: string;
  /** Name of the compose project the stack runs under. */
  composeProjectName: string;
  /** Prefix of every workspace container of this instance. */
  workspaceNamePrefix: string;
  /** Database name of the test instance. */
  postgresDb: string;
  /** Host port Postgres is published on. */
  postgresPort: number;
  /** Host port Redis is published on. */
  redisPort: number;
}

/**
 * Directories the harness addresses, derived from this file's own location.
 *
 * `dirname(fileURLToPath(import.meta.url))` rather than `new URL(path, import.meta.url)`: the
 * bundler treats the latter as an asset reference and rewrites it at build time, which silently
 * produces the wrong path when these modules are loaded by the unit-test runner.
 */
const SUPPORT_DIR = dirname(fileURLToPath(import.meta.url));

/** Absolute path of the `e2e` directory. */
const E2E_DIR = resolve(SUPPORT_DIR, '..');

/** Absolute path of the web workspace. */
export function webRoot(): string {
  return resolve(E2E_DIR, '..');
}

/** Absolute path of the repository root. */
export function repoRoot(): string {
  return resolve(webRoot(), '..', '..');
}

/** Resolves a path inside the `e2e` directory to an absolute one. */
function e2ePath(relative: string): string {
  return resolve(E2E_DIR, relative);
}

function readPortBase(env: E2eProcessEnv): number {
  const raw = env.E2E_PORT_BASE;
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_PORT_BASE;
  }
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`E2E_PORT_BASE must be an integer, got "${raw}"`);
  }
  return value;
}

/** An IPv4 literal, which is an address the git server's port can be published on. */
const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u;

/** Addresses that mean "every interface", which this must never publish the git server on. */
const WILDCARD_ADDRESSES: readonly string[] = ['0.0.0.0', '::', '[::]'];

/**
 * Address the git server's port is published on.
 *
 * Never a wildcard: the server accepts anonymous pushes, and publishing it on every interface
 * would offer a writable git endpoint to the whole network for the length of a run. A wildcard is
 * refused outright rather than mapped to loopback, because it was asked for explicitly and
 * silently doing something else would hide the mistake. A named host such as
 * `host.docker.internal` is a container-side alias with no address on this side, and a port bound
 * to loopback is reachable through it; an IPv4 literal — the bridge gateway on Linux — is bound
 * directly, because loopback is not reachable from a container there.
 *
 * @param gitServerHost - Host a workspace container dials.
 * @returns The address to publish on.
 * @throws Error when the host names every interface.
 */
export function gitServerBindAddress(gitServerHost: string): string {
  if (WILDCARD_ADDRESSES.includes(gitServerHost)) {
    throw new Error(
      `E2E_GITSERVER_HOST must name one interface, not "${gitServerHost}": the git server it ` +
        `publishes accepts anonymous pushes, so a wildcard address would offer a writable git ` +
        `endpoint to the whole network.`,
    );
  }
  return IPV4.test(gitServerHost) ? gitServerHost : LOOPBACK;
}

/**
 * Instance name for a port base.
 *
 * Moving the port block alone does not isolate anything: the instance name is what the database,
 * the compose project, the workspace-container prefix and the git-server container are all named
 * after, so two runs on different ports would still reset and reap each other's resources. A
 * non-default port base therefore takes an instance of its own. `test` stays a whole word of it,
 * which is what the destructive database helpers require before they will erase anything.
 *
 * @param portBase - Base of the port block.
 * @returns The instance name to derive everything else from.
 */
export function instanceForPortBase(portBase: number): string {
  return portBase === DEFAULT_PORT_BASE ? TEST_INSTANCE : `${TEST_INSTANCE}-${String(portBase)}`;
}

function readOverride(env: E2eProcessEnv, key: string, fallback: string): string {
  const raw = env[key];
  return raw === undefined || raw.trim().length === 0 ? fallback : raw.trim();
}

/**
 * Resolves every address, path and flag of one end-to-end run.
 *
 * @param processEnv - Environment to read (defaults to `process.env`).
 * @returns The resolved environment.
 * @throws Error when `E2E_MODE` or `E2E_PORT_BASE` hold something unusable.
 */
export function resolveE2eEnv(processEnv: E2eProcessEnv = process.env): E2eEnv {
  const mode = readMode(processEnv);
  const portBase = readPortBase(processEnv);
  const instance = readOverride(processEnv, 'E2E_INSTANCE', instanceForPortBase(portBase));
  const derived = resolveInstance({
    env: { AH_INSTANCE: instance, AH_PORT_BASE: String(portBase) },
  });
  const gitServerHost = readOverride(processEnv, 'E2E_GITSERVER_HOST', DEFAULT_GITSERVER_HOST);
  const gitServerPort = derived.portBase + PORT_OFFSETS.gitserver;
  const githubStubPort = derived.portBase + PORT_OFFSETS.githubStub;
  const tmpDir = e2ePath('.tmp');
  return {
    mode,
    instance: derived.instance,
    portBase: derived.portBase,
    webPort: derived.webPort,
    baseURL: `http://${LOOPBACK}:${String(derived.webPort)}`,
    databaseUrl: `postgresql://${POSTGRES_CREDENTIALS}@${LOOPBACK}:${String(derived.postgresPort)}/${derived.postgresDb}`,
    redisUrl: `redis://${LOOPBACK}:${String(derived.redisPort)}`,
    gitServerPort,
    gitServerHost,
    gitServerBindAddress: gitServerBindAddress(gitServerHost),
    githubStubPort,
    githubApiBaseUrl: `http://${LOOPBACK}:${String(githubStubPort)}`,
    repoUrl: `http://${gitServerHost}:${String(gitServerPort)}/${SAMPLE_REPO}.git`,
    allowedRepoOrigins: ['github.com', `http://${gitServerHost}:${String(gitServerPort)}`],
    fakeScriptPath: e2ePath('fake-provider/script.json'),
    masterKeyPath: `${tmpDir}/master.key`,
    tmpDir,
    workspaceImage: readOverride(processEnv, 'WORKSPACE_IMAGE', DEFAULT_WORKSPACE_IMAGE),
    composeProjectName: derived.composeProjectName,
    workspaceNamePrefix: derived.workspaceNamePrefix,
    postgresDb: derived.postgresDb,
    postgresPort: derived.postgresPort,
    redisPort: derived.redisPort,
  };
}

/**
 * The environment block handed to the web and worker processes Playwright manages.
 *
 * `ALLOWED_REPO_HOSTS` and `GITHUB_API_BASE_URL` are what let the suite point both processes at
 * its own git server and its own REST stub instead of at GitHub. `FAKE_PROVIDER_SCRIPT_PATH`
 * names the script the model provider answers from: the worker reads the file at boot, validates
 * it, and forwards its content to each workspace container as `AGENT_FAKE_SCRIPT_JSON` — a
 * different name, carrying the script itself rather than a path, because a path on this side
 * would not resolve on that one. The forwarding is gated on `AGENT_MODEL_PROVIDER` naming the
 * scripted provider, which is why both are set here and neither means anything without the other.
 *
 * @param env - The resolved environment.
 * @returns Variables to export for the managed servers.
 */
export function serverEnv(env: E2eEnv): Record<string, string> {
  return {
    AH_INSTANCE: env.instance,
    AH_PORT_BASE: String(env.portBase),
    WEB_PORT: String(env.webPort),
    POSTGRES_PORT: String(env.postgresPort),
    REDIS_PORT: String(env.redisPort),
    POSTGRES_DB: env.postgresDb,
    DATABASE_URL: env.databaseUrl,
    REDIS_URL: env.redisUrl,
    COMPOSE_PROJECT_NAME: env.composeProjectName,
    WORKSPACE_NAME_PREFIX: env.workspaceNamePrefix,
    WORKSPACE_IMAGE: env.workspaceImage,
    MASTER_KEY_PATH: env.masterKeyPath,
    AGENT_MODEL_PROVIDER: 'fake',
    FAKE_PROVIDER_SCRIPT_PATH: env.fakeScriptPath,
    ALLOWED_REPO_HOSTS: env.allowedRepoOrigins.join(','),
    GITHUB_API_BASE_URL: env.githubApiBaseUrl,
    LOG_LEVEL: 'info',
    NEXT_PUBLIC_API_MOCK: env.mode === 'mock' ? '1' : '0',
    WORKSPACE_IDLE_TTL_MIN: '30',
  };
}
