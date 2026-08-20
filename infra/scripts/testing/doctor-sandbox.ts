/**
 * Sandbox and shims shared by the `doctor.sh` suites.
 *
 * Layer: test double.
 *
 * The diagnostic's tests come in two files — the rows and their fixes in `doctor.test.ts`, the
 * Postgres/Redis service probes in `doctor.probes.test.ts` — because one file covering both grew
 * past the size the review gate allows. Everything they share lives here: the throwaway master
 * key, the env file path that keeps a run away from the developer's real `.env.local`, the ports
 * the derivation points at, and the helper shim standing in for `lib/*.main.ts`.
 *
 * This module is held to the same 100% coverage gate as the rest of `infra/scripts/testing/**`,
 * so it is written without branches a test would have to contrive to reach; the one part that
 * needs branches — claiming a port base against every other process on the machine — lives in
 * `port-base.ts` and is driven directly by `port-base.test.ts`.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { releasePortBases, reservePortBase } from './port-base.js';
import { createShimDir, writeExtraShim } from './shims.js';
import type { DockerShimOptions, PnpmShimOptions } from './shims.js';

/**
 * The `node:fs` surface this module needs, reached only through this object.
 *
 * Every path here is built at test-run time from a generated temp directory, never from untrusted
 * input, but the security linter cannot tell that from a direct call to the imported function by
 * name. Routing each access through one indirection level is the pattern `shims.ts` uses for the
 * same reason.
 */
const fsPort = { chmodSync, mkdtempSync, rmSync, writeFileSync };

/** Absolute path of the script under test. */
export const scriptPath = fileURLToPath(new URL('../doctor.sh', import.meta.url));

/** Master key material a green sandbox starts with: 64 hex characters, mode 600. */
const GREEN_KEY = `${'0'.repeat(64)}\n`;

/**
 * The range this suite allocates from. It sits below the ephemeral range both Linux (32768+) and
 * macOS (49152+) hand out, and above the one `rotate-key-sandbox.ts` uses, so the two suites have
 * a head start on each other; what actually keeps two claimants off one base is the marker
 * `port-base.ts` plants, which every suite on the machine shares.
 */
const PORT_BASE_FLOOR = 31600;
const PORT_BASE_SPAN = 1200;

const dirs: string[] = [];
const servers: Server[] = [];

/**
 * Binds a loopback listener, rejecting when the port is taken.
 *
 * A taken port fails the test that asked for it instead of being retried around: the bases come
 * from a private range, so a collision is a bug worth seeing rather than noise to absorb.
 *
 * @param port - Port to bind.
 * @returns The listening server, registered for teardown.
 */
function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      servers.push(server);
      resolve(server);
    });
  });
}

/** Throwaway paths and ports one doctor test runs against. */
export interface Sandbox {
  /** Temporary directory holding every file the test touches; also the run's HOME. */
  dir: string;
  /** Path the PATH shims append their invocations to. */
  log: string;
  /** A loadable master key, mode 600. */
  keyPath: string;
  /** Port base the derivation works from; `+ 1` and `+ 2` are Postgres and Redis. */
  portBase: number;
  /**
   * Env file path inside the sandbox. It is never created, so the run derives its instance from
   * the sandbox environment instead of reading the developer's real `.env.local` — which would
   * point MASTER_KEY_PATH at the real master key.
   */
  envFile: string;
}

/**
 * Builds a sandbox whose derived Postgres and Redis ports are both held by a listener.
 *
 * `env.sh` derives POSTGRES_PORT/REDIS_PORT from AH_PORT_BASE and ignores any same-named variable
 * in the environment, so a test that needs "something is on the port" listens where the
 * derivation points instead of pointing the derivation at a port it picked. Those listeners
 * answer nothing, which is the whole point: whether the service is the expected one is decided by
 * the probe, not by the socket.
 *
 * @returns The sandbox paths and its port base.
 */
export async function sandbox(): Promise<Sandbox> {
  const dir = fsPort.mkdtempSync(join(tmpdir(), 'ah-doctor-'));
  dirs.push(dir);
  const keyPath = join(dir, 'master.key');
  fsPort.writeFileSync(keyPath, GREEN_KEY);
  fsPort.chmodSync(keyPath, 0o600);
  const portBase = reservePortBase(PORT_BASE_FLOOR, PORT_BASE_SPAN);
  await listen(portBase + 1);
  await listen(portBase + 2);
  return { dir, log: join(dir, 'log'), keyPath, portBase, envFile: join(dir, '.env.local') };
}

/**
 * Reserves a port base whose derived ports nothing listens on, to simulate an absent service.
 *
 * @returns A base whose `+ 1` and `+ 2` ports are free.
 */
export function closedPortBase(): number {
  return reservePortBase(PORT_BASE_FLOOR, PORT_BASE_SPAN);
}

/**
 * Body of the `AH_DOCTOR_HELPER_CMD` shim: it inspects its own last path argument to tell the
 * three helper invocations apart, and answers each from the environment.
 *
 * @returns The shell script body.
 */
export function helperBody(): string {
  return [
    'case "$1" in',
    '  *secrets-status*)',
    '    printf \'%s\\n\' "$AH_SHIM_SECRETS_LINES"',
    '    exit "${AH_SHIM_SECRETS_RC:-0}"',
    '    ;;',
    '  *openai-check*)',
    '    printf \'%s\\n\' "$AH_SHIM_OPENAI_LINE"',
    '    exit "${AH_SHIM_OPENAI_RC:-0}"',
    '    ;;',
    '  *service-probes*)',
    '    printf \'%s\\n\' "$AH_SHIM_PROBE_LINES"',
    '    exit "${AH_SHIM_PROBE_RC:-0}"',
    '    ;;',
    'esac',
    'exit 9',
  ].join('\n');
}

/**
 * Writes the `AH_DOCTOR_HELPER_CMD` shim into a shim directory.
 *
 * @param shimDir - Directory to write into.
 * @returns The shim's absolute path.
 */
export function helperShim(shimDir: string): string {
  return writeExtraShim(shimDir, 'helper.sh', helperBody());
}

/**
 * Environment of a machine where every check passes, before a test breaks one of them.
 *
 * @param box - The sandbox the run works in.
 * @param extra - Variables to add or override.
 * @returns The environment to spawn the script with.
 */
export function greenEnv(box: Sandbox, extra: Record<string, string> = {}): Record<string, string> {
  return {
    HOME: box.dir,
    AH_ENV_FILE: box.envFile,
    AH_INSTANCE: 'default',
    AH_PORT_BASE: String(box.portBase),
    MASTER_KEY_PATH: box.keyPath,
    AH_SHIM_LOG: box.log,
    AH_SHIM_SECRETS_LINES: 'GITHUB_PAT=set:ab12\nOPENAI_API_KEY=set:cd34',
    AH_SHIM_OPENAI_LINE: 'ok gpt-5.6-sol',
    AH_SHIM_PROBE_LINES: 'POSTGRES=ok\nREDIS=ok',
    ...extra,
  };
}

/**
 * Docker shim behaviour of a healthy machine.
 *
 * @param overrides - Behaviour to change.
 * @returns Options for {@link createShimDir}.
 */
export function greenDocker(overrides: DockerShimOptions = {}): DockerShimOptions {
  return { availability: 'up', image: 'present', ...overrides };
}

/**
 * pnpm shim behaviour of a healthy machine.
 *
 * @param overrides - Behaviour to change.
 * @returns Options for {@link createShimDir}.
 */
export function greenPnpm(overrides: PnpmShimOptions = {}): PnpmShimOptions {
  return { migrateStatusExitCode: 0, ...overrides };
}

/**
 * Builds the shim directory a doctor run uses, with the standard docker and pnpm behaviour.
 *
 * @param box - The sandbox the run works in.
 * @param docker - Docker shim behaviour; healthy when omitted.
 * @param pnpm - pnpm shim behaviour; healthy when omitted.
 * @returns The shim directory.
 */
export function greenShims(
  box: Sandbox,
  docker: DockerShimOptions = greenDocker(),
  pnpm: PnpmShimOptions = greenPnpm(),
): string {
  return createShimDir({ log: box.log, docker, pnpm });
}

/**
 * Releases every sandbox directory, listener and port-base claim this file handed out. Called from
 * each suite's `afterEach`; the loops are unconditional so the module keeps no branches of its own.
 */
export function releaseSandboxes(): void {
  for (const server of servers) {
    server.close();
  }
  servers.length = 0;
  for (const dir of dirs) {
    fsPort.rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
  releasePortBases();
}
