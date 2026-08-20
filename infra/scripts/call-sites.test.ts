/**
 * Unit tests for how the infra scripts and the root manifest invoke each other.
 *
 * Layer: unit (reads the committed files; runs nothing).
 * Goal: rules that hold across many files and that no single behavioural test can pin. First,
 * every command that acts on an already configured instance resolves it through
 * `env.sh --print-checked`, so none of them can drift back to deriving an instance from the shell
 * while the checkout's env file says otherwise. Second, the diagnostic is reachable under a name
 * the package manager does not claim. Third, no script reaches one of this repository's own
 * package scripts by a spelling that drops the flags it passes.
 * Mocks: none.
 */
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { read, rootScripts, scriptsDir, shellScripts } from './testing/committed-files.js';

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

/**
 * Every `pnpm` invocation a script executes or prints, as `[lineNumber, words]`.
 *
 * Whole-line `#` comments are dropped first: a rule about what a script *does* must not fire on
 * prose that explains it, and the documentation headers here discuss the very spellings these
 * guards forbid. What is left is reduced to command words by blanking every character that cannot
 * appear in one, which is what lifts `pnpm` out of `echo "… \"pnpm run setup --force\" …"`
 * without a shell parser.
 *
 * @param source - A shell script's full text.
 * @returns One entry per `pnpm` word, carrying that word and the ones after it on its line.
 */
function pnpmInvocations(source: string): [number, string[]][] {
  const invocations: [number, string[]][] = [];
  source.split('\n').forEach((text, index) => {
    if (/^\s*#/.test(text)) {
      return;
    }
    const words = text
      .replace(/[^A-Za-z0-9_:./-]+/g, ' ')
      .trim()
      .split(' ');
    words.forEach((word, position) => {
      if (word === 'pnpm') {
        invocations.push([index + 1, words.slice(position + 1)]);
      }
    });
  });
  return invocations;
}

/**
 * The root manifest's script names that pnpm may resolve to one of its own built-in commands.
 *
 * A name containing a colon cannot collide, because no pnpm built-in has one — that is the whole
 * reason `infra:doctor` exists — so those are excluded and left free to carry flags.
 *
 * @returns The colon-free script names.
 */
function shadowableScriptNames(): string[] {
  return Object.keys(rootScripts()).filter((name) => !name.includes(':'));
}

/**
 * The places in one text where a flag is attached to a bare package script name — the spelling
 * that loses the flag.
 *
 * @param source - A shell script's full text, or one command line from the root manifest.
 * @returns `[lineNumber, 'pnpm <script> <flag>']` per violation.
 */
function droppedFlagSpellings(source: string): [number, string][] {
  const shadowable = shadowableScriptNames();
  return pnpmInvocations(source)
    .filter(
      ([, words]) =>
        words[0] !== undefined &&
        shadowable.includes(words[0]) &&
        words[1]?.startsWith('-') === true,
    )
    .map(([line, words]): [number, string] => [line, `pnpm ${words[0]} ${words[1]}`]);
}

describe('package script spellings', () => {
  /**
   * `pnpm setup --force` does not do what it reads like. pnpm parses the flags that follow a
   * built-in command name against that command's own option list before it falls back to the
   * package script, and `--force` is one of `pnpm setup`'s options: it is swallowed there and the
   * script runs with no arguments at all. `env.sh` printed exactly that line as the remedy for an
   * incomplete env file, so following the advice reprinted the same error — a loop entered at the
   * moment the reader is already stuck. `pnpm run <script>` passes everything after the name
   * through untouched, so any advice or invocation that carries a flag has to use it.
   */
  it.each(shellScripts())(
    '%s never attaches a flag to a bare package script name',
    (_name, source) => {
      const found = droppedFlagSpellings(source).map(([line, text]) => `${line}: ${text}`);
      expect(found).toEqual([]);
    },
  );

  /**
   * The root manifest answers to the same rule: its own one-liners are `pnpm` command lines too,
   * and one of them spelled this way would lose its flags exactly as the printed advice did.
   */
  it('the root manifest reaches its own scripts without dropping their flags', () => {
    const found = Object.entries(rootScripts()).flatMap(([name, command]) =>
      droppedFlagSpellings(command).map(([, text]) => `${name}: ${text}`),
    );
    expect(found).toEqual([]);
  });

  /**
   * The other half of the same problem: `doctor` is a name pnpm claims outright, so `pnpm doctor`
   * never reaches this project's diagnostic at all — it reports on the pnpm installation and exits
   * 0 whatever state the environment is in. A script that tells a reader to verify the app has to
   * name `pnpm infra:doctor` or `pnpm run doctor`.
   */
  it.each(shellScripts())(
    '%s does not send the reader to a shadowed `pnpm doctor`',
    (_name, source) => {
      const found = pnpmInvocations(source)
        .filter(([, words]) => words[0] === 'doctor')
        .map(([line]) => line);
      expect(found).toEqual([]);
    },
  );
});
