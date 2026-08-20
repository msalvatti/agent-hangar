/**
 * Production composition of the bundled runtime: the dispatcher with every provider wired in.
 *
 * Layer: composition root.
 *
 * `provider.ts` deliberately never imports the OpenAI SDK, so that the module deciding which
 * provider to build stays free of any code that reads a credential. Somebody still has to hand it
 * the factory, and this is that somebody — the one module that knows both the seam and the
 * implementation.
 *
 * It exists as a module of its own rather than as three lines inside `bin.ts` because `bin.ts` is
 * the process entry point: it owns `process.argv`, a top-level `await` and `process.exitCode`, so
 * it cannot be imported by a test and is excluded from coverage. Wiring done there is wiring no
 * test can see. Here the wiring is ordinary code, tested like any other, and `bin.ts` is left with
 * a call that takes no seam it could forget to fill — `scripts/check-bundle.mjs` runs a turn
 * through the shipped bundle to prove that call still reaches this module.
 */
import { createOpenAIClient, createOpenAIModelProvider } from '@agent-hangar/core';

import { runCli } from './cli.js';
import type { CliIo, CliOverrides } from './cli.js';
import type { ProviderFactories } from './provider.js';

/**
 * The providers a shipped runtime can build.
 *
 * The client is constructed per turn, from the key the worker injected into the container
 * environment: nothing here holds a credential between turns, and the SDK client is the only
 * object that ever sees one.
 */
export const PRODUCTION_PROVIDER_FACTORIES: ProviderFactories = {
  openai: (options) => createOpenAIModelProvider({ client: createOpenAIClient(options) }),
};

/**
 * Runs one command with the production providers wired in.
 *
 * The overrides are the same seams {@link runCli} exposes, and they are applied over the wiring
 * rather than under it, so a test can point the runtime at a local repository or a local endpoint
 * without giving up the real provider it is there to exercise.
 *
 * @param argv - Arguments after the script name.
 * @param io - Process resources.
 * @param overrides - Seams for tests; production supplies none.
 * @returns The process exit code.
 */
export function runProductionCli(
  argv: readonly string[],
  io: CliIo,
  overrides: CliOverrides = {},
): Promise<number> {
  return runCli(argv, io, { providerFactories: PRODUCTION_PROVIDER_FACTORIES, ...overrides });
}
