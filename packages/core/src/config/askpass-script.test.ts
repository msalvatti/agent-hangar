/**
 * Contract test for the workspace `GIT_ASKPASS` helper.
 *
 * Layer: integration (spawns sh; no Docker, no network).
 * Goal: the GitHub PAT is released only for the approved host and only through the prompts git
 * actually asks, and every refusal is silent on stdout and non-zero — git must fail authentication
 * rather than read an empty line as a valid password. The host is compared exactly, so the
 * suffix, userinfo and path-segment tricks that a substring test would accept are all refused.
 * Mocks: none — the real script runs under `sh` with a canary standing in for the PAT.
 *
 * Lives beside the other shell-script contract tests of this package.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { assertNoCanary, GITHUB_CANARY } from '../testing/canaries.js';

const scriptPath = fileURLToPath(
  new URL('../../../../infra/workspace/askpass.sh', import.meta.url),
);
const sh = existsSync('/bin/sh') ? '/bin/sh' : 'sh';

/** Runs the helper with one git prompt, returning exactly what it produced. */
function askpass(
  prompt: string,
  env: Record<string, string> = { GITHUB_TOKEN: GITHUB_CANARY },
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(sh, [scriptPath, prompt], {
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const APPROVED = "Password for 'https://x-access-token@github.com': ";

describe('infra/workspace/askpass.sh', () => {
  /**
   * The one case that must work: git asking for the password of the approved host gets the token,
   * on stdout, with a trailing newline and nothing else.
   */
  it('releases the token for a password prompt on the approved host', () => {
    const result = askpass(APPROVED);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${GITHUB_CANARY}\n`);
    expect(result.stderr).toBe('');
  });

  /**
   * Git asks for the username first; the approved host gets the fixed GitHub token username.
   */
  it('answers the username prompt for the approved host', () => {
    const result = askpass("Username for 'https://github.com': ");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('x-access-token\n');
  });

  /**
   * The exfiltration this guard exists for, in every shape a substring test would have let
   * through. `GIT_ASKPASS` is set image-wide, so anything that can run git inside the workspace
   * could otherwise point it at its own remote and be handed the PAT as Basic auth. Each case must
   * print nothing at all on stdout — an empty line would be read by git as a valid empty password —
   * exit non-zero, and never let the token reach stderr either.
   */
  it.each([
    ['a foreign host', "Password for 'https://x-access-token@evil.test': "],
    ['the host-suffix trick', "Password for 'https://github.com.evil.test': "],
    ['the userinfo trick', "Password for 'https://github.com@evil.test': "],
    ['the path-segment trick', "Password for 'https://evil.test/github.com/x': "],
    ['a foreign host with a port', "Password for 'https://evil.test:8443': "],
    ['the approved host on a non-default port', "Password for 'https://github.com:8443': "],
    ['cleartext http on the approved host', "Password for 'http://github.com': "],
    ['a scheme-less prompt naming the approved host', "Password for 'github.com': "],
    ['git protocol on the approved host', "Password for 'git://github.com': "],
    [
      'the approved host with userinfo on a non-default port',
      "Password for 'https://x@github.com:8443': ",
    ],
    ['a username prompt from a stranger', "Username for 'https://evil.test': "],
    ['a prompt naming no URL at all', 'Password: '],
    ['an empty prompt', ''],
  ])('refuses %s', (_label, prompt) => {
    const result = askpass(prompt);
    expect(result.stdout).toBe('');
    expect(result.status).not.toBe(0);
    expect(() => {
      assertNoCanary(result.stdout + result.stderr);
    }).not.toThrow();
  });

  /**
   * With no token there is nothing to release. Printing the empty string would hand git a valid
   * empty password and turn a misconfiguration into a confusing auth failure against the real
   * GitHub; failing closed says what is wrong instead.
   */
  it.each([
    ['absent', {}],
    ['empty', { GITHUB_TOKEN: '' }],
  ])('fails closed when the token is %s', (_label, env) => {
    const result = askpass(APPROVED, env);
    expect(result.stdout).toBe('');
    expect(result.status).not.toBe(0);
  });

  /**
   * The approved host is overridable so the end-to-end suite can point the workspace at its local
   * git server, but a variable that is set and empty is a misconfiguration: it must refuse
   * everything rather than match anything.
   */
  it('honours an overridden approved host and fails closed on an empty one', () => {
    const withOverride = (host: string, prompt: string) =>
      askpass(prompt, { GITHUB_TOKEN: GITHUB_CANARY, AH_GIT_ALLOWED_HOST: host });

    const allowed = withOverride('gitserver', "Password for 'https://gitserver/repo.git': ");
    expect(allowed.status).toBe(0);
    expect(allowed.stdout).toBe(`${GITHUB_CANARY}\n`);

    // GitHub is no longer the approved host once another one is named.
    expect(withOverride('gitserver', APPROVED).status).not.toBe(0);

    const empty = withOverride('', APPROVED);
    expect(empty.stdout).toBe('');
    expect(empty.status).not.toBe(0);
  });
});
