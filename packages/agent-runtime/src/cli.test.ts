/**
 * Unit tests for the command dispatcher.
 *
 * Layer: unit.
 * Goal: `--version` and its alias print the bundled version and exit 0, an unknown or missing
 * command prints usage on stderr and exits 64, and the node-backed `CliIo` exposes the process
 * resources without performing side effects at creation.
 * Mocks: in-memory `Writable` streams stand in for stdout and stderr.
 */
import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createNodeIo, EXIT, runCli } from './cli.js';
import type { CliIo } from './cli.js';
import { RUNTIME_VERSION } from './version.js';

/** Builds a `CliIo` whose streams collect what was written. */
function testIo(): { io: CliIo; stdout: () => string; stderr: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  const sink = (into: string[]): Writable =>
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        into.push(chunk.toString('utf8'));
        callback();
      },
    });
  return {
    io: {
      stdin: (async function* empty(): AsyncIterable<Uint8Array> {
        await Promise.resolve();
      })(),
      stdout: sink(out),
      stderr: sink(err),
      env: {},
      cwd: '/workspace',
      signals: { onSigint: () => () => undefined },
    },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

describe('runCli', () => {
  it.each(['--version', '-v'])('prints the runtime version for %s and exits 0', async (flag) => {
    // CI smoke-tests the image with exactly this command.
    const { io, stdout } = testIo();
    await expect(runCli([flag], io)).resolves.toBe(EXIT.ok);
    expect(stdout()).toBe(`${RUNTIME_VERSION}\n`);
  });

  it('dispatches the turn command and passes the overrides through', async () => {
    // Empty stdin is the shortest path through the turn command; the exit code proves it ran.
    const { io, stdout } = testIo();
    await expect(runCli(['turn'], io, { workspaceRoot: '/nowhere' })).resolves.toBe(
      EXIT.protocolError,
    );
    expect(stdout()).toBe('');
  });

  it.each([['unknown command', ['nope']] as const, ['no arguments', [] as const] as const])(
    'prints usage on stderr and exits 64 for %s',
    async (_name, argv) => {
      // A wrong invocation must not look like a completed turn to the worker.
      const { io, stdout, stderr } = testIo();
      await expect(runCli(argv, io)).resolves.toBe(EXIT.usage);
      expect(stderr()).toBe('usage: cli.js turn | --version\n');
      expect(stdout()).toBe('');
    },
  );
});

describe('createNodeIo', () => {
  it('exposes the process resources and a removable SIGINT registration', () => {
    // Creating the value must not install handlers or read stdin.
    const before = process.listenerCount('SIGINT');
    const io = createNodeIo();
    expect(io.stdout).toBe(process.stdout);
    expect(io.stderr).toBe(process.stderr);
    expect(io.env).toBe(process.env);
    expect(io.cwd).toBe(process.cwd());
    expect(process.listenerCount('SIGINT')).toBe(before);

    const handler = (): void => undefined;
    const unsubscribe = io.signals.onSigint(handler);
    expect(process.listenerCount('SIGINT')).toBe(before + 1);
    unsubscribe();
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});
