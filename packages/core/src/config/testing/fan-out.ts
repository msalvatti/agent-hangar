/**
 * Reading a manifest or wrapper script's command well enough to say whether it fans a suite out
 * across workspaces, and whether that fan-out is protected.
 *
 * Layer: test support (pure).
 *
 * Split out of `tooling-scripts.test.ts`, which held both the parser and everything it pins and
 * had grown past the size this repository allows a file. The seam is real rather than numeric:
 * one half decides what a command does, the other decides what the repository's commands must do.
 */

/** Flag that makes a recursive `pnpm run` execute one workspace at a time instead of all at once. */
export const SEQUENTIAL_FLAG = '--sequential';

/** Flag that keeps a recursive `pnpm run` going after a workspace fails, instead of stopping there. */
export const NO_BAIL_FLAG = '--no-bail';

/** Keyword that ends the options pnpm reads and names the script it is to run. */
export const RUN_KEYWORD = 'run';

/** Token after which pnpm forwards everything to the script instead of reading it. */
const FORWARD_SEPARATOR = '--';

/**
 * Matches a script that runs its command in every workspace, in either spelling pnpm accepts.
 *
 * Anchored on word boundaries so it reads the flag rather than a substring of a path or of a
 * longer option: `--recursive` and `-r` are the fan-out, `--report-dir` and `scripts/run-tests.sh`
 * are not.
 */
export const RECURSIVE_RUN_PATTERN = /(?:^|\s)(?:--recursive|-r)(?:\s|$)/u;

/** Name of the script that runs a package's default suite. */
const TEST_SCRIPT = 'test';

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
export function shellCommandOf(line: string): string {
  const [head = ''] = line.split('|');
  return head
    .replace(/\d?>&?\d?\s*\S*/gu, ' ')
    .replace(/"\$@"/gu, ' ')
    .trim();
}

/**
 * Wrapper scripts a root manifest hands its fan-out to.
 *
 * `test` and `test:integration` are one line each in `package.json` and the recursive pnpm command
 * lives in the file they name. Scanning only manifests would therefore report "no fan-out to
 * check" for both — the guard passing because it had stopped looking, which is the failure its own
 * message warns about.
 */
export const DELEGATED_TEST_SCRIPTS: readonly string[] = [
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
export function isTestScript(name: string): boolean {
  return name === TEST_SCRIPT || name.startsWith(TEST_SCRIPT_PREFIX);
}

/** Shell operators that end one command and begin the next. */
const COMMAND_SEPARATORS: readonly string[] = ['&&', '||', ';', '|', '&'];

/** Name of the package manager whose invocations this guard is about. */
const PNPM = 'pnpm';

/** Flags, either spelling, that make a pnpm invocation act on every workspace. */
export const RECURSIVE_FLAGS: readonly string[] = ['--recursive', '-r'];

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
export type FanOutVerdict = 'none' | 'complete' | 'incomplete' | 'undecidable';

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
export function splitInvocations(command: string): string[][] | null {
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
export function withoutEnvironment(tokens: string[]): string[] {
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
export function isRecursivePnpm(tokens: string[]): boolean {
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
export function protectsItsFanOut(tokens: string[]): boolean {
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
export function fanOutVerdict(command: string): FanOutVerdict {
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
