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
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const scriptPath = fileURLToPath(new URL('./env.sh', import.meta.url));
// Prefer the system bash (3.2 on macOS) so the script's portability is exercised where it matters.
const bash = existsSync('/bin/bash') ? '/bin/bash' : 'bash';

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
