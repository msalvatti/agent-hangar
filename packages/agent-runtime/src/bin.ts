/**
 * Process entry point of the bundled runtime; the only module that touches `process` directly.
 *
 * Layer: entry point.
 */
import { createNodeIo, runCli } from './cli.js';

process.exitCode = await runCli(process.argv.slice(2), createNodeIo());
