/**
 * Unit tests for the instance-isolation contract of `infra/scripts/env.sh`.
 *
 * Layer: unit (spawns bash; no Docker, no Postgres, no network).
 * Goal: the instance identity — the ports, database name, URLs, compose project and container
 * prefix — is a pure function of AH_INSTANCE/AH_PORT_BASE and cannot be steered by a same-named
 * variable already exported in the shell, so no instance can be made to call itself one thing
 * while its connection strings point at another instance's data; and the variables that are
 * ordinary configuration rather than identity still honour an explicit value.
 * Mocks: none.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const scriptPath = fileURLToPath(new URL('./env.sh', import.meta.url));
// Prefer the system bash (3.2 on macOS) so the script's portability is exercised where it matters.
const bash = existsSync('/bin/bash') ? '/bin/bash' : 'bash';

/** Throwaway directories created by a test, removed afterwards. */
const sandboxes: string[] = [];

afterEach(() => {
  while (sandboxes.length > 0) {
    const dir = sandboxes.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/**
 * Runs `env.sh --print` with a given environment and parses the `export KEY="value"` lines.
 *
 * @param env - Variables to export for the run, on top of PATH and HOME.
 * @returns The printed variables by name.
 */
function printEnv(env: Record<string, string>): Record<string, string> {
  const output = execFileSync(bash, [scriptPath, '--print'], {
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', ...env },
    encoding: 'utf8',
  });
  const result: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const match = /^export ([A-Z_]+)="(.*)"$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      result[match[1]] = match[2].replaceAll(/\\(.)/g, '$1');
    }
  }
  return result;
}

/** Every variable that carries the instance identity, with the value derived for base 3100. */
const IDENTITY_FOR_3100: Record<string, string> = {
  WEB_PORT: '3100',
  POSTGRES_PORT: '3101',
  REDIS_PORT: '3102',
  POSTGRES_DB: 'agent_hangar_feat_x',
  DATABASE_URL: 'postgresql://ah:ah@127.0.0.1:3101/agent_hangar_feat_x',
  REDIS_URL: 'redis://127.0.0.1:3102',
  COMPOSE_PROJECT_NAME: 'agent-hangar-feat-x',
  WORKSPACE_NAME_PREFIX: 'ah-ws-feat-x-',
};

describe('env.sh instance isolation', () => {
  /**
   * The regression this suite exists for: `AH_PORT_BASE=3100 POSTGRES_PORT=3001` used to produce
   * an environment that called itself `feat-x` while its DATABASE_URL pointed at the default
   * instance's Postgres. The derivation must ignore the exported value outright — including in
   * the DATABASE_URL/REDIS_URL built from it — so one instance can never write into another's
   * database.
   */
  it('ignores an exported POSTGRES_PORT/REDIS_PORT', () => {
    const derived = printEnv({ AH_INSTANCE: 'feat-x', AH_PORT_BASE: '3100' });
    const withOverrides = printEnv({
      AH_INSTANCE: 'feat-x',
      AH_PORT_BASE: '3100',
      POSTGRES_PORT: '3001',
      REDIS_PORT: '3002',
    });

    expect(derived).toMatchObject(IDENTITY_FOR_3100);
    expect(withOverrides).toEqual(derived);
  });

  /**
   * The same rule holds for every other identity variable: exporting a conflicting WEB_PORT,
   * POSTGRES_DB, DATABASE_URL, REDIS_URL, COMPOSE_PROJECT_NAME or WORKSPACE_NAME_PREFIX changes
   * nothing. Only AH_INSTANCE and AH_PORT_BASE move them.
   */
  it('ignores every other exported identity variable', () => {
    const printed = printEnv({
      AH_INSTANCE: 'feat-x',
      AH_PORT_BASE: '3100',
      WEB_PORT: '9000',
      POSTGRES_DB: 'agent_hangar_default',
      DATABASE_URL: 'postgresql://ah:ah@127.0.0.1:3001/agent_hangar_default',
      REDIS_URL: 'redis://127.0.0.1:3002',
      COMPOSE_PROJECT_NAME: 'agent-hangar-default',
      WORKSPACE_NAME_PREFIX: 'ah-ws-default-',
    });

    expect(printed).toMatchObject(IDENTITY_FOR_3100);
  });

  /**
   * The complement of the rule, pinned so the split stays deliberate rather than accidental: the
   * variables that describe what an instance runs with — not which instance it is — still take an
   * explicit value. None of them can make two instances share a database.
   */
  it('still honours an explicit value for the configuration variables', () => {
    const printed = printEnv({
      AH_INSTANCE: 'feat-x',
      AH_PORT_BASE: '3100',
      WORKSPACE_IMAGE: 'agent-hangar/workspace:test',
      MASTER_KEY_PATH: '/tmp/ah-test/master.key',
      WORKSPACE_IDLE_TTL_MIN: '5',
      WORKER_TURN_CONCURRENCY: '7',
      OPENAI_MODEL: 'gpt-test',
      AGENT_MODEL_PROVIDER: 'fake',
      LOG_LEVEL: 'debug',
    });

    expect(printed).toMatchObject({
      WORKSPACE_IMAGE: 'agent-hangar/workspace:test',
      MASTER_KEY_PATH: '/tmp/ah-test/master.key',
      WORKSPACE_IDLE_TTL_MIN: '5',
      WORKER_TURN_CONCURRENCY: '7',
      OPENAI_MODEL: 'gpt-test',
      AGENT_MODEL_PROVIDER: 'fake',
      LOG_LEVEL: 'debug',
    });
    expect(printed).toMatchObject(IDENTITY_FOR_3100);
  });
});

describe('env.sh incomplete env file', () => {
  /**
   * Writes an env file holding only the keys a predicate keeps, with the values the derivation
   * would have produced for them.
   *
   * The keys come from the derivation itself rather than from a list repeated here, so a key added
   * to `env.sh` is covered without this file being edited. The one that is left out is written
   * back as a comment, which is the spelling the failure was reported in: it reads as configured
   * and is stripped before anything evaluates the file.
   *
   * @param keep - Decides which keys the file records.
   * @returns The env file's path.
   */
  function writePartialEnvFile(keep: (key: string) => boolean): string {
    const dir = mkdtempSync(join(tmpdir(), 'ah-env-partial-'));
    sandboxes.push(dir);
    const envFile = join(dir, '.env.local');
    const complete = printEnv({ AH_INSTANCE: 'feat-x', AH_PORT_BASE: '3100' });
    const lines = Object.entries(complete).map(([key, value]) =>
      keep(key) ? `${key}="${value}"` : `# ${key}="${value}"`,
    );
    writeFileSync(envFile, `${lines.join('\n')}\n`);
    return envFile;
  }

  /**
   * Runs a print mode against a given env file.
   *
   * @param mode - `--print-effective` or `--print-checked`.
   * @param envFile - File the script must read.
   * @returns Exit status and both output streams.
   */
  function printFrom(
    mode: '--print-effective' | '--print-checked',
    envFile: string,
  ): SpawnSyncReturns<string> {
    return spawnSync(bash, [scriptPath, mode], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '/tmp',
        AH_ENV_FILE: envFile,
      },
      encoding: 'utf8',
    });
  }

  /**
   * The finding: a file holding 5 of the 17 keys was trusted and echoed verbatim, so the first
   * consumer to dereference one of the other twelve died on `MASTER_KEY_PATH: unbound variable` —
   * a message that names neither the file nor the other eleven nor the way out. The refusal has to
   * name what is missing, and it has to arrive before an environment nobody can use is handed over.
   */
  it.each(['--print-effective', '--print-checked'] as const)(
    '%s names every missing key',
    (mode) => {
      const kept = ['AH_INSTANCE', 'AH_PORT_BASE', 'WEB_PORT', 'POSTGRES_PORT', 'REDIS_PORT'];
      const envFile = writePartialEnvFile((key) => kept.includes(key));

      const result = printFrom(mode, envFile);

      expect(result.status).toBe(4);
      expect(result.stderr).toContain(envFile);
      for (const key of ['MASTER_KEY_PATH', 'DATABASE_URL', 'REDIS_URL', 'WORKSPACE_IMAGE']) {
        expect(result.stderr).toContain(key);
      }
      // Nothing an unsuspecting `eval` could act on: the caller gets a refusal, not half a shell.
      expect(result.stdout).toBe('');
    },
  );

  /**
   * The specific spelling that caused it. A commented-out key reads as configured to a human and
   * is stripped before anything evaluates the file, so "present as a comment" has to count as
   * missing or the diagnosis is worse than useless.
   */
  it('counts a key that survives only as a comment as missing', () => {
    const envFile = writePartialEnvFile((key) => key !== 'MASTER_KEY_PATH');

    const result = printFrom('--print-effective', envFile);

    expect(result.status).toBe(4);
    expect(result.stderr).toContain('MASTER_KEY_PATH');
  });

  /**
   * A key recorded with an empty value passes `set -u` and then fails further along with even less
   * to go on, so it is the same defect and gets the same answer.
   */
  it('counts a key recorded empty as missing', () => {
    const envFile = writePartialEnvFile(() => true);
    writeFileSync(
      envFile,
      readFileSync(envFile, 'utf8').replace(/^LOG_LEVEL=.*$/m, 'LOG_LEVEL=""'),
    );

    const result = printFrom('--print-effective', envFile);

    expect(result.status).toBe(4);
    expect(result.stderr).toContain('LOG_LEVEL');
  });

  /**
   * The complement, so the check cannot drift into refusing the ordinary case: a file the script
   * itself wrote is complete, and is still echoed verbatim.
   */
  it('accepts the file env.sh writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ah-env-complete-'));
    sandboxes.push(dir);
    const envFile = join(dir, '.env.local');
    execFileSync(bash, [scriptPath, '--force'], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '/tmp',
        AH_ENV_FILE: envFile,
        AH_INSTANCE: 'feat-x',
        AH_PORT_BASE: '3100',
      },
      encoding: 'utf8',
    });

    const result = printFrom('--print-effective', envFile);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('export MASTER_KEY_PATH=');
  });
});
