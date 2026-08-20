/**
 * Packing {@link WorkspaceFile} entries into the tar archives Docker extracts into a container.
 *
 * Layer: service (adapter).
 *
 * Pure: no daemon call, so the one property that matters — what ownership and mode the extracted
 * file ends up with — is pinned by a unit test rather than inferred from a daemon's behaviour.
 *
 * Ownership is the whole point. Docker extracts an uploaded archive as root and honours the
 * `uid`/`gid` in each tar header, so an entry written as uid 0 lands root-owned inside a container
 * whose own user is unprivileged. That is what makes the file unforgeable from inside: the
 * workspace user can read it and cannot replace it, and because the parent directory is root-owned
 * too, it cannot unlink it and write a new one either — unlink is governed by the directory's
 * write bit, not by the file's owner.
 */
import { buffer } from 'node:stream/consumers';

import { pack } from 'tar-stream';

import type { WorkspaceFile } from '../types.ts';

import { DockerRunnerError } from './errors.ts';

/** Owner of every placed file: root, which no workspace process is. */
const ROOT_ID = 0;

/** Mode of every placed file: readable by all, writable by none but its owner. */
const READ_ONLY_MODE = 0o644;

/** Fixed timestamp, so the same file produces the same archive on every create. */
const FIXED_MTIME = new Date(0);

/**
 * Segments a usable path splits into at minimum: the empty one before the leading slash, one
 * directory, and the file itself. `/name` has a parent of `/`, which is not somewhere this places
 * files.
 */
const MINIMUM_SEGMENTS = 2;

/** A tar archive and the directory Docker should extract it into. */
export interface ContainerFileArchive {
  /** Directory inside the container the archive is extracted into. */
  path: string;
  /** The tar archive itself. */
  archive: Buffer;
}

/**
 * Splits an absolute container path into its parent directory and its final segment.
 *
 * @param path - Absolute path inside the container.
 * @returns The parent directory and the file name.
 * @throws DockerRunnerError when the path is not absolute, names no file, or carries a `.` or
 *   `..` segment — each of which would let a caller write outside the directory it named.
 */
function splitContainerPath(path: string): { directory: string; name: string } {
  // Judged on the segments rather than on the ends, so the file name is held to the same rule as
  // every directory above it: `/opt/x/..` names a directory, not a file, and must not be treated
  // as one because it happens to have a last segment.
  const segments = path.split('/');
  const isUsable =
    path.startsWith('/') &&
    segments.length > MINIMUM_SEGMENTS &&
    segments.slice(1).every((segment) => segment !== '' && segment !== '.' && segment !== '..');
  if (!isUsable) {
    throw new DockerRunnerError(`invalid workspace file path "${path}"`);
  }
  const cut = path.lastIndexOf('/');
  return { directory: path.slice(0, cut), name: path.slice(cut + 1) };
}

/**
 * Packs one file into the archive Docker extracts into its parent directory.
 *
 * One archive per file rather than one per directory: the caller places a handful of small files,
 * and a single-entry archive keeps the mapping between what was asked for and what the daemon is
 * told trivially checkable.
 *
 * @param file - Path and content to place.
 * @returns The archive and the directory it belongs in.
 * @throws DockerRunnerError when the path is not a usable absolute file path.
 */
export async function buildContainerFileArchive(
  file: WorkspaceFile,
): Promise<ContainerFileArchive> {
  const { directory, name } = splitContainerPath(file.path);
  const tarball = pack();
  tarball.entry(
    {
      name,
      mode: READ_ONLY_MODE,
      uid: ROOT_ID,
      gid: ROOT_ID,
      uname: 'root',
      gname: 'root',
      mtime: FIXED_MTIME,
    },
    file.content,
  );
  tarball.finalize();
  return { path: directory, archive: await buffer(tarball) };
}
