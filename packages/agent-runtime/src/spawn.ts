/**
 * The process-spawning seam shared by the git runner and the shell tool.
 *
 * Layer: adapter.
 *
 * Narrowing `child_process.spawn` to a single signature is what makes it injectable: the real
 * function is a wide set of overloads that a test double cannot implement without a cast, and the
 * runtime only ever calls this one shape.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

/** Starts a child process. */
export type SpawnFunction = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/** The real spawner; used unless a caller injects a double. */
export const nodeSpawn: SpawnFunction = spawn;
