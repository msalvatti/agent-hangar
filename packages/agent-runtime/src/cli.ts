/**
 * Command dispatcher of the bundled runtime (`node /opt/agent-runtime/cli.js <command>`).
 *
 * Layer: adapter.
 *
 * Every process-level dependency arrives as a {@link CliIo} value so the whole dispatcher can be
 * driven from in-memory streams in tests; `bin.ts` is the only place that touches `process`.
 */
import { RUNTIME_VERSION } from './version.js';

/** Process resources the runtime needs, injected so tests can supply in-memory equivalents. */
export interface CliIo {
  /** The single `TurnRequest` line arrives here. */
  stdin: AsyncIterable<Uint8Array>;
  /** Protocol events are written here, one JSON object per line. */
  stdout: NodeJS.WritableStream;
  /** Redacted diagnostics. */
  stderr: NodeJS.WritableStream;
  /** Container environment; the only place secrets reach the runtime. */
  env: Readonly<Record<string, string | undefined>>;
  /** Cancellation signalling. */
  signals: {
    /**
     * Registers a SIGINT handler.
     *
     * @param handler - Called when the worker cancels the turn.
     * @returns A function that removes the handler.
     */
    onSigint(handler: () => void): () => void;
  };
  /** Working directory of the process. */
  cwd: string;
}

/**
 * Exit codes of the runtime.
 *
 * A completed turn exits 0 even when the agent's own task failed: the outcome travels in the
 * event stream. Non-zero means the runtime itself could not do its job.
 */
export const EXIT = {
  /** Turn completed, cancelled, or failed in a way the event stream describes. */
  ok: 0,
  /** Unhandled runtime failure. */
  runtimeFailure: 1,
  /** stdin did not carry a valid `TurnRequest`. */
  protocolError: 2,
  /** Unknown or missing command. */
  usage: 64,
  /** Recognised command that this build cannot run yet. */
  notImplemented: 70,
} as const;

/** Usage text written to stderr when the command line is not understood. */
const USAGE = 'usage: cli.js turn | --version';

/**
 * Runs one command.
 *
 * @param argv - Arguments after the script name.
 * @param io - Process resources.
 * @returns The process exit code.
 */
export function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const command = argv[0];
  if (command === '--version' || command === '-v') {
    io.stdout.write(`${RUNTIME_VERSION}\n`);
    return Promise.resolve(EXIT.ok);
  }
  if (command === 'turn') {
    io.stderr.write('turn: not implemented yet\n');
    return Promise.resolve(EXIT.notImplemented);
  }
  io.stderr.write(`${USAGE}\n`);
  return Promise.resolve(EXIT.usage);
}

/**
 * Builds the {@link CliIo} backed by the real process.
 *
 * @returns Process streams, environment, working directory and SIGINT registration.
 */
export function createNodeIo(): CliIo {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: process.cwd(),
    signals: {
      onSigint(handler) {
        process.on('SIGINT', handler);
        return () => {
          process.off('SIGINT', handler);
        };
      },
    },
  };
}
