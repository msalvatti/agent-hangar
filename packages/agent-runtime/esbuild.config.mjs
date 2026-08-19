/**
 * Bundles the agent runtime into a single ESM file for the workspace image.
 *
 * Layer: build.
 *
 * The image carries `dist/cli.js` alone — no `node_modules`, no manifest — so nothing may stay
 * external. `@agent-hangar/core` is a barrel over the whole domain, including modules that only
 * a host process can load (Prisma, pg, pino, BullMQ, ioredis, dockerode); the plugin below marks
 * everything reached through that package side-effect-free so tree shaking removes what the
 * runtime never calls. `scripts/check-bundle.mjs` proves the result really is self-contained.
 */
import { chmod, readFile, writeFile } from 'node:fs/promises';

import { build } from 'esbuild';

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

await build({
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
  logLevel: 'info',
});

await chmod('dist/cli.js', 0o755);

// The bundle is ESM in a file named `.js`. Node only guesses that by re-parsing a file that
// failed as CommonJS, which is a default that can be switched off; the manifest beside the bundle
// states it outright, so the image does not depend on a heuristic to start the runtime at all.
// It must travel into the image together with `cli.js` — see the PR description.
await writeFile('dist/package.json', `${JSON.stringify({ type: 'module' }, null, 2)}\n`, 'utf8');
