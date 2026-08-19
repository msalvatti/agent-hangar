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
   * The worker runs from source through tsx, which does not enable the condition by default. The
   * flag must also sit after the `watch` subcommand, or tsx reads it as the entry file.
   */
  it('asks tsx for the development condition in the worker dev script', () => {
    const { scripts } = readManifest('apps/worker/package.json');
    const dev = scripts?.dev ?? '';
    expect(dev).toContain('--conditions=development');
    expect(dev.indexOf('watch')).toBeLessThan(dev.indexOf('--conditions=development'));
  });

  /**
   * The root dev script exports the condition so any further child process — a tsx helper added by
   * a later lane, for instance — inherits it instead of rediscovering this failure.
   */
  it('exports the development condition to every child of the root dev script', () => {
    const { scripts } = readManifest('package.json');
    expect(scripts?.dev ?? '').toContain('--conditions=development');
  });
});
