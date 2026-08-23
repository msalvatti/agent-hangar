/**
 * Unit tests for instance resolution.
 *
 * Layer: unit.
 * Goal: precedence `AH_*` → `CONDUCTOR_*` → defaults, the derived ports/db/compose/prefix/image
 * values, slugify rules, and port-base validation.
 * Mocks: none (the environment is passed explicitly).
 */
import { describe, expect, it } from 'vitest';

import { ConfigError } from '../errors.ts';

import {
  DEFAULT_INSTANCE,
  DEFAULT_PORT_BASE,
  INSTANCE_SLUG_MAX_LENGTH,
  resolveInstance,
  slugifyInstance,
  WORKSPACE_IMAGE_REPOSITORY,
  workspaceImageFor,
} from './instance.ts';

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

describe('workspaceImageFor', () => {
  /**
   * The tag is the instance name, so no two instances name the same image and `pnpm infra:image`
   * in one checkout cannot retarget what another checkout's next container is created from.
   */
  it('tags the shared repository with the instance', () => {
    expect(workspaceImageFor('default')).toBe(`${WORKSPACE_IMAGE_REPOSITORY}:default`);
    expect(workspaceImageFor('feat-x')).toBe('agent-hangar/workspace:feat-x');
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
      workspaceImage: 'agent-hangar/workspace:default',
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
      workspaceImage: 'agent-hangar/workspace:feat-x',
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

describe('what a port base and an instance name may be', () => {
  /**
   * The variable arrives from a shell or a Conductor workspace, where a trailing newline or a
   * padded value is ordinary. Read untrimmed it matches no digits and the whole checkout fails to
   * start over whitespace.
   */
  it('accepts a port base with whitespace around it', () => {
    expect(resolveInstance({ env: { AH_PORT_BASE: ' 4100 ' } }).portBase).toBe(4100);
  });

  /**
   * The pattern is anchored at both ends: a value that merely contains digits is not a port, and
   * either anchor removed lets one through to be read as a number that was never written.
   */
  it.each([
    'x4100',
    '4100x',
    '41 00',
    '4100.5',
    // Spellings `Number` accepts and this does not: a sign, an exponent and a radix prefix all
    // parse to a perfectly good integer, so a pattern that merely finds digits somewhere in the
    // value would let each of them through as a port nobody wrote.
    '+4100',
    '4100e0',
    '0x1004',
  ])('refuses a port base of %s', (value) => {
    expect(() => resolveInstance({ env: { AH_PORT_BASE: value } })).toThrow(ConfigError);
  });

  /**
   * The range is inclusive at both ends: the two values named in the message have to be the two
   * values that work, or an operator following it is refused for doing what it said.
   */
  it.each([1024, 65_000])('accepts a port base of %i', (value) => {
    expect(resolveInstance({ env: { AH_PORT_BASE: String(value) } }).portBase).toBe(value);
  });

  /** And one step outside either end is refused, naming the range. */
  it.each([1023, 65_001])('refuses a port base of %i', (value) => {
    expect(() => resolveInstance({ env: { AH_PORT_BASE: String(value) } })).toThrow(
      'AH_PORT_BASE must be an integer between 1024 and 65000',
    );
  });
});
