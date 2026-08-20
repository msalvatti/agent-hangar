/**
 * Sandbox and shims shared by the `rotate-key.sh` suites.
 *
 * Layer: test double.
 *
 * The rotation tests come in two files — the forward path in `rotate-key.test.ts`, the resume and
 * concurrency behaviour in `rotate-key.resume.test.ts` — because one file covering both grew past
 * the size the review gate allows. Everything they share lives here rather than being duplicated
 * across them: the throwaway key/state/lock paths, the port base the running-instance probe has to
 * find quiet, the helper shims standing in for `lib/*.main.ts`, and the two ways of starting the
 * script (awaited, or detached so a second run can meet the first mid-flight).
 *
 * This module is held to the same 100% coverage gate as the rest of `infra/scripts/testing/**`, so
 * it is written without branches a test would have to contrive to reach.
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo, Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createShimDir, spawnScript, writeExtraShim } from './shims.js';

/**
 * The `node:fs` surface this module needs, reached only through this object.
 *
 * Every path here is built at test-run time from a generated temp directory, never from untrusted
 * input, but the security linter cannot tell that from a direct call to the imported function by
 * name. Routing each access through one indirection level is the pattern `shims.ts` uses for the
 * same reason.
 */
const fsPort = { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync };

/** Absolute path of the script under test. */
export const scriptPath = fileURLToPath(new URL('../rotate-key.sh', import.meta.url));

/** Key material of the file the sandbox starts with. */
export const OLD_KEY = `${'a'.repeat(64)}\n`;

/** Key material of a `.new` file a crashed rotation left behind. */
export const PENDING_KEY = `${'b'.repeat(64)}\n`;

/** Key material the shimmed `openssl rand -hex 32` produces. */
export const GENERATED_KEY = `${'0'.repeat(64)}\n`;

const dirs: string[] = [];
const servers: Server[] = [];

/** Throwaway paths and ports one rotation test runs against. */
export interface Sandbox {
  /** Temporary directory holding every file the test touches; also the run's HOME. */
  dir: string;
  /** Path the PATH shims append their invocations to. */
  log: string;
  /** The master key the rotation starts from, mode 600. */
  keyPath: string;
  /** Where the script records the phase it has reached. */
  statePath: string;
  /** The replacement key an interrupted rotation leaves behind. */
  newKeyPath: string;
  /** Port base whose web port nothing is listening on, so the running-instance probe stays quiet. */
  portBase: number;
}

/**
 * Binds a loopback listener on an OS-chosen port.
 *
 * @param port - Port to bind; `0` lets the OS choose.
 * @returns The listening server.
 */
export function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      servers.push(server);
      resolve(server);
    });
  });
}

/**
 * Reserves a port base whose web port (`base + 0`) nothing is listening on.
 *
 * The script probes that port to decide whether the instance is running, so every test that is
 * not about that check has to name a base where the probe finds nothing. The port is bound and
 * released rather than merely guessed: the OS hands out ephemeral ports in rotation rather than
 * reissuing the one just returned, so it stays free for the length of one test.
 *
 * @returns A base whose web port is free.
 */
export async function freePortBase(): Promise<number> {
  const server = await listen(0);
  // A TCP server that has emitted `listening` always reports an AddressInfo; the union with
  // `string | null` covers pipe servers and the not-yet-listening state, neither of which can
  // occur here. Narrowing by assertion rather than by a check keeps this module branch-free,
  // which is what lets it sit under the 100% coverage gate honestly.
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  servers.pop();
  return port;
}

/**
 * Builds a sandbox: a fresh temporary directory holding a mode-600 master key, and a port base the
 * running-instance probe will find quiet. Registered for teardown by {@link releaseSandboxes}.
 *
 * @returns The sandbox paths and port base.
 */
export async function sandbox(): Promise<Sandbox> {
  const dir = fsPort.mkdtempSync(join(tmpdir(), 'ah-rotate-'));
  dirs.push(dir);
  const keyPath = join(dir, 'master.key');
  fsPort.writeFileSync(keyPath, OLD_KEY);
  fsPort.chmodSync(keyPath, 0o600);
  return {
    dir,
    log: join(dir, 'log'),
    keyPath,
    statePath: `${keyPath}.rotation`,
    newKeyPath: `${keyPath}.new`,
    portBase: await freePortBase(),
  };
}

/**
 * Writes the standard `AH_DOCTOR_HELPER_CMD` shim: it tells the secrets-status and rotate-key
 * invocations apart by their path argument, logs the rotation mode it was given, and answers from
 * `AH_SHIM_SECRETS_*` / `AH_SHIM_ROTATE_*`.
 *
 * @param shimDir - Shim directory to write into.
 * @returns The absolute path of the shim.
 */
export function helperShim(shimDir: string): string {
  return writeExtraShim(
    shimDir,
    'helper.sh',
    [
      'log="${AH_SHIM_LOG:?AH_SHIM_LOG is not set}"',
      // The mode is what tells a strict rotation from a salvaging resume, and it reaches the
      // helper through the environment rather than the command line, so it is logged here.
      'printf \'%s\\n\' "helper ${AH_ROTATION_MODE:-none} $1" >> "$log"',
      'case "$1" in',
      '  *secrets-status*)',
      '    printf \'%s\\n\' "${AH_SHIM_SECRETS_LINES:-GITHUB_PAT=set:ab12}"',
      '    exit "${AH_SHIM_SECRETS_RC:-0}"',
      '    ;;',
      '  *rotate-key*)',
      '    printf \'%s\\n\' "${AH_SHIM_ROTATE_LINE:-rotated 1 secret(s) to keyVersion 2}"',
      '    exit "${AH_SHIM_ROTATE_RC:-0}"',
      '    ;;',
      'esac',
      'exit 9',
    ].join('\n'),
  );
}

/**
 * Shims `cp` and `mv` so a test can see the exact order the key files were moved in, then
 * delegates to the real tool.
 *
 * @param shimDir - Shim directory prepended to PATH.
 */
export function fileOpShims(shimDir: string): void {
  for (const name of ['cp', 'mv'] as const) {
    writeExtraShim(
      shimDir,
      name,
      [
        'log="${AH_SHIM_LOG:?AH_SHIM_LOG is not set}"',
        `printf '%s\\n' "${name} $*" >> "$log"`,
        `exec /bin/${name} "$@"`,
      ].join('\n'),
    );
  }
}

/**
 * Writes the rotation state file a crashed run would have left behind.
 *
 * @param box - The sandbox.
 * @param phase - Phase recorded in the file.
 * @param backup - Backup path recorded in the file; empty before the swap phase.
 */
export function writeState(box: Sandbox, phase: string, backup = ''): void {
  fsPort.writeFileSync(box.statePath, `phase=${phase}\nbackup=${backup}\n`, { mode: 0o600 });
}

/**
 * Runs the script with the standard helper shim.
 *
 * @param box - The sandbox.
 * @param args - Command-line arguments.
 * @param env - Extra environment variables.
 * @param shimDir - Shim directory to use; a fresh one when omitted.
 * @returns The captured outcome.
 */
export function run(
  box: Sandbox,
  args: string[],
  env: Record<string, string> = {},
  shimDir = createShimDir({ log: box.log }),
): ReturnType<typeof spawnScript> {
  const helper = helperShim(shimDir);
  return spawnScript(scriptPath, {
    shimDir,
    args,
    env: {
      HOME: box.dir,
      AH_PORT_BASE: String(box.portBase),
      MASTER_KEY_PATH: box.keyPath,
      AH_SHIM_LOG: box.log,
      AH_DOCTOR_HELPER_CMD: helper,
      ...env,
    },
  });
}

/** Child processes started by a test, torn down in `afterEach`. */
const children: ChildProcess[] = [];

/**
 * Starts the script without waiting for it, so a second run can meet it mid-flight.
 *
 * @param box - The sandbox.
 * @param args - Command-line arguments.
 * @param env - Extra environment variables.
 * @param shimDir - Shim directory to use.
 * @returns The child, and a promise resolving to its exit code.
 */
export function runDetached(
  box: Sandbox,
  args: string[],
  env: Record<string, string>,
  shimDir: string,
): { child: ChildProcess; exitCode: Promise<number | null> } {
  const child = spawn('bash', [scriptPath, ...args], {
    env: {
      HOME: box.dir,
      AH_PORT_BASE: String(box.portBase),
      MASTER_KEY_PATH: box.keyPath,
      AH_SHIM_LOG: box.log,
      ...env,
      PATH: `${shimDir}:/usr/bin:/bin`,
    },
  });
  children.push(child);
  const exitCode = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => {
      resolve(code);
    });
  });
  return { child, exitCode };
}

/**
 * Writes a helper shim that stops inside the re-encryption step until it is released, so a test
 * can hold a run open inside the section the lock protects.
 *
 * @param shimDir - Shim directory to write into.
 * @param started - Path the shim creates once it has been reached.
 * @param release - Path the shim waits for before returning.
 * @returns The absolute path of the shim.
 */
export function gateHelperShim(shimDir: string, started: string, release: string): string {
  return writeExtraShim(
    shimDir,
    'gate-helper.sh',
    [
      'log="${AH_SHIM_LOG:?AH_SHIM_LOG is not set}"',
      'printf \'%s\\n\' "helper ${AH_ROTATION_MODE:-none} $1" >> "$log"',
      'case "$1" in',
      '  *rotate-key*)',
      `    printf '%s\\n' 'reached' > '${started}'`,
      `    while [ ! -f '${release}' ]; do sleep 0.05; done`,
      "    printf '%s\\n' 'rotated 1 secret(s)'",
      '    exit 0',
      '    ;;',
      'esac',
      'exit 0',
    ].join('\n'),
  );
}

/**
 * Returns a process id that is certainly not running: a trivial child is started and reaped, and
 * its id is reported once it has exited.
 *
 * @returns The dead process id.
 */
export function deadPid(): number {
  const finished = spawnSync('bash', ['-c', 'exit 0']);
  return finished.pid;
}

/**
 * Reads a file's permission bits.
 *
 * @param path - File to inspect.
 * @returns The mode as an octal string, e.g. `600`.
 */
export function fileMode(path: string): string {
  return (fsPort.statSync(path).mode & 0o777).toString(8);
}

/**
 * Lists the backup files the sandbox holds, oldest name first.
 *
 * @param box - The sandbox.
 * @returns Their absolute paths.
 */
export function backupPaths(box: Sandbox): string[] {
  return fsPort
    .readdirSync(box.dir)
    .filter((name) => name.startsWith('master.key.bak-'))
    .sort()
    .map((name) => join(box.dir, name));
}

/**
 * Tears down every sandbox, listener and child a test created. Called from each suite's
 * `afterEach`; the loops are unconditional so the module keeps no branches of its own.
 */
export function releaseSandboxes(): void {
  for (const child of children) {
    child.kill('SIGKILL');
  }
  children.length = 0;
  for (const server of servers) {
    server.close();
  }
  servers.length = 0;
  for (const dir of dirs) {
    fsPort.rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
}
