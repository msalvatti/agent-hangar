/**
 * Unit tests for the container specification builder.
 *
 * Layer: unit.
 * Goal: pin the exact `createContainer` options a workspace gets — the hardening flags, the
 * resource ceilings, the discovery labels and the compose-grouping labels — and prove the builder
 * refuses inputs that would either be rejected by Docker or silently produce an unbounded
 * container, without ever echoing an environment value.
 * Mocks: none (the builder is pure).
 */
import { describe, expect, it } from 'vitest';

import { CANARY_MARKER, GITHUB_CANARY } from '../../testing/canaries.ts';
import type { WorkspaceSpec } from '../types.ts';

import {
  buildContainerCreateOptions,
  buildNetworkCreateOptions,
  LABEL_CHAT,
  LABEL_COMPOSE_PROJECT,
  LABEL_COMPOSE_SERVICE,
  LABEL_JOB_RUN,
  toEnvArray,
  WORKSPACE_HANDOFF_DIR,
} from './container-spec.ts';
import { DockerRunnerError } from './errors.ts';

/** Naming and scoping used by every case. */
const OPTIONS = { namePrefix: 'ah-ws-test-', instance: 'test' };

/**
 * Builds a workspace spec with the fields a case cares about overridden.
 *
 * @param overrides - Fields to replace on the baseline chat spec.
 * @returns A complete spec.
 */
function spec(overrides: Partial<WorkspaceSpec> = {}): WorkspaceSpec {
  return {
    workspaceId: 'ws-1',
    kind: 'CHAT',
    image: 'agent-hangar/workspace:dev',
    env: { AGENT_MODEL_PROVIDER: 'openai' },
    limits: { cpus: 2, memoryBytes: 2_147_483_648, pids: 512 },
    labels: { 'ah.chat': 'chat-1' },
    ...overrides,
  };
}

describe('toEnvArray', () => {
  /**
   * Docker takes the environment as `KEY=VALUE` strings, so a value that itself contains `=` must
   * survive intact — a naive split-and-rejoin would truncate a token at the first separator.
   */
  it('encodes entries as KEY=VALUE and keeps separators inside values', () => {
    expect(toEnvArray({ A: 'b=c', EMPTY: '' })).toEqual(['A=b=c', 'EMPTY=']);
  });

  /**
   * Security boundary: an invalid key must be reported by NAME only. The value here is the GitHub
   * canary, so a message that quoted the pair would leak a credential into an error, a log line
   * and eventually an API response.
   */
  it('rejects an invalid key without echoing its value', () => {
    let message = '';
    try {
      toEnvArray({ 'BAD-KEY': GITHUB_CANARY });
    } catch (error) {
      message = (error as Error).message;
      expect(error).toBeInstanceOf(DockerRunnerError);
    }

    expect(message).toContain('BAD-KEY');
    expect(message).not.toContain(GITHUB_CANARY);
    expect(message).not.toContain(CANARY_MARKER);
  });
});

describe('buildContainerCreateOptions', () => {
  /**
   * The whole security posture of a chat workspace in one assertion: unprivileged user, dropped
   * capabilities, `no-new-privileges`, tmpfs `/tmp`, this instance's own network, the three
   * resource ceilings, and the discovery labels. Any future edit that weakens one of them fails
   * here.
   */
  it('produces the exact hardened options for a CHAT workspace', () => {
    expect(buildContainerCreateOptions(spec(), OPTIONS)).toEqual({
      name: 'ah-ws-test-ws-1',
      Image: 'agent-hangar/workspace:dev',
      Env: ['AGENT_MODEL_PROVIDER=openai'],
      User: 'agent',
      WorkingDir: '/workspace',
      Tty: false,
      OpenStdin: false,
      Labels: {
        'ah.chat': 'chat-1',
        'ah.instance': 'test',
        'ah.workspace': 'ws-1',
        'ah.kind': 'CHAT',
        'com.docker.compose.project': 'agent-hangar-test-ws',
        'com.docker.compose.service': 'chat',
      },
      HostConfig: {
        Memory: 2_147_483_648,
        NanoCpus: 2_000_000_000,
        PidsLimit: 512,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        Tmpfs: { '/tmp': '' },
        NetworkMode: 'ah-ws-test',
        Init: true,
      },
    });
  });

  /**
   * Workspaces of one instance share a network of their own, and that network forbids traffic
   * between the containers on it.
   *
   * Regression: every workspace joined the default `bridge`, where a container reaches any other
   * by address alone. Two chats of the same user ran side by side with nothing between them, and
   * a repository whose task the model was following could scan for the neighbour. The named
   * network keeps the egress each workspace needs -- it clones and calls OpenAI -- while
   * `enable_icc=false` drops packets between its own members.
   */
  it('puts an instance on its own network with traffic between members disabled', () => {
    const network = buildNetworkCreateOptions('test');

    expect(network).toEqual({
      Name: 'ah-ws-test',
      Driver: 'bridge',
      Options: { 'com.docker.network.bridge.enable_icc': 'false' },
      Labels: { 'ah.instance': 'test' },
    });
    expect(buildContainerCreateOptions(spec(), OPTIONS).HostConfig?.NetworkMode).toBe(network.Name);
    expect(buildNetworkCreateOptions('other').Name).not.toBe(network.Name);
  });

  /**
   * A scheduled run carries `ah.jobRun` instead of `ah.chat`, and its kind must reach both the
   * `ah.kind` label (used by GC) and the compose service label (used only for grouping).
   */
  it('produces the labels of a JOB workspace', () => {
    const options = buildContainerCreateOptions(
      spec({ workspaceId: 'ws-2', kind: 'JOB', labels: { 'ah.jobRun': 'run-9' } }),
      OPTIONS,
    );

    expect(options.Labels).toEqual({
      'ah.jobRun': 'run-9',
      'ah.instance': 'test',
      'ah.workspace': 'ws-2',
      'ah.kind': 'JOB',
      'com.docker.compose.project': 'agent-hangar-test-ws',
      'com.docker.compose.service': 'job',
    });
  });

  /**
   * The compose project label exists only so Docker Desktop groups an instance's workspaces; its
   * value must stay in the dedicated `-ws` project. This is the assertion that actually holds the
   * contract — a grep can prove the key exists but not that the value is safe.
   */
  it('scopes the compose project label to a dedicated -ws project', () => {
    const labels = buildContainerCreateOptions(spec(), OPTIONS).Labels ?? {};

    expect(labels[LABEL_COMPOSE_PROJECT]).toMatch(/-ws$/);
    expect(labels[LABEL_COMPOSE_SERVICE]).toBe('chat');
  });

  /**
   * Regression guard for a destructive failure mode: `infra/scripts/archive.sh` runs
   * `docker compose down -v --remove-orphans`, which deletes every container labelled with the
   * stack's compose project that is not in the compose file. If workspaces ever carried
   * `agent-hangar-<instance>`, a routine teardown would destroy live chat containers mid-turn.
   */
  it('never reuses the stack compose project name', () => {
    const labels = buildContainerCreateOptions(spec(), OPTIONS).Labels ?? {};

    expect(labels[LABEL_COMPOSE_PROJECT]).not.toBe(`agent-hangar-${OPTIONS.instance}`);
  });

  /**
   * Discovery and reaping depend on the fixed labels; a caller that supplies `ah.workspace` (by
   * accident or to hide a container from GC) must not be able to override them.
   */
  it('lets the fixed labels win over caller-supplied ones', () => {
    const options = buildContainerCreateOptions(
      spec({ labels: { 'ah.workspace': 'spoofed', 'ah.instance': 'other' } }),
      OPTIONS,
    );

    expect(options.Labels?.['ah.workspace']).toBe('ws-1');
    expect(options.Labels?.['ah.instance']).toBe('test');
  });

  /**
   * Docker expresses the CPU quota in nanoseconds per second, so a fractional `cpus` has to be
   * scaled and rounded rather than truncated. Boundary: 1.5 CPU.
   */
  it('scales fractional cpus into NanoCpus', () => {
    const options = buildContainerCreateOptions(
      spec({ limits: { cpus: 1.5, memoryBytes: 1024, pids: 8 } }),
      OPTIONS,
    );

    expect(options.HostConfig?.NanoCpus).toBe(1_500_000_000);
  });

  /**
   * Isolation invariant: a workspace has no bind mount, no named volume and — critically — no
   * Docker socket, otherwise agent-authored code could create privileged containers on the host.
   */
  it('never mounts anything into the container', () => {
    const options = buildContainerCreateOptions(spec(), OPTIONS);

    expect(options.HostConfig).not.toHaveProperty('Binds');
    expect(options.HostConfig).not.toHaveProperty('Mounts');
    expect(options.HostConfig).not.toHaveProperty('Privileged');
    expect(JSON.stringify(options)).not.toContain('docker.sock');
  });

  /**
   * The id becomes a container name, so anything outside Docker's name charset (or longer than the
   * 64-character segment) has to be rejected before the daemon call.
   */
  it.each([
    ['empty', ''],
    ['leading separator', '-ws'],
    ['path traversal', '../etc'],
    ['shell metacharacter', 'ws;rm'],
    ['too long', 'a'.repeat(65)],
  ])('rejects a workspace id that is %s', (_case, workspaceId) => {
    const build = (): unknown => buildContainerCreateOptions(spec({ workspaceId }), OPTIONS);

    expect(build).toThrow(DockerRunnerError);
    // Naming the id, because a create refused with an empty message tells an operator that
    // something about the workspace was wrong and nothing about what.
    expect(build).toThrow(`invalid workspace id "${workspaceId}"`);
  });

  /**
   * Docker reads a zero or negative ceiling as "unlimited". A typo must therefore fail the create
   * call rather than hand the workspace the whole host.
   */
  it.each([
    ['memoryBytes', { cpus: 1, memoryBytes: 0, pids: 8 }],
    ['pids', { cpus: 1, memoryBytes: 1024, pids: -1 }],
    // Zero, not merely negative: Docker reads a `PidsLimit` of zero as no limit at all, and a
    // check that only refuses negatives hands the workspace every process slot on the host.
    ['zero pids', { cpus: 1, memoryBytes: 1024, pids: 0 }],
  ])('rejects a non-positive %s limit', (_case, limits) => {
    const build = (): unknown => buildContainerCreateOptions(spec({ limits }), OPTIONS);

    expect(build).toThrow(DockerRunnerError);
    expect(build).toThrow(
      'workspace ws-1 must have finite positive cpus, memoryBytes and pids limits',
    );
  });

  /**
   * A cpus limit of zero is refused for being non-positive rather than for what it rounds to. The
   * two refusals have different messages, and the second exists for a limit that is positive and
   * still rounds away — so a reader told the wrong one goes looking for a rounding problem in a
   * value that was never positive.
   */
  it('refuses a zero cpus limit as a non-positive limit', () => {
    const build = (): unknown =>
      buildContainerCreateOptions(
        spec({ limits: { cpus: 0, memoryBytes: 1024, pids: 8 } }),
        OPTIONS,
      );

    expect(build).toThrow(
      'workspace ws-1 must have finite positive cpus, memoryBytes and pids limits',
    );
  });

  /**
   * `NaN` slips through every relational test — `NaN <= 0` is false — and `Infinity` passes a
   * positivity check while meaning "no ceiling". Both serialize to a limit Docker treats as absent,
   * which is the same unbounded workspace the check above exists to prevent.
   */
  it.each([
    ['NaN cpus', { cpus: Number.NaN, memoryBytes: 1024, pids: 8 }],
    ['NaN memoryBytes', { cpus: 1, memoryBytes: Number.NaN, pids: 8 }],
    ['NaN pids', { cpus: 1, memoryBytes: 1024, pids: Number.NaN }],
    ['infinite cpus', { cpus: Number.POSITIVE_INFINITY, memoryBytes: 1024, pids: 8 }],
    ['infinite memoryBytes', { cpus: 1, memoryBytes: Number.POSITIVE_INFINITY, pids: 8 }],
    ['infinite pids', { cpus: 1, memoryBytes: 1024, pids: Number.POSITIVE_INFINITY }],
  ])('rejects a %s limit', (_case, limits) => {
    expect(() => buildContainerCreateOptions(spec({ limits }), OPTIONS)).toThrow(DockerRunnerError);
  });

  /**
   * The ceiling has to survive the conversion, not just the input. A positive `cpus` below one
   * nano-CPU rounds to `NanoCpus: 0`, and zero is exactly how Docker spells "unlimited" — so a
   * value that looks like the tightest possible limit would in fact remove it.
   */
  it('rejects a cpus limit that rounds away to an unlimited NanoCpus', () => {
    expect(() =>
      buildContainerCreateOptions(
        spec({ limits: { cpus: 1e-12, memoryBytes: 1024, pids: 8 } }),
        OPTIONS,
      ),
    ).toThrow(/rounds to an unlimited/);
  });

  /**
   * The environment key check runs through the builder too, and the resulting message must stay
   * free of the credential the value carries.
   */
  it('rejects an invalid environment key without leaking the value', () => {
    let message = '';
    try {
      buildContainerCreateOptions(spec({ env: { '1BAD': GITHUB_CANARY } }), OPTIONS);
    } catch (error) {
      message = (error as Error).message;
      expect(error).toBeInstanceOf(DockerRunnerError);
    }

    expect(message).toContain('1BAD');
    expect(message).not.toContain(CANARY_MARKER);
  });

  /**
   * Three values that only mean something to somebody else. The handoff directory is a path the
   * image creates and the runtime reads; the two caller-set labels are what the reaper and the
   * dashboards select workspaces by. Nothing in this package reads any of them back, so each is
   * pinned to the spelling the other side uses.
   */
  it.each([
    [
      'the handoff directory the image prepares',
      WORKSPACE_HANDOFF_DIR,
      '/opt/agent-runtime/handoff',
    ],
    ['the label a chat workspace is found by', LABEL_CHAT, 'ah.chat'],
    ['the label a scheduled run is found by', LABEL_JOB_RUN, 'ah.jobRun'],
  ])('names %s', (_case, actual, expected) => {
    expect(actual).toBe(expected);
  });
});
