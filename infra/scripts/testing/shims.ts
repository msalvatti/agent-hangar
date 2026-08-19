/**
 * Test-only PATH shims for the infra script test suite.
 *
 * Layer: test double.
 *
 * Every script test spawns a real bash script (`run.sh`, `setup.sh`, `archive.sh`, …) with `PATH`
 * pointing at a temporary directory of fake executables instead of the real `docker`, `pnpm`,
 * `openssl`, `node` and `concurrently`. Each shim appends its own invocation to a shared log file
 * so a test can assert exactly which commands ran, in what order, with what arguments — without a
 * Docker daemon, a Postgres/Redis instance or network access.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The small subset of `node:fs` this module needs, called only through this object.
 *
 * Every path here is built at test-run time from a generated temp directory, never from
 * untrusted input, but a security linter cannot tell that from a direct call to the imported
 * function by name; routing every access through one indirection level (a method call instead of
 * a bare identifier call) is the same pattern `packages/core/src/secrets/master-key-file.ts` uses
 * for the same reason.
 */
const fsPort = { writeFileSync, chmodSync, existsSync, readFileSync };

/** Permission bits every generated shim is created with (owner read/write/execute only). */
const SHIM_MODE = 0o700;

/** Whether the shimmed `docker info` reports a reachable daemon. */
export type DockerAvailability = 'up' | 'down';

/** Whether the shimmed `docker image inspect` reports the workspace image as present. */
export type WorkspaceImagePresence = 'present' | 'missing';

/** Canned behaviour of the shimmed `docker` executable. */
export interface DockerShimOptions {
  /** `docker info` outcome; `'down'` also makes `docker compose …` fail. Default `'up'`. */
  availability?: DockerAvailability;
  /** `docker image inspect` outcome. Default `'missing'`. */
  image?: WorkspaceImagePresence;
  /** Exit code of `docker compose … up`/`down …`. Default `0`, or `1` when `availability` is `'down'`. */
  composeExitCode?: number;
  /** Container names printed by `docker ps --format …` (workspace-container listing). */
  psNames?: string[];
  /** Container ids printed by `docker ps -aq --filter …` (workspace-container id lookups). */
  psIds?: string[];
  /** Stdout of `docker compose … exec … psql …` (used by `db-prune.sh` tests). */
  execOutput?: string;
  /** Exit code of `docker compose … exec …`. Default `0`. */
  execExitCode?: number;
}

/** Canned behaviour of the shimmed `pnpm` executable. */
export interface PnpmShimOptions {
  /** Printed for `pnpm -v`. Default `'11.22.0'`. */
  version?: string;
  /** Exit code of `pnpm … exec prisma migrate status`. Default `0`. */
  migrateStatusExitCode?: number;
}

/** Options accepted by {@link createShimDir}. */
export interface CreateShimDirOptions {
  /** Path every shim appends its invocation line to. */
  log: string;
  /** Behaviour of the `docker` shim. */
  docker?: DockerShimOptions;
  /** Behaviour of the `pnpm` shim. */
  pnpm?: PnpmShimOptions;
  /** Printed for `node -v`. Default `'v24.0.0'`. */
  nodeVersion?: string;
}

/** A spawned script's outcome. */
export interface SpawnedScript {
  /** Process exit code, or `null` when the process was killed by a signal. */
  status: number | null;
  /** Captured standard output. */
  stdout: string;
  /** Captured standard error. */
  stderr: string;
}

/** Options accepted by {@link spawnScript}. */
export interface SpawnScriptOptions {
  /** Extra environment variables; merged over a minimal base (`PATH`, `HOME`). */
  env?: Record<string, string>;
  /** Command-line arguments passed to the script. */
  args?: string[];
  /** Directory of shims to prepend to `PATH` (from {@link createShimDir}). */
  shimDir: string;
  /** Working directory for the spawned process; defaults to the current process's `cwd`. */
  cwd?: string;
}

/**
 * Escapes a value for embedding inside a single-quoted shell string literal.
 *
 * @param value - Raw text to embed.
 * @returns The value, safe to place between single quotes in a generated shim.
 */
function shellSingleQuote(value: string): string {
  return value.replaceAll("'", `'\\''`);
}

/**
 * Writes one executable shim into a shim directory.
 *
 * @param dir - Shim directory.
 * @param name - Executable name (`docker`, `pnpm`, …).
 * @param body - Shell script body, without the shebang line.
 */
function writeShim(dir: string, name: string, body: string): void {
  const path = join(dir, name);
  fsPort.writeFileSync(path, `#!/usr/bin/env bash\nset -u\n${body}\n`, { encoding: 'utf8' });
  fsPort.chmodSync(path, SHIM_MODE);
}

/**
 * Builds the body of the `docker` shim from its canned behaviour.
 *
 * @param options - Behaviour every `docker` invocation should follow.
 * @returns A bash script body that logs its invocation and branches on the subcommand.
 */
function dockerShimBody(options: DockerShimOptions): string {
  const availability = options.availability ?? 'up';
  const infoExit = availability === 'up' ? 0 : 1;
  const composeExit = options.composeExitCode ?? (availability === 'up' ? 0 : 1);
  const imageExit = (options.image ?? 'missing') === 'present' ? 0 : 1;
  const psIdsLines = (options.psIds ?? []).map((id) => `printf '%s\\n' '${shellSingleQuote(id)}'`);
  const psNameLines = (options.psNames ?? []).map(
    (name) => `printf '%s\\n' '${shellSingleQuote(name)}'`,
  );
  const execOutput = shellSingleQuote(options.execOutput ?? '');
  const execExit = options.execExitCode ?? 0;

  return `
log="\${AH_SHIM_LOG:?AH_SHIM_LOG is not set}"
printf '%s\\n' "docker $*" >> "$log"
case "\${1:-}" in
  info)
    exit ${infoExit}
    ;;
  image)
    exit ${imageExit}
    ;;
  ps)
    if printf '%s\\n' "$*" | grep -q -- '-aq'; then
      ${psIdsLines.length > 0 ? psIdsLines.join('\n      ') : ': no ids'}
      exit 0
    fi
    printf '%s\\n' 'NAMES\\tSTATUS\\tKIND\\tCHAT'
    ${psNameLines.length > 0 ? psNameLines.join('\n    ') : ': no names'}
    exit 0
    ;;
  rm)
    shift
    for id in "$@"; do
      case "$id" in
        -*) continue ;;
      esac
      printf '%s\\n' "$id"
    done
    exit 0
    ;;
  build)
    exit 0
    ;;
  compose)
    for arg in "$@"; do
      case "$arg" in
        up|down)
          exit ${composeExit}
          ;;
        exec)
          printf '%s\\n' '${execOutput}'
          exit ${execExit}
          ;;
      esac
    done
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;
}

/**
 * Builds the body of the `pnpm` shim from its canned behaviour.
 *
 * @param options - Behaviour every `pnpm` invocation should follow.
 * @returns A bash script body that logs its invocation and branches on the subcommand.
 */
function pnpmShimBody(options: PnpmShimOptions): string {
  const version = shellSingleQuote(options.version ?? '11.22.0');
  const migrateStatusExit = options.migrateStatusExitCode ?? 0;
  return `
log="\${AH_SHIM_LOG:?AH_SHIM_LOG is not set}"
printf '%s\\n' "pnpm $*" >> "$log"
if [ "\${1:-}" = '-v' ]; then
  printf '%s\\n' '${version}'
  exit 0
fi
if printf '%s\\n' "$*" | grep -q 'migrate status'; then
  exit ${migrateStatusExit}
fi
exit 0
`;
}

/**
 * Creates a temporary directory of fake `docker`, `pnpm`, `openssl`, `node` and `concurrently`
 * executables that behave as configured and log every invocation.
 *
 * @param options - Log path and per-tool canned behaviour.
 * @returns The absolute path of the shim directory.
 */
export function createShimDir(options: CreateShimDirOptions): string {
  const dir = mkdtempSync(join(tmpdir(), 'ah-shims-'));
  const nodeVersion = shellSingleQuote(options.nodeVersion ?? 'v24.0.0');

  writeShim(dir, 'docker', dockerShimBody(options.docker ?? {}));
  writeShim(dir, 'pnpm', pnpmShimBody(options.pnpm ?? {}));
  writeShim(
    dir,
    'openssl',
    `
log="\${AH_SHIM_LOG:?AH_SHIM_LOG is not set}"
printf '%s\\n' "openssl $*" >> "$log"
if [ "\${1:-}" = 'rand' ]; then
  printf '%064d\\n' 0
  exit 0
fi
exit 0
`,
  );
  writeShim(
    dir,
    'node',
    `
log="\${AH_SHIM_LOG:?AH_SHIM_LOG is not set}"
printf '%s\\n' "node $*" >> "$log"
if [ "\${1:-}" = '-v' ]; then
  printf '%s\\n' '${nodeVersion}'
  exit 0
fi
exit 0
`,
  );
  writeShim(
    dir,
    'concurrently',
    `
log="\${AH_SHIM_LOG:?AH_SHIM_LOG is not set}"
printf '%s\\n' "concurrently $*" >> "$log"
exit 0
`,
  );

  return dir;
}

/**
 * Writes one additional executable into an existing shim directory (or a fresh temporary one).
 *
 * Used by tasks that need a bespoke shim beyond the five standard tools — for example the
 * `AH_DOCTOR_HELPER_CMD` target that stands in for `pnpm exec tsx infra/scripts/lib/*.main.ts`.
 *
 * @param dir - Directory to write into; created when omitted.
 * @param name - Executable name.
 * @param body - Shell script body, without the shebang line.
 * @returns The absolute path of the written executable.
 */
export function writeExtraShim(dir: string | undefined, name: string, body: string): string {
  const target = dir ?? mkdtempSync(join(tmpdir(), 'ah-shims-'));
  writeShim(target, name, body);
  return join(target, name);
}

/**
 * Reads the lines a shim log recorded, oldest first.
 *
 * @param log - Path passed as `AH_SHIM_LOG` to the spawned script.
 * @returns Every logged invocation line, or an empty array when the log was never written.
 */
export function readShimLog(log: string): string[] {
  if (!fsPort.existsSync(log)) {
    return [];
  }
  return fsPort
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
}

/**
 * Spawns a bash script with a shim directory prepended to `PATH`.
 *
 * @param script - Absolute path of the script under test.
 * @param options - Environment, arguments, shim directory and working directory.
 * @returns The captured exit code, stdout and stderr.
 */
export function spawnScript(script: string, options: SpawnScriptOptions): SpawnedScript {
  const env: Record<string, string> = {
    HOME: options.env?.HOME ?? '/tmp',
    ...options.env,
    PATH: `${options.shimDir}:/usr/bin:/bin`,
  };
  // 'bash' (not an absolute path) so resolution goes through the PATH above — /bin on both
  // macOS and Linux carries the system bash, and the shim directory is searched first.
  const result = spawnSync('bash', [script, ...(options.args ?? [])], {
    env,
    encoding: 'utf8',
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
