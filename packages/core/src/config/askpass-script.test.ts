/**
 * Contract test for the workspace `GIT_ASKPASS` helper.
 *
 * Layer: integration (spawns sh; no Docker, no network).
 * Goal: the GitHub PAT is released only for the single origin the workspace was created for, read
 * from the root-owned file the host places and never from the environment, and only through the
 * prompts git actually asks; the token itself likewise comes from a file and from nothing else, so
 * a variable naming one is answered with nothing; every refusal is silent on stdout and non-zero —
 * git must fail authentication rather than read an empty line as a valid password. The origin is compared whole
 * and exactly, so the suffix, userinfo, port and path-segment tricks that a substring or host-only
 * test would accept are all refused, while a forge the operator listed on another host or another
 * port is served. `https` is required of the approved origin itself, so a cleartext workspace
 * clones anonymously and is answered nothing.
 *
 * The script reads that file from a path it hard-codes, which no test can move, so every case here
 * runs the script through a copy whose one constant points at a temporary file. What is under test
 * is the decision, and the copy differs from the shipped script in exactly that one line — pinned
 * below, so a rewrite that reintroduced an environment lookup could not slip past this suite.
 * Mocks: none — the real script runs under `sh` with a canary standing in for the PAT.
 *
 * Lives beside the other shell-script contract tests of this package.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertNoCanary, GITHUB_CANARY } from '../testing/canaries.ts';

const shippedScriptPath = fileURLToPath(
  new URL('../../../../infra/workspace/askpass.sh', import.meta.url),
);
const sh = existsSync('/bin/sh') ? '/bin/sh' : 'sh';

/** The line of the shipped script that names where the approved origin is read from. */
const SHIPPED_ORIGIN_FILE_LINE = 'ALLOWED_ORIGIN_FILE=/opt/agent-runtime/allowed-origin';

let workDir: string;
let scriptPath: string;
let originFile: string;
let tokenFile: string;

/**
 * Rewrites the approved-origin file the script under test reads.
 *
 * @param content - Exactly what the file holds, or `null` to remove it.
 */
function setApprovedOrigin(content: string | null): void {
  if (content === null) {
    rmSync(originFile, { force: true });
    return;
  }
  writeFileSync(originFile, content, 'utf8');
}

/**
 * Rewrites the private token file the agent runtime writes for the duration of a turn.
 *
 * @param content - Exactly what the file holds, or `null` to remove it.
 */
function setTokenFile(content: string | null): void {
  if (content === null) {
    rmSync(tokenFile, { force: true });
    return;
  }
  writeFileSync(tokenFile, content, 'utf8');
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'ah-askpass-'));
  scriptPath = join(workDir, 'askpass.sh');
  originFile = join(workDir, 'allowed-origin');
  tokenFile = join(workDir, 'git-token');
  const shipped = readFileSync(shippedScriptPath, 'utf8');
  // The redirection is one line and it is asserted, so the copy cannot drift into testing a
  // different script than the image ships.
  expect(shipped).toContain(SHIPPED_ORIGIN_FILE_LINE);
  writeFileSync(
    scriptPath,
    shipped.replace(SHIPPED_ORIGIN_FILE_LINE, `ALLOWED_ORIGIN_FILE=${originFile}`),
    'utf8',
  );
  setApprovedOrigin(`${GITHUB_ORIGIN}\n`);
  setTokenFile(`${GITHUB_CANARY}\n`);
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** Origin the workspace under test was created for, unless a case names another. */
const GITHUB_ORIGIN = 'https://github.com';

/**
 * Runs the helper with one git prompt, returning exactly what it produced.
 *
 * The environment stands in for the one a workspace command runs with: the path of the private
 * token file, and nothing that decides policy. Neither the approved origin nor the token itself is
 * in it — that is the point of both files.
 *
 * @param prompt - The prompt git would print.
 * @param env - Environment for the run; defaults to the token file alone.
 * @returns Status, stdout and stderr.
 */
function askpass(
  prompt: string,
  env: Record<string, string> = { AH_GIT_TOKEN_FILE: tokenFile },
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(sh, [scriptPath, prompt], {
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Runs the helper for a workspace created for the given origin, restoring the default afterwards.
 *
 * @param origin - What the host wrote into the approved-origin file.
 * @param prompt - The prompt git would print.
 * @returns What the helper produced.
 */
function askpassFor(
  origin: string,
  prompt: string,
): { status: number | null; stdout: string; stderr: string } {
  try {
    setApprovedOrigin(`${origin}\n`);
    return askpass(prompt);
  } finally {
    setApprovedOrigin(`${GITHUB_ORIGIN}\n`);
  }
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
    ['no file is named', () => ({})],
    ['the named file is not there', () => ({ AH_GIT_TOKEN_FILE: join(workDir, 'absent') })],
    [
      'the file is empty',
      () => {
        setTokenFile('');
        return { AH_GIT_TOKEN_FILE: tokenFile };
      },
    ],
  ])('fails closed when %s', (_label, prepareEnv) => {
    try {
      const result = askpass(APPROVED, prepareEnv());
      expect(result.stdout).toBe('');
      expect(result.status).not.toBe(0);
    } finally {
      setTokenFile(`${GITHUB_CANARY}\n`);
    }
  });

  /**
   * The token has one source, and a variable is not it. Nothing puts the PAT in an environment any
   * more, and a fallback to one would be a fallback to whatever the workspace chose to set: the
   * shell tool runs a command a model wrote, and a variable assignment in front of a git command
   * is all it would take to decide what the helper releases.
   */
  it('answers nothing for a token named only in the environment', () => {
    const result = askpass(APPROVED, { GITHUB_TOKEN: GITHUB_CANARY });

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
   * A container nobody prepared has no forge to fall back to. An absent file used to mean
   * github.com — the variable's default — which handed the PAT to the public forge from a
   * workspace that was never bound to it.
   */
  it.each([
    ['missing', null],
    ['empty', ''],
    ['blank', '   \n'],
  ])('fails closed when the approved-origin file is %s', (_label, content) => {
    try {
      setApprovedOrigin(content);
      const result = askpass(APPROVED);
      expect(result.stdout).toBe('');
      expect(result.status).not.toBe(0);
      expect(() => {
        assertNoCanary(result.stdout + result.stderr);
      }).not.toThrow();
    } finally {
      setApprovedOrigin(`${GITHUB_ORIGIN}\n`);
    }
  });

  /**
   * The defence the file exists for. `run_shell` hands the model's own command to `bash -lc` with
   * the workspace environment, and a command may set any variable for the process it starts — so
   * for as long as this policy lived in a variable, `AH_GIT_ALLOWED_ORIGIN=... git clone ...` let
   * the model choose where its PAT was sent. Nothing in the environment is consulted now.
   */
  it.each([
    ['AH_GIT_ALLOWED_ORIGIN', 'AH_GIT_ALLOWED_ORIGIN'],
    ['ALLOWED_ORIGIN_FILE', 'ALLOWED_ORIGIN_FILE'],
  ])('ignores %s in the environment', (_label, name) => {
    const foreign = "Password for 'https://evil.test': ";

    const refused = askpass(foreign, {
      AH_GIT_TOKEN_FILE: tokenFile,
      [name]: 'https://evil.test',
    });
    const approved = askpass(APPROVED, {
      AH_GIT_TOKEN_FILE: tokenFile,
      [name]: 'https://evil.test',
    });

    expect(refused.stdout).toBe('');
    expect(refused.status).not.toBe(0);
    expect(approved.stdout).toBe(`${GITHUB_CANARY}\n`);
  });

  /**
   * The shipped script names its own file and takes the path from nothing else, which is what
   * stops a workspace pointing the helper at a file it authored. Asserted against the shipped text
   * rather than the copy, because the copy is the one thing about this suite that is not shipped.
   */
  it('reads the approved origin from a hard-coded path and no variable', () => {
    // Comment lines are dropped first: the header explains the attack in terms of the variable
    // that used to carry this policy, and a text search that could not tell an explanation from a
    // lookup would either fail on the explanation or have to stop looking for the lookup.
    const code = readFileSync(shippedScriptPath, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');

    expect(code).toContain(SHIPPED_ORIGIN_FILE_LINE);
    expect(code).not.toContain('AH_GIT_ALLOWED_ORIGIN');
    expect(code).not.toContain('${ALLOWED_ORIGIN_FILE-');
    expect(code).not.toContain('${ALLOWED_ORIGIN_FILE:-');
    // And the token likewise: the variable that used to be the fallback is named nowhere but in
    // the header, which the filter above has already removed.
    expect(code).not.toContain('GITHUB_TOKEN');
  });
});
