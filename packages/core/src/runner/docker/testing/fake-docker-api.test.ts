/**
 * Unit tests for the in-memory Docker API the runner's suites are written against.
 *
 * Layer: unit (the double's own contract).
 * Goal: the two places this double models the daemon rather than the caller stay modelled. The
 * runner asks for one shape of each — every exec is created without a TTY, and every listing asks
 * for stopped containers as well — so nothing that drives the double through the runner can reach
 * the other arm. A double loosened there would answer a question the daemon answers differently,
 * and the suite written against it would agree.
 * Mocks: none; the double is the unit.
 */
import { describe, expect, it } from 'vitest';

import { FakeDockerApi } from './fake-docker-api.ts';

/** Bytes of the Docker stream frame header, mirrored from the format the double writes. */
const FRAME_HEADER_BYTES = 8;

/**
 * Reads everything one exec stream produces.
 *
 * @param stream - The hijacked stream the exec handed back.
 * @returns The bytes it emitted, concatenated.
 */
async function readAll(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Creates one container and returns the daemon handle it was created through.
 *
 * @param docker - The double.
 * @param name - Container name.
 * @returns The container handle.
 */
async function createContainer(docker: FakeDockerApi, name: string) {
  return docker.createContainer({
    name,
    Image: 'agent-hangar/workspace:test',
    Labels: { ah: '1' },
  });
}

describe('the exec stream the double hands back', () => {
  /**
   * Without a TTY the daemon multiplexes: every write carries an eight-byte header naming the
   * stream it came from, which is what the runner's demultiplexer exists to read. This is the
   * shape every exec in this project asks for.
   */
  it('frames the output of an exec created without a TTY', async () => {
    const docker = new FakeDockerApi({
      execScripts: [{ match: () => true, stdout: 'hello', exitCode: 0 }],
    });
    const container = await createContainer(docker, 'ah-ws-frames');
    const exec = await container.exec({
      Cmd: ['echo', 'hello'],
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });

    const output = await readAll(await exec.start({ hijack: true, stdin: false }));

    expect(output).toHaveLength(FRAME_HEADER_BYTES + 'hello'.length);
    expect(output.subarray(FRAME_HEADER_BYTES).toString('utf8')).toBe('hello');
  });

  /**
   * With a TTY there is nothing to multiplex — one stream, no headers — so a caller that asked for
   * one and then demultiplexed would be reading the first bytes of its own output as a header. The
   * double says so rather than framing regardless, which would hide that mistake.
   */
  it('leaves the output of an exec created with a TTY unframed', async () => {
    const docker = new FakeDockerApi({
      execScripts: [{ match: () => true, stdout: 'hello', exitCode: 0 }],
    });
    const container = await createContainer(docker, 'ah-ws-tty');
    const exec = await container.exec({
      Cmd: ['echo', 'hello'],
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    });

    const output = await readAll(await exec.start({ hijack: true, stdin: false }));

    expect(output.toString('utf8')).toBe('hello');
  });
});

describe('what a listing returns', () => {
  /**
   * `all` decides whether a stopped container is listed. The reaper asks for it because a stopped
   * workspace is exactly what it exists to clean up; a listing that ignored the flag would show a
   * caller asking for running containers one that had already exited.
   */
  it('lists a stopped container only when the listing asks for all of them', async () => {
    const docker = new FakeDockerApi({});
    const running = await createContainer(docker, 'ah-ws-running');
    await createContainer(docker, 'ah-ws-stopped');
    await running.start();

    const withAll = await docker.listContainers({ all: true, filters: { label: ['ah=1'] } });
    const runningOnly = await docker.listContainers({ all: false, filters: { label: ['ah=1'] } });

    expect(withAll).toHaveLength(2);
    expect(runningOnly).toHaveLength(1);
    expect(runningOnly[0]?.Labels).toStrictEqual({ ah: '1' });
  });
});
