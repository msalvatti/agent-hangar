/**
 * Verifies that `dist/cli.js` is a self-contained runtime bundle.
 *
 * Layer: build.
 *
 * Three properties are checked, because each has already been a way for the image to break:
 * the bundle stays small enough to ship in an image layer, no host-only dependency survived tree
 * shaking, and the file runs on its own from a directory with no `node_modules` above it — which
 * is exactly the situation inside the workspace container.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Largest bundle the image is willing to carry, in bytes. */
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;

/**
 * Modules that only a host process may load. Any of them in the bundle means tree shaking failed
 * and the runtime would try to open a database, a queue or the Docker socket from inside a
 * disposable container.
 */
const HOST_ONLY_MARKERS = [
  '@prisma/client',
  'PrismaClient',
  'from "pg"',
  'pino',
  'bullmq',
  'ioredis',
  'dockerode',
];

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const bundlePath = join(packageRoot, 'dist', 'cli.js');
const sourceMapPath = `${bundlePath}.map`;
const version = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;

/**
 * Prints a message and exits with a failing status.
 *
 * @param message - What went wrong and how to look into it.
 */
function fail(message) {
  console.error(`check-bundle: ${message}`);
  process.exit(1);
}

let size;
try {
  size = statSync(bundlePath).size;
} catch {
  fail(`${bundlePath} is missing; run \`pnpm --filter @agent-hangar/agent-runtime build\` first`);
}

if (size >= MAX_BUNDLE_BYTES) {
  fail(
    `bundle is ${Math.round(size / 1024)} KB, over the ${Math.round(MAX_BUNDLE_BYTES / 1024)} KB budget`,
  );
}

const bundle = readFileSync(bundlePath, 'utf8');
const survivor = HOST_ONLY_MARKERS.find((marker) => bundle.includes(marker));
if (survivor !== undefined) {
  fail(
    `host-only module marker "${survivor}" survived tree shaking; rebuild with \`metafile: true\` in esbuild.config.mjs and follow the import chain`,
  );
}

/**
 * Copies the bundle into an empty directory and runs it there.
 *
 * The fresh directory is what proves self-containment: nothing resolves out of the repository's
 * `node_modules`, which is the situation inside the workspace image.
 *
 * @returns `undefined` when the bundle printed the expected version, otherwise the failure text.
 */
function runStandalone() {
  const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-bundle-'));
  try {
    copyFileSync(bundlePath, join(scratch, 'cli.js'));
    copyFileSync(sourceMapPath, join(scratch, 'cli.js.map'));
    const stdout = execFileSync(process.execPath, ['cli.js', '--version'], {
      cwd: scratch,
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
    });
    return stdout === `${version}\n`
      ? undefined
      : `bundle printed ${JSON.stringify(stdout)}, expected ${JSON.stringify(`${version}\n`)}`;
  } catch (error) {
    return `bundle failed to run standalone: ${error instanceof Error ? error.message : 'unknown error'}`;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const standaloneFailure = runStandalone();
if (standaloneFailure !== undefined) {
  fail(standaloneFailure);
}

console.log(`check-bundle: dist/cli.js is ${Math.round(size / 1024)} KB and runs standalone`);
