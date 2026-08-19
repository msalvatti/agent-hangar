/**
 * The process-spawning seam shared by the git runner and the shell tool.
 *
 * Layer: adapter.
 *
 * `child_process.spawn` is a wide set of overloads returning a large object; declaring the single
 * signature and the four members the runtime actually uses is what makes the seam injectable, so a
 * test double needs no cast and a reader can see exactly how much of the API is in play.
 */
import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';

/** The part of a child process the runtime touches. */
export interface SpawnedProcess extends EventEmitter {
  /** Process id, absent when the child never started. */
  readonly pid?: number | undefined;
  /** Standard output, `null` when the child was started without a pipe for it. */
  readonly stdout: Readable | null;
  /** Standard error, `null` when the child was started without a pipe for it. */
  readonly stderr: Readable | null;
  /**
   * Signals the child.
   *
   * @param signal - Signal to deliver; the platform default when omitted.
   * @returns Whether the signal was delivered.
   */
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** Starts a child process. */
export type SpawnFunction = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => SpawnedProcess;

/** The real spawner; used unless a caller injects a double. */
export const nodeSpawn: SpawnFunction = spawn;
