/**
 * Command dispatcher of the bundled runtime (`node /opt/agent-runtime/cli.js <command>`).
 *
 * Layer: adapter.
 *
 * Every process-level dependency arrives as a {@link CliIo} value so the whole dispatcher can be
 * driven from in-memory streams in tests; `bin.ts` is the only place that touches `process`.
 */
import type { GitRunner } from './git.js';
import type { RepositoryUrlPolicy } from './prepare.js';
import type { ProviderFactories } from './provider.js';
import { runTurnCommand } from './turn.js';
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
} as const;

/** Usage text written to stderr when the command line is not understood. */
const USAGE = 'usage: cli.js turn | --version';

/**
 * Seams the `turn` command exposes for tests and for whoever composes the runtime.
 *
 * Production passes none of these: the container's own paths and the real git runner are the
 * defaults, and the OpenAI factory is wired in by the composition that ships it.
 */
export interface CliOverrides {
  /** Factories for providers this build cannot construct on its own. */
  providerFactories?: ProviderFactories;
  /** Overrides the workspace root. */
  workspaceRoot?: string;
  /** Overrides the private runtime directory. */
  runtimeDir?: string;
  /** Overrides the git runner. */
  git?: GitRunner;
  /** Overrides the repository URL policy. */
  urlPolicy?: RepositoryUrlPolicy;
}

/**
 * Runs one command.
 *
 * @param argv - Arguments after the script name.
 * @param io - Process resources.
 * @param overrides - Seams for tests and for the composition that wires a real provider.
 * @returns The process exit code.
 */
export function runCli(
  argv: readonly string[],
  io: CliIo,
  overrides: CliOverrides = {},
): Promise<number> {
  const command = argv[0];
  if (command === '--version' || command === '-v') {
    io.stdout.write(`${RUNTIME_VERSION}\n`);
    return Promise.resolve(EXIT.ok);
  }
  if (command === 'turn') {
    return runTurnCommand({ io, ...overrides });
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
