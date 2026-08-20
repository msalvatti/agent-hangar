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
 * This module is held to the same 100% coverage gate as the rest of `infra/scripts/testing/**`.
 * Only the port-base allocator branches, and `rotate-key-sandbox.test.ts` drives every one of them
 * directly; everything else here is written straight through, so a rotation test never has to
 * contrive a path in the double it is using.
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import type { Server } from 'node:net';
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
 *
 * Exported so `rotate-key-sandbox.test.ts` can spy on `renameSync` to inject the one interleaving
 * of the stale-marker reclaim that only two independent processes racing each other could produce;
 * every other consumer reaches this module only through the functions exported below.
 */
export const fsPort = {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
};

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

/** Lowest port base handed out, and the width of the range; see {@link reservePortBase}. */
const PORT_BASE_FLOOR = 30000;
const PORT_BASE_SPAN = 1500;

/** Ports consumed per instance (web, Postgres, Redis), so blocks never overlap. */
const PORT_BASE_STRIDE = 3;

/** Name prefix of the marker directory that holds one base for whoever created it. */
const CLAIM_PREFIX = 'ah-port-base-';

/**
 * Age at which a marker is treated as abandoned rather than held.
 *
 * A run killed outright — Ctrl-C on a watch session, a cancelled job — never reaches its teardown,
 * and without this its markers would hold their bases for good; some twenty such runs would exhaust
 * the range and turn a convenience into an outage. An hour is far longer than any run of this
 * project (under half a minute idle, a little over two minutes with four copies racing each other
 * on a loaded machine), so a marker that old cannot belong to a run still using it.
 */
const STALE_CLAIM_MS = 60 * 60 * 1000;

/**
 * Where this process starts looking. Seeding from the pid means concurrent workers usually claim
 * on their first try instead of walking past each other's bases; it is a head start, not the thing
 * that keeps them apart, which is the marker below.
 */
let nextPortBase = process.pid * PORT_BASE_STRIDE;

/** Marker directories this process created, removed by {@link releaseSandboxes}. */
const claims: string[] = [];

/**
 * Reports whether a failed `mkdir` (or `rename`) lost the race over a path that another actor
 * already holds.
 *
 * @param error - Value thrown by `mkdirSync` or `renameSync`.
 * @param code - The `errno` code that means "somebody else got there first".
 * @returns `true` when the operation failed for that reason.
 */
function isRaceLossError(error: unknown, code: 'EEXIST' | 'ENOENT'): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

/**
 * Deletes `marker` if — and only if — it is actually abandoned, without ever deleting a directory
 * a concurrent claimant just created there.
 *
 * A plain stat-then-remove reads the marker's age and acts on that reading afterwards, and those
 * are two separate steps a concurrent reclaimer can land in between: harmlessly, it can remove the
 * same abandoned directory a moment after this process already did (`force` absorbs that); unsafely,
 * it can recreate a fresh claim at `marker` in the gap between this process's read and its removal,
 * and this process would then delete that fresh claim believing it was still the old one — the two
 * processes would go on to both believe they hold the same base. Renaming first turns the read into
 * a claim: an atomic rename either takes exclusive possession of whatever currently sits at
 * `marker` (no other process can rename the same source out from under it) or fails with `ENOENT`
 * because somebody already reclaimed or released it, in which case there is nothing left for this
 * process to do. Only the directory this process now exclusively holds is inspected, and if it
 * turns out not to be stale after all — a fresh claim this process raced into holding — it is
 * renamed straight back, restoring its owner's claim exactly as found.
 *
 * @param marker - Marker path to inspect.
 */
function reclaimIfStale(marker: string): void {
  const held = `${marker}.reclaim-${String(process.pid)}-${String(Math.random()).slice(2)}`;
  try {
    fsPort.renameSync(marker, held);
  } catch (error) {
    if (isRaceLossError(error, 'ENOENT')) {
      return;
    }
    throw error;
  }
  // `throwIfNoEntry: false` rather than a plain stat: the marker can be a dangling symlink left
  // behind by a half-finished cleanup, which resolves to nothing. Missing reads as `0`, which is
  // stale, so the removal below is what disposes of it.
  const heldSince = fsPort.statSync(held, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  if (Date.now() - heldSince > STALE_CLAIM_MS) {
    fsPort.rmSync(held, { recursive: true, force: true });
  } else {
    fsPort.renameSync(held, marker);
  }
}

/**
 * Takes one base for this process, or reports it as somebody else's.
 *
 * `mkdir` is the test-and-set: it either creates the directory or fails, never both, and it fails
 * the same way for a sibling worker of this run and for a wholly separate Vitest process, which is
 * what a pid-seeded counter could not do. A marker old enough to be abandoned is deleted rather
 * than claimed here, so the sweep that follows can take the base on its second pass instead of
 * this call having to succeed at a `mkdir` it just raced somebody for.
 *
 * @param base - Base to claim.
 * @returns `true` when this process now owns the base.
 */
function claimPortBase(base: number): boolean {
  const marker = join(tmpdir(), `${CLAIM_PREFIX}${base}`);
  try {
    fsPort.mkdirSync(marker);
  } catch (error) {
    if (!isRaceLossError(error, 'EEXIST')) {
      throw error;
    }
    reclaimIfStale(marker);
    return false;
  }
  claims.push(marker);
  return true;
}

/**
 * Reserves a port base whose web port (`base + 0`) nothing is listening on.
 *
 * The script probes that port to decide whether the instance is running, so every test that is not
 * about that check has to name a base where the probe finds nothing. Two things have to hold, and
 * they are enforced separately.
 *
 * The range is private rather than OS-assigned: it sits below the ephemeral range both Linux
 * (32768+) and macOS (49152+) allocate from, so the OS never hands one of these ports to somebody
 * else. Binding port 0 and releasing it does not survive that — a released ephemeral port is free
 * only until the OS hands it to the next caller, and with suites running in parallel it did
 * exactly that.
 *
 * Within the range, a base belongs to one claimant at a time, and the marker directory is what
 * says so. A counter seeded from the pid is not enough: workers spawned back to back get adjacent
 * pids, so their sequences interleave over the same five hundred slots with the same stride, and
 * a base one worker had bound to play a running instance was handed to another worker as a base it
 * expected quiet — the rotation there refused to start and exited 1.
 *
 * Two sweeps of the range, because the first may spend a candidate deleting an abandoned marker
 * rather than taking it.
 *
 * @param floor - Lowest base to consider.
 * @param span - Width of the range in ports; must be a whole number of strides.
 * @returns A base no other live sandbox on this machine holds.
 * @throws When every base in the range is held by a run that is still going.
 */
export function reservePortBase(floor = PORT_BASE_FLOOR, span = PORT_BASE_SPAN): number {
  const attempts = (span / PORT_BASE_STRIDE) * 2;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const base = floor + (nextPortBase % span);
    nextPortBase += PORT_BASE_STRIDE;
    if (claimPortBase(base)) {
      return base;
    }
  }
  throw new Error(
    `No free port base in [${floor}, ${floor + span}): every one is held by a live run. ` +
      `Stop the other test runs, or delete the stale markers with ` +
      `rm -rf ${join(tmpdir(), `${CLAIM_PREFIX}*`)}`,
  );
}

/**
 * Builds a sandbox: a fresh temporary directory holding a mode-600 master key, and a port base the
 * running-instance probe will find quiet. Registered for teardown by {@link releaseSandboxes}.
 *
 * @returns The sandbox paths and port base.
 */
export function sandbox(): Sandbox {
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
    portBase: reservePortBase(),
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
function helperShim(shimDir: string): string {
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
 * Tears down every sandbox, listener, child and port-base marker a test created. Called from each
 * suite's `afterEach`; the loops are unconditional, so a teardown never depends on how the test
 * that preceded it ended. Releasing the markers here is what keeps the range from filling up over
 * a working day — the age-based reclamation in {@link reservePortBase} covers only the runs that
 * never get here at all.
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
  for (const marker of claims) {
    fsPort.rmSync(marker, { recursive: true, force: true });
  }
  claims.length = 0;
}
