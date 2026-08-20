/**
 * Contract test between the package exports and the scripts that run from source.
 *
 * Layer: integration (reads the workspace manifests and resolves the package's own entry points;
 * no I/O beyond the file system).
 * Goal: `@agent-hangar/core` resolves to its build output by default and to its TypeScript source
 * only under the `development` condition. Node does not enable that condition on its own, so a dev
 * process that forgets to ask for it dies with ERR_MODULE_NOT_FOUND on `dist/index.js` in a tree
 * that has never been built — which is every fresh clone and every fresh worktree.
 *
 * Manifest text alone cannot show that: a declaration test passes just as happily in a tree with
 * no build output as in one holding a stale build, because it never asks the resolver anything.
 * The last test here therefore imports `@agent-hangar/core/testing` for real — the subpath every
 * suite in this repository loads its doubles from — and compares module identity with the source
 * barrel, which only holds when the source is what the resolver reached. That one import is
 * written inside the test rather than at the top of the file on purpose: `import-x/order` groups a
 * static import by what the resolver finds for it, and this package referring to itself by name
 * resolves only once `dist` exists, so the required order flipped between a built tree and a fresh
 * checkout. An import in the body belongs to no group, and the specifier is still a literal, so the
 * runner resolves it exactly as it resolves every other consumer's.
 * Mocks: none.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as sourceTestingBarrel from '../testing/index.ts';

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

  /**
   * What the resolver did, rather than what the manifest says it should do. Every suite in this
   * repository loads its doubles from `@agent-hangar/core/testing`, and the runner resolves that
   * subpath through the package `exports` — so if the `development` condition ever stopped winning
   * there, the suites would quietly start running against whatever `dist` happened to hold.
   *
   * The subpath and the source barrel are imported into the same module graph and compared by
   * identity. Resolving through `development` loads one module, so the two namespaces are the same
   * object. Resolving through `default` loads a second copy out of `dist`: a different object when
   * a build is present, stale or not, and an unresolvable specifier when it is not — which is why
   * this fails in a tree with a stale build instead of passing like a text check would. Identity
   * is asserted rather than the exported names, because two copies of one barrel export the same
   * names and comparing those would pass either way.
   */
  it('resolves the testing subpath to the source barrel and not to a copy in dist', async () => {
    const packageTestingEntry = await import('@agent-hangar/core/testing');
    expect(
      Object.keys(sourceTestingBarrel).length,
      'the barrel must export something',
    ).toBeGreaterThan(0);
    expect(packageTestingEntry).toBe(sourceTestingBarrel);
  });
});
