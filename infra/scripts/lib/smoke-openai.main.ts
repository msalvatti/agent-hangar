/**
 * Real process wiring for {@link runSmoke}: parses argv, runs the check and exits with its code.
 *
 * Layer: entry point. Excluded from coverage — see the root `vitest.config.ts` comment.
 */
import { parseFlags } from './cli-args.js';
import { EXIT_PRECONDITION, resolveOptions, SMOKE_FLAGS, USAGE } from './smoke-openai-options.js';
import type { SmokeOptions } from './smoke-openai-options.js';
import { runSmoke } from './smoke-openai.js';

let options: SmokeOptions;
try {
  options = resolveOptions(
    parseFlags(process.argv.slice(2), { allowed: SMOKE_FLAGS }),
    process.env,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : 'invalid arguments');
  console.error(USAGE);
  process.exit(EXIT_PRECONDITION);
}

const result = await runSmoke(options, {
  fetch: (input, init) => fetch(input, init),
  now: Date.now,
  log: (line) => {
    console.log(line);
  },
});
process.exit(result.exitCode);
