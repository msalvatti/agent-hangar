/**
 * Unit tests for the rows of `infra/scripts/doctor.sh`.
 *
 * Layer: unit (spawns bash with PATH shims and real ephemeral TCP listeners; no real Docker,
 * Postgres or Redis).
 * Goal: an all-green machine exits 0; each required failure (Docker down, image missing, wrong
 * key mode, service absent, migrations pending) reports the documented fix and exits 1; the
 * optional Secrets/OpenAI rows never fail the exit code and skip in the documented cascade;
 * `--json` parses into 10 objects with the four documented keys. The Postgres/Redis service
 * probes have their own file, `doctor.probes.test.ts`.
 * Mocks: docker/pnpm/openssl/node and the `AH_DOCTOR_HELPER_CMD` helper via
 * `infra/scripts/testing/{shims,doctor-sandbox}.ts`.
 */
import { chmodSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import {
  closedPortBase,
  greenDocker,
  greenEnv,
  greenPnpm,
  greenShims,
  helperBody,
  helperShim,
  releaseSandboxes,
  sandbox,
  scriptPath,
} from './testing/doctor-sandbox.js';
import { createShimDir, spawnScript, writeExtraShim, writeGnuStatShim } from './testing/shims.js';

afterEach(() => {
  releaseSandboxes();
});

describe('doctor.sh — all green', () => {
  /**
   * The helper command override is one executable path, not a word list: a path containing a
   * space must still resolve to a single command. Splitting it on whitespace would look for an
   * executable that does not exist and turn the Secrets row into a helper error.
   */
  it('runs a helper override whose path contains a space', async () => {
    const box = await sandbox();
    const shimDir = greenShims(box);
    const helperPath = writeExtraShim(shimDir, 'helper with space.sh', helperBody());
    const result = spawnScript(scriptPath, {
      shimDir,
      env: greenEnv(box, { AH_DOCTOR_HELPER_CMD: helperPath }),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('GitHub PAT: set (…ab12)');
    expect(result.stdout).not.toContain('helper error');
  });

  /**
   * Every required row passes and both optional rows report success: exit 0.
   */
  it('exits 0 when every check passes', async () => {
    const box = await sandbox();
    const shimDir = greenShims(box);
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      env: greenEnv(box, { AH_DOCTOR_HELPER_CMD: helper }),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('All required checks passed');
    expect(result.stdout).toContain('instance=default');
    for (const symbol of ['✓']) {
      expect(result.stdout).toContain(symbol);
    }
  });

  /**
   * `--json` parses into 10 objects, each with the four documented keys.
   */
  it('--json prints 10 rows with the documented keys', async () => {
    const box = await sandbox();
    const shimDir = greenShims(box);
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(box, { AH_DOCTOR_HELPER_CMD: helper }),
    });
    expect(result.status).toBe(0);
    const rows = JSON.parse(result.stdout) as {
      check: string;
      status: string;
      detail: string;
      fix: string;
    }[];
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['check', 'detail', 'fix', 'status']);
    }
    expect(rows.map((row) => row.check)).toEqual([
      'Node',
      'pnpm',
      'Docker socket',
      'Postgres',
      'Redis',
      'Migrations',
      'Workspace image',
      'Master key',
      'Secrets',
      'OpenAI model',
    ]);
  });
});

describe('doctor.sh — required failures', () => {
  /**
   * The root manifest asks for `"node": ">=24 <25"` and pnpm refuses to install outside that
   * range, so the diagnostic has to refuse the same set. A major below the floor is the case the
   * lower-bound check always covered.
   */
  it('reports a Node below the supported major with the required range', async () => {
    const box = await sandbox();
    const shimDir = createShimDir({
      log: box.log,
      docker: greenDocker(),
      pnpm: greenPnpm(),
      nodeVersion: 'v22.23.2',
    });
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(box, { AH_DOCTOR_HELPER_CMD: helper }),
    });
    expect(result.status).toBe(1);
    const rows = JSON.parse(result.stdout) as {
      check: string;
      status: string;
      detail: string;
      fix: string;
    }[];
    const node = rows.find((row) => row.check === 'Node');
    expect(node?.status).toBe('✗');
    expect(node?.detail).toBe('v22.23.2');
    expect(node?.fix).toContain('>=24 <25');
  });

  /**
   * The case a lower bound alone got wrong: a major *above* the range satisfies `>= 24` but not
   * `engines.node`, so `pnpm install` now stops on it. A green Node row there would send a reader
   * looking for the problem everywhere except the version they are running.
   */
  it('reports a Node above the supported major with the required range', async () => {
    const box = await sandbox();
    const shimDir = createShimDir({
      log: box.log,
      docker: greenDocker(),
      pnpm: greenPnpm(),
      nodeVersion: 'v25.0.0',
    });
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(box, { AH_DOCTOR_HELPER_CMD: helper }),
    });
    expect(result.status).toBe(1);
    const rows = JSON.parse(result.stdout) as {
      check: string;
      status: string;
      detail: string;
      fix: string;
    }[];
    const node = rows.find((row) => row.check === 'Node');
    expect(node?.status).toBe('✗');
    expect(node?.detail).toBe('v25.0.0');
    expect(node?.fix).toContain('>=24 <25');
  });

  /**
   * Docker unreachable: the socket row is ✗ with the R2 fix, the image row is skipped, exit 1.
   */
  it('reports Docker down with the R2 fix and skips the image row', async () => {
    const box = await sandbox();
    const shimDir = greenShims(box, greenDocker({ availability: 'down' }), greenPnpm());
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(box, { AH_DOCTOR_HELPER_CMD: helper }),
    });
    expect(result.status).toBe(1);
    const rows = JSON.parse(result.stdout) as { check: string; status: string; fix: string }[];
    const docker = rows.find((row) => row.check === 'Docker socket');
    const image = rows.find((row) => row.check === 'Workspace image');
    expect(docker?.status).toBe('✗');
    expect(docker?.fix).toContain('DOCKER_HOST=unix://');
    expect(image?.status).toBe('–');
  });

  /**
   * The workspace image is missing: fix is `pnpm infra:image`.
   */
  it('reports a missing workspace image with pnpm infra:image', async () => {
    const box = await sandbox();
    const shimDir = greenShims(box, greenDocker({ image: 'missing' }), greenPnpm());
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(box, { AH_DOCTOR_HELPER_CMD: helper }),
    });
    expect(result.status).toBe(1);
    const rows = JSON.parse(result.stdout) as { check: string; status: string; fix: string }[];
    const image = rows.find((row) => row.check === 'Workspace image');
    expect(image).toEqual({
      check: 'Workspace image',
      status: '✗',
      detail: 'missing',
      fix: 'pnpm infra:image',
    });
  });

  /**
   * The workspace image is present but was built from other sources. Present is not the question
   * the row answers: an image that lags the checkout starts containers running code that is in no
   * tree, and every turn taken through them succeeds, so nothing else on the machine reports it.
   * The fix is the same one command.
   */
  it('reports a workspace image built from other sources with pnpm infra:image', async () => {
    const box = await sandbox();
    const shimDir = greenShims(box);
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(box, {
        AH_DOCTOR_HELPER_CMD: helper,
        AH_SHIM_IMAGE_DIGEST: 'c'.repeat(64),
      }),
    });
    expect(result.status).toBe(1);
    const rows = JSON.parse(result.stdout) as { check: string; status: string; fix: string }[];
    expect(rows.find((row) => row.check === 'Workspace image')).toEqual({
      check: 'Workspace image',
      status: '✗',
      detail: 'built from other sources',
      fix: 'pnpm infra:image',
    });
  });

  /**
   * A master key file with mode 644 is refused with `chmod 600`, and the Secrets row is skipped.
   */
  it('reports a wrongly-permissioned master key with chmod 600', async () => {
    const box = await sandbox();
    chmodSync(box.keyPath, 0o644);
    const shimDir = greenShims(box);
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(box, { AH_DOCTOR_HELPER_CMD: helper }),
    });
    expect(result.status).toBe(1);
    const rows = JSON.parse(result.stdout) as {
      check: string;
      status: string;
      fix: string;
      detail: string;
    }[];
    const key = rows.find((row) => row.check === 'Master key');
    expect(key?.status).toBe('✗');
    expect(key?.fix).toContain('chmod 600');
    const secrets = rows.find((row) => row.check === 'Secrets');
    expect(secrets?.status).toBe('–');
  });

  /**
   * A missing master key reports the `pnpm setup` fix.
   */
  it('reports a missing master key with pnpm setup', async () => {
    const box = await sandbox();
    rmSync(box.keyPath);
    const shimDir = greenShims(box);
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(box, { AH_DOCTOR_HELPER_CMD: helper }),
    });
    const rows = JSON.parse(result.stdout) as { check: string; status: string; fix: string }[];
    const key = rows.find((row) => row.check === 'Master key');
    expect(key).toEqual({ check: 'Master key', status: '✗', detail: 'missing', fix: 'pnpm setup' });
  });

  /**
   * Postgres unreachable: the Postgres row is ✗, Migrations and Secrets are skipped with
   * "postgres down"/"master key or database unavailable", and OpenAI model is skipped too
   * (nothing reports the key as set).
   */
  it('cascades Postgres-down into the dependent rows', async () => {
    const box = await sandbox();
    const shimDir = greenShims(box);
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(box, {
        AH_DOCTOR_HELPER_CMD: helper,
        AH_PORT_BASE: String(closedPortBase()),
      }),
    });
    expect(result.status).toBe(1);
    const rows = JSON.parse(result.stdout) as { check: string; status: string; detail: string }[];
    expect(rows.find((row) => row.check === 'Postgres')?.status).toBe('✗');
    expect(rows.find((row) => row.check === 'Migrations')).toEqual({
      check: 'Migrations',
      status: '–',
      detail: 'postgres down',
      fix: '',
    });
    expect(rows.find((row) => row.check === 'Secrets')?.status).toBe('–');
    expect(rows.find((row) => row.check === 'OpenAI model')?.status).toBe('–');
  });

  /**
   * Pending migrations report the `pnpm db:migrate` fix.
   */
  it('reports pending migrations with pnpm db:migrate', async () => {
    const box = await sandbox();
    const shimDir = greenShims(box, greenDocker(), greenPnpm({ migrateStatusExitCode: 1 }));
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(box, { AH_DOCTOR_HELPER_CMD: helper }),
    });
    expect(result.status).toBe(1);
    const rows = JSON.parse(result.stdout) as { check: string; status: string; fix: string }[];
    const migrations = rows.find((row) => row.check === 'Migrations');
    expect(migrations).toEqual({
      check: 'Migrations',
      status: '✗',
      detail: 'pending',
      fix: 'pnpm db:migrate',
    });
  });
});

describe('doctor.sh master key validation', () => {
  /**
   * The diagnostic used to check only that the key file existed with the right mode, so a file
   * that no reader can actually load — content that is not 64 hex characters — failed further
   * down, in the OPTIONAL secrets row, where it rendered as a skip and left the whole run exiting
   * 0. A required dependency that fails must fail a required row.
   */
  it('fails the required key row on a malformed key', async () => {
    const box = await sandbox();
    writeFileSync(box.keyPath, 'not-a-key\n');
    chmodSync(box.keyPath, 0o600);
    const shimDir = greenShims(box);
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(box, { AH_DOCTOR_HELPER_CMD: helper }),
    });

    expect(result.status).toBe(1);
    const rows = JSON.parse(result.stdout) as { check: string; status: string; detail: string }[];
    const key = rows.find((row) => row.check === 'Master key');
    expect(key?.status).toBe('✗');
    expect(key?.detail).toContain('malformed');
  });

  /**
   * Right length, right characters, wrong count still cannot be loaded.
   */
  it('fails the required key row on a key of the wrong length', async () => {
    const box = await sandbox();
    writeFileSync(box.keyPath, `${'0'.repeat(63)}\n`);
    chmodSync(box.keyPath, 0o600);
    const shimDir = greenShims(box);
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(box, { AH_DOCTOR_HELPER_CMD: helper }),
    });

    expect(result.status).toBe(1);
    const rows = JSON.parse(result.stdout) as { check: string; status: string; detail: string }[];
    expect(rows.find((row) => row.check === 'Master key')?.detail).toContain('63 of 64');
  });

  /**
   * `MasterKeyFile` opens the key with O_NOFOLLOW and refuses a symbolic link outright, so a link
   * pointing at a perfectly good key is still a key the app cannot load. The check follows the
   * loader rather than the filesystem.
   */
  it('fails the required key row on a symlinked key', async () => {
    const box = await sandbox();
    const target = `${box.keyPath}.real`;
    renameSync(box.keyPath, target);
    symlinkSync(target, box.keyPath);
    const shimDir = greenShims(box);
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(box, { AH_DOCTOR_HELPER_CMD: helper }),
    });

    expect(result.status).toBe(1);
    const rows = JSON.parse(result.stdout) as { check: string; status: string; fix: string }[];
    const key = rows.find((row) => row.check === 'Master key');
    expect(key?.status).toBe('✗');
    expect(key?.fix).toContain('regular file');
  });
});

describe('doctor.sh — optional rows never fail the exit code', () => {
  /**
   * An unset secret reports a warning with a Settings-page fix and does not fail the exit code;
   * the OpenAI row is skipped because no key is set.
   */
  it('reports unset secrets as a warning without failing the run', async () => {
    const box = await sandbox();
    const shimDir = greenShims(box);
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(box, {
        AH_DOCTOR_HELPER_CMD: helper,
        AH_SHIM_SECRETS_LINES: 'GITHUB_PAT=set:ab12\nOPENAI_API_KEY=unset',
      }),
    });
    expect(result.status).toBe(0);
    const rows = JSON.parse(result.stdout) as {
      check: string;
      status: string;
      detail: string;
      fix: string;
    }[];
    const secrets = rows.find((row) => row.check === 'Secrets');
    expect(secrets?.status).toBe('⚠');
    expect(secrets?.detail).toBe('GitHub PAT: set (…ab12) · OpenAI key: unset');
    expect(secrets?.fix).toBe(
      `Open http://127.0.0.1:${String(box.portBase)}/settings and save the missing key`,
    );
    const openai = rows.find((row) => row.check === 'OpenAI model');
    expect(openai).toEqual({
      check: 'OpenAI model',
      status: '–',
      detail: 'no OpenAI key',
      fix: '',
    });
  });

  /**
   * An OpenAI key that is set and reachable reports the model id, still exit 0.
   */
  it('reports the OpenAI model as reachable when the key is set', async () => {
    const box = await sandbox();
    const shimDir = greenShims(box);
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(box, { AH_DOCTOR_HELPER_CMD: helper }),
    });
    expect(result.status).toBe(0);
    const rows = JSON.parse(result.stdout) as { check: string; status: string; detail: string }[];
    expect(rows.find((row) => row.check === 'OpenAI model')).toEqual({
      check: 'OpenAI model',
      status: '✓',
      detail: 'gpt-5.6-sol',
      fix: '',
    });
  });

  /**
   * A model-missing outcome from the OpenAI helper is a warning, not a failure.
   */
  it('reports model-missing as a warning', async () => {
    const box = await sandbox();
    const shimDir = greenShims(box);
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(box, {
        AH_DOCTOR_HELPER_CMD: helper,
        AH_SHIM_OPENAI_LINE: 'model-missing gpt-5.6-sol (available: a, b)',
        AH_SHIM_OPENAI_RC: '5',
      }),
    });
    expect(result.status).toBe(0);
    const rows = JSON.parse(result.stdout) as {
      check: string;
      status: string;
      detail: string;
      fix: string;
    }[];
    const openai = rows.find((row) => row.check === 'OpenAI model');
    expect(openai?.status).toBe('⚠');
    expect(openai?.detail).toBe('model-missing gpt-5.6-sol (available: a, b)');
    expect(openai?.fix).toContain('OPENAI_MODEL');
  });

  /**
   * An auth failure from the OpenAI helper reports the Settings-page fix.
   */
  it('reports an auth failure with the Settings fix', async () => {
    const box = await sandbox();
    const shimDir = greenShims(box);
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(box, {
        AH_DOCTOR_HELPER_CMD: helper,
        AH_SHIM_OPENAI_LINE: 'auth',
        AH_SHIM_OPENAI_RC: '6',
      }),
    });
    expect(result.status).toBe(0);
    const rows = JSON.parse(result.stdout) as {
      check: string;
      status: string;
      detail: string;
      fix: string;
    }[];
    const openai = rows.find((row) => row.check === 'OpenAI model');
    expect(openai).toEqual({
      check: 'OpenAI model',
      status: '⚠',
      detail: 'auth',
      fix: 'Replace the OpenAI key in Settings',
    });
  });

  /**
   * A network failure from the OpenAI helper reports the network/base-URL fix.
   */
  it('reports a network failure with the network fix', async () => {
    const box = await sandbox();
    const shimDir = greenShims(box);
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(box, {
        AH_DOCTOR_HELPER_CMD: helper,
        AH_SHIM_OPENAI_LINE: 'network connection reset',
        AH_SHIM_OPENAI_RC: '7',
      }),
    });
    expect(result.status).toBe(0);
    const rows = JSON.parse(result.stdout) as {
      check: string;
      status: string;
      detail: string;
      fix: string;
    }[];
    const openai = rows.find((row) => row.check === 'OpenAI model');
    expect(openai?.status).toBe('⚠');
    expect(openai?.fix).toContain('OPENAI_BASE_URL');
  });

  /**
   * The secrets-status helper's own db-unreachable/master-key-missing outcomes are reported
   * verbatim as skipped rows (defensive: doctor.sh's own bash-level gating already prevents this
   * in practice, since row 9 is only reached when Postgres and the master key both passed).
   */
  it.each([
    ['3', 'db-unreachable'],
    ['4', 'master-key-missing'],
  ])('reports the secrets helper exit %s as skipped with %s', async (rc, detail) => {
    const box = await sandbox();
    const shimDir = greenShims(box);
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(box, {
        AH_DOCTOR_HELPER_CMD: helper,
        AH_SHIM_SECRETS_RC: rc,
      }),
    });
    expect(result.status).toBe(0);
    const rows = JSON.parse(result.stdout) as { check: string; status: string; detail: string }[];
    const secrets = rows.find((row) => row.check === 'Secrets');
    expect(secrets).toEqual({ check: 'Secrets', status: '–', detail, fix: '' });
  });
});

describe('doctor.sh on a GNU userland', () => {
  /**
   * The Linux-only regression this shim reproduces on any machine: with GNU coreutils, the key's
   * mode was read by a `stat -f … || stat -c …` chain whose first branch prints a filesystem block
   * on stdout before failing. The mode came back as that block with the real mode appended, so a
   * correctly-permissioned key was reported as wrongly-permissioned, the run exited 1, and the
   * embedded newlines made `--json` unparseable.
   */
  it('reads the key mode correctly and still emits valid JSON', async () => {
    const box = await sandbox();
    const shimDir = greenShims(box);
    writeGnuStatShim(shimDir);
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(box, { AH_DOCTOR_HELPER_CMD: helper }),
    });

    expect(result.status).toBe(0);
    const rows = JSON.parse(result.stdout) as { check: string; status: string; detail: string }[];
    const key = rows.find((row) => row.check === 'Master key');
    expect(key?.status).toBe('✓');
    expect(key?.detail).toBe(`${box.keyPath} (mode 600)`);
  });

  /**
   * The check still refuses a group-readable key on the same userland: the fix is about reading
   * the mode, not about accepting whatever it reads.
   */
  it('still refuses a group-readable key', async () => {
    const box = await sandbox();
    const shimDir = greenShims(box);
    writeGnuStatShim(shimDir, '644');
    const helper = helperShim(shimDir);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--json'],
      env: greenEnv(box, { AH_DOCTOR_HELPER_CMD: helper }),
    });

    expect(result.status).toBe(1);
    const rows = JSON.parse(result.stdout) as { check: string; status: string; fix: string }[];
    const key = rows.find((row) => row.check === 'Master key');
    expect(key?.status).toBe('✗');
    expect(key?.fix).toContain('chmod 600');
  });
});

describe('doctor.sh usage', () => {
  /**
   * An unrecognised flag exits 2 with a usage line.
   */
  it('rejects an unknown flag', async () => {
    const box = await sandbox();
    const shimDir = greenShims(box);
    const result = spawnScript(scriptPath, {
      shimDir,
      args: ['--nope'],
      env: greenEnv(box),
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage');
  });
});
