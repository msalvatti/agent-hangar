/**
 * Contract test over the two repository-wide tooling scripts the gates run through.
 *
 * Layer: integration (spawns a real bash process against a fake `pnpm`; reads the workspace
 * manifests; no compiler, no test runner, no network).
 * Goal: both scripts exist because chaining their steps with `&&` silently skipped one of them.
 *
 *   * `scripts/tsc-build.sh` — `tsc -b` emits `packages/core/dist` for every project it reaches,
 *     and those declarations are only usable once `declarations:rewrite` has turned their relative
 *     ".ts" specifiers into ".js". Chained with `&&`, a failing compile skips the rewrite and
 *     leaves a partially emitted `dist` that breaks the next command to read it — a failure that
 *     belongs to nobody. The rewrite must therefore run either way, while the compiler still
 *     decides the exit status.
 *   * `scripts/run-tests.sh` — chained with `&&`, one failing workspace stopped the run before the
 *     `scripts` project executed, and suites that never ran were indistinguishable from suites that
 *     passed. Observed for real: a timing-dependent web test failed and the suites covering the
 *     change under review were never executed. Every group must run, and the exit status must
 *     still be non-zero when any of them failed.
 *
 * The manifest tests close the same gaps one level up, where they are actually introduced: a
 * script that runs the compiler and never rewrites is the omission both wrappers exist to prevent,
 * and a script that fans the test suites across workspaces without `--sequential` starts them all
 * against one Postgres and one Redis.
 * Mocks: `pnpm` is a PATH shim that logs its invocation and exits with a status chosen per
 * subcommand.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** Permission bits every generated shim is created with (owner read/write/execute only). */
const SHIM_MODE = 0o700;

/** Directories `pnpm-workspace.yaml` collects its packages from, one level deep. */
const WORKSPACE_ROOTS = ['apps', 'packages'];

/** The only route a manifest script may take to the compiler, relative to the repository root. */
const WRAPPER_PATH = 'scripts/tsc-build.sh';

/** File name of {@link WRAPPER_PATH}, which manifests reach by their own relative path. */
const WRAPPER_BASENAME = 'tsc-build.sh';

/**
 * Matches the path a manifest script names the wrapper by, whatever `../` prefix it carries. Kept
 * beside {@link WRAPPER_BASENAME} so the two stay in step; written out rather than built from it,
 * because a name assembled at run time is a name no reader can check against the file on disk.
 */
const WRAPPER_REFERENCE_PATTERN = /\S*tsc-build\.sh/;

/** Flag that makes a recursive `pnpm run` execute one workspace at a time instead of all at once. */
const SEQUENTIAL_FLAG = '--sequential';

/** Flag that keeps a recursive `pnpm run` going after a workspace fails, instead of stopping there. */
const NO_BAIL_FLAG = '--no-bail';

/** Keyword that ends the options pnpm reads and names the script it is to run. */
const RUN_KEYWORD = 'run';

/** Token after which pnpm forwards everything to the script instead of reading it. */
const FORWARD_SEPARATOR = '--';

/**
 * Matches a script that runs its command in every workspace, in either spelling pnpm accepts.
 *
 * Anchored on word boundaries so it reads the flag rather than a substring of a path or of a
 * longer option: `--recursive` and `-r` are the fan-out, `--report-dir` and `scripts/run-tests.sh`
 * are not.
 */
const RECURSIVE_RUN_PATTERN = /(?:^|\s)(?:--recursive|-r)(?:\s|$)/u;

/** Name of the script that runs a package's default suite. */
const TEST_SCRIPT = 'test';

/**
 * Wrapper scripts a root manifest hands its fan-out to.
 *
 * `test` and `test:integration` are one line each in `package.json` and the recursive pnpm command
 * lives in the file they name. Scanning only manifests would therefore report "no fan-out to
 * check" for both — the guard passing because it had stopped looking, which is the failure its own
 * message warns about.
 */
/**
 * Reduces one line of a wrapper script to the command a manifest would have carried.
 *
 * A manifest's script is a bare command; a shell line is the same command wearing a pipeline, a
 * redirection and `"$@"`. The parser this feeds understands the first and reports the rest as
 * undecidable — a verdict that is neither "protected" nor "unprotected", so it would fail the gate
 * while saying nothing about the flags. Stripping the shell's own punctuation asks the question
 * that was meant.
 *
 * @param line - One line of a wrapper script.
 * @returns The command with its pipeline tail, redirections and argument forwarding removed.
 */
function shellCommandOf(line: string): string {
  const [head = ''] = line.split('|');
  return head
    .replace(/\d?>&?\d?\s*\S*/gu, ' ')
    .replace(/"\$@"/gu, ' ')
    .trim();
}

const DELEGATED_TEST_SCRIPTS: readonly string[] = [
  'scripts/run-tests.sh',
  'scripts/run-integration.sh',
];

/** Prefix of every script that runs one of a package's other suites (`test:integration`, …). */
const TEST_SCRIPT_PREFIX = 'test:';

/**
 * Whether a script name is one that runs a test suite.
 *
 * @param name - Key of the script in its manifest.
 * @returns `true` for `test` and for every `test:<suite>`.
 */
function isTestScript(name: string): boolean {
  return name === TEST_SCRIPT || name.startsWith(TEST_SCRIPT_PREFIX);
}

/** Shell operators that end one command and begin the next. */
const COMMAND_SEPARATORS: readonly string[] = ['&&', '||', ';', '|', '&'];

/** Name of the package manager whose invocations this guard is about. */
const PNPM = 'pnpm';

/** Flags, either spelling, that make a pnpm invocation act on every workspace. */
const RECURSIVE_FLAGS: readonly string[] = ['--recursive', '-r'];

/** Matches a leading `NAME=value` token, which is environment for the command rather than the command. */
const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/** Quote inside which the shell expands nothing, so its contents are literal text. */
const LITERAL_QUOTE = "'";

/** Quote inside which the shell still expands, so its contents are not guaranteed literal. */
const EXPANDING_QUOTE = '"';

/** Characters that hand part of the command to the shell to produce, rather than stating it. */
const EXPANSIONS: readonly string[] = ['$', '`'];

/** Characters that open or close a subshell, changing what counts as a command. */
const SUBSHELL: readonly string[] = ['(', ')'];

/**
 * What a script does about fanning a suite out across workspaces.
 *
 * `undecidable` is deliberately not folded into either verdict. It says the command contains
 * something that looks like a recursive run and is written in a shape this guard will not take
 * apart — which is a reason to stop, not a reason to assume either answer.
 */
type FanOutVerdict = 'none' | 'complete' | 'incomplete' | 'undecidable';

/**
 * Splits a script into the individual commands it runs, tokenised.
 *
 * A script is not one invocation. `a && b` is two, and a guard that looks for *the* pnpm call in
 * the text finds whichever one happens to come first — so a chain whose first half is protected
 * vouches for a second half that is not. Every command has to be recovered before any of them can
 * be judged.
 *
 * Quotes are tracked so a separator inside an argument is not mistaken for one between commands,
 * which is what lets `--filter './packages/*'` survive. Anything the shell would expand returns
 * `null` instead — subshells, command substitution, a variable, an unterminated quote — because
 * those decide which text is a command at all, and only a single-quoted stretch is literal enough
 * to rule that out. A parser that guessed there would be guessing about exactly the thing being
 * checked.
 *
 * @param command - The script body as written in the manifest.
 * @returns One token list per command, or `null` when the script is not safely decomposable.
 */
function splitInvocations(command: string): string[][] | null {
  const invocations: string[][] = [];
  let tokens: string[] = [];
  let token = '';
  let quote = '';
  const endToken = (): void => {
    if (token.length > 0) {
      tokens.push(token);
      token = '';
    }
  };
  const endInvocation = (): void => {
    endToken();
    if (tokens.length > 0) {
      invocations.push(tokens);
      tokens = [];
    }
  };
  for (const character of command) {
    if (quote === LITERAL_QUOTE) {
      // Nothing expands inside single quotes, so every character is text, including a separator.
      if (character === LITERAL_QUOTE) {
        quote = '';
      } else {
        token += character;
      }
    } else if (EXPANSIONS.includes(character)) {
      // Reached outside single quotes — double quotes do not stop the shell expanding.
      return null;
    } else if (quote === EXPANDING_QUOTE) {
      if (character === EXPANDING_QUOTE) {
        quote = '';
      } else {
        token += character;
      }
    } else if (character === LITERAL_QUOTE || character === EXPANDING_QUOTE) {
      quote = character;
    } else if (SUBSHELL.includes(character)) {
      return null;
    } else if (COMMAND_SEPARATORS.some((separator) => separator.startsWith(character))) {
      endInvocation();
    } else if (/\s/u.test(character)) {
      endToken();
    } else {
      token += character;
    }
  }
  endInvocation();
  return quote === '' ? invocations : null;
}

/**
 * Strips the environment a command is prefixed with, leaving the command itself.
 *
 * `DOCKER_AVAILABLE=1 vitest run` is `vitest`, not `DOCKER_AVAILABLE=1`, and the difference decides
 * whether an invocation is recognised as pnpm's at all.
 *
 * @param tokens - Tokens of one invocation.
 * @returns The same tokens without any leading `NAME=value` assignments.
 */
function withoutEnvironment(tokens: string[]): string[] {
  const commandAt = tokens.findIndex((token) => !ENVIRONMENT_ASSIGNMENT.test(token));
  // Every token being an assignment means there is no command here to judge, and `slice(-1)` would
  // answer that with the last assignment rather than with nothing.
  return commandAt === -1 ? [] : tokens.slice(commandAt);
}

/**
 * Whether one invocation is a pnpm command that acts on every workspace.
 *
 * Both halves matter. `grep -r` carries a recursive flag and is not pnpm's business; `pnpm --filter
 * web run test` is pnpm and is not a fan-out. Only the intersection is what this gate is about.
 *
 * @param tokens - Tokens of one invocation, environment already stripped.
 * @returns `true` when the command is `pnpm` and carries `-r` or `--recursive`.
 */
function isRecursivePnpm(tokens: string[]): boolean {
  return tokens[0] === PNPM && tokens.some((token) => RECURSIVE_FLAGS.includes(token));
}

/**
 * Whether one recursive pnpm invocation hands pnpm both flags a complete gate depends on.
 *
 * Searching the invocation's text for a flag is not the same question, and the difference is the
 * whole check. Measured on pnpm 11.22.0: `pnpm -r run test -- --sequential` and `pnpm -r run test
 * --sequential` both start every workspace at the same instant and hand the script `--sequential`
 * as an argument — the flag is present in the text and absent from pnpm's own parse.
 *
 * The boundary is the `run` keyword: everything before it is an option pnpm reads, everything from
 * the script name on is not. Requiring the keyword rather than inferring the script name is what
 * makes the boundary a fact about the invocation instead of a guess about which options take
 * values: without it, telling `--filter web` (an option and its value) from `--if-present test` (an
 * option and the script) means keeping a list of which options take values, and a list like that is
 * wrong the day pnpm adds one.
 *
 * The cost is deliberate and worth stating: `pnpm -r --sequential --no-bail test` runs correctly —
 * measured — and is still reported, because nothing in it marks where the options stop. The refusal
 * is conservative rather than a verdict on the command, and the message names the spelling to use
 * instead. A guard on a gate should fail loudly on what it cannot read, not guess.
 *
 * @param tokens - Tokens of one recursive pnpm invocation, environment already stripped.
 * @returns `true` when `--sequential` and `--no-bail` both reach pnpm's own option segment.
 */
function protectsItsFanOut(tokens: string[]): boolean {
  const runAt = tokens.indexOf(RUN_KEYWORD);
  if (runAt === -1) {
    return false;
  }
  const options = tokens.slice(0, runAt);
  return (
    !options.includes(FORWARD_SEPARATOR) &&
    options.includes(SEQUENTIAL_FLAG) &&
    options.includes(NO_BAIL_FLAG)
  );
}

/**
 * What a script does about fanning a suite out, judged over every command it runs.
 *
 * @param command - The script body as written in the manifest.
 * @returns `none` when nothing in it fans out, `complete` when every recursive pnpm invocation is
 *   protected, `incomplete` when one is not, and `undecidable` when the script cannot be taken
 *   apart yet still looks like it fans out.
 */
function fanOutVerdict(command: string): FanOutVerdict {
  const invocations = splitInvocations(command);
  if (invocations === null) {
    return RECURSIVE_RUN_PATTERN.test(command) ? 'undecidable' : 'none';
  }
  const fanOuts = invocations.map(withoutEnvironment).filter(isRecursivePnpm);
  if (fanOuts.length === 0) {
    return 'none';
  }
  return fanOuts.every(protectsItsFanOut) ? 'complete' : 'incomplete';
}

/**
 * How long a spawned script may run before it is killed.
 *
 * This is the bound that does the work, and it has to live on the child rather than on the test:
 * `spawnSync` blocks the thread it runs on, so a per-test timeout cannot interrupt it — Vitest only
 * compares the elapsed time once the synchronous body has already returned, which is a report about
 * a hang, not an escape from one. `spawnSync`'s own `timeout` sends the child a signal, so a script
 * that never exits is killed here instead of holding the run open until the job's own ceiling.
 *
 * Every test here is a process tree — one `bash` for the script and one more for each shimmed
 * `pnpm` it calls — so what they pay is the machine's process-creation cost, not the cost of any
 * work. That is exactly the number a loaded runner inflates: the slowest here takes half a second
 * on an idle machine, and the same measurement on `infra/scripts`, whose tests spawn a far larger
 * tree, grew fivefold under four concurrent copies of this project. Twenty seconds keeps an
 * order-of-magnitude margin over that.
 */
const SCRIPT_TIMEOUT_MS = 20_000;

/**
 * Timeout for the suites that spawn a script.
 *
 * Deliberately above {@link SCRIPT_TIMEOUT_MS} so the child's own kill always lands first and the
 * failure names the script that hung. This is the outer net for the rest of the test body — reading
 * the log file, comparing the result — never for the spawn itself, which it cannot interrupt.
 */
const SCRIPT_SUITE_TIMEOUT_MS = 30_000;

/** Temporary directories created by the tests, removed after each one. */
const temporaryDirectories: string[] = [];

/** Outcome of one spawned script. */
interface ScriptRun {
  /** Process exit code, or `null` when the process was killed by a signal. */
  status: number | null;
  /** One line per shim invocation, in the order they ran. */
  log: string[];
  /** Captured standard error, where both scripts write their summary. */
  stderr: string;
}

/**
 * Options accepted by {@link runScript}.
 */
interface RunScriptOptions {
  /** Script to spawn, relative to the repository root. */
  script: string;
  /** Exit status the `pnpm` shim uses, keyed by the subcommand it is invoked with. */
  exitCodes: Record<string, number>;
  /** Extra arguments handed to the script. */
  args?: string[];
}

/**
 * Writes the executable `pnpm` shim both scripts reach every one of their steps through.
 *
 * One shim covers every step because neither script calls anything else: the compiler runs as
 * `pnpm exec tsc`, the declaration rewrite as `pnpm --filter …`, the workspace suites as
 * `pnpm --recursive …` and the `scripts` project as `pnpm exec vitest`. Branching on the
 * subcommand lets each step be given its own status.
 *
 * @param dir - Shim directory.
 * @param exitCodes - Status to exit with, keyed by the shim's first argument. An invocation whose
 *   first argument is not listed exits `0`.
 */
function writePnpmShim(dir: string, exitCodes: Record<string, number>): void {
  const branches = Object.entries(exitCodes)
    .map(([subcommand, exitCode]) => `  ${subcommand}) exit ${exitCode} ;;`)
    .join('\n');
  const body = `#!/usr/bin/env bash
set -u
printf '%s\\n' "pnpm $*" >> "\${AH_SHIM_LOG:?AH_SHIM_LOG is not set}"
case "\${1:-}" in
${branches}
  *) exit 0 ;;
esac
`;
  writeFileSync(join(dir, 'pnpm'), body, { encoding: 'utf8' });
  chmodSync(join(dir, 'pnpm'), SHIM_MODE);
}

/**
 * Spawns one tooling script against a shimmed `pnpm`.
 *
 * @param options - Script to run, per-subcommand exit statuses and extra arguments.
 * @returns The script's exit status, the shim invocation log and its standard error.
 */
function runScript(options: RunScriptOptions): ScriptRun {
  const dir = mkdtempSync(join(tmpdir(), 'ah-tooling-'));
  temporaryDirectories.push(dir);
  writePnpmShim(dir, options.exitCodes);
  const log = join(dir, 'shim.log');
  // The shim directory comes first so the fake wins, followed by the system directories that
  // carry `bash` itself — /bin on both macOS and the Linux runner. Nothing else is on the path,
  // so the real `pnpm` installed on the machine can never be reached from here.
  const spawned = spawnSync('bash', [join(repoRoot, options.script), ...(options.args ?? [])], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, AH_SHIM_LOG: log },
    timeout: SCRIPT_TIMEOUT_MS,
  });
  // Set when the child could not be run at all or was killed on the timeout above. Both leave a
  // null status, which every assertion here would report as a plain value mismatch; raising says
  // which script failed to finish and why.
  if (spawned.error !== undefined) {
    throw new Error(`${options.script} did not complete: ${spawned.error.message}`);
  }
  const lines = existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
    : [];
  return { status: spawned.status, log: lines, stderr: spawned.stderr };
}

/**
 * Lists every workspace manifest, the root one included.
 *
 * Derived from the file system rather than from a hand-kept list, so a workspace added later is
 * covered the day it appears. {@link WORKSPACE_ROOTS} is the one hand-kept part, and the suite
 * checks it against `pnpm-workspace.yaml`.
 *
 * @returns Manifest paths relative to the repository root.
 */
function listManifests(): string[] {
  const packageManifests = WORKSPACE_ROOTS.flatMap((root) =>
    readdirSync(join(repoRoot, root), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${root}/${entry.name}/package.json`)
      .filter((manifest) => existsSync(join(repoRoot, manifest))),
  );
  return ['package.json', ...packageManifests];
}

/**
 * Reads a workspace manifest's scripts block.
 *
 * @param relativePath - Path of the manifest, relative to the repository root.
 * @returns The scripts block, or an empty object when the manifest declares none.
 */
function readScripts(relativePath: string): Record<string, string> {
  const parsed = JSON.parse(readFileSync(join(repoRoot, relativePath), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return parsed.scripts ?? {};
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const dir = temporaryDirectories.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe(
  'the compile step that emits @agent-hangar/core',
  () => {
    /**
     * Runs `scripts/tsc-build.sh` with the compile and the rewrite each given their own status.
     *
     * @param compileExitCode - Status `pnpm exec tsc -b` exits with.
     * @param rewriteExitCode - Status `pnpm --filter … declarations:rewrite` exits with.
     * @param args - Extra arguments handed to the script.
     * @returns The script's outcome.
     */
    function runCompile(
      compileExitCode: number,
      rewriteExitCode: number,
      args: string[] = [],
    ): ScriptRun {
      return runScript({
        script: 'scripts/tsc-build.sh',
        exitCodes: { exec: compileExitCode, '--filter': rewriteExitCode },
        args,
      });
    }

    /**
     * The ordinary path: compile, then rewrite, then report success. Asserted as an ordered log
     * rather than as two membership checks, because a rewrite that ran *before* the compile would
     * rewrite the previous build's output and leave the new one untouched.
     */
    it('rewrites the declarations after a successful compile and reports success', () => {
      const run = runCompile(0, 0);
      expect(run.status).toBe(0);
      expect(run.log).toEqual([
        'pnpm exec tsc -b',
        'pnpm --filter @agent-hangar/core declarations:rewrite',
      ]);
    });

    /**
     * The failure this wrapper exists for. `tsc -b && <rewrite>` skips the rewrite when the compile
     * fails, so a broken tree keeps a partially emitted `dist` whose declarations name ".ts" files —
     * and the next unrelated command that reads it fails for a reason nobody introduced. The rewrite
     * must run anyway, and the caller must still see the compiler's own status: a compile that
     * failed is a failure whatever the rewrite did afterwards.
     */
    it('still rewrites the declarations when the compile fails, and exits with the compiler status', () => {
      const run = runCompile(2, 0);
      expect(run.status).toBe(2);
      expect(run.log).toEqual([
        'pnpm exec tsc -b',
        'pnpm --filter @agent-hangar/core declarations:rewrite',
      ]);
    });

    /**
     * The rewrite is a gate of its own: it fails when a declaration is left naming a ".ts" file, and
     * that has to fail the build rather than being swallowed by a compiler that happened to succeed.
     */
    it('fails when the rewrite fails after a successful compile', () => {
      expect(runCompile(0, 3).status).toBe(3);
    });

    /**
     * When both fail the compiler's status is the one reported. A rewrite failing on the output of a
     * failed compile is a symptom of that compile, and reporting the symptom would send whoever reads
     * the log looking at the declaration graph instead of at the type error that caused it.
     */
    it('reports the compiler status rather than the rewrite status when both fail', () => {
      expect(runCompile(2, 3).status).toBe(2);
    });

    /**
     * Callers pass build-mode flags through (`--force`, `--verbose`, a project path). They have to
     * reach the compiler after `-b`, not be swallowed by the wrapper.
     */
    it('forwards its arguments to the compiler', () => {
      const run = runCompile(0, 0, ['--force', 'packages/core']);
      expect(run.log[0]).toBe('pnpm exec tsc -b --force packages/core');
    });
  },
  SCRIPT_SUITE_TIMEOUT_MS,
);

describe(
  'the test step that runs every suite',
  () => {
    /**
     * Runs `scripts/run-tests.sh` with the workspace suites and the `scripts` project each given
     * their own status.
     *
     * @param workspacesExitCode - Status the recursive workspace run exits with.
     * @param scriptsExitCode - Status the `scripts` project exits with.
     * @param args - Extra arguments handed to the script.
     * @returns The script's outcome.
     */
    function runTests(
      workspacesExitCode: number,
      scriptsExitCode: number,
      args: string[] = [],
    ): ScriptRun {
      return runScript({
        script: 'scripts/run-tests.sh',
        exitCodes: { '--recursive': workspacesExitCode, exec: scriptsExitCode },
        args,
      });
    }

    /**
     * The ordinary path: every workspace suite, then the `scripts` project, then success. The
     * workspace run is asserted to be sequential and non-bailing, because those two flags are what
     * make the group finish instead of stopping at its first failure.
     */
    it('runs the workspace suites and then the scripts project, and reports success', () => {
      const run = runTests(0, 0);
      expect(run.status).toBe(0);
      expect(run.log).toEqual([
        'pnpm --recursive --if-present --sequential --no-bail --no-include-workspace-root run test',
        'pnpm exec vitest run --project scripts',
      ]);
      expect(run.stderr).toContain('PASS  workspace packages');
      expect(run.stderr).toContain('PASS  infra/scripts');
    });

    /**
     * The failure this script exists for. Chained with `&&`, a failing workspace suite stopped the
     * run before the `scripts` project executed, and the job reported the earlier failure rather than
     * "these tests did not run" — so a flake elsewhere silently voided the gate. Both the second run
     * and the reported outcome are asserted: reaching the project and saying so are what turn a
     * skipped suite back into something a reader can see.
     */
    it('runs the scripts project even after a workspace suite fails, and still fails overall', () => {
      const run = runTests(1, 0);
      expect(run.status).not.toBe(0);
      expect(run.log).toEqual([
        'pnpm --recursive --if-present --sequential --no-bail --no-include-workspace-root run test',
        'pnpm exec vitest run --project scripts',
      ]);
      expect(run.stderr).toContain('FAIL  workspace packages');
      expect(run.stderr).toContain('PASS  infra/scripts');
    });

    /**
     * The other half of the gate. The `scripts` project runs last, so its failure is the one an
     * `&&` chain would have reported correctly — and the one a script that ignored the last status
     * would swallow.
     */
    it('fails overall when only the scripts project fails', () => {
      const run = runTests(0, 1);
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain('FAIL  infra/scripts');
    });

    /**
     * `pnpm test -- --coverage` is how the continuous-integration job invokes the gate. With the two
     * commands chained, those arguments reached only the last one; here they have to reach both
     * groups.
     */
    it('forwards its arguments to both groups', () => {
      const run = runTests(0, 0, ['--coverage']);
      expect(run.log).toEqual([
        'pnpm --recursive --if-present --sequential --no-bail --no-include-workspace-root run test --coverage',
        'pnpm exec vitest run --project scripts --coverage',
      ]);
    });
  },
  SCRIPT_SUITE_TIMEOUT_MS,
);

describe('the manifests that reach the compiler', () => {
  /**
   * The invariant the compile wrapper exists to make keepable, checked where it is actually
   * violated: a manifest script. `tsc -b` emits this package's declarations from any project that
   * reaches it, and only the wrapper guarantees the rewrite that follows runs at all — so the
   * compiler is not something a manifest may invoke on its own terms. Asking for the rewrite to be
   * present somewhere on the line would be weaker: `tsc -b && <rewrite>` satisfies that reading and
   * is exactly the shape that skips the rewrite whenever the compile fails. Naming the wrapper as
   * the only route makes the short-circuit unrepresentable rather than merely detectable.
   */
  it('reaches the compiler only through the wrapper', () => {
    const manifests = listManifests();
    expect(manifests, 'the scan must reach the workspaces it is meant to cover').toContain(
      'packages/core/package.json',
    );
    const offenders = manifests.flatMap((manifest) =>
      Object.entries(readScripts(manifest))
        .filter(([, command]) => command.includes('tsc -b'))
        .map(([name]) => `${manifest} → ${name}`),
    );
    expect(
      offenders,
      `these scripts run the compiler outside ${WRAPPER_PATH}, where a failed compile skips the rewrite`,
    ).toEqual([]);
  });

  /**
   * The other half, without which the check above passes vacuously: a repository where nothing
   * compiles at all satisfies "no script invokes the compiler directly". At least one script has to
   * reach the wrapper, and every script that names it has to name a path that resolves to the real
   * file. The paths are relative — `bash ../../scripts/tsc-build.sh` from a workspace package — so
   * a package moved one level deeper would keep a plausible-looking script that silently runs
   * nothing, which is precisely the failure a text comparison would miss.
   */
  it('points every delegating script at the real wrapper', () => {
    const delegations = listManifests().flatMap((manifest) =>
      Object.entries(readScripts(manifest))
        .filter(([, command]) => command.includes(WRAPPER_BASENAME))
        .map(([name, command]) => ({ manifest, name, command })),
    );
    expect(delegations.length, 'nothing compiles through the wrapper any more').toBeGreaterThan(0);

    const wrapper = join(repoRoot, WRAPPER_PATH);
    const unresolved = delegations
      .filter(({ manifest, command }) => {
        const named = WRAPPER_REFERENCE_PATTERN.exec(command)?.[0] ?? '';
        return resolve(dirname(join(repoRoot, manifest)), named) !== wrapper;
      })
      .map(({ manifest, name }) => `${manifest} → ${name}`);
    expect(unresolved, `these scripts name a path that is not ${WRAPPER_PATH}`).toEqual([]);
    expect(existsSync(wrapper), `${WRAPPER_PATH} must exist`).toBe(true);
  });

  /**
   * The scan above walks {@link WORKSPACE_ROOTS} rather than the workspace definition, because
   * `pnpm-workspace.yaml` also carries build allow-lists and dependency overrides that no test
   * here should have to parse. A third root added to that file would silently go unscanned, so the
   * two are compared: the declared globs must be exactly the roots this suite walks.
   */
  it('walks every directory pnpm collects workspace packages from', () => {
    const workspaceFile = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
    const declaredGlobs = [...workspaceFile.matchAll(/^\s*-\s*'([^']+)'/gm)].map(
      ([, glob]) => glob,
    );
    expect(declaredGlobs).toEqual(WORKSPACE_ROOTS.map((root) => `${root}/*`));
  });
});

describe('the manifests that fan a suite out across workspaces', () => {
  /**
   * The invariant a shared Redis makes non-negotiable. Recursive `pnpm run` is concurrent by
   * default, so a script that fans the integration suites out across workspaces starts them at the
   * same instant — and they do not have separate infrastructure to run against. One of those suites
   * empties Redis on purpose (`FLUSHDB`, which cannot be narrowed to a key prefix once it has run),
   * so a suite in another workspace loses the jobs and streams it is mid-assertion on and reports a
   * state that never existed. Measured: the web app's retry suite failed with its BullMQ job
   * `undefined` rather than `completed`, because the worker's harness had flushed the database
   * underneath it.
   *
   * `--no-bail` is the other half, and it is the same failure `scripts/run-tests.sh` was written
   * for one level down. Sequential execution without it stops the whole command at the first
   * workspace that fails, so every later suite is never run — and a run that never happened is
   * indistinguishable, in the job's output, from one that passed. Measured on pnpm 11.22.0 over
   * three workspaces whose middle one fails: `--sequential` alone runs two of them, `--sequential
   * --no-bail` runs all three and still exits non-zero. Making the suite sequential is therefore
   * only safe together with the flag that keeps it going.
   *
   * Both are asserted over every command the script runs, against pnpm's own option segment in
   * each: see {@link splitInvocations} and {@link protectsItsFanOut} for why either shortcut —
   * one invocation, or the command's text — is a different question from this one.
   */
  it('runs every workspace test suite one at a time, and runs all of them', () => {
    const fromManifests = listManifests().flatMap((manifest) =>
      Object.entries(readScripts(manifest))
        .map(([name, command]) => ({
          where: `${manifest} → ${name}`,
          test: isTestScript(name),
          verdict: fanOutVerdict(command),
        }))
        .filter(({ test, verdict }) => test && verdict !== 'none'),
    );
    // A manifest that delegates to a shell script moves its fan-out out of reach of the scan
    // above, and a rule that a file can step outside of by being written somewhere else is not a
    // rule. Both wrappers are read here for the same reason the manifests are.
    const fromWrappers = DELEGATED_TEST_SCRIPTS.flatMap((script) =>
      readFileSync(join(repoRoot, script), 'utf8')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'))
        .map((line) => ({
          where: `${script} → ${line.trim()}`,
          verdict: fanOutVerdict(shellCommandOf(line)),
        }))
        .filter(({ verdict }) => verdict !== 'none')
        .map(({ where, verdict }) => ({ where, test: true, verdict })),
    );
    const verdicts = [...fromManifests, ...fromWrappers];
    expect(
      verdicts.length,
      'the scan must still recognise the fan-out it exists for; a guard tightened until it ' +
        'matches nothing passes every manifest for the wrong reason',
    ).toBeGreaterThan(0);
    expect(
      verdicts.map(({ where }) => where).filter((where) => where.includes('run-integration.sh')),
      'the integration fan-out moved from the manifest into a wrapper; the scan has to follow it',
    ).not.toEqual([]);

    const offenders = verdicts
      .filter(({ verdict }) => verdict !== 'complete')
      .map(({ where, verdict }) => `${where} (${verdict})`);
    expect(
      offenders,
      `these scripts either start every workspace suite at once, against one Postgres and one ` +
        `Redis, or stop at the first failure and leave the rest unrun; every recursive pnpm ` +
        `invocation must receive ${SEQUENTIAL_FLAG} and ${NO_BAIL_FLAG} before its ` +
        `${RUN_KEYWORD} keyword`,
    ).toEqual([]);
  });

  /**
   * The check above is only worth having if it cannot be satisfied by a command that does not have
   * the property, so every spelling that would fool a simpler reading is pinned here rather than
   * left to the reader's confidence. Each rejected form was run against pnpm 11.22.0 and started
   * every workspace at the same instant while handing the script the flag as an argument, or —
   * for the chained ones — left a second fan-out entirely unprotected.
   */
  it('rejects a fan-out whose flags never reach the pnpm invocation that needs them', () => {
    expect(
      fanOutVerdict('pnpm --recursive --if-present --sequential --no-bail run test:integration'),
      'the real command must pass',
    ).toBe('complete');

    // Forwarded past `--`: pnpm parses none of it, and hands the script "-- --sequential".
    expect(fanOutVerdict('pnpm -r run test -- --sequential --no-bail')).toBe('incomplete');
    // After the script name: same outcome without the separator.
    expect(fanOutVerdict('pnpm -r run test --sequential --no-bail')).toBe('incomplete');
    // No `run` keyword. This spelling does run sequentially, but nothing in the text marks where
    // the options stop, so it is refused rather than read by guesswork; see the parser's note.
    expect(fanOutVerdict('pnpm -r --sequential --no-bail test:integration')).toBe('incomplete');
    // Each flag is load-bearing on its own.
    expect(fanOutVerdict('pnpm -r --sequential run test')).toBe('incomplete');
    expect(fanOutVerdict('pnpm -r --no-bail run test')).toBe('incomplete');
    // The flags belong to another command entirely, which never fans anything out.
    expect(fanOutVerdict('echo --sequential --no-bail run && pnpm -r run test')).toBe('incomplete');
    // A chain whose first half is protected does not vouch for its second half.
    expect(
      fanOutVerdict('pnpm -r --sequential --no-bail run test && pnpm -r run test:integration'),
    ).toBe('incomplete');
    // Both halves protected is the shape that legitimately passes.
    expect(
      fanOutVerdict(
        'pnpm -r --sequential --no-bail run test && pnpm -r --sequential --no-bail run test:integration',
      ),
    ).toBe('complete');
  });

  /**
   * The two verdicts that are not about the flags at all, kept apart because collapsing either into
   * a pass is how a gate stops reporting. A command with no fan-out in it is simply not this
   * check's business; a command carrying something the shell would expand is its business and
   * cannot be read, which is a reason to stop rather than to assume.
   */
  it('separates a script that does not fan out from one it cannot read', () => {
    expect(fanOutVerdict('bash scripts/run-tests.sh')).toBe('none');
    expect(fanOutVerdict('vitest run --project unit')).toBe('none');
    expect(fanOutVerdict('grep -r pattern src && vitest run')).toBe('none');
    expect(fanOutVerdict('DOCKER_AVAILABLE=1 vitest run --project integration')).toBe('none');
    expect(
      fanOutVerdict('DOCKER_AVAILABLE=1 pnpm -r --sequential --no-bail run test'),
      'environment in front of the command must not hide the command',
    ).toBe('complete');
    expect(
      fanOutVerdict("pnpm -r --sequential --no-bail --filter './packages/*' run test"),
      'a separator inside a quoted argument is not a separator between commands',
    ).toBe('complete');
    expect(
      fanOutVerdict('FOO=1 BAR=2'),
      'an invocation that is only environment has no command in it to judge',
    ).toBe('none');
    expect(fanOutVerdict('pnpm -r run $SCRIPT')).toBe('undecidable');
    expect(fanOutVerdict('(pnpm -r run test)')).toBe('undecidable');
    expect(fanOutVerdict('echo "unterminated && pnpm -r run test')).toBe('undecidable');
    expect(
      fanOutVerdict('echo "$HOME"'),
      'an unreadable command with no fan-out in it is still outside this gate',
    ).toBe('none');
  });
});
