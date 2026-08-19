/**
 * In-memory `WorkspaceRunner` for tests: scripted execs, per-workspace virtual filesystem,
 * signal support, deterministic snapshots and a call log for assertions.
 *
 * Layer: test double.
 *
 * Deterministic by construction: no real processes, no real timers unless `createDelayMs` is set
 * (tests then use fake timers).
 */
import { setTimeout as sleep } from 'node:timers/promises';

import { systemClock } from '../config/clock.js';
import type { Clock } from '../config/clock.js';
import type {
  ExecEvent,
  ExecSignal,
  ExecSpec,
  WorkspaceHandle,
  WorkspaceHealth,
  WorkspaceRunner,
  WorkspaceSnapshot,
  WorkspaceSpec,
} from '../runner/types.js';

/** A scripted response to an exec whose command matches. */
export interface ExecScript {
  /** Predicate over the exec command. The first matching script wins. */
  match: (cmd: readonly string[]) => boolean;
  /** Events to yield after `started`, or a factory producing them (may be long-running). */
  events: ExecEvent[] | ((spec: ExecSpec, signal: AbortSignal) => AsyncIterable<ExecEvent>);
}

/** Constructor options. */
export interface FakeWorkspaceRunnerOptions {
  scripts?: ExecScript[];
  /** Delay of `create()` in ms; use fake timers when set. */
  createDelayMs?: number;
  clock?: Clock;
}

/** Git state reported by `snapshot()`; override per workspace with `setGitState`. */
export type FakeGitState = WorkspaceSnapshot['git'];

/** Observable state of one fake workspace. */
export interface FakeWorkspaceState {
  handle: WorkspaceHandle;
  spec: WorkspaceSpec;
  files: Map<string, string>;
  status: 'running' | 'gone';
  createdAt: Date;
  git: FakeGitState;
}

/** One recorded call, for assertions. */
export interface RecordedCall {
  method: string;
  args: unknown[];
}

const encoder = new TextEncoder();

async function collectStdin(stdin: ExecSpec['stdin']): Promise<Uint8Array[]> {
  if (stdin === undefined) {
    return [];
  }
  if (typeof stdin === 'string') {
    return [encoder.encode(stdin)];
  }
  if (stdin instanceof Uint8Array) {
    return [stdin];
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of stdin) {
    chunks.push(chunk);
  }
  return chunks;
}

/** Default behaviour: echo stdin to stdout and exit 0. */
async function* echoScript(spec: ExecSpec): AsyncIterable<ExecEvent> {
  for (const chunk of await collectStdin(spec.stdin)) {
    yield { type: 'stdout', data: chunk };
  }
  yield { type: 'exit', code: 0 };
}

function onAbort(signal: AbortSignal): Promise<'aborted'> {
  return new Promise((resolve) => {
    signal.addEventListener(
      'abort',
      () => {
        resolve('aborted');
      },
      { once: true },
    );
  });
}

/** Fake runner; `kind` is `"fake"`. */
export class FakeWorkspaceRunner implements WorkspaceRunner {
  readonly kind = 'fake';
  /** Every method call in order, for assertions. */
  readonly calls: RecordedCall[] = [];

  private readonly scripts: ExecScript[];
  private readonly createDelayMs: number;
  private readonly clock: Clock;
  private readonly workspaces = new Map<string, FakeWorkspaceState>();
  private readonly execs = new Map<string, { controller: AbortController; signal?: ExecSignal }>();
  private sequence = 0;

  constructor(options: FakeWorkspaceRunnerOptions = {}) {
    this.scripts = options.scripts ?? [];
    this.createDelayMs = options.createDelayMs ?? 0;
    this.clock = options.clock ?? systemClock;
  }

  /** Creates a running workspace; rejects when `opts.signal` aborts during the create delay. */
  async create(spec: WorkspaceSpec, opts: { signal?: AbortSignal } = {}): Promise<WorkspaceHandle> {
    this.calls.push({ method: 'create', args: [spec, opts] });
    if (this.createDelayMs > 0) {
      await sleep(this.createDelayMs, undefined, { signal: opts.signal });
    }
    const handle: WorkspaceHandle = {
      workspaceId: spec.workspaceId,
      runnerRef: `fake-${String(++this.sequence)}`,
    };
    this.workspaces.set(spec.workspaceId, {
      handle,
      spec,
      files: new Map(),
      status: 'running',
      createdAt: this.clock.now(),
      git: { branch: null, headSha: null, dirty: false, ahead: 0, behind: 0 },
    });
    return handle;
  }

  /** Yields `started`, then the matching script's events (default: echo stdin), then `exit`. */
  async *exec(handle: WorkspaceHandle, spec: ExecSpec): AsyncIterable<ExecEvent> {
    this.calls.push({ method: 'exec', args: [handle, spec] });
    const state = this.requireRunning(handle);
    const execRef = `${state.handle.runnerRef}-exec-${String(++this.sequence)}`;
    const controller = new AbortController();
    this.execs.set(execRef, { controller });
    yield { type: 'started', execRef };

    const script = this.scripts.find((candidate) => candidate.match(spec.cmd));
    const source =
      script === undefined
        ? echoScript(spec)
        : Array.isArray(script.events)
          ? script.events
          : script.events(spec, controller.signal);
    yield* this.pump(source, execRef, controller, spec.signal);
    this.execs.delete(execRef);
  }

  /** Aborts the in-flight exec; the exec stream then ends with `exit { code: null, signal }`. */
  async signal(handle: WorkspaceHandle, execRef: string, sig: ExecSignal): Promise<void> {
    this.calls.push({ method: 'signal', args: [handle, execRef, sig] });
    const entry = this.execs.get(execRef);
    if (entry !== undefined) {
      entry.signal = sig;
      entry.controller.abort();
    }
    await Promise.resolve();
  }

  /** Deterministic snapshot: git state set via `setGitState`, summary from the virtual files. */
  async snapshot(handle: WorkspaceHandle): Promise<WorkspaceSnapshot> {
    this.calls.push({ method: 'snapshot', args: [handle] });
    const state = this.requireRunning(handle);
    const lines = [...state.files.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, content]) => `${path} (${String(encoder.encode(content).byteLength)} bytes)`);
    await Promise.resolve();
    return {
      takenAt: this.clock.now(),
      git: { ...state.git, dirty: state.git.dirty || state.files.size > 0 },
      summary: lines.join('\n'),
    };
  }

  /** Marks the workspace gone and drops its files. Idempotent; unknown handles are ignored. */
  async destroy(handle: WorkspaceHandle): Promise<void> {
    this.calls.push({ method: 'destroy', args: [handle] });
    const state = this.workspaces.get(handle.workspaceId);
    if (state !== undefined) {
      state.status = 'gone';
      state.files.clear();
    }
    await Promise.resolve();
  }

  /** `healthy` with uptime from the clock while running; `gone` after destroy or if unknown. */
  async health(handle: WorkspaceHandle): Promise<WorkspaceHealth> {
    this.calls.push({ method: 'health', args: [handle] });
    const state = this.workspaces.get(handle.workspaceId);
    await Promise.resolve();
    if (state === undefined || state.status === 'gone') {
      return { status: 'gone' };
    }
    return { status: 'healthy', uptimeMs: this.clock.now().getTime() - state.createdAt.getTime() };
  }

  /** Running workspaces whose labels contain every given label (subset match). */
  async list(labels: Readonly<Record<string, string>>): Promise<WorkspaceHandle[]> {
    this.calls.push({ method: 'list', args: [labels] });
    await Promise.resolve();
    return [...this.workspaces.values()]
      .filter((state) => state.status === 'running')
      .filter((state) =>
        Object.entries(labels).every(([key, value]) => state.spec.labels[key] === value),
      )
      .map((state) => state.handle);
  }

  /** Observable state of a workspace, or `undefined` when never created. */
  getWorkspace(workspaceId: string): FakeWorkspaceState | undefined {
    return this.workspaces.get(workspaceId);
  }

  /** Writes a file into the virtual filesystem of a workspace. */
  writeFile(workspaceId: string, path: string, content: string): void {
    this.requireKnown(workspaceId).files.set(path, content);
  }

  /** Reads a file from the virtual filesystem, or `undefined` when absent. */
  readFile(workspaceId: string, path: string): string | undefined {
    return this.requireKnown(workspaceId).files.get(path);
  }

  /** Overrides the git state reported by `snapshot()`. */
  setGitState(workspaceId: string, git: Partial<FakeGitState>): void {
    const state = this.requireKnown(workspaceId);
    state.git = { ...state.git, ...git };
  }

  private requireKnown(workspaceId: string): FakeWorkspaceState {
    const state = this.workspaces.get(workspaceId);
    if (state === undefined) {
      throw new Error(`FakeWorkspaceRunner: unknown workspace ${workspaceId}`);
    }
    return state;
  }

  private requireRunning(handle: WorkspaceHandle): FakeWorkspaceState {
    const state = this.requireKnown(handle.workspaceId);
    if (state.status === 'gone') {
      throw new Error(`FakeWorkspaceRunner: workspace ${handle.workspaceId} is gone`);
    }
    return state;
  }

  private async *pump(
    source: Iterable<ExecEvent> | AsyncIterable<ExecEvent>,
    execRef: string,
    controller: AbortController,
    external: AbortSignal | undefined,
  ): AsyncIterable<ExecEvent> {
    external?.addEventListener(
      'abort',
      () => {
        controller.abort();
      },
      { once: true },
    );
    if (external?.aborted === true) {
      controller.abort();
    }
    const aborted = onAbort(controller.signal);
    const iterator =
      Symbol.asyncIterator in source ? source[Symbol.asyncIterator]() : source[Symbol.iterator]();
    try {
      for (;;) {
        const next = await Promise.race([Promise.resolve(iterator.next()), aborted]);
        if (next === 'aborted' || controller.signal.aborted) {
          yield { type: 'exit', code: null, signal: this.execs.get(execRef)?.signal ?? 'ABORT' };
          return;
        }
        if (next.done === true) {
          return;
        }
        yield next.value;
      }
    } finally {
      // Not awaited: an async generator suspended in an `await` only honours `return()` after
      // that await settles, which a long-running script may never do unless it watches `signal`.
      const closing = iterator.return?.();
      if (closing instanceof Promise) {
        closing.catch(() => undefined);
      }
    }
  }
}
