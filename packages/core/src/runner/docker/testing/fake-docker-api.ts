/**
 * In-memory Docker API for the runner's unit tests.
 *
 * Layer: test double.
 *
 * Implements the same {@link DockerApi} surface the real dockerode client satisfies, including the
 * hijacked exec stream in Docker's multiplexed frame format, so the runner under test exercises its
 * real parsing and termination code. Scripted execs and injectable per-operation failures make the
 * daemon's error statuses (404, 304, 409) reproducible without a daemon.
 *
 * Not exported from the folder's public barrel: tests import it by relative path so no production
 * bundle can pull it in.
 */
import { Duplex } from 'node:stream';

import type Dockerode from 'dockerode';

import type {
  DockerApi,
  DockerContainerApi,
  DockerExecApi,
  DockerExecCreateOptions,
  DockerExecStartOptions,
  DockerExecStream,
} from '../docker-api.js';

/** Bytes of the Docker stream frame header. */
const FRAME_HEADER_BYTES = 8;

/** Docker stream type byte for stdout. */
const STDOUT_TYPE = 1;

/** Docker stream type byte for stderr. */
const STDERR_TYPE = 2;

/** HTTP status used for "no such container / image". */
const NOT_FOUND = 404;

/** HTTP status used for "name already in use". */
const CONFLICT = 409;

/** How one scripted exec behaves. */
export interface FakeExecScript {
  /** Selects the commands this script answers. */
  match: (cmd: string[]) => boolean;
  /** Text emitted on stdout. */
  stdout?: string;
  /** Text emitted on stderr. */
  stderr?: string;
  /** Exit code reported by `inspect`; defaults to 0. */
  exitCode?: number | null;
  /** When true the stream never ends, so timeout and abort paths can run. */
  hang?: boolean;
  /** When true `start` rejects, simulating a daemon that refuses the exec. */
  failStart?: boolean;
}

/** Per-operation failures a test can inject; each is thrown by the matching call. */
export interface FakeDockerFailures {
  /** Thrown by `getImage(...).inspect()`. */
  imageInspect?: Error | undefined;
  /** Thrown by `createContainer`. */
  createContainer?: Error | undefined;
  /** Thrown by `container.stop`. */
  containerStop?: Error | undefined;
  /** Thrown by `container.remove`. */
  containerRemove?: Error | undefined;
  /** Thrown by `container.inspect`. */
  containerInspect?: Error | undefined;
  /** Thrown by `container.exec`. */
  containerExec?: Error | undefined;
  /** Thrown by `container.kill`. */
  containerKill?: Error | undefined;
}

/** State the fake keeps per created container. */
export interface FakeContainerRecord {
  /** Options the runner passed to `createContainer`. */
  options: Dockerode.ContainerCreateOptions;
  /** Whether `start` has been called and `kill`/`stop` has not. */
  running: boolean;
  /** Value reported as `State.StartedAt`. */
  startedAt: string;
  /** Value reported as `State.OOMKilled`. */
  oomKilled: boolean;
  /** Value reported as `State.ExitCode`; absent while the container has never stopped. */
  exitCode?: number | undefined;
  /** Every command passed to `container.exec`, in order. */
  execCommands: string[][];
}

/** Construction inputs of {@link FakeDockerApi}. */
export interface FakeDockerApiOptions {
  /** Image references the daemon knows about. */
  images?: readonly string[];
  /** Scripts consulted in order for every exec. */
  execScripts?: readonly FakeExecScript[];
}

/**
 * Builds a daemon-style rejection.
 *
 * @param statusCode - HTTP status dockerode would attach.
 * @param message - Error message.
 * @returns An error carrying `statusCode`, as dockerode's do.
 */
export function dockerError(statusCode: number, message = 'docker error'): Error {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * Encodes text as one Docker stream frame.
 *
 * @param type - Stream type byte.
 * @param payload - Text payload.
 * @returns Header plus payload.
 */
function frame(type: number, payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

/**
 * The hijacked duplex a real exec returns.
 *
 * Modelled as a half-open duplex on purpose: closing stdin (which the runner always does) must not
 * end the output side, exactly as a real Docker connection behaves. A plain `PassThrough` would
 * conflate the two halves and make every exec look like it finished the moment stdin closed.
 */
class FakeHijackedStream extends Duplex {
  readonly #stdinWrites: string[];

  /**
   * @param stdinWrites - Collector the written stdin is decoded into.
   */
  constructor(stdinWrites: string[]) {
    super({ allowHalfOpen: true });
    this.#stdinWrites = stdinWrites;
  }

  /** Output is pushed by the exec script, not pulled. */
  override _read(): void {
    // Intentionally empty: frames are pushed eagerly when the exec starts.
  }

  /**
   * Records what the runner wrote to stdin.
   *
   * @param chunk - Bytes written.
   * @param _encoding - Unused; the runner always writes bytes.
   * @param callback - Completion callback.
   */
  override _write(
    chunk: Uint8Array,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#stdinWrites.push(Buffer.from(chunk).toString('utf8'));
    callback();
  }
}

/** Behaviour of a scripted exec, without the selector that chose it. */
type ScriptedBehaviour = Omit<FakeExecScript, 'match'>;

/** A scripted exec instance. */
class FakeExec implements DockerExecApi {
  readonly #script: ScriptedBehaviour;
  readonly #stdinWrites: string[];

  /**
   * @param script - Behaviour this exec replays; an empty object means "exit 0, no output".
   * @param stdinWrites - Collector the written stdin is decoded into.
   */
  constructor(script: ScriptedBehaviour, stdinWrites: string[]) {
    this.#script = script;
    this.#stdinWrites = stdinWrites;
  }

  /**
   * Starts the exec and returns a stream carrying the scripted output.
   *
   * @param opts - Hijack and stdin flags, recorded but not otherwise used.
   * @returns The hijacked stream.
   */
  async start(opts: DockerExecStartOptions): Promise<DockerExecStream> {
    if (this.#script.failStart === true) {
      throw dockerError(500, `exec start refused (stdin=${String(opts.stdin)})`);
    }
    const stream = new FakeHijackedStream(this.#stdinWrites);
    if (this.#script.stdout !== undefined) {
      stream.push(frame(STDOUT_TYPE, this.#script.stdout));
    }
    if (this.#script.stderr !== undefined) {
      stream.push(frame(STDERR_TYPE, this.#script.stderr));
    }
    if (this.#script.hang !== true) {
      stream.push(null);
    }
    return Promise.resolve(stream);
  }

  /**
   * Reports the scripted exit status.
   *
   * @returns Exit code and running flag.
   */
  inspect(): Promise<{ ExitCode: number | null; Running: boolean }> {
    return Promise.resolve({ ExitCode: this.#script.exitCode ?? 0, Running: false });
  }
}

/** A container handle backed by the fake's record map. */
class FakeContainer implements DockerContainerApi {
  readonly #api: FakeDockerApi;

  /** Container id assigned by the fake. */
  readonly id: string;

  /**
   * @param api - Owning fake, consulted for records, scripts and injected failures.
   * @param id - Container id this handle refers to.
   */
  constructor(api: FakeDockerApi, id: string) {
    this.#api = api;
    this.id = id;
  }

  /**
   * Marks the container as running.
   *
   * @returns Resolves once started.
   */
  async start(): Promise<unknown> {
    this.#record().running = true;
    return Promise.resolve(undefined);
  }

  /**
   * Stops the container.
   *
   * @param opts - Grace period, recorded in the call log.
   * @returns Resolves once stopped.
   */
  async stop(opts: { t: number }): Promise<unknown> {
    const record = this.#record();
    this.#api.calls.push(`stop:${this.id}:t=${String(opts.t)}`);
    this.#throwIf(this.#api.failures.containerStop);
    record.running = false;
    return Promise.resolve(undefined);
  }

  /**
   * Removes the container from the fake's map.
   *
   * @param opts - Volume and force flags, recorded in the call log.
   * @returns Resolves once removed.
   */
  async remove(opts: { v: boolean; force: boolean }): Promise<unknown> {
    this.#record();
    this.#api.calls.push(`remove:${this.id}:v=${String(opts.v)}:force=${String(opts.force)}`);
    this.#throwIf(this.#api.failures.containerRemove);
    this.#api.containers.delete(this.id);
    return Promise.resolve(undefined);
  }

  /**
   * Kills the container's main process.
   *
   * @returns Resolves once killed.
   */
  async kill(): Promise<unknown> {
    const record = this.#record();
    this.#api.calls.push(`kill:${this.id}`);
    this.#throwIf(this.#api.failures.containerKill);
    record.running = false;
    return Promise.resolve(undefined);
  }

  /**
   * Reports the container's identity, state and labels.
   *
   * @returns The inspect payload the runner reads.
   */
  async inspect(): Promise<{
    Id: string;
    State: {
      Status: string;
      Running: boolean;
      StartedAt: string;
      OOMKilled?: boolean | undefined;
      ExitCode?: number | undefined;
    };
    Config: { Labels: Record<string, string> };
  }> {
    const record = this.#record();
    this.#throwIf(this.#api.failures.containerInspect);
    return Promise.resolve({
      Id: this.id,
      State: {
        Status: record.running ? 'running' : 'exited',
        Running: record.running,
        StartedAt: record.startedAt,
        OOMKilled: record.oomKilled,
        ExitCode: record.exitCode,
      },
      Config: { Labels: record.options.Labels ?? {} },
    });
  }

  /**
   * Creates a scripted exec.
   *
   * @param opts - Exec options; the command is recorded and matched against the scripts.
   * @returns The scripted exec instance.
   */
  async exec(opts: DockerExecCreateOptions): Promise<DockerExecApi> {
    const record = this.#record();
    this.#api.calls.push(`exec:${this.id}:${opts.Cmd.join(' ')}`);
    this.#throwIf(this.#api.failures.containerExec);
    record.execCommands.push(opts.Cmd);
    this.#api.execOptions.push(opts);
    const script = this.#api.execScripts.find((candidate) => candidate.match(opts.Cmd));
    return Promise.resolve(new FakeExec(script ?? {}, this.#api.stdinWrites));
  }

  /**
   * Looks the record up, failing like the daemon would when it is gone.
   *
   * @returns The container record.
   */
  #record(): FakeContainerRecord {
    const record = this.#api.containers.get(this.id);
    if (record === undefined) {
      throw dockerError(NOT_FOUND, `no such container: ${this.id}`);
    }
    return record;
  }

  /**
   * Rethrows an injected failure when the test configured one.
   *
   * @param failure - The configured failure, if any.
   */
  #throwIf(failure: Error | undefined): void {
    if (failure !== undefined) {
      throw failure;
    }
  }
}

/** An in-memory stand-in for the Docker daemon. */
export class FakeDockerApi implements DockerApi {
  /** Image references the daemon knows about. */
  readonly images: Set<string>;

  /** Created containers, keyed by the id the fake assigned. */
  readonly containers = new Map<string, FakeContainerRecord>();

  /** Every daemon call, in order, for assertions. */
  readonly calls: string[] = [];

  /** Every exec option object the runner passed, in order. */
  readonly execOptions: DockerExecCreateOptions[] = [];

  /** Everything the runner wrote to an exec's stdin, decoded as UTF-8. */
  readonly stdinWrites: string[] = [];

  /** Scripts consulted in order for each exec; mutable so a test can change behaviour mid-run. */
  execScripts: FakeExecScript[];

  /** Per-operation failures; assign one to make the matching call reject. */
  readonly failures: FakeDockerFailures = {};

  #nextId = 1;

  /**
   * @param options - Known images and exec scripts.
   */
  constructor(options: FakeDockerApiOptions = {}) {
    this.images = new Set(options.images ?? []);
    this.execScripts = [...(options.execScripts ?? [])];
  }

  /**
   * References an image.
   *
   * @param name - Image reference.
   * @returns A handle whose `inspect` fails with 404 for an unknown image.
   */
  getImage(name: string): { inspect(): Promise<unknown> } {
    return {
      inspect: async (): Promise<unknown> => {
        this.calls.push(`getImage:${name}`);
        if (this.failures.imageInspect !== undefined) {
          throw this.failures.imageInspect;
        }
        if (!this.images.has(name)) {
          throw dockerError(NOT_FOUND, `no such image: ${name}`);
        }
        return Promise.resolve({ Id: `sha256:${name}` });
      },
    };
  }

  /**
   * Creates a container.
   *
   * @param opts - Create options from the runner.
   * @returns A handle to the created container.
   */
  async createContainer(opts: Dockerode.ContainerCreateOptions): Promise<DockerContainerApi> {
    this.calls.push(`createContainer:${String(opts.name)}`);
    if (this.failures.createContainer !== undefined) {
      throw this.failures.createContainer;
    }
    for (const record of this.containers.values()) {
      if (record.options.name === opts.name) {
        throw dockerError(CONFLICT, 'container name already in use');
      }
    }

    const id = `c${String(this.#nextId)}`;
    this.#nextId += 1;
    this.containers.set(id, {
      options: opts,
      running: false,
      startedAt: '2026-01-01T00:00:00.000Z',
      oomKilled: false,
      exitCode: 0,
      execCommands: [],
    });
    return Promise.resolve(new FakeContainer(this, id));
  }

  /**
   * References a container by id.
   *
   * @param id - Container id.
   * @returns A handle; its methods fail with 404 when the id is unknown.
   */
  getContainer(id: string): DockerContainerApi {
    return new FakeContainer(this, id);
  }

  /**
   * Lists containers whose labels match every selector.
   *
   * @param opts - `all` is accepted and recorded; `filters.label` holds `key=value` selectors.
   * @returns Matching container ids and labels.
   */
  async listContainers(opts: {
    all: boolean;
    filters: { label: string[] };
  }): Promise<{ Id: string; Labels: Record<string, string> }[]> {
    this.calls.push(`listContainers:${opts.filters.label.join(',')}`);
    const matches: { Id: string; Labels: Record<string, string> }[] = [];

    for (const [id, record] of this.containers) {
      const labels = record.options.Labels ?? {};
      const matchesAll = opts.filters.label.every((selector) => {
        const separator = selector.indexOf('=');
        const key = selector.slice(0, separator);
        return labels[key] === selector.slice(separator + 1);
      });
      if (matchesAll) {
        matches.push({ Id: id, Labels: labels });
      }
    }

    return Promise.resolve(matches);
  }
}
