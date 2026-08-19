/**
 * Contract test for the repository's suppression ban.
 *
 * Layer: integration (spawns bash and git; no Docker, no network).
 * Goal: `scripts/check-suppressions.sh` fails on a planted suppression and passes on a clean
 * tree, in both of its modes; it looks only at tracked files; the real tree is clean; and CI
 * actually runs it, so the ban cannot quietly stop being enforced.
 * Mocks: none — every assertion runs the real script against a throwaway git repository.
 *
 * Lives beside the `env.sh` contract test: this package is where the repository's shell scripts
 * are exercised from.
 *
 * Every forbidden marker below is assembled from fragments at runtime, exactly as the script
 * assembles its own pattern, so this file does not trip the gate it tests.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const scriptPath = join(repoRoot, 'scripts', 'check-suppressions.sh');
const workflowPath = join(repoRoot, '.github', 'workflows', 'ci.yml');
const bash = existsSync('/bin/bash') ? '/bin/bash' : 'bash';

/** The markers the gate must catch, each split so this file never contains one literally. */
const SUPPRESSIONS = [
  ['eslint-dis', 'able next-line no-console'],
  ['@ts-ig', 'nore'],
  ['@ts-exp', 'ect-error'],
  ['@ts-no', 'check'],
  ['istanbul ig', 'nore next'],
  ['v8 ig', 'nore next'],
].map(([head = '', tail = '']) => `${head}${tail}`);

/**
 * Runs the script in a throwaway git repository so a planted suppression never touches the real
 * working tree.
 *
 * @param body - Receives the sandbox root and a runner for the copied script.
 */
function withSandbox(
  body: (
    root: string,
    run: (...args: string[]) => { status: number | null; stdout: string; stderr: string },
  ) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), 'ah-suppressions-'));
  try {
    const script = join(root, 'scripts', 'check-suppressions.sh');
    mkdirSync(dirname(script), { recursive: true });
    copyFileSync(scriptPath, script);
    execFileSync('git', ['init', '-q', '.'], { cwd: root });
    const run = (...args: string[]) => {
      const result = spawnSync(bash, [script, ...args], { cwd: root, encoding: 'utf8' });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    };
    body(root, run);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('scripts/check-suppressions.sh', () => {
  /**
   * The gate exists for exactly this: every suppression marker, in a source file and in a shell
   * file, must fail the repository-wide scan and name the offending file.
   */
  it.each(SUPPRESSIONS)('fails the tracked-file scan on %s', (marker) => {
    withSandbox((root, run) => {
      execFileSync(bash, ['-c', `printf '// %s\\n' ${JSON.stringify(marker)} > planted.ts`], {
        cwd: root,
      });
      execFileSync(bash, ['-c', `printf '# %s\\n' ${JSON.stringify(marker)} > planted.sh`], {
        cwd: root,
      });
      execFileSync('git', ['add', '-A'], { cwd: root });

      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('planted.ts');
      expect(result.stderr).toContain('planted.sh');
    });
  });

  /**
   * A tree without suppressions passes, so the gate cannot be dismissed as noise, and the same
   * file passes once the marker is removed.
   */
  it('passes on a clean tracked tree', () => {
    withSandbox((root, run) => {
      execFileSync(bash, ['-c', "printf 'const a = 1;\\n' > clean.ts"], { cwd: root });
      execFileSync(bash, ['-c', "printf 'echo hi\\n' > clean.sh"], { cwd: root });
      execFileSync('git', ['add', '-A'], { cwd: root });

      expect(run().status).toBe(0);
    });
  });

  /**
   * lint-staged passes explicit paths, so that mode must fail on a bad file and pass on a good
   * one independently of what git tracks.
   */
  it('checks explicit files regardless of tracking', () => {
    withSandbox((root, run) => {
      const marker = SUPPRESSIONS[0] ?? '';
      execFileSync(bash, ['-c', `printf '// %s\\n' ${JSON.stringify(marker)} > loose.ts`], {
        cwd: root,
      });
      execFileSync(bash, ['-c', "printf 'const b = 2;\\n' > fine.ts"], { cwd: root });

      expect(run('loose.ts').status).toBe(1);
      expect(run('fine.ts').status).toBe(0);
      // Untracked, so the repository-wide scan must not see it — the two modes differ on purpose.
      expect(run().status).toBe(0);
    });
  });

  /**
   * The gate is only real if CI runs it and the repository it guards is actually clean; a hit
   * here means a suppression reached the tree.
   */
  it('is wired into CI and passes on this repository', () => {
    expect(readFileSync(workflowPath, 'utf8')).toContain('bash scripts/check-suppressions.sh');
    const result = spawnSync(bash, [scriptPath], { cwd: repoRoot, encoding: 'utf8' });
    expect(result.stdout + result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
