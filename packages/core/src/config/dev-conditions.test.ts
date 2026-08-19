/**
 * Contract test between the package exports and the scripts that run from source.
 *
 * Layer: integration (reads the workspace manifests; no I/O beyond the file system).
 * Goal: `@agent-hangar/core` resolves to its build output by default and to its TypeScript source
 * only under the `development` condition. Node does not enable that condition on its own, so a dev
 * process that forgets to ask for it dies with ERR_MODULE_NOT_FOUND on `dist/index.js` in a tree
 * that has never been built — which is every fresh clone and every fresh worktree.
 * Mocks: none.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/**
 * Reads a workspace manifest.
 *
 * @param relativePath - Path of the manifest, relative to the repository root.
 * @returns The parsed manifest.
 */
function readManifest(relativePath: string): {
  scripts?: Record<string, string>;
  exports?: Record<string, Record<string, string>>;
} {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), 'utf8')) as {
    scripts?: Record<string, string>;
    exports?: Record<string, Record<string, string>>;
  };
}

describe('resolution of @agent-hangar/core from source', () => {
  /**
   * Every export entry keeps a `development` condition ahead of `default`: conditions match in
   * order, so a `development` placed after `default` would never win and tests would silently go
   * back to needing a build.
   */
  it('declares a development condition before default on every export entry', () => {
    const { exports: entries } = readManifest('packages/core/package.json');
    expect(entries).toBeDefined();
    for (const [subpath, conditions] of Object.entries(entries ?? {})) {
      const keys = Object.keys(conditions);
      expect(keys, `${subpath} must offer the source`).toContain('development');
      expect(conditions.development, `${subpath} must point at src`).toMatch(/^\.\/src\//);
      expect(
        keys.indexOf('development'),
        `${subpath} must resolve development before default`,
      ).toBeLessThan(keys.indexOf('default'));
    }
  });

  /**
   * The worker runs from source through tsx, which does not enable the condition by default, and
   * the whole token sequence matters: before `watch` the flag is read as the entry file, after the
   * entry file it is forwarded to the application instead of enabling package resolution. The
   * sequence is asserted directly rather than by comparing positions, because a positional check
   * passes when a token is missing entirely (`indexOf` returns -1) and when the flag trails the
   * entry file.
   */
  it('runs tsx as `tsx watch --conditions=development <entry>` in the worker dev script', () => {
    const { scripts } = readManifest('apps/worker/package.json');
    expect(scripts?.dev?.split(/\s+/)).toEqual([
      'tsx',
      'watch',
      '--conditions=development',
      'src/main.ts',
    ]);
  });

  /**
   * The root dev script exports the condition so any further child process — a tsx helper added by
   * a later lane, for instance — inherits it instead of rediscovering this failure. The export has
   * to happen before the children are spawned, so its position relative to `concurrently` is part
   * of the contract, and both tokens are asserted present rather than compared blindly.
   */
  it('exports the development condition before spawning the children of the root dev script', () => {
    const dev = readManifest('package.json').scripts?.dev ?? '';
    const exportAt = dev.indexOf('NODE_OPTIONS');
    const spawnAt = dev.indexOf('concurrently');
    expect(dev).toContain('--conditions=development');
    expect(exportAt, 'the dev script must export NODE_OPTIONS').toBeGreaterThanOrEqual(0);
    expect(spawnAt, 'the dev script must spawn its children with concurrently').toBeGreaterThan(0);
    expect(exportAt, 'the export must precede the children').toBeLessThan(spawnAt);
  });
});
