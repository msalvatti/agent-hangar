/**
 * Unit tests for `.conductor/settings.toml`.
 *
 * Layer: unit (parses the committed file; reads and stats the scripts it references).
 * Goal: the file matches spec 05 §6 exactly (schema URL, the three script paths, `run_mode`),
 * every referenced script exists relative to the repository root, is executable, and starts with
 * a bash shebang — so a typo or a missing `chmod +x` is caught before Conductor ever runs it.
 * Mocks: none.
 */
import { accessSync, constants, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const settingsPath = join(repoRoot, '.conductor', 'settings.toml');

/** One parsed TOML value: a top-level string, or a table of string values. */
type TomlValue = string | Record<string, string>;

/**
 * Parses the small TOML subset `.conductor/settings.toml` uses: `[table]` headers, `key = "value"`
 * and `"quoted key" = "value"` lines, `#` comments and blank lines. Throws on anything else, so
 * the file drifting out of this shape is caught by a test failure instead of silently parsing to
 * something unexpected.
 *
 * @param text - Raw file content.
 * @returns Top-level string values, plus one nested object per `[table]`.
 */
function parseTomlSubset(text: string): Record<string, TomlValue> {
  const result: Record<string, TomlValue> = {};
  let table: Record<string, string> | null = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const tableMatch = /^\[([A-Za-z0-9_-]+)\]$/.exec(line);
    if (tableMatch?.[1] !== undefined) {
      table = {};
      result[tableMatch[1]] = table;
      continue;
    }
    const pairMatch = /^(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*=\s*"([^"]*)"$/.exec(line);
    if (pairMatch) {
      const key = pairMatch[1] ?? pairMatch[2] ?? '';
      const value = pairMatch[3] ?? '';
      if (table === null) {
        result[key] = value;
      } else {
        table[key] = value;
      }
      continue;
    }
    throw new Error(`Unsupported TOML line: ${line}`);
  }
  return result;
}

describe('.conductor/settings.toml', () => {
  const parsed = parseTomlSubset(readFileSync(settingsPath, 'utf8'));

  /**
   * The schema URL and every script path/run_mode match spec 05 §6 exactly.
   */
  it('matches the documented schema and scripts', () => {
    expect(parsed.$schema).toBe('https://conductor.build/schemas/settings.repo.schema.json');
    expect(parsed.scripts).toEqual({
      setup: './infra/scripts/setup.sh',
      run: './infra/scripts/run.sh',
      archive: './infra/scripts/archive.sh',
      run_mode: 'concurrent',
    });
  });

  /**
   * Every script Conductor calls exists relative to the repository root, is executable, and is a
   * bash script — a missing `chmod +x` (a real regression the Task 1I.1 mode-change history
   * proves is easy to lose in a rebase) fails this test immediately.
   */
  it.each(['setup', 'run', 'archive'])('%s references an executable bash script', (name) => {
    const scripts = parsed.scripts;
    if (typeof scripts !== 'object') {
      throw new Error('scripts table missing');
    }
    const relativePath = scripts[name];
    if (relativePath === undefined) {
      throw new Error(`scripts.${name} missing`);
    }
    const absolutePath = join(repoRoot, relativePath);
    expect(() => {
      accessSync(absolutePath, constants.X_OK);
    }).not.toThrow();
    expect(readFileSync(absolutePath, 'utf8')).toMatch(/^#!\/usr\/bin\/env bash\n/);
  });

  /**
   * A line outside the supported subset (proving the parser is not silently permissive) throws.
   */
  it('rejects an unsupported line', () => {
    expect(() => parseTomlSubset('not-a-valid-line')).toThrow('Unsupported TOML line');
  });
});
