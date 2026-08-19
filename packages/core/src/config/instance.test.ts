/**
 * Unit tests for instance resolution.
 *
 * Layer: unit.
 * Goal: precedence `AH_*` → `CONDUCTOR_*` → defaults, the derived ports/db/compose/prefix values,
 * slugify rules, and port-base validation.
 * Mocks: none (the environment is passed explicitly).
 */
import { describe, expect, it } from 'vitest';

import { ConfigError } from '../errors.js';

import {
  DEFAULT_INSTANCE,
  DEFAULT_PORT_BASE,
  INSTANCE_SLUG_MAX_LENGTH,
  resolveInstance,
  slugifyInstance,
} from './instance.js';

describe('slugifyInstance', () => {
  /**
   * Table of slugify rules: lowercase, separators → `-`, collapse, trim, cap at 30, unicode
   * stripped, empty → `default`.
   */
  it.each([
    ['feat-x', 'feat-x'],
    ['Feature/ABC def', 'feature-abc-def'],
    ['Feat_X', 'feat-x'],
    ['--hello--world--', 'hello-world'],
    ['spaces   and   tabs\t', 'spaces-and-tabs'],
    ['ünïcödé', 'n-c-d'],
    ['a'.repeat(40), 'a'.repeat(INSTANCE_SLUG_MAX_LENGTH)],
    [`${'a'.repeat(29)}-bcd`, 'a'.repeat(29)],
    ['', DEFAULT_INSTANCE],
    ['###', DEFAULT_INSTANCE],
  ])('slugifies %j to %j', (input, expected) => {
    expect(slugifyInstance(input)).toBe(expected);
  });
});

describe('resolveInstance', () => {
  /**
   * Nothing configured: the `default` instance on the 3000 block with the documented derived
   * names (spec 05 §3 defaults).
   */
  it('returns the documented defaults for an empty environment', () => {
    expect(resolveInstance({ env: {} })).toEqual({
      instance: DEFAULT_INSTANCE,
      portBase: DEFAULT_PORT_BASE,
      webPort: 3000,
      postgresPort: 3001,
      redisPort: 3002,
      postgresDb: 'agent_hangar_default',
      composeProjectName: 'agent-hangar-default',
      workspaceNamePrefix: 'ah-ws-default-',
    });
  });

  /**
   * `AH_*` explicit values win, are slugified, and `-` becomes `_` in the database name.
   */
  it('uses AH_INSTANCE and AH_PORT_BASE when set', () => {
    expect(resolveInstance({ env: { AH_INSTANCE: 'Feat_X', AH_PORT_BASE: '4000' } })).toEqual({
      instance: 'feat-x',
      portBase: 4000,
      webPort: 4000,
      postgresPort: 4001,
      redisPort: 4002,
      postgresDb: 'agent_hangar_feat_x',
      composeProjectName: 'agent-hangar-feat-x',
      workspaceNamePrefix: 'ah-ws-feat-x-',
    });
  });

  /**
   * Conductor fallbacks apply when `AH_*` are absent or blank.
   */
  it('falls back to CONDUCTOR_WORKSPACE_NAME and CONDUCTOR_PORT', () => {
    const info = resolveInstance({
      env: { AH_INSTANCE: '  ', CONDUCTOR_WORKSPACE_NAME: 'My Workspace', CONDUCTOR_PORT: '5100' },
    });
    expect(info.instance).toBe('my-workspace');
    expect(info.portBase).toBe(5100);
    expect(info.redisPort).toBe(5102);
  });

  /**
   * Precedence: when both families are set, `AH_*` beats `CONDUCTOR_*` for each variable
   * independently (instance from AH, port from Conductor here).
   */
  it('prefers AH_* over CONDUCTOR_* per variable', () => {
    const info = resolveInstance({
      env: { AH_INSTANCE: 'lane-a', CONDUCTOR_WORKSPACE_NAME: 'other', CONDUCTOR_PORT: '6000' },
    });
    expect(info.instance).toBe('lane-a');
    expect(info.portBase).toBe(6000);
  });

  /**
   * Invalid port bases: non-numeric, below the privileged range, and too high for a 10-port
   * block all raise a `ConfigError` naming the variable.
   */
  it.each(['abc', '80', '65001', '3000.5', '-1'])('rejects AH_PORT_BASE=%s', (value) => {
    expect(() => resolveInstance({ env: { AH_PORT_BASE: value } })).toThrow(ConfigError);
    expect(() => resolveInstance({ env: { AH_PORT_BASE: value } })).toThrow(/AH_PORT_BASE/);
  });

  /**
   * Default env source: with no `env` option the function reads `process.env` (exercised with a
   * known-unset state so the result equals the defaults).
   */
  it('reads process.env when no env is given', () => {
    const saved = { ...process.env };
    delete process.env.AH_INSTANCE;
    delete process.env.AH_PORT_BASE;
    delete process.env.CONDUCTOR_WORKSPACE_NAME;
    delete process.env.CONDUCTOR_PORT;
    try {
      expect(resolveInstance().instance).toBe(DEFAULT_INSTANCE);
    } finally {
      process.env = saved;
    }
  });
});
