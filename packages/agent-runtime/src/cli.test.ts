/**
 * Unit tests for the command dispatcher.
 *
 * Layer: unit.
 * Goal: `--version` and its alias print the bundled version and exit 0, an unknown or missing
 * command prints usage on stderr and exits 64, none of those commands builds a model provider on
 * the way, and the node-backed `CliIo` exposes the process resources without performing side
 * effects at creation.
 * Mocks: in-memory `Writable` streams stand in for stdout and stderr, and provider factories that
 * refuse to build stand in for the wiring a real build supplies.
 */
import { Writable } from 'node:stream';

import { describe, expect, expectTypeOf, it } from 'vitest';

import { createNodeIo, EXIT, runCli } from './cli.js';
import type { CliDeps, CliIo, CliOverrides } from './cli.js';
import type { ProviderFactories } from './provider.js';
import { CREDENTIALS_FAILURE_CODE } from './turn.js';
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

/**
 * Wiring the commands in this suite must never reach.
 *
 * The dispatcher takes the provider wiring whatever the command turns out to be, so every case
 * here has to supply it — and none of them may use it: `--version` and an unknown command answer
 * without a model, and the `turn` case stops on a protocol error before a provider is built.
 * Counting the calls states that instead of assuming it, and refusing to build one keeps an
 * unexpected call from passing as an ordinary run.
 *
 * @returns The factories to pass, and how many times one of them was called.
 */
function unreachedFactories(): { factories: ProviderFactories; calls: () => number } {
  let calls = 0;
  return {
    factories: {
      openai: () => {
        calls += 1;
        throw new Error('this command must answer without building a provider');
      },
    },
    calls: () => calls,
  };
}

describe('runCli', () => {
  /**
   * CI smoke-tests the image with exactly this command, and it must answer from the bundle alone:
   * reading a version is not a reason to construct anything that reads a credential.
   */
  it.each(['--version', '-v'])('prints the runtime version for %s and exits 0', async (flag) => {
    const { io, stdout } = testIo();
    const { factories, calls } = unreachedFactories();
    await expect(runCli([flag], io, { providerFactories: factories })).resolves.toBe(EXIT.ok);
    expect(stdout()).toBe(`${RUNTIME_VERSION}\n`);
    expect(calls()).toBe(0);
  });

  /**
   * A turn with no credentials placed for it is the shortest path through the turn command: it is
   * the first thing that command does, before stdin is read and long before a provider is built,
   * which is what lets the wiring here refuse to build one. The exit code and the event prove the
   * dispatch reached it.
   */
  it('dispatches the turn command and passes the overrides through', async () => {
    const { io, stdout } = testIo();
    const { factories, calls } = unreachedFactories();
    await expect(
      runCli(['turn'], io, { providerFactories: factories, workspaceRoot: '/nowhere' }),
    ).resolves.toBe(EXIT.runtimeFailure);
    const event: unknown = JSON.parse(stdout());
    expect(event).toMatchObject({ type: 'turn.failed', error: { code: CREDENTIALS_FAILURE_CODE } });
    expect(stdout()).toContain('credentials.json');
    expect(calls()).toBe(0);
  });

  /**
   * A wrong invocation must not look like a completed turn to the worker, and must not build
   * anything on its way to saying so.
   */
  it.each([['unknown command', ['nope']] as const, ['no arguments', [] as const] as const])(
    'prints usage on stderr and exits 64 for %s',
    async (_name, argv) => {
      const { io, stdout, stderr } = testIo();
      const { factories, calls } = unreachedFactories();
      await expect(runCli(argv, io, { providerFactories: factories })).resolves.toBe(EXIT.usage);
      expect(stderr()).toBe('usage: cli.js turn | --version\n');
      expect(stdout()).toBe('');
      expect(calls()).toBe(0);
    },
  );
});

describe('what runCli asks to be given', () => {
  /**
   * The defect this closes was a seam that compiled while empty: an entry point that wired no
   * provider type-checked, shipped, and failed on the operator's first real turn. The seams a
   * caller may replace and the wiring a build must supply are now separate types, so leaving the
   * wiring out is a compile error rather than a run-time surprise. These assertions are checked by
   * the compiler, not at run time: they are what stops the field going back to optional.
   */
  it('will not accept the overrides alone, without the provider wiring', () => {
    expectTypeOf<CliOverrides>().not.toExtend<CliDeps>();
    expectTypeOf<CliDeps>().toExtend<CliOverrides>();
  });
});

describe('createNodeIo', () => {
  /** Creating the value must not install handlers or read stdin. */
  it('exposes the process resources and a removable SIGINT registration', () => {
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
