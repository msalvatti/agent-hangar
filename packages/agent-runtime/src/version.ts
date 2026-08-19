/**
 * Version string of the bundled agent runtime.
 *
 * Layer: utility.
 *
 * The value is baked in at bundle time by esbuild's `define`, so `dist/cli.js` reports the
 * package version without reading `package.json` — the bundle is copied into the image alone,
 * with no `node_modules` and no manifest beside it.
 */

declare const __AGENT_RUNTIME_VERSION__: string | undefined;

/** Version reported by `cli.js --version`; falls back to a dev marker outside the bundle. */
export const RUNTIME_VERSION: string =
  typeof __AGENT_RUNTIME_VERSION__ === 'string' ? __AGENT_RUNTIME_VERSION__ : '0.0.0-dev';
