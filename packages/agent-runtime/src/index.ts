// Public API of @agent-hangar/agent-runtime: the command dispatcher, the protocol adapters and
// the runtime redactor. `bin.ts` is the process entry point and is deliberately not re-exported.
export { createNodeIo, EXIT, runCli } from './cli.js';
export type { CliIo } from './cli.js';
export { createDiagnostics, createEventWriter, readTurnRequest } from './protocol.js';
export type { EventWriter } from './protocol.js';
export { createRuntimeRedactor, REDACTED } from './redact.js';
export type { RuntimeRedactor, RuntimeRedactorOptions } from './redact.js';
export { RUNTIME_VERSION } from './version.js';
