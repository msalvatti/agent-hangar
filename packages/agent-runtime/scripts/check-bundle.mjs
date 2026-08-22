/**
 * Verifies that `dist/cli.js` is a self-contained runtime bundle.
 *
 * Layer: build.
 *
 * Five properties are checked, because each has already been a way for the image to break:
 * the bundle stays small enough to ship in an image layer, no host-only dependency survived tree
 * shaking, the file runs on its own from a directory with no `node_modules` above it — which is
 * exactly the situation inside the workspace container — a turn run through it reaches a real
 * model provider, and that turn takes its credentials file off the disk instead of leaving it
 * there.
 *
 * That last one exists because the entry point is the one module no unit test can import: it owns
 * `process.argv`, a top-level `await` and `process.exitCode`, so it is excluded from coverage, and
 * a build whose entry point composed nothing once shipped with every unit test green. Running the
 * shipped artefact is the only way to see it.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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
const manifestPath = join(packageRoot, 'dist', 'package.json');
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
 * `node_modules`, which is the situation inside the workspace image. Only the three files the
 * image receives are copied, and `--no-experimental-detect-module` turns off Node's guess at the
 * module system, so the run also proves the manifest beside the bundle is doing its job.
 *
 * @param args - Arguments after the script name.
 * @param env - Container environment for the run; `PATH` is always present.
 * @param input - What the worker would write to the runtime's stdin.
 * @returns The bundle's standard output.
 */
function runInScratchImage(args, env = {}, input = '') {
  const scratch = mkdtempSync(join(tmpdir(), 'agent-runtime-bundle-'));
  try {
    copyFileSync(bundlePath, join(scratch, 'cli.js'));
    copyFileSync(sourceMapPath, join(scratch, 'cli.js.map'));
    copyFileSync(manifestPath, join(scratch, 'package.json'));
    return execFileSync(process.execPath, ['--no-experimental-detect-module', 'cli.js', ...args], {
      cwd: scratch,
      env: { PATH: process.env.PATH, ...env },
      input,
      encoding: 'utf8',
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Runs the bundle on its own and checks it printed its version.
 *
 * @returns `undefined` when the bundle printed the expected version, otherwise the failure text.
 */
function runStandalone() {
  let stdout;
  try {
    stdout = runInScratchImage(['--version']);
  } catch (error) {
    return `bundle failed to run standalone: ${error instanceof Error ? error.message : 'unknown error'}`;
  }
  return stdout === `${version}\n`
    ? undefined
    : `bundle printed ${JSON.stringify(stdout)}, expected ${JSON.stringify(`${version}\n`)}`;
}

/**
 * A turn the bundle can only get past by building a real model provider.
 *
 * Building the provider is the first thing a turn does after announcing itself, and it is the
 * only step that can fail before the workspace is even looked at. Everything after it needs a
 * prepared container this script is not running in, so the turn is expected to fail — the probe
 * asks only *which* failure it is. The repository URL is one no workspace could be created for,
 * which keeps the check offline: nothing is cloned and no model endpoint is contacted.
 */
const WIRING_PROBE = {
  protocolVersion: 1,
  turnId: 'check-bundle',
  model: 'gpt-5.6-sol',
  instructions: '',
  items: [],
  repo: {
    url: 'https://not-a-forge.example/owner/repository',
    baseBranch: 'main',
    workBranch: 'main',
  },
  limits: { maxSteps: 1, maxTurnMs: 1000, toolTimeoutMs: 1000, maxToolOutputBytes: 1024 },
  prepare: { clone: true },
};

/**
 * Placeholder credentials: the provider is constructed from them and never used here.
 *
 * A workspace receives these as a file the host places beside the container and the runtime
 * unlinks as it starts, so the probe has to place one too — and the run doubles as proof that the
 * shipped bundle really does take the file away, which is asserted below.
 */
const PROBE_CREDENTIALS = {
  githubToken: 'check-bundle-placeholder-github',
  openaiApiKey: 'check-bundle-placeholder-openai',
};

/**
 * The one failure this probe exists to catch, as `src/provider.ts` words it.
 *
 * Matched on the text rather than on `turn.failed { code: 'config' }`, because every gate the
 * runtime passes before it has a workspace reports that same code — an unprepared container has
 * no approved origin either — and only the message tells the two apart.
 */
const UNWIRED_MESSAGE = 'not wired into this build';

/**
 * Runs one turn through the bundle and checks it reached a model provider.
 *
 * `AGENT_MODEL_PROVIDER` is left unset on purpose, so the run exercises the provider a workspace
 * container selects by default rather than one this script named.
 *
 * @returns `undefined` when the turn got past provider construction, otherwise the failure text.
 */
function runWiringProbe() {
  const handoff = mkdtempSync(join(tmpdir(), 'agent-runtime-handoff-'));
  const credentialsFile = join(handoff, 'credentials.json');
  let events;
  let credentialsSurvived;
  try {
    writeFileSync(credentialsFile, JSON.stringify(PROBE_CREDENTIALS), 'utf8');
    const stdout = runInScratchImage(
      ['turn'],
      { AH_CREDENTIALS_FILE: credentialsFile },
      `${JSON.stringify(WIRING_PROBE)}\n`,
    );
    // Asked before the directory goes, which is the whole point of asking.
    credentialsSurvived = existsSync(credentialsFile);
    events = stdout
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line));
  } catch (error) {
    // Anything on stdout that is not one protocol event per line is itself a broken bundle.
    return `bundle could not run a turn: ${error instanceof Error ? error.message : 'unknown error'}`;
  } finally {
    rmSync(handoff, { recursive: true, force: true });
  }
  if (credentialsSurvived) {
    return "bundle left this turn's credentials file in place; it must be unlinked as it is read";
  }
  if (!events.some((event) => event.type === 'turn.started')) {
    return 'bundle ran a turn without announcing one; expected a turn.started event';
  }
  const unwired = events.find(
    (event) =>
      event.type === 'turn.failed' && String(event.error.message).includes(UNWIRED_MESSAGE),
  );
  return unwired === undefined
    ? undefined
    : `bundle failed the turn with ${JSON.stringify(unwired.error)}; the entry point reaches no model provider — see src/composition.ts`;
}

for (const check of [runStandalone, runWiringProbe]) {
  const failure = check();
  if (failure !== undefined) {
    fail(failure);
  }
}

console.log(
  `check-bundle: dist/cli.js is ${Math.round(size / 1024)} KB, runs standalone and wires a model provider`,
);
