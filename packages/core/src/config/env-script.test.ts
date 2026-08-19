/**
 * Contract test between `infra/scripts/env.sh` and `resolveInstance`.
 *
 * Layer: integration (spawns bash; no Docker, no network).
 * Goal: the shell derivation used by setup/compose prints exactly the values the TypeScript
 * derivation computes, for defaults, explicit `AH_*`, Conductor fallbacks, slugify and port
 * validation — so .env.local and the apps can never disagree.
 * Mocks: none.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { resolveInstance } from './instance.js';
import { COMPOSE_DB_CREDENTIALS } from './schema.js';

const scriptPath = fileURLToPath(new URL('../../../../infra/scripts/env.sh', import.meta.url));
// Prefer the system bash (3.2 on macOS) so the script's portability is exercised where it matters.
const bash = existsSync('/bin/bash') ? '/bin/bash' : 'bash';

function printEnv(env: Record<string, string>): Record<string, string> {
  const output = execFileSync(bash, [scriptPath, '--print'], {
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', ...env },
    encoding: 'utf8',
  });
  const result: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const match = /^export ([A-Z_]+)=(.*)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      result[match[1]] = match[2];
    }
  }
  return result;
}

function expectedFor(env: Record<string, string>): Record<string, string> {
  const info = resolveInstance({ env });
  return {
    AH_INSTANCE: info.instance,
    AH_PORT_BASE: String(info.portBase),
    WEB_PORT: String(info.webPort),
    POSTGRES_PORT: String(info.postgresPort),
    REDIS_PORT: String(info.redisPort),
    POSTGRES_DB: info.postgresDb,
    DATABASE_URL: `postgresql://${COMPOSE_DB_CREDENTIALS}@127.0.0.1:${String(info.postgresPort)}/${info.postgresDb}`,
    REDIS_URL: `redis://127.0.0.1:${String(info.redisPort)}`,
    COMPOSE_PROJECT_NAME: info.composeProjectName,
    WORKSPACE_NAME_PREFIX: info.workspaceNamePrefix,
  };
}

describe('infra/scripts/env.sh', () => {
  /**
   * Permutation table: defaults, explicit AH_*, Conductor fallbacks with AH_* precedence, and
   * slugify of a Conductor-style name — every derived value must equal `resolveInstance`.
   */
  it.each([
    ['defaults', {}],
    ['explicit AH_*', { AH_INSTANCE: 'Feat_X', AH_PORT_BASE: '4000' }],
    [
      'conductor fallbacks',
      { CONDUCTOR_WORKSPACE_NAME: 'Feature/ABC def', CONDUCTOR_PORT: '5100' },
    ],
    [
      'AH_* beats CONDUCTOR_*',
      { AH_INSTANCE: 'lane-a', CONDUCTOR_WORKSPACE_NAME: 'other', CONDUCTOR_PORT: '6000' },
    ],
    ['long unicode name', { AH_INSTANCE: `Ünïcödé ${'x'.repeat(40)}` }],
  ])('matches resolveInstance for %s', (_label, env) => {
    const printed = printEnv(env);
    expect(printed).toMatchObject(expectedFor(env));
  });

  /**
   * Static defaults written to .env.local match the documented configuration defaults.
   */
  it('prints the documented static defaults', () => {
    const printed = printEnv({});
    expect(printed).toMatchObject({
      WORKSPACE_IMAGE: 'agent-hangar/workspace:dev',
      WORKSPACE_IDLE_TTL_MIN: '30',
      WORKER_TURN_CONCURRENCY: '2',
      OPENAI_MODEL: 'gpt-5.6-sol',
      AGENT_MODEL_PROVIDER: 'openai',
      LOG_LEVEL: 'info',
    });
    expect(printed.MASTER_KEY_PATH).toMatch(/\/\.agent-hangar\/master\.key$/);
  });

  /**
   * Invalid port bases fail with the same rule as `resolveInstance` (non-numeric, privileged,
   * too high), exiting non-zero with a message naming the variable.
   */
  it.each(['abc', '80', '65001'])('rejects AH_PORT_BASE=%s', (value) => {
    const result = spawnSync(bash, [scriptPath, '--print'], {
      env: { PATH: process.env.PATH ?? '', HOME: '/tmp', AH_PORT_BASE: value },
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('AH_PORT_BASE');
    expect(() => resolveInstance({ env: { AH_PORT_BASE: value } })).toThrow();
  });

  /**
   * Unknown flags are rejected with a usage line so typos never silently write .env.local.
   */
  it('rejects unknown flags', () => {
    const result = spawnSync(bash, [scriptPath, '--nope'], {
      env: { PATH: process.env.PATH ?? '', HOME: '/tmp' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage');
  });
});
