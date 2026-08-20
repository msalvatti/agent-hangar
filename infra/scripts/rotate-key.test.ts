/**
 * Unit tests for the forward path of `infra/scripts/rotate-key.sh`.
 *
 * Layer: unit (spawns bash with PATH shims; no real Postgres, no real `tsx`).
 * Goal: without `--yes` nothing runs and the plan is printed; a successful rotation puts the new
 * key in place, keeps a mode-600 backup under a name no earlier rotation took, records its phase
 * by renaming a sibling over the state file, and never leaves the key path empty; a failure the
 * helper could undo leaves the current key untouched and removes the half-written `.new`, while
 * every failure it could not undo keeps both key files; and an unknown flag is rejected.
 * Mocks: `openssl`, and (for the ordering assertions) `cp`/`mv`, via PATH shims; a bespoke
 * `AH_DOCTOR_HELPER_CMD` shim standing in for the secrets-status/rotate-key helpers. The sandbox
 * and the shims live in `infra/scripts/testing/rotate-key-sandbox.ts`, shared with the resume and
 * concurrency suite.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import type { Sandbox } from './testing/rotate-key-sandbox.js';
import {
  GENERATED_KEY,
  OLD_KEY,
  PENDING_KEY,
  backupPaths,
  fileMode,
  fileOpShims,
  releaseSandboxes,
  run,
  sandbox,
  scriptPath,
  writeState,
} from './testing/rotate-key-sandbox.js';
import { createShimDir, readShimLog, spawnScript, writeExtraShim } from './testing/shims.js';

afterEach(() => {
  releaseSandboxes();
});

/**
 * Finds the single backup file the sandbox holds, asserting there is exactly one.
 *
 * @param box - The sandbox.
 * @returns The absolute path of the backup.
 */
function backupPath(box: Sandbox): string {
  const backups = backupPaths(box);
  expect(backups).toHaveLength(1);
  return backups[0] ?? '';
}

describe('rotate-key.sh without --yes', () => {
  /**
   * Prints the plan (key path, backup pattern, secret count) and exits 2 without touching
   * anything.
   */
  it('prints the plan and exits 2', () => {
    const box = sandbox();
    const result = run(box, []);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain(box.keyPath);
    expect(result.stdout).toContain('bak-');
    expect(result.stdout).toContain('re-encrypts 1 secret(s)');
    expect(readFileSync(box.keyPath, 'utf8')).toBe(OLD_KEY);
    expect(existsSync(box.newKeyPath)).toBe(false);
  });

  /**
   * An interrupted rotation is named in the plan together with the phase it stopped in, so the
   * operator learns what state the store is in before deciding anything.
   */
  it('names an interrupted rotation and its phase', () => {
    const box = sandbox();
    writeFileSync(box.newKeyPath, PENDING_KEY);
    writeState(box, 'reencrypting');
    const result = run(box, []);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('in progress: phase reencrypting');
    expect(result.stdout).toContain('--resume');
  });
});

describe('rotate-key.sh --yes success', () => {
  /**
   * Generates a new key, runs the helper in strict mode, then puts the new key in place: the old
   * content survives in a mode-600 backup, the new key (from the shimmed `openssl`) becomes
   * `master.key`, and the rotation state file is cleared.
   */
  it('rotates the key and keeps a mode-600 backup of the old one', () => {
    const box = sandbox();
    const result = run(box, ['--yes']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Master key rotated');

    expect(readFileSync(box.keyPath, 'utf8')).toBe(GENERATED_KEY);
    expect(fileMode(box.keyPath)).toBe('600');

    const backup = backupPath(box);
    expect(readFileSync(backup, 'utf8')).toBe(OLD_KEY);
    expect(fileMode(backup)).toBe('600');

    expect(existsSync(box.newKeyPath)).toBe(false);
    expect(existsSync(box.statePath)).toBe(false);
    const log = readShimLog(box.log);
    expect(log).toContain('openssl rand -hex 32');
    expect(
      log.some((line) => line.startsWith('helper strict') && line.includes('rotate-key')),
    ).toBe(true);
  });

  /**
   * The backup name carries a one-second timestamp, so two rotations of a small store can compute
   * the same one. Reusing it would overwrite a backup that is still the only copy of the key it
   * holds, so a name already taken is stepped past instead.
   */
  it('never reuses a backup name two rotations computed in the same second', () => {
    const box = sandbox();
    const shimDir = createShimDir({ log: box.log });
    // A frozen clock is what makes the collision certain rather than occasional.
    writeExtraShim(shimDir, 'date', "printf '%s\\n' '20260819000000'");

    expect(run(box, ['--yes'], {}, shimDir).status).toBe(0);
    expect(run(box, ['--yes'], {}, shimDir).status).toBe(0);

    const backups = backupPaths(box);
    expect(backups).toHaveLength(2);
    expect(readFileSync(backups[0] ?? '', 'utf8')).toBe(OLD_KEY);
    expect(readFileSync(backups[1] ?? '', 'utf8')).toBe(GENERATED_KEY);
  });

  /**
   * The phase file is what a resume reads to decide whether the store has already been
   * re-encrypted, so it is never left half-written: each update goes to a sibling and is renamed
   * over the real path. A plain redirect truncates first and fills after, and a crash inside that
   * window would strand a partial phase line.
   */
  it('updates the rotation state by renaming a sibling over it', () => {
    const box = sandbox();
    const shimDir = createShimDir({ log: box.log });
    fileOpShims(shimDir);
    const result = run(box, ['--yes'], {}, shimDir);

    expect(result.status).toBe(0);
    const log = readShimLog(box.log);
    expect(log).toContain(`mv ${box.statePath}.tmp ${box.statePath}`);
    expect(existsSync(`${box.statePath}.tmp`)).toBe(false);
  });

  /**
   * The swap must never leave the key path empty. The old key is COPIED to the backup while it is
   * still the current key, and the new material then arrives by renaming `.new` over it — a single
   * atomic replacement. Moving the current key aside first, as an earlier version did, opened a
   * window in which neither file stood at `master.key`.
   */
  it('copies the old key aside and renames the new one over it', () => {
    const box = sandbox();
    const shimDir = createShimDir({ log: box.log });
    fileOpShims(shimDir);
    const result = run(box, ['--yes'], {}, shimDir);
    expect(result.status).toBe(0);

    const log = readShimLog(box.log);
    const backup = backupPath(box);
    // The backup arrives by renaming a finished sibling, never by copying onto its own path: `cp`
    // truncates before it writes, so a kill mid-copy would leave a partial file exactly where the
    // resume path treats existence as completeness.
    expect(log).toContain(`cp ${box.keyPath} ${backup}.tmp`);
    expect(log).toContain(`mv ${backup}.tmp ${backup}`);
    expect(log.some((line) => line === `cp ${box.keyPath} ${backup}`)).toBe(false);
    // The current key is never moved away, so the key path is never empty.
    expect(log).toContain(`mv ${box.newKeyPath} ${box.keyPath}`);
    expect(log.some((line) => line.startsWith(`mv ${box.keyPath} `))).toBe(false);
    expect(log.indexOf(`mv ${backup}.tmp ${backup}`)).toBeLessThan(
      log.indexOf(`mv ${box.newKeyPath} ${box.keyPath}`),
    );
  });
});

describe('rotate-key.sh --yes failure', () => {
  /**
   * A rollback the helper completed (exit 3) puts every row back under the current key, so the
   * half-written `.new` and the rotation state can both go.
   */
  it('leaves the current key unchanged and removes .new after a completed rollback', () => {
    const box = sandbox();
    const result = run(box, ['--yes'], { AH_SHIM_ROTATE_RC: '3' });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('Rotation aborted');
    expect(readFileSync(box.keyPath, 'utf8')).toBe(OLD_KEY);
    expect(existsSync(box.newKeyPath)).toBe(false);
    expect(existsSync(box.statePath)).toBe(false);
  });

  /**
   * A strict run that aborted (exit 2) wrote nothing to a store that was wholly under the current
   * key, so the same cleanup is safe.
   */
  it('removes .new after a strict abort', () => {
    const box = sandbox();
    const result = run(box, ['--yes'], { AH_SHIM_ROTATE_RC: '2' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Rotation aborted');
    expect(existsSync(box.newKeyPath)).toBe(false);
    expect(existsSync(box.statePath)).toBe(false);
  });

  /**
   * Helper exit 4 means the rollback itself failed: part of the store is sealed under `.new`.
   * Deleting that file would destroy those credentials, so it is kept, the state stays at
   * `reencrypting` for the resume to read, and the operator is told both key files now matter.
   */
  it('keeps .new and names both files when the rollback itself failed', () => {
    const box = sandbox();
    const result = run(box, ['--yes'], { AH_SHIM_ROTATE_RC: '4' });
    expect(result.status).toBe(4);
    expect(result.stderr).toContain('KEEP BOTH');
    expect(result.stderr).not.toContain('Rotation aborted');
    expect(readFileSync(box.keyPath, 'utf8')).toBe(OLD_KEY);
    expect(existsSync(box.newKeyPath)).toBe(true);
    expect(readFileSync(box.statePath, 'utf8')).toContain('phase=reencrypting');
  });

  /**
   * An exit code the helper never produces means it died before it could report anything — a kill
   * mid-write among the possibilities — so the store may be split. Both key files are kept and the
   * recorded phase sends the operator to `--resume`, which opens each row with whichever key
   * authenticates it.
   */
  it('keeps both key files when the helper died without reporting', () => {
    const box = sandbox();
    const result = run(box, ['--yes'], { AH_SHIM_ROTATE_RC: '137' });
    expect(result.status).toBe(137);
    expect(result.stderr).toContain('KEEP BOTH');
    expect(result.stderr).not.toContain('Rotation aborted');
    expect(existsSync(box.newKeyPath)).toBe(true);
    expect(readFileSync(box.statePath, 'utf8')).toContain('phase=reencrypting');
  });

  /**
   * A salvaging resume that aborts cannot claim the store is intact: rows may still be sealed
   * under `.new` from the run it was resuming, so the file stays.
   */
  it('keeps .new when a salvaging resume aborts', () => {
    const box = sandbox();
    writeFileSync(box.newKeyPath, PENDING_KEY);
    writeState(box, 'reencrypting');
    const result = run(box, ['--yes', '--resume'], { AH_SHIM_ROTATE_RC: '2' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('KEEP BOTH');
    expect(readFileSync(box.newKeyPath, 'utf8')).toBe(PENDING_KEY);
    expect(readFileSync(box.keyPath, 'utf8')).toBe(OLD_KEY);
  });

  /**
   * The helper override is one executable path, not a word list: a path containing a space must
   * still resolve to a single command instead of being split into a missing executable and a
   * stray argument.
   */
  it('runs a helper override whose path contains a space', () => {
    const box = sandbox();
    const shimDir = createShimDir({ log: box.log });
    const helper = writeExtraShim(
      shimDir,
      'helper with space.sh',
      ['printf \'%s\\n\' "rotated 1 secret(s)"', 'exit 0'].join('\n'),
    );
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--yes'],
      env: {
        HOME: box.dir,
        AH_ENV_FILE: box.envFile,
        AH_PORT_BASE: String(box.portBase),
        MASTER_KEY_PATH: box.keyPath,
        AH_SHIM_LOG: box.log,
        AH_DOCTOR_HELPER_CMD: helper,
      },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('rotated 1 secret(s)');
    expect(result.stdout).toContain('Master key rotated');
  });
});

describe('rotate-key.sh usage', () => {
  /**
   * An unrecognised flag exits 2 with a usage line.
   */
  it('rejects an unknown flag', () => {
    const box = sandbox();
    const shimDir = createShimDir({ log: box.log });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--nope'],
      env: {
        HOME: box.dir,
        AH_ENV_FILE: box.envFile,
        MASTER_KEY_PATH: box.keyPath,
        AH_SHIM_LOG: box.log,
      },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage');
  });
});
