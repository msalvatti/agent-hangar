/**
 * Unit tests for `--resume` and for concurrent runs of `infra/scripts/rotate-key.sh`.
 *
 * Layer: unit (spawns bash with PATH shims; no real Postgres, no real `tsx`).
 * Goal: `--resume` recovers from a crash at each phase boundary of the protocol — before
 * re-encryption, during it, after it but before the backup copy, after the copy but before the
 * rename, and after the rename — reaching the same end state from all five; the run refuses to
 * start while the instance's web port answers, because a running process caches the master key and
 * would go on writing under the old one; and the per-key lock makes one rotation at a time a claim
 * rather than a check, including when a second run meets the first inside the critical section.
 * Mocks: `openssl` and `cp`/`mv` via PATH shims; `AH_DOCTOR_HELPER_CMD` shims standing in for the
 * helpers, one of which blocks mid-rotation; a real `node:net` listener standing in for a running
 * instance. The sandbox and the shims live in `infra/scripts/testing/rotate-key-sandbox.ts`.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  GENERATED_KEY,
  OLD_KEY,
  PENDING_KEY,
  backupPaths,
  deadPid,
  fileMode,
  fileOpShims,
  gateHelperShim,
  listen,
  releaseSandboxes,
  run,
  runDetached,
  sandbox,
  writeState,
} from './testing/rotate-key-sandbox.js';
import { createShimDir, readShimLog } from './testing/shims.js';

afterEach(() => {
  releaseSandboxes();
});

describe('rotate-key.sh --resume', () => {
  /**
   * A rotation left half-done is refused outright without `--resume`, and the refusal warns
   * against deleting the file that may hold the only key some rows open under.
   */
  it('refuses an interrupted rotation without --resume', async () => {
    const box = await sandbox();
    writeFileSync(box.newKeyPath, PENDING_KEY);
    writeState(box, 'reencrypting');
    const result = run(box, ['--yes']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--resume');
    expect(result.stderr).toContain('Do not delete');
    expect(readShimLog(box.log)).toEqual([]);
  });

  /**
   * With nothing left behind there is nothing to continue, and the run says so instead of
   * generating a key and re-encrypting under it.
   */
  it('refuses to resume when no rotation is in progress', async () => {
    const box = await sandbox();
    const result = run(box, ['--yes', '--resume']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Nothing to resume');
    expect(readShimLog(box.log)).toEqual([]);
  });

  /**
   * A rotation needs the key it rotates away from: the helper decrypts with it and the backup is
   * a copy of it. Without the file the run stops at once and names both ways back, rather than
   * re-encrypting first and then failing to copy a file that is not there.
   */
  it('refuses to run without a current master key', async () => {
    const box = await sandbox();
    rmSync(box.keyPath);
    writeFileSync(box.newKeyPath, PENDING_KEY);
    const result = run(box, ['--yes', '--resume']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No master key at');
    expect(readShimLog(box.log)).toEqual([]);
    expect(readFileSync(box.newKeyPath, 'utf8')).toBe(PENDING_KEY);
  });

  /**
   * Crash window 1 — the key was generated and the database was never touched. The store is
   * wholly under the current key, so the resume re-encrypts in strict mode, exactly as a fresh run
   * would, and reuses the key that is already on disk rather than generating a second one.
   */
  it('resumes from `prepared` in strict mode without generating a second key', async () => {
    const box = await sandbox();
    writeFileSync(box.newKeyPath, PENDING_KEY);
    writeState(box, 'prepared');
    const result = run(box, ['--yes', '--resume']);

    expect(result.status).toBe(0);
    const log = readShimLog(box.log);
    expect(log.some((line) => line.includes('openssl'))).toBe(false);
    expect(
      log.some((line) => line.startsWith('helper strict') && line.includes('rotate-key')),
    ).toBe(true);
    expect(readFileSync(box.keyPath, 'utf8')).toBe(PENDING_KEY);
    const [backup = ''] = backupPaths(box);
    expect(readFileSync(backup, 'utf8')).toBe(OLD_KEY);
    expect(existsSync(box.statePath)).toBe(false);
  });

  /**
   * Crash window 2 — the helper had started, so rows may be under either key or split between
   * them. The resume re-encrypts in salvage mode, which opens each row with whichever key
   * authenticates it, and then completes the swap.
   */
  it('resumes from `reencrypting` in salvage mode', async () => {
    const box = await sandbox();
    writeFileSync(box.newKeyPath, PENDING_KEY);
    writeState(box, 'reencrypting');
    const result = run(box, ['--yes', '--resume']);

    expect(result.status).toBe(0);
    expect(
      readShimLog(box.log).some(
        (line) => line.startsWith('helper salvage') && line.includes('rotate-key'),
      ),
    ).toBe(true);
    expect(readFileSync(box.keyPath, 'utf8')).toBe(PENDING_KEY);
    expect(existsSync(box.statePath)).toBe(false);
  });

  /**
   * The state file itself can be lost. `.new` alone says a rotation was interrupted but not how
   * far it got, so the widest assumption is taken: salvage, which is correct for every state the
   * store can be in before the swap.
   */
  it('salvages when the state file is gone but .new is not', async () => {
    const box = await sandbox();
    writeFileSync(box.newKeyPath, PENDING_KEY);
    const result = run(box, ['--yes', '--resume']);

    expect(result.status).toBe(0);
    const log = readShimLog(box.log);
    expect(log.some((line) => line.includes('openssl'))).toBe(false);
    expect(
      log.some((line) => line.startsWith('helper salvage') && line.includes('rotate-key')),
    ).toBe(true);
    expect(readFileSync(box.keyPath, 'utf8')).toBe(PENDING_KEY);
  });

  /**
   * Crash window 3 — the whole store was re-encrypted and the crash landed before any file moved.
   * This is the window that used to lose every credential: `master.key` still held the old key
   * while every row was sealed under the new one, and re-running the helper aborted. The resume
   * now skips the helper entirely — proving the swap finishes even with the database unreachable
   * — and completes the rotation from the recorded phase alone.
   */
  it('resumes from `reencrypted` without touching the database', async () => {
    const box = await sandbox();
    const backup = `${box.keyPath}.bak-20260819000000`;
    writeFileSync(box.newKeyPath, PENDING_KEY);
    writeState(box, 'reencrypted', backup);
    const result = run(box, ['--yes', '--resume']);

    expect(result.status).toBe(0);
    expect(readShimLog(box.log).some((line) => line.includes('rotate-key'))).toBe(false);
    expect(readFileSync(box.keyPath, 'utf8')).toBe(PENDING_KEY);
    expect(readFileSync(backup, 'utf8')).toBe(OLD_KEY);
    expect(fileMode(backup)).toBe('600');
    expect(existsSync(box.newKeyPath)).toBe(false);
    expect(existsSync(box.statePath)).toBe(false);
  });

  /**
   * Crash window 4 — the backup copy was already made and the rename had not run. `master.key`
   * still held the old material at that instant, which is the point of copying before renaming.
   * The resume finishes the rename and must not overwrite the backup, which is the only remaining
   * copy of the previous key.
   */
  it('resumes from `reencrypted` with the backup already written', async () => {
    const box = await sandbox();
    const backup = `${box.keyPath}.bak-20260819000000`;
    writeFileSync(backup, OLD_KEY, { mode: 0o600 });
    writeFileSync(box.newKeyPath, PENDING_KEY);
    writeState(box, 'reencrypted', backup);
    const shimDir = createShimDir({ log: box.log });
    fileOpShims(shimDir);
    const result = run(box, ['--yes', '--resume'], {}, shimDir);

    expect(result.status).toBe(0);
    expect(readShimLog(box.log).some((line) => line.startsWith('cp '))).toBe(false);
    expect(readFileSync(backup, 'utf8')).toBe(OLD_KEY);
    expect(readFileSync(box.keyPath, 'utf8')).toBe(PENDING_KEY);
    expect(existsSync(box.statePath)).toBe(false);
  });

  /**
   * Crash window 5 — the rename had already happened and only the state file was left. Nothing
   * remains to redo: the resume clears the state and neither the current key nor the backup moves.
   */
  it('resumes from `reencrypted` after the rename already happened', async () => {
    const box = await sandbox();
    const backup = `${box.keyPath}.bak-20260819000000`;
    writeFileSync(backup, OLD_KEY, { mode: 0o600 });
    writeFileSync(box.keyPath, PENDING_KEY);
    writeState(box, 'reencrypted', backup);
    const result = run(box, ['--yes', '--resume']);

    expect(result.status).toBe(0);
    expect(readFileSync(box.keyPath, 'utf8')).toBe(PENDING_KEY);
    expect(readFileSync(backup, 'utf8')).toBe(OLD_KEY);
    expect(existsSync(box.statePath)).toBe(false);
  });

  /**
   * A state file that claims the swap phase without naming the backup cannot be acted on: copying
   * to an empty path is not a backup, and renaming without one would leave the previous key
   * material nowhere. The run stops and says what is wrong instead.
   */
  it('refuses a state file that records the swap phase without a backup path', async () => {
    const box = await sandbox();
    writeFileSync(box.newKeyPath, PENDING_KEY);
    writeState(box, 'reencrypted');
    const result = run(box, ['--yes', '--resume']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Corrupt rotation state');
    expect(readFileSync(box.keyPath, 'utf8')).toBe(OLD_KEY);
    expect(existsSync(box.newKeyPath)).toBe(true);
  });
});

describe('rotate-key.sh with the instance running', () => {
  /**
   * Rotating under a live app loses credentials two ways: a Settings write landing between the
   * reveal and the re-encryption is silently replaced by the value revealed earlier, and one
   * landing afterwards is sealed with the old key — which the running process keeps using anyway,
   * because MasterKeyFile caches it for the lifetime of the process. So the run refuses to start
   * while the instance's web port answers, and nothing is touched.
   */
  it('refuses to rotate and touches nothing', async () => {
    const box = await sandbox();
    await listen(box.portBase);
    const result = run(box, ['--yes']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(String(box.portBase));
    expect(result.stderr).toContain('caches the master key');
    expect(readFileSync(box.keyPath, 'utf8')).toBe(OLD_KEY);
    expect(existsSync(box.newKeyPath)).toBe(false);
    expect(existsSync(box.statePath)).toBe(false);
    expect(readShimLog(box.log)).toEqual([]);
  });

  /**
   * A resume is refused on the same grounds: finishing an interrupted rotation swaps the key
   * files, which is exactly what a live process must not have happen under it.
   */
  it('refuses to resume as well', async () => {
    const box = await sandbox();
    writeFileSync(box.newKeyPath, PENDING_KEY);
    writeState(box, 'reencrypted', `${box.keyPath}.bak-20260819000000`);
    await listen(box.portBase);
    const result = run(box, ['--yes', '--resume']);

    expect(result.status).toBe(1);
    expect(readFileSync(box.keyPath, 'utf8')).toBe(OLD_KEY);
    expect(readFileSync(box.newKeyPath, 'utf8')).toBe(PENDING_KEY);
  });

  /**
   * The plan is read-only, so it still prints while the app runs — the operator has to be able to
   * see what a rotation would do before stopping anything.
   */
  it('still prints the plan', async () => {
    const box = await sandbox();
    await listen(box.portBase);
    const result = run(box, []);

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('Plan (not run without --yes)');
  });
});

describe('rotate-key.sh concurrency', () => {
  /**
   * The interleaving the lock exists for. The state-file check alone is a check, not a claim: two
   * --yes runs could both find no rotation in progress before either created `.new`, then
   * re-encrypt the same rows independently and overwrite each other's key and state files, leaving
   * the installed key and the stored ciphertext mismatched. Here the first run is held inside the
   * re-encryption step — squarely inside the section — and the second must refuse rather than
   * proceed, without disturbing anything the first is holding.
   */
  it('refuses a second run that meets the first inside the critical section', async () => {
    const box = await sandbox();
    const shimDir = createShimDir({ log: box.log });
    const started = join(box.dir, 'gate-started');
    const release = join(box.dir, 'gate-release');
    const gate = gateHelperShim(shimDir, started, release);

    const first = runDetached(box, ['--yes'], { AH_DOCTOR_HELPER_CMD: gate }, shimDir);
    await expect.poll(() => existsSync(started)).toBe(true);

    // The first run now holds the lock and its `.new` exists; the second must bounce off it.
    const second = run(box, ['--yes']);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain('Another rotation is already running');
    expect(readFileSync(box.statePath, 'utf8')).toContain('phase=reencrypting');
    expect(readFileSync(box.newKeyPath, 'utf8')).toBe(GENERATED_KEY);
    expect(readFileSync(box.keyPath, 'utf8')).toBe(OLD_KEY);

    writeFileSync(release, '');
    expect(await first.exitCode).toBe(0);

    // The first run finishes normally and leaves nothing behind for the next one.
    expect(readFileSync(box.keyPath, 'utf8')).toBe(GENERATED_KEY);
    expect(existsSync(box.statePath)).toBe(false);
    expect(existsSync(`${box.keyPath}.lock`)).toBe(false);
  });

  /**
   * A lock is released however the run ends, so a failed rotation does not wedge the next one.
   */
  it('releases the lock when the rotation fails', async () => {
    const box = await sandbox();
    const result = run(box, ['--yes'], { AH_SHIM_ROTATE_RC: '3' });

    expect(result.status).toBe(3);
    expect(existsSync(`${box.keyPath}.lock`)).toBe(false);
    expect(run(box, ['--yes']).status).toBe(0);
  });

  /**
   * A lock left behind by a killed run must not block every future rotation — that would be a
   * denial of service dressed as safety — so one whose recorded process is gone is reclaimed, and
   * the operator is told it happened rather than it being silently swallowed.
   */
  it('reclaims a lock whose owner is no longer running', async () => {
    const box = await sandbox();
    const stale = deadPid();
    writeFileSync(`${box.keyPath}.lock`, `${String(stale)}\n`);

    const result = run(box, ['--yes']);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('Removed a rotation lock left behind');
    expect(result.stderr).toContain(String(stale));
    expect(readFileSync(box.keyPath, 'utf8')).toBe(GENERATED_KEY);
    expect(existsSync(`${box.keyPath}.lock`)).toBe(false);
  });

  /**
   * The complement, which is what stops the reclaim from turning the lock into a suggestion: a
   * lock whose owner is alive is never taken, whatever this run would like to do.
   */
  it('never takes a lock whose owner is alive', async () => {
    const box = await sandbox();
    // This test process is unquestionably running, so it stands in for a live rotation.
    writeFileSync(`${box.keyPath}.lock`, `${String(process.pid)}\n`);

    const result = run(box, ['--yes']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Another rotation is already running');
    expect(readFileSync(box.keyPath, 'utf8')).toBe(OLD_KEY);
    expect(existsSync(box.newKeyPath)).toBe(false);
    // The live owner's lock is still there, untouched.
    expect(readFileSync(`${box.keyPath}.lock`, 'utf8')).toBe(`${String(process.pid)}\n`);
  });

  /**
   * A lock file with no readable owner is the trace of a run killed before it could name itself.
   * Nothing is alive to protect, so it is reclaimed on the same terms.
   */
  it('reclaims a lock that names no owner', async () => {
    const box = await sandbox();
    writeFileSync(`${box.keyPath}.lock`, '');

    const result = run(box, ['--yes']);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('Removed a rotation lock left behind');
    expect(existsSync(`${box.keyPath}.lock`)).toBe(false);
  });
});
