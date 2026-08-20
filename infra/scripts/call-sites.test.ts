/**
 * Unit tests for how the infra scripts and the root manifest invoke each other.
 *
 * Layer: unit (reads the committed files; runs nothing).
 * Goal: two rules that hold across many files and that no single behavioural test can pin. First,
 * every command that acts on an already configured instance resolves it through
 * `env.sh --print-checked`, so none of them can drift back to deriving an instance from the shell
 * while the checkout's env file says otherwise. Second, the diagnostic is reachable under a name
 * the package manager does not claim.
 * Mocks: none.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptsDir, '..', '..');

/**
 * Reads one committed file.
 *
 * @param path - Absolute path.
 * @returns Its text.
 */
function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/** The root manifest's `scripts` block. */
function rootScripts(): Record<string, string> {
  const manifest = JSON.parse(read(join(repoRoot, 'package.json'))) as {
    scripts: Record<string, string>;
  };
  return manifest.scripts;
}

/**
 * Scripts that act on an instance somebody already configured, so the checkout's env file decides
 * which one — and a shell naming a different one stops them.
 */
const INSTANCE_ACTING_SCRIPTS = [
  'archive.sh',
  'db-prune.sh',
  'doctor.sh',
  'rotate-key.sh',
  'run.sh',
  'ws.sh',
] as const;

describe('instance resolution call sites', () => {
  /**
   * The rule the destructive defect came from: `archive.sh` resolved its instance from the shell
   * while `setup.sh` wrote and read the checkout's env file, so archiving a checkout configured
   * for one instance tore down another's compose stack. Each script has its own behavioural test
   * for that; this one is what stops a seventh script — or a revert of any of these six — from
   * reintroducing the split without failing anything else.
   */
  it.each(INSTANCE_ACTING_SCRIPTS)('%s resolves the instance through --print-checked', (name) => {
    const source = read(join(scriptsDir, name));
    expect(source).toContain('env.sh" --print-checked');
    expect(source).not.toContain('env.sh" --print)');
    expect(source).not.toContain('env.sh" --print-effective');
  });

  /**
   * `setup.sh` is the one command that establishes the file rather than acting on it: with
   * `--force` it rewrites the file from the shell, and without it the preserved file wins. Making
   * it refuse a disagreement it is there to resolve would leave no way out of one.
   */
  it('setup.sh keeps resolving through --print-effective', () => {
    const source = read(join(scriptsDir, 'setup.sh'));
    expect(source).toContain('env.sh --print-effective');
  });

  /**
   * The root one-liners bring compose up and run migrations against an instance's ports and
   * database, so they answer to the same rule as the scripts.
   */
  it.each(['infra:up', 'infra:down', 'infra:reset', 'db:migrate', 'db:studio'])(
    '%s resolves the instance through --print-checked',
    (name) => {
      const command = rootScripts()[name];
      expect(command).toContain('env.sh --print-checked');
      expect(command).not.toContain('env.sh --print)');
    },
  );
});

describe('doctor invocation names', () => {
  /**
   * `pnpm doctor` runs the package manager's own built-in diagnostic — pnpm claims that name and
   * no package script can override it — which reports on the pnpm installation and exits 0
   * whatever state this project's environment is in. A namespaced alias cannot be shadowed,
   * because no pnpm built-in command contains a colon, so the short form has to be one.
   */
  it('offers a namespaced alias that pnpm cannot shadow', () => {
    const scripts = rootScripts();
    const aliases = Object.entries(scripts).filter(
      ([name, command]) =>
        name.includes(':') && (command.includes('doctor.sh') || command === 'pnpm run doctor'),
    );
    expect(aliases.length).toBeGreaterThan(0);
    expect(scripts.doctor).toBe('bash infra/scripts/doctor.sh');
  });
});
