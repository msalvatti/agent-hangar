/**
 * Workspace containers of the end-to-end instance: listing them and reaping what a spec left
 * behind.
 *
 * Layer: test support (spawns processes).
 *
 * A crashed spec can leave a workspace container running, and the next spec would then assert
 * against a machine that is not in the state it expects. Containers are matched by the instance's
 * name prefix rather than by a label, because the prefix is what `resolveInstance` derives and
 * what `pnpm ws:list` already uses.
 */
import { exec, succeeds } from './process';

/**
 * Names of the workspace containers of one instance, running or stopped.
 *
 * @param namePrefix - `ah-ws-<instance>-`, from the resolved environment.
 * @returns Container names, possibly empty.
 */
async function listWorkspaceContainers(namePrefix: string): Promise<string[]> {
  const { stdout } = await exec('docker', [
    'ps',
    '--all',
    '--filter',
    `name=^${namePrefix}`,
    '--format',
    '{{.Names}}',
  ]);
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Force-removes every workspace container of one instance.
 *
 * @param namePrefix - `ah-ws-<instance>-`.
 * @returns The names that were removed.
 */
export async function reapWorkspaces(namePrefix: string): Promise<string[]> {
  const names = await listWorkspaceContainers(namePrefix);
  if (names.length === 0) {
    return names;
  }
  await exec('docker', ['rm', '--force', ...names]);
  return names;
}

/**
 * Whether an image is present locally.
 *
 * @param image - Image reference.
 * @returns `true` when `docker image inspect` succeeds.
 */
export async function imageExists(image: string): Promise<boolean> {
  return succeeds('docker', ['image', 'inspect', image]);
}
