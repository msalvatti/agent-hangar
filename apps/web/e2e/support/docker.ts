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
import { exec } from './process';

/**
 * Names of the workspace containers of one instance, running or stopped.
 *
 * @param namePrefix - `ah-ws-<instance>-`, from the resolved environment.
 * @returns Container names, possibly empty.
 */
export async function listWorkspaceContainers(namePrefix: string): Promise<string[]> {
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
 * How far the workspace image can be trusted for a run started from this tree.
 *
 * A present image is not a current one: `pnpm infra:image` stamps a digest of what it carried into
 * the image, and `infra/scripts/workspace-image.sh` recomputes that digest from the tree and
 * compares. A run against an image that lags the checkout does not fail — it succeeds and reports
 * a result for an agent runtime that exists in no tree, which is the whole reason this is asked
 * before Playwright starts rather than left to be noticed afterwards.
 *
 * @param repoRootPath - Absolute path of the repository root.
 * @param image - Image reference.
 * @returns `current`, `stale`, `missing`, or `unavailable` when the question could not be asked.
 */
export async function workspaceImageStatus(repoRootPath: string, image: string): Promise<string> {
  const { stdout } = await exec('bash', ['infra/scripts/workspace-image.sh', '--status', image], {
    cwd: repoRootPath,
  });
  return stdout.trim();
}
