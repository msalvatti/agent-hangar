/**
 * Process entry point of the bundled runtime; the only module that touches `process` directly.
 *
 * Layer: entry point.
 *
 * Nothing is composed here. `composition.ts` owns the wiring and exposes it as a call that takes
 * only the process resources, so this file has no seam it could be left holding empty — which is
 * exactly how the OpenAI provider once shipped unwired.
 */
import { createNodeIo } from './cli.js';
import { runProductionCli } from './composition.js';

process.exitCode = await runProductionCli(process.argv.slice(2), createNodeIo());
