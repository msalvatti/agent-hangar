/**
 * Build options of the agent runtime bundle, shared by the build and by anything that has to
 * reproduce the bundle without writing it.
 *
 * Layer: build.
 *
 * They live apart from `esbuild.config.mjs` so there is exactly one description of what the
 * workspace image carries. `scripts/bundle-digest.mjs` builds from these options in memory and
 * hashes the result; if the two could drift, the digest stamped into the image would describe a
 * bundle nobody ships.
 *
 * `conditions: ['development']` makes `@agent-hangar/core` resolve to its TypeScript source. The
 * package's `default` condition points at `dist`, which is generated output: bundling through it
 * means the runtime shipped in the image is one compile step removed from the tree it is supposed
 * to come from, and a `dist` that lags the source produces a bundle that lags it too — with every
 * build reporting success. Reading the source removes the intermediate rather than checking it,
 * and it is also what lets the digest be recomputed in a fifth of a second instead of a full
 * project build. Third-party resolution is unaffected: esbuild adds this condition to the ones it
 * always applies, and no bundled dependency declares it.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** Absolute path of this package, so a build produces the same bytes from any working directory. */
const packageRoot = fileURLToPath(new URL('.', import.meta.url));

const packageManifest = JSON.parse(
  await readFile(new URL('./package.json', import.meta.url), 'utf8'),
);

/**
 * Marks every module reached through `packages/core` as side-effect-free.
 *
 * Covers both the core modules themselves and the third-party packages they import, which is
 * where the host-only dependencies live: without this, a package that does not declare
 * `sideEffects: false` is kept in the bundle even when nothing uses its exports.
 */
const coreSideEffectFree = {
  name: 'core-side-effect-free',
  setup(builder) {
    builder.onResolve({ filter: /.*/ }, async (args) => {
      if (args.pluginData?.resolvedByCorePlugin === true) {
        return undefined;
      }
      const reachedThroughCore =
        args.importer.includes('/packages/core/') || args.path.startsWith('@agent-hangar/core');
      if (!reachedThroughCore) {
        return undefined;
      }
      const resolved = await builder.resolve(args.path, {
        kind: args.kind,
        resolveDir: args.resolveDir,
        importer: args.importer,
        pluginData: { resolvedByCorePlugin: true },
      });
      if (resolved.errors.length > 0) {
        return { errors: resolved.errors };
      }
      return { path: resolved.path, external: resolved.external, sideEffects: false };
    });
  },
};

/** Everything esbuild needs to produce `dist/cli.js`. */
export const bundleOptions = {
  absWorkingDir: packageRoot,
  entryPoints: ['src/bin.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  minify: false,
  legalComments: 'none',
  treeShaking: true,
  conditions: ['development'],
  // `createRequire` is defined because bundled CommonJS dependencies expect `require` to exist in
  // scope; the shebang lets the file be executed directly as well as through `node`.
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __agentHangarCreateRequire } from 'node:module';",
      'const require = __agentHangarCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  define: { __AGENT_RUNTIME_VERSION__: JSON.stringify(packageManifest.version) },
  plugins: [coreSideEffectFree],
};

/** Name of the bundle inside the output directory, as the image and the digest both refer to it. */
export const BUNDLE_FILENAME = 'cli.js';

/** Absolute path of the directory the build writes into. */
export const BUNDLE_DIR = new URL('./dist/', import.meta.url);

/**
 * Manifest written beside the bundle.
 *
 * The bundle is ESM in a file named `.js`. Node only guesses that by re-parsing a file that failed
 * as CommonJS, which is a default that can be switched off; this states it outright, so the image
 * does not depend on a heuristic to start the runtime at all. It travels into the image together
 * with `cli.js`.
 */
export const BUNDLE_MANIFEST = `${JSON.stringify({ type: 'module' }, null, 2)}\n`;
