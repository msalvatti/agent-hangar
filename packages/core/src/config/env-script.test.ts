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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { resolveInstance } from './instance.js';
import { COMPOSE_DB_CREDENTIALS } from './schema.js';

const scriptPath = fileURLToPath(new URL('../../../../infra/scripts/env.sh', import.meta.url));
const setupPath = fileURLToPath(new URL('../../../../infra/scripts/setup.sh', import.meta.url));
// Prefer the system bash (3.2 on macOS) so the script's portability is exercised where it matters.
const bash = existsSync('/bin/bash') ? '/bin/bash' : 'bash';

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
   * Values are double-quoted and shell-escaped so `eval "$(env.sh --print)"` and `.env.local`
   * survive paths with spaces or special characters (e.g. a home directory with a space).
   */
  it('quotes values safely for eval and .env files', () => {
    const printed = printEnv({ HOME: '/Users/John Doe', OPENAI_MODEL: 'gpt "x" $y `z`' });
    expect(printed.MASTER_KEY_PATH).toBe('/Users/John Doe/.agent-hangar/master.key');
    expect(printed.OPENAI_MODEL).toBe('gpt "x" $y `z`');
    const evaluated = execFileSync(
      bash,
      ['-c', `eval "$(${bash} ${scriptPath} --print)"; printf '%s' "$MASTER_KEY_PATH"`],
      { env: { PATH: process.env.PATH ?? '', HOME: '/Users/John Doe' }, encoding: 'utf8' },
    );
    expect(evaluated).toBe('/Users/John Doe/.agent-hangar/master.key');
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

describe('infra/scripts/env.sh --print-effective', () => {
  /**
   * `env.sh` derives the root from its own location, so the script is copied into a sandbox: the
   * test must never read or overwrite the developer's real `.env.local`.
   *
   * @param body - Receives the sandbox root and the copied script's path.
   */
  function withSandbox(body: (root: string, script: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), 'ah-env-'));
    try {
      const script = join(root, 'infra', 'scripts', 'env.sh');
      mkdirSync(dirname(script), { recursive: true });
      copyFileSync(scriptPath, script);
      body(root, script);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  function printEffective(script: string, env: Record<string, string>): Record<string, string> {
    const output = execFileSync(bash, [script, '--print-effective'], {
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

  /**
   * The regression this mode exists for: on a second `pnpm setup`, a preserved `.env.local`
   * must beat whatever the shell exports. `docker compose --env-file` reads that file, so if the
   * rest of the run recomputed its ports from the environment, compose would come up on one
   * instance while the migrations and the image build targeted another.
   */
  it('follows an existing .env.local instead of the exported environment', () => {
    withSandbox((root, script) => {
      execFileSync(bash, [script], {
        env: {
          PATH: process.env.PATH ?? '',
          HOME: '/tmp',
          AH_INSTANCE: 'alpha',
          AH_PORT_BASE: '4200',
        },
        encoding: 'utf8',
      });

      const conflicting = { AH_INSTANCE: 'beta', AH_PORT_BASE: '5300' };
      expect(printEffective(script, conflicting)).toMatchObject({
        AH_INSTANCE: 'alpha',
        AH_PORT_BASE: '4200',
        WEB_PORT: '4200',
        POSTGRES_PORT: '4201',
        REDIS_PORT: '4202',
        POSTGRES_DB: 'agent_hangar_alpha',
        COMPOSE_PROJECT_NAME: 'agent-hangar-alpha',
      });

      // A second `env.sh` run must also leave the file untouched, or the preserved instance would
      // be silently rewritten under the caller.
      const before = readFileSync(join(root, '.env.local'), 'utf8');
      execFileSync(bash, [script], {
        env: { PATH: process.env.PATH ?? '', HOME: '/tmp', ...conflicting },
        encoding: 'utf8',
      });
      expect(readFileSync(join(root, '.env.local'), 'utf8')).toBe(before);
    });
  });

  /**
   * With no file yet (a first run) there is nothing to follow, so the mode falls back to the
   * derivation `--print` performs, and quoting survives the round-trip through the file.
   */
  it('falls back to the derived environment when .env.local is absent', () => {
    withSandbox((_root, script) => {
      const env = { AH_INSTANCE: 'fresh', AH_PORT_BASE: '4300', OPENAI_MODEL: 'gpt "x" $y `z`' };
      expect(printEffective(script, env)).toMatchObject({
        AH_INSTANCE: 'fresh',
        AH_PORT_BASE: '4300',
        POSTGRES_PORT: '4301',
        OPENAI_MODEL: 'gpt "x" $y `z`',
      });

      execFileSync(bash, [script], {
        env: { PATH: process.env.PATH ?? '', HOME: '/tmp', ...env },
        encoding: 'utf8',
      });
      // Now that the file exists the same values must come back out of it, quoting intact.
      expect(printEffective(script, {})).toMatchObject({
        AH_INSTANCE: 'fresh',
        POSTGRES_PORT: '4301',
        OPENAI_MODEL: 'gpt "x" $y `z`',
      });
    });
  });

  /**
   * The mode is only useful if `setup.sh` actually uses it; a call site that reverted to
   * `--print` would reintroduce the split-brain without failing any other test here.
   */
  it('is what setup.sh loads its environment from', () => {
    const setup = readFileSync(setupPath, 'utf8');
    expect(setup).toContain('env.sh --print-effective');
    expect(setup).not.toContain('env.sh --print)');
  });
});
