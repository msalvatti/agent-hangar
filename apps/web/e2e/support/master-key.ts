/**
 * The master key file the web server and the worker read during a real-stack run.
 *
 * Layer: test support (touches the file system).
 *
 * The secrets module refuses a key whose file or whose directory grants anything to group or
 * other, so writing one is a statement about permissions as much as about content. It lives apart
 * from the stack preparation that calls it because that module is an entry point — it runs the
 * whole preparation on import — and this decision is worth pinning on its own.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';

import type { E2eEnv } from './env';

/** Bytes of the master key; the secrets module expects a 32-byte hex key. */
const MASTER_KEY_BYTES = 32;

/** Permissions of the master key file: readable by its owner only. */
export const MASTER_KEY_MODE = 0o600;

/**
 * Permissions of the directory holding it. The secrets module refuses a key whose directory group
 * or others can reach — write access to the directory is enough to replace the key — so `mkdir`
 * alone is not sufficient: the mode it applies is filtered by the umask, and a directory that
 * already exists keeps whatever permissions it had.
 */
export const MASTER_KEY_DIR_MODE = 0o700;

/** Where a run's master key is written, and the directory it lives in. */
export type MasterKeyPaths = Pick<E2eEnv, 'masterKeyPath' | 'tmpDir'>;

/**
 * Writes a fresh master key for this run, in the shape and with the permissions it demands.
 *
 * Both modes are applied twice, and for the same reason in each case: the mode passed to a call
 * that creates something is honoured only when it does create it. `mkdirSync` leaves an existing
 * directory's permissions alone, and `writeFileSync` applies its `mode` only on the `O_CREAT` that
 * makes the file — so a key file left by an earlier run would keep whatever it had, exposing the
 * fresh key and making the secrets module refuse it at boot. The `chmod` after each is what makes
 * the permissions a property of this run rather than of what it found.
 *
 * @param env - The paths this run writes its key to.
 */
export function writeMasterKey(env: MasterKeyPaths): void {
  mkdirSync(env.tmpDir, { recursive: true, mode: MASTER_KEY_DIR_MODE });
  chmodSync(env.tmpDir, MASTER_KEY_DIR_MODE);
  writeFileSync(env.masterKeyPath, `${randomBytes(MASTER_KEY_BYTES).toString('hex')}\n`, {
    mode: MASTER_KEY_MODE,
  });
  chmodSync(env.masterKeyPath, MASTER_KEY_MODE);
}
