/**
 * Shared fixture for the {@link DockerWorkspaceRunner} unit suites.
 *
 * Layer: test double.
 *
 * Wires the runner against {@link FakeDockerApi} with everything non-deterministic replaced: a
 * fake clock, an exec reference that never changes, and a no-op delay so the readiness back-off
 * costs no wall-clock time. The workspace environment carries the GitHub canary,
 * so any suite built on this fixture also asserts, by construction, that the credential never
 * escapes into an error or a serialisation.
 *
 * Not exported from the folder's public barrel: suites import it by relative path.
 */
import { GITHUB_CANARY } from '../../../testing/canaries.ts';
import { FakeClock } from '../../../testing/fake-clock.ts';
import type { ExecEvent, WorkspaceHandle, WorkspaceSpec } from '../../types.ts';
import { DockerWorkspaceRunner } from '../docker-workspace-runner.ts';

import { FakeDockerApi } from './fake-docker-api.ts';
import type { FakeExecScript } from './fake-docker-api.ts';

/** Image the fake daemon knows about and every spec refers to. */
export const FIXTURE_IMAGE = 'agent-hangar/workspace:dev';

/** Instance the fixture's runner is scoped to. */
export const FIXTURE_INSTANCE = 'test';

/** Container name prefix of the fixture's runner. */
export const FIXTURE_NAME_PREFIX = 'ah-ws-test-';

/** Exec reference the injected id source returns, so wrapper commands are assertable verbatim. */
export const FIXTURE_EXEC_REF = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const decoder = new TextDecoder();

/** A runner wired to an inspectable fake daemon and a controllable clock. */
export interface RunnerFixture {
  /** The runner under test. */
  runner: DockerWorkspaceRunner;
  /** The daemon it drives; carries the call log and the failure injection points. */
  docker: FakeDockerApi;
  /** The clock behind snapshot timestamps and uptime. */
  clock: FakeClock;
}

/** Everything one drained exec produced. */
export interface DrainedExec {
  /** Event kinds in the order they were yielded. */
  kinds: string[];
  /** Decoded stdout. */
  stdout: string;
  /** Decoded stderr. */
  stderr: string;
  /** The terminal event, or `undefined` if the stream ended without one. */
  exit: ExecEvent | undefined;
}

/**
 * Builds a workspace spec.
 *
 * The environment carries a canary under an ordinary name. No credential travels this way any
 * more — they are placed per execution as {@link WorkspaceSpec.files} — but the runner must still
 * never echo an environment value into an error or a serialisation, because the operator's own
 * configuration is in it and the daemon is handed the whole map. A canary is simply the value a
 * leak assertion can recognise.
 *
 * @param overrides - Fields to replace on the baseline chat spec.
 * @returns A complete spec.
 */
export function fixtureSpec(overrides: Partial<WorkspaceSpec> = {}): WorkspaceSpec {
  return {
    workspaceId: 'ws-1',
    kind: 'CHAT',
    image: FIXTURE_IMAGE,
    env: { AH_FIXTURE_VALUE: GITHUB_CANARY },
    limits: { cpus: 1, memoryBytes: 536_870_912, pids: 256 },
    labels: { 'ah.chat': 'chat-1' },
    ...overrides,
  };
}

/**
 * Builds a runner over a fake daemon that already knows the workspace image.
 *
 * @param options - Exec scripts the daemon replays and a readiness budget override.
 * @returns The runner, the fake daemon and the clock.
 */
export function makeRunnerFixture(
  options: {
    execScripts?: FakeExecScript[];
    readiness?: { attempts: number; delayMs: number };
  } = {},
): RunnerFixture {
  const docker = new FakeDockerApi({
    images: [FIXTURE_IMAGE],
    execScripts: options.execScripts ?? [],
  });
  const clock = new FakeClock();
  const runner = new DockerWorkspaceRunner({
    docker,
    instance: FIXTURE_INSTANCE,
    namePrefix: FIXTURE_NAME_PREFIX,
    clock,
    readiness: options.readiness ?? { attempts: 3, delayMs: 1 },
    // No delay: the readiness back-off is never what a unit test is about.
    sleep: async () => Promise.resolve(),
    randomUUID: () => FIXTURE_EXEC_REF,
  });
  return { runner, docker, clock };
}

/**
 * Drains an exec into its parts.
 *
 * @param events - The exec's event stream.
 * @returns Event kinds in order, decoded output, and the terminal event.
 */
export async function drainExec(events: AsyncIterable<ExecEvent>): Promise<DrainedExec> {
  const kinds: string[] = [];
  let stdout = '';
  let stderr = '';
  let exit: ExecEvent | undefined;

  for await (const event of events) {
    kinds.push(event.type);
    if (event.type === 'stdout') {
      stdout += decoder.decode(event.data);
    }
    if (event.type === 'stderr') {
      stderr += decoder.decode(event.data);
    }
    if (event.type === 'exit') {
      exit = event;
    }
  }

  return { kinds, stdout, stderr, exit };
}

/**
 * Creates a ready workspace from the baseline spec.
 *
 * @param runner - Runner to create through.
 * @param overrides - Fields to replace on the baseline chat spec.
 * @returns The handle of the created workspace.
 */
export async function createFixtureWorkspace(
  runner: DockerWorkspaceRunner,
  overrides: Partial<WorkspaceSpec> = {},
): Promise<WorkspaceHandle> {
  return runner.create(fixtureSpec(overrides));
}
