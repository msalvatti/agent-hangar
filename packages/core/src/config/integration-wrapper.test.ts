/**
 * Contract test for the integration fan-out wrapper.
 *
 * Layer: integration (spawns bash; no Docker, no database, no network).
 * Goal: `scripts/run-integration.sh` calls a run that executed assertions a pass, calls a run in
 * which every suite skipped itself a failure, and hands a real failure's exit code straight back —
 * reading each verdict out of output a machine actually produced, including GitHub's, where the
 * summary arrives wrapped in colour.
 * Mocks: a `pnpm` shim on `PATH` that replays a recorded log; the script under test is the real
 * one, run from the repository root.
 *
 * Lives beside the `check-suppressions.sh` and `env.sh` contract tests: this package is where the
 * repository's shell scripts are exercised from.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const scriptPath = join(repoRoot, 'scripts', 'run-integration.sh');
const fixtureDir = join(repoRoot, 'packages', 'core', 'fixtures', 'integration');
const bash = existsSync('/bin/bash') ? '/bin/bash' : 'bash';

/** Permission bits the generated `pnpm` shim is created with (owner read/write/execute only). */
const SHIM_MODE = 0o700;

/** Assertions the recorded GitHub Actions run executed, across its three workspace suites. */
const PASSING_SUITES = 3;

/** Tests the recorded resource-less run skipped, across the same three suites (126 + 14 + 10). */
const SKIPPED_TESTS = 150;

/** Exit code the shimmed `pnpm` uses to stand for a suite that genuinely failed. */
const SUITE_FAILURE_CODE = 2;

/**
 * Reads one recorded pnpm log.
 *
 * @param name - File name inside `fixtures/integration`.
 * @returns The log's bytes, escape sequences and all.
 */
function fixture(name: string): string {
  return readFileSync(join(fixtureDir, name), 'utf8');
}

/**
 * Runs the real wrapper with a `pnpm` that replays a given log.
 *
 * The shim is written to a throwaway directory placed ahead of the real `PATH`, so the script's
 * own `mktemp`, `tee`, `sed`, `grep` and `awk` still resolve to the system's.
 *
 * @param log - Output the shimmed `pnpm` prints, byte for byte.
 * @param exitCode - Status the shimmed `pnpm` exits with. Defaults to `0`.
 * @returns The wrapper's exit status and captured streams.
 */
function runWrapper(
  log: string,
  exitCode = 0,
): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ah-integration-wrapper-'));
  try {
    const logPath = join(dir, 'recorded.log');
    const shimPath = join(dir, 'pnpm');
    writeFileSync(logPath, log, { encoding: 'utf8' });
    writeFileSync(
      shimPath,
      `#!/usr/bin/env bash\ncat ${JSON.stringify(logPath)}\nexit ${exitCode}\n`,
      {
        encoding: 'utf8',
      },
    );
    chmodSync(shimPath, SHIM_MODE);
    const result = spawnSync(bash, [scriptPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('scripts/run-integration.sh', () => {
  /**
   * The regression this file exists for. On GitHub's runners pnpm leaves colour on even though
   * `tee` has put a pipe on the other end, so every Vitest summary arrives as
   * `ESC[2m      Tests ESC[22m ESC[1mESC[32m126 passedESC[39m…`. Read with an anchor on leading
   * whitespace that matches none of it, three suites and a hundred and fifty passing assertions
   * were counted as zero and the job failed with `NOTHING RAN — 0 test(s) skipped`. The recorded
   * bytes of that exact run are replayed here, so the reading is pinned by the output that broke
   * it rather than by a pattern checked against itself.
   */
  it('reads a passing run whose summary arrives in colour', () => {
    const result = runWrapper(fixture('github-actions-passing.log'));

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(`${PASSING_SUITES} workspace suite(s) executed`);
    expect(result.stderr).not.toContain('NOTHING RAN');
  });

  /**
   * The guarantee the wrapper was added for, unchanged: every suite skipping itself is not a pass.
   * The recorded run behind this fixture exits 0 from pnpm — that is the whole defect — so the
   * assertion is on the wrapper turning it into a failure, and on the count it reports, which is
   * the number a developer needs to recognise a machine with no Postgres, Redis or Docker.
   */
  it('refuses a run in which every suite skipped itself', () => {
    const result = runWrapper(fixture('all-skipped.log'));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`NOTHING RAN — ${SKIPPED_TESTS} test(s) skipped`);
  });

  /**
   * What keeps the fix above from being the defect coming back. A pattern loosened until it
   * matches the word `Tests` anywhere — or `Test` followed by `passed` — would report the coloured
   * run as executed no matter what it contained, which is a check that cannot fail. Here the three
   * `Tests` summary lines are deleted from the recorded log and everything else is left standing,
   * `Test Files  13 passed (13)` included: the wrapper must still say nothing ran. Watched to fail
   * with the anchored pattern relaxed to `Test.*[0-9]+ passed`, which counted the three file lines
   * and exited 0 here — and, on the full recording, reported six workspace suites where three ran.
   */
  it('does not mistake any other line for a summary of executed tests', () => {
    const withoutSummaries = fixture('github-actions-passing.log')
      .split('\n')
      .filter((line) => !/^\s*Tests\s/u.test(line.replaceAll(/\u001b\[[0-9;?]*[A-Za-z]/gu, '')))
      .join('\n');

    const result = runWrapper(withoutSummaries);

    expect(result.stdout, 'the rest of the recorded run must still be there').toContain(
      'Test Files',
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('NOTHING RAN');
  });

  /**
   * A genuine failure decides the exit code before the wrapper's own question is ever asked, and
   * it must not be dressed up as an empty run: a developer whose suite failed needs pnpm's status
   * and pnpm's reason, not a paragraph about bringing an instance up.
   */
  it('hands a failing run its own exit code back, unexplained by this script', () => {
    const result = runWrapper(fixture('all-skipped.log'), SUITE_FAILURE_CODE);

    expect(result.status).toBe(SUITE_FAILURE_CODE);
    expect(result.stderr).not.toContain('NOTHING RAN');
    expect(result.stderr).not.toContain('workspace suite(s) executed');
  });

  /**
   * The trap this file fell into while it was being written. `.gitignore` carries a blanket
   * `*.log`, so both recordings were staged, silently dropped from the commit, and would have
   * reached CI as a missing file — the suite failing for the wrong reason, and the reading it
   * exists to pin never exercised at all. A fixture that is not committed is not a fixture.
   */
  it('keeps both recordings under version control', () => {
    const tracked = execFileSync('git', ['ls-files', '--', 'packages/core/fixtures/integration'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(tracked).toContain('github-actions-passing.log');
    expect(tracked).toContain('all-skipped.log');
  });

  /**
   * The wrapper reads the run by teeing it, and the copy the developer watches has to stay the run
   * itself — same lines, same colour. A wrapper that swallowed its child's output to parse it
   * would leave a failing suite with nothing on screen to say which assertion broke.
   */
  it('passes the run through to the terminal exactly as pnpm printed it', () => {
    const recorded = fixture('github-actions-passing.log');

    const result = runWrapper(recorded);

    expect(result.stdout).toContain(recorded);
  });
});
