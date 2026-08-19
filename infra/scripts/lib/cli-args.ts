/**
 * Minimal `--flag [value]` parser shared by the infra node helpers.
 *
 * Layer: utility (pure).
 *
 * Kept dependency-free on purpose: the helpers run through `tsx` with no package manifest of
 * their own, so pulling in a CLI-parsing library would be a new dependency for a few lines of
 * logic. A bare word (not starting with `--`) is never valid here — every helper is invoked with
 * flags only, so a stray positional argument is a usage error, not something to guess about.
 */

/** One parsed flag's value: the following word, or `true` when it has none. */
export type FlagValue = string | true;

/** Options accepted by {@link parseFlags}. */
export interface ParseFlagsOptions {
  /** Flag names (without the leading `--`) this invocation accepts. */
  allowed: readonly string[];
}

/**
 * Parses `argv` into a flag map, rejecting anything not in `options.allowed`.
 *
 * A flag takes the following word as its value unless that word is itself a flag (starts with
 * `--`) or is absent, in which case the flag's value is `true`.
 *
 * @param argv - Arguments after the script name (`process.argv.slice(2)`).
 * @param options - The flags this invocation accepts.
 * @returns One entry per flag encountered.
 * @throws Error naming the first unrecognised token — an unexpected positional argument, or a
 * flag outside `options.allowed`.
 */
export function parseFlags(
  argv: readonly string[],
  options: ParseFlagsOptions,
): Record<string, FlagValue> {
  const result: Record<string, FlagValue> = {};
  // A queue (rather than an index) so `token` narrows to `string` for the whole loop body: an
  // index-based `argv[index]` stays `string | undefined` to the type checker even under a
  // `while (index < argv.length)` guard, which `noUncheckedIndexedAccess` cannot see through.
  const queue = [...argv];
  let token = queue.shift();
  while (token !== undefined) {
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const name = token.slice(2);
    if (!options.allowed.includes(name)) {
      throw new Error(`Unknown flag: --${name}`);
    }
    const next = queue[0];
    if (next !== undefined && !next.startsWith('--')) {
      result[name] = next;
      queue.shift();
    } else {
      result[name] = true;
    }
    token = queue.shift();
  }
  return result;
}
