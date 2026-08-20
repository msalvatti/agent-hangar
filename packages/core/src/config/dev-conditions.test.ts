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
   * The root `dev` script no longer spawns `concurrently` itself: it delegates to
   * `infra/scripts/run.sh`, the single entry point shared by `pnpm dev` and the Conductor Run
   * button, so the two callers cannot silently diverge. That delegation is asserted first — a
   * later change that inlines a different command here would break the guarantee even if
   * `run.sh` itself stayed correct. `run.sh` is then read from disk, the same way `readManifest`
   * reads the workspace manifests, and it must export the condition before it spawns its
   * children — a further child process, such as a tsx helper added by a later lane, inherits it
   * instead of rediscovering this failure. Comment lines are stripped before the search: the
   * script's own header comment talks about `NODE_OPTIONS` and `--conditions=development` in
   * prose, so matching the raw file text would pass even with the real `export` line deleted.
   * Both tokens are asserted present in the remaining code, not just compared positionally,
   * because a naive position check passes when a token is missing entirely (`indexOf` returns
   * -1).
   */
  it('exports the development condition before spawning the children of the root dev script', () => {
    const dev = readManifest('package.json').scripts?.dev ?? '';
    expect(dev, 'pnpm dev and the Conductor Run button must share one entry point').toBe(
      'bash infra/scripts/run.sh',
    );

    const runScript = readFileSync(join(repoRoot, 'infra/scripts/run.sh'), 'utf8');
    const code = runScript
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    const exportAt = code.indexOf('export NODE_OPTIONS');
    const spawnAt = code.indexOf('concurrently');
    expect(code).toContain('--conditions=development');
    expect(exportAt, 'run.sh must export NODE_OPTIONS outside of a comment').toBeGreaterThanOrEqual(
      0,
    );
    expect(spawnAt, 'run.sh must spawn its children with concurrently').toBeGreaterThan(0);
    expect(exportAt, 'the export must precede the children').toBeLessThan(spawnAt);
  });
});
