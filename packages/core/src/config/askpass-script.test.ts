/**
 * Contract test for the workspace `GIT_ASKPASS` helper.
 *
 * Layer: integration (spawns sh; no Docker, no network).
 * Goal: the GitHub PAT is released only for the single origin the workspace was created for, and
 * only through the prompts git actually asks, and every refusal is silent on stdout and non-zero —
 * git must fail authentication rather than read an empty line as a valid password. The origin is
 * compared whole and exactly, so the suffix, userinfo, port and path-segment tricks that a
 * substring or host-only test would accept are all refused, while a forge the operator listed on
 * another host or another port is served. `https` is required of the approved origin itself, so a
 * cleartext workspace clones anonymously and is answered nothing.
 * Mocks: none — the real script runs under `sh` with a canary standing in for the PAT.
 *
 * Lives beside the other shell-script contract tests of this package.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { assertNoCanary, GITHUB_CANARY } from '../testing/canaries.ts';

const scriptPath = fileURLToPath(
  new URL('../../../../infra/workspace/askpass.sh', import.meta.url),
);
const sh = existsSync('/bin/sh') ? '/bin/sh' : 'sh';

/** Origin the workspace under test was created for, unless a case names another. */
const GITHUB_ORIGIN = 'https://github.com';

/**
 * Runs the helper with one git prompt, returning exactly what it produced.
 *
 * The environment stands in for a container the worker prepared: the token, and the one origin it
 * derived from the repository URL it had just measured against `ALLOWED_REPO_HOSTS`.
 */
function askpass(
  prompt: string,
  env: Record<string, string> = {
    GITHUB_TOKEN: GITHUB_CANARY,
    AH_GIT_ALLOWED_ORIGIN: GITHUB_ORIGIN,
  },
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(sh, [scriptPath, prompt], {
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Runs the helper for a workspace created for the given origin.
 *
 * @param origin - What the worker put in `AH_GIT_ALLOWED_ORIGIN`.
 * @param prompt - The prompt git would print.
 * @returns What the helper produced.
 */
function askpassFor(
  origin: string,
  prompt: string,
): { status: number | null; stdout: string; stderr: string } {
  return askpass(prompt, { GITHUB_TOKEN: GITHUB_CANARY, AH_GIT_ALLOWED_ORIGIN: origin });
}

const APPROVED = "Password for 'https://x-access-token@github.com': ";

describe('infra/workspace/askpass.sh', () => {
  /**
   * The one case that must work: git asking for the password of the approved origin gets the
   * token, on stdout, with a trailing newline and nothing else.
   */
  it('releases the token for a password prompt on the approved origin', () => {
    const result = askpass(APPROVED);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${GITHUB_CANARY}\n`);
    expect(result.stderr).toBe('');
  });

  /**
   * Git asks for the username first; the approved host gets the fixed GitHub token username.
   */
  it('answers the username prompt for the approved origin', () => {
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
   *
   * The query-string, fragment and backslash cases are the same trick written with a character
   * that ENDS the authority rather than one that starts a new label:
   * `https://evil.test?@github.com` reaches `evil.test`, and a reduction that dropped userinfo
   * before cutting the query would report `github.com` and release the token to a host it does not
   * belong to.
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
    ['an scp-style target on the approved host', "Password for 'git@github.com:acme/x.git': "],
    [
      'the approved host with userinfo on a non-default port',
      "Password for 'https://x@github.com:8443': ",
    ],
    ['a username prompt from a stranger', "Username for 'https://evil.test': "],
    ['the query-string userinfo trick', "Password for 'https://evil.test?@github.com': "],
    ['the fragment userinfo trick', "Password for 'https://evil.test#@github.com': "],
    ['the backslash userinfo trick', "Password for 'https://evil.test\\@github.com': "],
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
    ['absent', { AH_GIT_ALLOWED_ORIGIN: GITHUB_ORIGIN }],
    ['empty', { AH_GIT_ALLOWED_ORIGIN: GITHUB_ORIGIN, GITHUB_TOKEN: '' }],
  ])('fails closed when the token is %s', (_label, env) => {
    const result = askpass(APPROVED, env);
    expect(result.stdout).toBe('');
    expect(result.status).not.toBe(0);
  });

  /**
   * A private repository on a forge the operator listed is the case the helper used to make
   * impossible: it released credentials for github.com and refused every explicit port, so a
   * workspace created for another origin could clone but never authenticate. The origin decides
   * host and port together, so the forge is served on exactly the port it was listed on.
   */
  it('releases the token for a listed forge on another host and port', () => {
    const result = askpassFor(
      'https://forge.internal:8443',
      "Password for 'https://x-access-token@forge.internal:8443/acme/widgets.git': ",
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${GITHUB_CANARY}\n`);
  });

  /**
   * The narrowing that comes with it, and the reason the allow-list itself is not handed to the
   * container: a workspace created for one origin is answered for that origin only. The public
   * forge is not special — it is simply not this workspace's origin.
   */
  it('refuses the public forge when the workspace was created for another origin', () => {
    const result = askpassFor('https://forge.internal:8443', APPROVED);
    expect(result.stdout).toBe('');
    expect(result.status).not.toBe(0);
    expect(() => {
      assertNoCanary(result.stdout + result.stderr);
    }).not.toThrow();
  });

  /**
   * The same host on a different port is a different service, and the token belongs to one of
   * them. This is the port rule, and it is the same comparison as the host rule rather than a
   * second one beside it.
   */
  it('refuses the approved host on a port the workspace was not created for', () => {
    expect(
      askpassFor('https://forge.internal:8443', "Password for 'https://forge.internal:9443': ")
        .status,
    ).not.toBe(0);
    expect(
      askpassFor('https://forge.internal:8443', "Password for 'https://forge.internal': ").status,
    ).not.toBe(0);
  });

  /**
   * `ALLOWED_REPO_HOSTS` may authorise a cleartext origin — the local forge a container reaches
   * through the host gateway is why it may — but authorising a clone is not authorising a
   * credential. A workspace created for an http origin clones anonymously and is answered nothing,
   * even when the prompt names that exact origin.
   */
  it('refuses to release the token for a cleartext origin, including its own', () => {
    const own = askpassFor(
      'http://host.docker.internal:3907',
      "Password for 'http://host.docker.internal:3907/acme/sample.git': ",
    );
    expect(own.stdout).toBe('');
    expect(own.status).not.toBe(0);
    expect(() => {
      assertNoCanary(own.stdout + own.stderr);
    }).not.toThrow();
  });

  /**
   * A container nobody prepared has no forge to fall back to. The variable being absent used to
   * mean github.com, which handed the PAT to the public forge from a workspace that was never
   * bound to it; it now refuses, as an empty value already did.
   */
  it.each([
    ['absent', {}],
    ['set and empty', { AH_GIT_ALLOWED_ORIGIN: '' }],
  ])('fails closed when the approved origin is %s', (_label, env) => {
    const result = askpass(APPROVED, { GITHUB_TOKEN: GITHUB_CANARY, ...env });
    expect(result.stdout).toBe('');
    expect(result.status).not.toBe(0);
    expect(() => {
      assertNoCanary(result.stdout + result.stderr);
    }).not.toThrow();
  });
});
