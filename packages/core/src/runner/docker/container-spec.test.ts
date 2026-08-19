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

import { CANARY_MARKER, GITHUB_CANARY } from '../../testing/canaries.js';
import type { WorkspaceSpec } from '../types.js';

import {
  buildContainerCreateOptions,
  LABEL_COMPOSE_PROJECT,
  LABEL_COMPOSE_SERVICE,
  toEnvArray,
} from './container-spec.js';
import { DockerRunnerError } from './errors.js';

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
    env: { GITHUB_TOKEN: GITHUB_CANARY },
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
   * capabilities, `no-new-privileges`, tmpfs `/tmp`, bridge egress, the three resource ceilings,
   * and the discovery labels. Any future edit that weakens one of them fails here.
   */
  it('produces the exact hardened options for a CHAT workspace', () => {
    expect(buildContainerCreateOptions(spec(), OPTIONS)).toEqual({
      name: 'ah-ws-test-ws-1',
      Image: 'agent-hangar/workspace:dev',
      Env: [`GITHUB_TOKEN=${GITHUB_CANARY}`],
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
        NetworkMode: 'bridge',
        Init: true,
      },
    });
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
    expect(() => buildContainerCreateOptions(spec({ workspaceId }), OPTIONS)).toThrow(
      DockerRunnerError,
    );
  });

  /**
   * Docker reads a zero or negative ceiling as "unlimited". A typo must therefore fail the create
   * call rather than hand the workspace the whole host.
   */
  it.each([
    ['cpus', { cpus: 0, memoryBytes: 1024, pids: 8 }],
    ['memoryBytes', { cpus: 1, memoryBytes: 0, pids: 8 }],
    ['pids', { cpus: 1, memoryBytes: 1024, pids: -1 }],
  ])('rejects a non-positive %s limit', (_case, limits) => {
    expect(() => buildContainerCreateOptions(spec({ limits }), OPTIONS)).toThrow(DockerRunnerError);
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
});
