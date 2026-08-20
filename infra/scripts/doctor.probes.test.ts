/**
 * Unit tests for the Postgres and Redis rows of `infra/scripts/doctor.sh`.
 *
 * Layer: unit (spawns bash with PATH shims and real ephemeral TCP listeners; no real Docker,
 * Postgres or Redis).
 * Goal: the two rows report what the service answered, not merely that its port accepted a
 * socket; they say only what the outcome vocabulary supports, never that the listener is a
 * different service; and a probe that could not run at all is a third state with its own fix,
 * not folded into the unhealthy-service branch. The listeners the sandbox binds answer nothing,
 * which is exactly the case a bare TCP check called healthy; here the shimmed probe supplies the
 * verdict and the rows are checked against it. The probe itself is proven against a real silent
 * listener in `infra/scripts/lib/service-probes.test.ts`.
 * Mocks: docker/pnpm/openssl/node and the `AH_DOCTOR_HELPER_CMD` helper via
 * `infra/scripts/testing/{shims,doctor-sandbox}.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  closedPortBase,
  greenEnv,
  greenShims,
  helperBody,
  helperShim,
  releaseSandboxes,
  sandbox,
  scriptPath,
} from './testing/doctor-sandbox.js';
import { readShimLog, spawnScript, writeExtraShim } from './testing/shims.js';

afterEach(() => {
  releaseSandboxes();
});

describe('doctor.sh service probes', () => {
  /**
   * The defect these rows were rebuilt for: the check was a bare TCP connect, so ANY listener on
   * the port read as healthy — an unrelated container bound to the database port reported a
   * working Postgres. The listener in this sandbox is exactly that: a socket that accepts and
   * answers nothing. The row now follows the probe's verdict, so it fails, and it says why.
   */
  it('fails the Postgres row when the listener does not answer SELECT 1', async () => {
    const box = await sandbox();
    const shimDir = greenShims(box);
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(box, {
        AH_DOCTOR_HELPER_CMD: helper,
        AH_SHIM_PROBE_LINES: 'POSTGRES=no-select-1\nREDIS=ok',
      }),
    });
    expect(result.status).toBe(1);
    const rows = JSON.parse(result.stdout) as {
      check: string;
      status: string;
      detail: string;
      fix: string;
    }[];
    const postgres = rows.find((row) => row.check === 'Postgres');
    expect(postgres?.status).toBe('✗');
    // What was measured, and nothing more: a socket was accepted and the query went unanswered.
    // A timeout, a refusal and a credential mismatch all arrive as this one outcome, so the row
    // must not claim the listener is some other database.
    expect(postgres?.detail).toContain('something is listening, but SELECT 1 went unanswered');
    expect(postgres?.detail).toContain('no-select-1');
    expect(postgres?.detail).not.toContain('is not agent_hangar_default');
    expect(postgres?.fix).toContain(String(box.portBase + 1));
    expect(rows.find((row) => row.check === 'Redis')?.status).toBe('✓');
    expect(rows.find((row) => row.check === 'Migrations')?.detail).toBe('postgres down');
  });

  /**
   * The same for the cache: a socket that never replies to `PING` is not a Redis.
   */
  it('fails the Redis row when the listener does not answer PING', async () => {
    const box = await sandbox();
    const shimDir = greenShims(box);
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(box, {
        AH_DOCTOR_HELPER_CMD: helper,
        AH_SHIM_PROBE_LINES: 'POSTGRES=ok\nREDIS=no-pong',
      }),
    });
    expect(result.status).toBe(1);
    const rows = JSON.parse(result.stdout) as { check: string; status: string; detail: string }[];
    const redis = rows.find((row) => row.check === 'Redis');
    expect(redis?.status).toBe('✗');
    expect(redis?.detail).toContain('something is listening, but PING went unanswered');
    expect(redis?.detail).not.toContain('is not');
    expect(rows.find((row) => row.check === 'Postgres')?.status).toBe('✓');
  });

  /**
   * A healthy row says what it established, not merely that a port was open.
   */
  it('names the answer each healthy service gave', async () => {
    const box = await sandbox();
    const shimDir = greenShims(box);
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(box, { AH_DOCTOR_HELPER_CMD: helper }),
    });
    expect(result.status).toBe(0);
    const rows = JSON.parse(result.stdout) as { check: string; detail: string }[];
    expect(rows.find((row) => row.check === 'Postgres')?.detail).toContain(
      'agent_hangar_default answered SELECT 1',
    );
    expect(rows.find((row) => row.check === 'Redis')?.detail).toContain('answered PING with PONG');
  });

  /**
   * A probe that cannot run at all is a different problem from an unhealthy service. Folded into
   * the same branch, both rows claimed the listener was not the expected service and recommended
   * bringing infrastructure up — two assertions about a service nobody managed to ask. The row now
   * says the probe did not run, carries the helper's exit code, and its fix is about the probe.
   */
  it('reports a probe that could not run instead of guessing a verdict', async () => {
    const box = await sandbox();
    const shimDir = greenShims(box);
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(box, { AH_DOCTOR_HELPER_CMD: helper, AH_SHIM_PROBE_RC: '9' }),
    });
    expect(result.status).toBe(1);
    const rows = JSON.parse(result.stdout) as {
      check: string;
      status: string;
      detail: string;
      fix: string;
    }[];
    for (const name of ['Postgres', 'Redis']) {
      const row = rows.find((entry) => entry.check === name);
      expect(row?.status).toBe('✗');
      expect(row?.detail).toContain('not probed (helper exit 9)');
      expect(row?.detail).not.toContain('unanswered');
      expect(row?.fix).toContain('service-probes.main.ts');
      expect(row?.fix).not.toContain('infra:up');
    }
  });

  /**
   * With neither port held there is nothing to interrogate, so the probe process is not started
   * at all and both rows report the plain "nothing listening" cause with the `pnpm infra:up` fix.
   */
  it('skips the probe entirely when nothing is listening', async () => {
    const box = await sandbox();
    const shimDir = greenShims(box);
    const helper = writeExtraShim(
      shimDir,
      'logging-helper.sh',
      [
        'log="${AH_SHIM_LOG:?AH_SHIM_LOG is not set}"',
        'printf \'%s\\n\' "helper $1" >> "$log"',
        helperBody(),
      ].join('\n'),
    );
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(box, {
        AH_DOCTOR_HELPER_CMD: helper,
        AH_PORT_BASE: String(closedPortBase()),
      }),
    });
    expect(result.status).toBe(1);
    const rows = JSON.parse(result.stdout) as { check: string; detail: string; fix: string }[];
    expect(rows.find((row) => row.check === 'Postgres')?.detail).toContain('nothing listening');
    expect(rows.find((row) => row.check === 'Redis')?.fix).toBe('pnpm infra:up');
    expect(readShimLog(box.log).some((line) => line.includes('service-probes'))).toBe(false);
  });
});
