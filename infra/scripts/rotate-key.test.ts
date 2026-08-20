/**
 * Unit tests for `infra/scripts/rotate-key.sh`.
 *
 * Layer: unit (spawns bash with PATH shims; no real Postgres, no real `tsx`).
 * Goal: without `--yes` nothing runs and the plan is printed; a successful rotation puts the new
 * key in place, keeps a mode-600 backup and clears the rotation state; a failure the helper could
 * undo leaves the current key untouched and removes the half-written `.new`, while every failure
 * it could not undo keeps both key files; and `--resume` recovers from a crash at each phase
 * boundary of the protocol — before re-encryption, during it, after it but before the backup copy,
 * after the copy but before the rename, and after the rename — reaching the same end state from
 * all five, without ever leaving the key path empty.
 * Mocks: `openssl`, and (for the swap-order assertions) `cp`/`mv`, via PATH shims; a bespoke
 * `AH_DOCTOR_HELPER_CMD` shim standing in for the secrets-status/rotate-key helpers; a real
 * `node:net` listener standing in for a running instance.
 */
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createShimDir, readShimLog, spawnScript, writeExtraShim } from './testing/shims.js';

const scriptPath = fileURLToPath(new URL('./rotate-key.sh', import.meta.url));

/** Key material of the file the sandbox starts with. */
const OLD_KEY = `${'a'.repeat(64)}\n`;

/** Key material of a `.new` file a crashed rotation left behind. */
const PENDING_KEY = `${'b'.repeat(64)}\n`;

/** Key material the shimmed `openssl rand -hex 32` produces. */
const GENERATED_KEY = `${'0'.repeat(64)}\n`;

const dirs: string[] = [];
const servers: Server[] = [];

interface Sandbox {
  dir: string;
  log: string;
  keyPath: string;
  statePath: string;
  newKeyPath: string;
  portBase: number;
}

/**
 * Binds a loopback listener on an OS-chosen port.
 *
 * @param port - Port to bind; `0` lets the OS choose.
 * @returns The listening server.
 */
function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      servers.push(server);
      resolve(server);
    });
  });
}

/**
 * Reserves a port base whose web port (`base + 0`) nothing is listening on.
 *
 * The script probes that port to decide whether the instance is running, so every test that is
 * not about that check has to name a base where the probe finds nothing. The port is bound and
 * released rather than merely guessed: the OS hands out ephemeral ports in rotation rather than
 * reissuing the one just returned, so it stays free for the length of one test.
 *
 * @returns A base whose web port is free.
 */
async function freePortBase(): Promise<number> {
  const server = await listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  servers.pop();
  return port;
}

async function sandbox(): Promise<Sandbox> {
  const dir = mkdtempSync(join(tmpdir(), 'ah-rotate-'));
  dirs.push(dir);
  const keyPath = join(dir, 'master.key');
  writeFileSync(keyPath, OLD_KEY);
  chmodSync(keyPath, 0o600);
  return {
    dir,
    log: join(dir, 'log'),
    keyPath,
    statePath: `${keyPath}.rotation`,
    newKeyPath: `${keyPath}.new`,
    portBase: await freePortBase(),
  };
}

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()?.close();
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function helperShim(shimDir: string): string {
  return writeExtraShim(
    shimDir,
    'helper.sh',
    [
      'log="${AH_SHIM_LOG:?AH_SHIM_LOG is not set}"',
      // The mode is what tells a strict rotation from a salvaging resume, and it reaches the
      // helper through the environment rather than the command line, so it is logged here.
      'printf \'%s\\n\' "helper ${AH_ROTATION_MODE:-none} $1" >> "$log"',
      'case "$1" in',
      '  *secrets-status*)',
      '    printf \'%s\\n\' "${AH_SHIM_SECRETS_LINES:-GITHUB_PAT=set:ab12}"',
      '    exit "${AH_SHIM_SECRETS_RC:-0}"',
      '    ;;',
      '  *rotate-key*)',
      '    printf \'%s\\n\' "${AH_SHIM_ROTATE_LINE:-rotated 1 secret(s) to keyVersion 2}"',
      '    exit "${AH_SHIM_ROTATE_RC:-0}"',
      '    ;;',
      'esac',
      'exit 9',
    ].join('\n'),
  );
}

/**
 * Shims `cp` and `mv` so a test can see the exact order the key files were moved in, then
 * delegates to the real tool.
 *
 * @param shimDir - Shim directory prepended to PATH.
 */
function fileOpShims(shimDir: string): void {
  for (const name of ['cp', 'mv'] as const) {
    writeExtraShim(
      shimDir,
      name,
      [
        'log="${AH_SHIM_LOG:?AH_SHIM_LOG is not set}"',
        `printf '%s\\n' "${name} $*" >> "$log"`,
        `exec /bin/${name} "$@"`,
      ].join('\n'),
    );
  }
}

/**
 * Writes the rotation state file a crashed run would have left behind.
 *
 * @param box - The sandbox.
 * @param phase - Phase recorded in the file.
 * @param backup - Backup path recorded in the file; empty before the swap phase.
 */
function writeState(box: Sandbox, phase: string, backup = ''): void {
  writeFileSync(box.statePath, `phase=${phase}\nbackup=${backup}\n`, { mode: 0o600 });
}

/**
 * Runs the script with the standard helper shim.
 *
 * @param box - The sandbox.
 * @param args - Command-line arguments.
 * @param env - Extra environment variables.
 * @param shimDir - Shim directory to use; a fresh one when omitted.
 * @returns The captured outcome.
 */
function run(
  box: Sandbox,
  args: string[],
  env: Record<string, string> = {},
  shimDir = createShimDir({ log: box.log }),
): ReturnType<typeof spawnScript> {
  const helper = helperShim(shimDir);
  return spawnScript(scriptPath, {
    shimDir,
    args,
    env: {
      HOME: box.dir,
      AH_PORT_BASE: String(box.portBase),
      MASTER_KEY_PATH: box.keyPath,
      AH_SHIM_LOG: box.log,
      AH_DOCTOR_HELPER_CMD: helper,
      ...env,
    },
  });
}

function fileMode(path: string): string {
  return (statSync(path).mode & 0o777).toString(8);
}

/**
 * Lists the backup files the sandbox holds, oldest name first.
 *
 * @param box - The sandbox.
 * @returns Their absolute paths.
 */
function backupPaths(box: Sandbox): string[] {
  return readdirSync(box.dir)
    .filter((name) => name.startsWith('master.key.bak-'))
    .sort()
    .map((name) => join(box.dir, name));
}

/**
 * Finds the single backup file the sandbox holds.
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
  it('prints the plan and exits 2', async () => {
    const box = await sandbox();
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
  it('names an interrupted rotation and its phase', async () => {
    const box = await sandbox();
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
  it('rotates the key and keeps a mode-600 backup of the old one', async () => {
    const box = await sandbox();
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
  it('never reuses a backup name two rotations computed in the same second', async () => {
    const box = await sandbox();
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
  it('updates the rotation state by renaming a sibling over it', async () => {
    const box = await sandbox();
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
  it('copies the old key aside and renames the new one over it', async () => {
    const box = await sandbox();
    const shimDir = createShimDir({ log: box.log });
    fileOpShims(shimDir);
    const result = run(box, ['--yes'], {}, shimDir);
    expect(result.status).toBe(0);

    const log = readShimLog(box.log);
    expect(log).toContain(`cp ${box.keyPath} ${backupPath(box)}`);
    expect(log).toContain(`mv ${box.newKeyPath} ${box.keyPath}`);
    expect(log.some((line) => line.startsWith(`mv ${box.keyPath} `))).toBe(false);
    expect(log.indexOf(`cp ${box.keyPath} ${backupPath(box)}`)).toBeLessThan(
      log.indexOf(`mv ${box.newKeyPath} ${box.keyPath}`),
    );
  });
});

describe('rotate-key.sh --yes failure', () => {
  /**
   * A rollback the helper completed (exit 3) puts every row back under the current key, so the
   * half-written `.new` and the rotation state can both go.
   */
  it('leaves the current key unchanged and removes .new after a completed rollback', async () => {
    const box = await sandbox();
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
  it('removes .new after a strict abort', async () => {
    const box = await sandbox();
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
  it('keeps .new and names both files when the rollback itself failed', async () => {
    const box = await sandbox();
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
  it('keeps both key files when the helper died without reporting', async () => {
    const box = await sandbox();
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
  it('keeps .new when a salvaging resume aborts', async () => {
    const box = await sandbox();
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
  it('runs a helper override whose path contains a space', async () => {
    const box = await sandbox();
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
    expect(readFileSync(backupPath(box), 'utf8')).toBe(OLD_KEY);
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

describe('rotate-key.sh usage', () => {
  /**
   * An unrecognised flag exits 2 with a usage line.
   */
  it('rejects an unknown flag', async () => {
    const box = await sandbox();
    const shimDir = createShimDir({ log: box.log });
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--nope'],
      env: { HOME: box.dir, MASTER_KEY_PATH: box.keyPath, AH_SHIM_LOG: box.log },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage');
  });
});
