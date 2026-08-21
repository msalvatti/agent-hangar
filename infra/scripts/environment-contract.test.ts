/**
 * Unit tests for the promises this repository's tooling makes about the environment it runs in.
 *
 * Layer: unit (reads the committed files; runs nothing).
 * Goal: three guarantees that live in different files and would otherwise only be checked by a
 * person following the README on a fresh machine. The Node version the manifest asks for is
 * actually enforced at install time; pnpm's own settings sit where pnpm 11 reads them; and every
 * URL the scripts print names the address the web server binds, so a printed link does not depend
 * on the reader's resolver preferring one loopback family over the other.
 * Mocks: none.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { read, repoRoot, scriptsDir, shellScripts } from './testing/committed-files.js';

/**
 * The Node range the root manifest asks for.
 *
 * @returns The `engines.node` string.
 */
function requiredNodeRange(): string {
  const manifest = JSON.parse(read(join(repoRoot, 'package.json'))) as {
    engines?: { node?: string };
  };
  return manifest.engines?.node ?? '';
}

/**
 * The host `apps/web` tells Next.js to bind, taken from the `-H` flag of its `dev` and `start`
 * scripts. Both are read so a change to one that leaves the other behind fails here rather than
 * making the question "which host?" unanswerable.
 *
 * @returns The bound host, or the empty string when the two scripts disagree.
 */
function boundWebHost(): string {
  const manifest = JSON.parse(read(join(repoRoot, 'apps', 'web', 'package.json'))) as {
    scripts: Record<string, string>;
  };
  const hosts = ['dev', 'start'].map(
    (name) => /-H\s+(\S+)/.exec(manifest.scripts[name] ?? '')?.[1],
  );
  return hosts[0] !== undefined && hosts[0] === hosts[1] ? hosts[0] : '';
}

/**
 * Settings that belong to pnpm rather than to npm. pnpm 11 reads them from `pnpm-workspace.yaml`
 * only; the same keys in an `.npmrc` are silently ignored, which is what left `engine-strict=true`
 * standing in this repository as an unenforced promise.
 */
const PNPM_OWNED_SETTINGS = ['engine-strict', 'auto-install-peers', 'shamefully-hoist'] as const;

describe('Node version gate', () => {
  /**
   * The README promises Node 24 and `engines.node` records it, but a manifest field alone only
   * produces a warning: measured on pnpm 11.22.0, an install against `">=24 <25"` under Node
   * v22.23.2 printed `[WARN] Unsupported engine` and completed, leaving the reader with a working
   * install and a failure much later in something unrelated. `engineStrict` is the setting pnpm 11
   * honours for this, and it turns that warning into ERR_PNPM_UNSUPPORTED_ENGINE — naming both the
   * range and the version found — before anything is written.
   */
  it('declares the setting that makes pnpm refuse an install outside engines.node', () => {
    expect(read(join(repoRoot, 'pnpm-workspace.yaml'))).toMatch(/^engineStrict: true$/m);
    expect(requiredNodeRange()).not.toBe('');
  });

  /**
   * The gate and the diagnostic have to accept the same versions. `engines.node` pins a single
   * major, which is the number `doctor.sh` compares against and the one the Node rows of
   * `doctor.test.ts` are written around; widening the range without revisiting those would leave
   * the doctor reporting ✓ for a version the install refuses.
   */
  it('pins the single major the doctor checks for', () => {
    expect(requiredNodeRange()).toBe('>=24 <25');
    expect(read(join(scriptsDir, 'doctor.sh'))).toContain('"$major" -eq 24');
  });

  /**
   * pnpm's own settings are read from `pnpm-workspace.yaml`; the same keys in an `.npmrc` are
   * ignored without a word, so one left there reads as configuration while doing nothing. Keys
   * from npm's own domain, `registry` among them, are unaffected and may still live in an
   * `.npmrc`.
   */
  it('keeps pnpm settings out of an .npmrc, where pnpm would ignore them', () => {
    const npmrc = join(repoRoot, '.npmrc');
    const declared = existsSync(npmrc) ? read(npmrc) : '';
    const keys = declared
      .split('\n')
      .map((line) => line.split('=')[0]?.trim() ?? '')
      .filter((key) => key !== '' && !key.startsWith(';') && !key.startsWith('#'));
    const ignored = PNPM_OWNED_SETTINGS.filter((setting) => keys.includes(setting));
    expect(ignored).toEqual([]);
  });
});

describe('printed URLs', () => {
  /**
   * `next dev` and `next start` are both given `-H 127.0.0.1`, so the listener is IPv4 loopback
   * only. `localhost` resolves to `::1` first on macOS, where nothing answers, which leaves a
   * printed `http://localhost:<port>` working only for clients that retry the second address — the
   * same reason `.env.example` spells the database and Redis hosts numerically. Naming the bound
   * address depends on no fallback at all, and tying this to the manifest means a future change of
   * the bind drags the messages along instead of quietly stranding them.
   */
  it.each(shellScripts())('%s prints URLs on the host the web server binds', (_name, source) => {
    const host = boundWebHost();
    expect(host).not.toBe('');
    const wrong = [...source.matchAll(/http:\/\/([^:/\s"'\\]+)/g)]
      .map((match) => match[1])
      .filter((printed) => printed !== host);
    expect(wrong).toEqual([]);
  });
});

describe('workspace image tag', () => {
  /**
   * The tag is the instance's, always derived and never written down. It used to be a constant,
   * which made it machine-global: `pnpm infra:image` in one checkout retargeted the tag every
   * other checkout resolves at container creation, so a rebuild here decided what a run there
   * executed — measured, and the failure it produced described a combination of worker and runtime
   * that existed in no tree. `env.sh` derives it and `workspace-image.sh` refuses a tag that is not
   * the instance's; this is what stops a third script from spelling one out again, which no
   * behavioural test would catch because a constant tag works perfectly on one checkout.
   *
   * A tag is derived when the colon is followed by a shell expansion (`$`) or, in prose, by the
   * placeholder the derivation is described with (`<instance>`). Anything else is a constant.
   */
  it.each(shellScripts())(
    '%s derives the workspace image tag rather than naming one',
    (_n, src) => {
      const constants = [...src.matchAll(/agent-hangar\/workspace:(?![$<])\S*/g)].map((m) => m[0]);
      expect(constants).toEqual([]);
    },
  );
});
