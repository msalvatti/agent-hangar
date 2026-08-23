/**
 * Unit tests for the container-file archives.
 *
 * Layer: unit.
 * Goal: the archive Docker is handed writes the file root-owned and read-only, under the directory
 * the caller named and nowhere else, so the value it carries is one the container's own user can
 * read and cannot author; and a path that could escape that directory is refused outright.
 * Mocks: none — the archive is parsed back with the same library that wrote it.
 */
import { Readable } from 'node:stream';

import { extract } from 'tar-stream';
import { describe, expect, it } from 'vitest';

import { buildContainerFileArchive } from './container-files.ts';
import { DockerRunnerError } from './errors.ts';

/** One entry read back out of an archive. */
interface Entry {
  name: string;
  mode: number | undefined;
  uid: number | undefined;
  gid: number | undefined;
  uname: string | undefined;
  gname: string | undefined;
  content: string;
}

/**
 * Reads every entry of a tar archive back.
 *
 * @param archive - The archive to parse.
 * @returns The entries, in order.
 */
async function entriesOf(archive: Buffer): Promise<Entry[]> {
  const entries: Entry[] = [];
  const reader = extract();
  Readable.from(archive).pipe(reader);
  for await (const entry of reader) {
    const chunks: Buffer[] = [];
    for await (const chunk of entry) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    entries.push({
      name: entry.header.name,
      mode: entry.header.mode,
      uid: entry.header.uid,
      gid: entry.header.gid,
      // The names as well as the numbers: an archive that carries an owner id of zero and no owner
      // name is extracted by some tar readers as owned by whoever is extracting it, which for a
      // file the container's user must not be able to rewrite is the whole guarantee gone.
      uname: entry.header.uname,
      gname: entry.header.gname,
      content: Buffer.concat(chunks).toString('utf8'),
    });
  }
  return entries;
}

describe('buildContainerFileArchive', () => {
  /**
   * Ownership is the whole mechanism: Docker extracts as root and honours these headers, so a uid
   * of 0 is what the container's unprivileged user cannot forge. The mode still has to leave the
   * file readable by that user, because reading it is the point.
   */
  it('writes one root-owned, world-readable entry into the file directory', async () => {
    const result = await buildContainerFileArchive({
      path: '/opt/agent-runtime/allowed-origin',
      content: 'https://github.com\n',
    });

    expect(result.path).toBe('/opt/agent-runtime');
    await expect(entriesOf(result.archive)).resolves.toStrictEqual([
      {
        name: 'allowed-origin',
        mode: 0o644,
        uid: 0,
        gid: 0,
        uname: 'root',
        gname: 'root',
        content: 'https://github.com\n',
      },
    ]);
  });

  /**
   * A timestamp taken from the clock would make two identical creates produce two different
   * archives, which is a difference every later reader would have to explain away.
   */
  it('produces the same bytes for the same file every time', async () => {
    const file = { path: '/opt/agent-runtime/allowed-origin', content: 'https://github.com\n' };

    const [first, second] = await Promise.all([
      buildContainerFileArchive(file),
      buildContainerFileArchive(file),
    ]);

    expect(first.archive.equals(second.archive)).toBe(true);
  });

  /**
   * The directory half of the path is handed to the daemon as the extraction target, so a segment
   * that walks out of it is a way to write anywhere in the container's filesystem.
   */
  it.each([
    ['a relative path', 'opt/agent-runtime/allowed-origin'],
    ['a path with no directory', '/allowed-origin'],
    ['a directory rather than a file', '/opt/agent-runtime/'],
    ['a parent traversal', '/opt/agent-runtime/../../etc/passwd'],
    ['a dot segment', '/opt/./agent-runtime/allowed-origin'],
    ['an empty segment', '/opt//agent-runtime/allowed-origin'],
    ['nothing at all', ''],
  ])('refuses %s', async (_name, path) => {
    await expect(buildContainerFileArchive({ path, content: 'x' })).rejects.toThrow(
      DockerRunnerError,
    );
  });

  /**
   * The path is judged segment by segment, and a refusal names the path it refused: an archive
   * asked for somewhere the container's user could reach is refused here rather than extracted,
   * and an operator reading the failure has to see which path was asked for.
   */
  it.each([
    ['relative', 'opt/agent-runtime/file'],
    ['a directory rather than a file', '/opt/agent-runtime/..'],
    ['an empty segment', '/opt//file'],
    ['a current-directory segment', '/opt/./file'],
    ['a single segment', '/file'],
  ])('refuses a container file path that is %s', async (_case, path) => {
    await expect(buildContainerFileArchive({ path, content: 'x' })).rejects.toThrow(
      `invalid workspace file path "${path}"`,
    );
  });
});
