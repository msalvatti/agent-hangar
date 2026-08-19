/**
 * Version string of the bundled agent runtime.
 *
 * Layer: utility.
 *
 * The value is baked in at bundle time by esbuild's `define`, so `dist/cli.js` reports the
 * package version without reading a manifest at run time. The `dist/package.json` copied into the
 * image alongside it carries only `{"type": "module"}`, and is never read for a version.
 */

declare const __AGENT_RUNTIME_VERSION__: string | undefined;

/** Version reported by `cli.js --version`; falls back to a dev marker outside the bundle. */
export const RUNTIME_VERSION: string =
  typeof __AGENT_RUNTIME_VERSION__ === 'string' ? __AGENT_RUNTIME_VERSION__ : '0.0.0-dev';
