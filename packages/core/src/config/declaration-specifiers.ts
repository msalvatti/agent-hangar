/**
 * Pure text transform that rewrites relative ".ts" specifiers to ".js" in emitted declarations.
 *
 * Layer: config (pure functions; no file-system access — the build step that walks `dist` and
 * writes the result lives in `packages/core/scripts/rewrite-declaration-specifiers.ts`).
 *
 * `rewriteRelativeImportExtensions` lets this package write relative imports with a ".ts"
 * extension in source, so a bundler can resolve `@agent-hangar/core` straight from source during
 * development. The compiler rewrites those specifiers back to ".js" when it emits JavaScript, but
 * it does not apply the same rewrite when it emits declaration files: as of TypeScript 6 that is
 * an open compiler defect (microsoft/TypeScript#61037). Left alone, every emitted `.d.ts` under
 * `dist` names a `.ts` sibling that does not exist anywhere on disk — `tsc` itself tolerates this
 * by substituting a matching `.d.ts` when it resolves a `.ts`-suffixed specifier, but that
 * substitution is a TypeScript-specific accommodation, not something every declaration consumer
 * implements, and it does not change the fact that the specifier written to disk is wrong. This
 * module supplies the rewrite that makes the emitted graph name files that actually exist; the
 * build script applies it to the files on disk.
 */

/**
 * Matches a quoted relative module specifier ending in ".ts" that immediately follows the `from`
 * keyword or an opening `import(`. Those are the only two syntactic positions in which
 * TypeScript's declaration emitter writes a module specifier: static
 * `import`/`export { … } from '…'` statements (including bare `export * from '…'`) and a dynamic
 * `import('…')` reference used in a type position. A bare package specifier (no leading `./` or
 * `../`) never matches, so re-exports of npm dependencies pass through untouched.
 */
const RELATIVE_TS_SPECIFIER_PATTERN = /\b(from\s*|import\s*\()(['"])(\.\.?\/[^'"]+)\.ts\2/g;

/**
 * Rewrites every relative ".ts" specifier in `source` to end in ".js" instead, leaving every other
 * character — including bare package specifiers and specifiers that already end in ".js" — exactly
 * as it was.
 *
 * ".ts" and ".js" are both three characters, so this never changes the length of a line: any
 * `.d.ts.map` generated for the original file stays byte-accurate against the rewritten one, and
 * no source-map regeneration is needed alongside this rewrite.
 *
 * Idempotent: a specifier is only matched while it still ends in ".ts", so applying this to text
 * it has already rewritten returns the input unchanged.
 *
 * @param source - Declaration file content to rewrite.
 * @returns The rewritten content.
 */
export function rewriteDeclarationSpecifiers(source: string): string {
  return source.replace(
    RELATIVE_TS_SPECIFIER_PATTERN,
    (_match, keyword: string, quote: string, path: string) =>
      `${keyword}${quote}${path}.js${quote}`,
  );
}

/**
 * Lists every relative ".ts" specifier still present in `source`, in the exact text they occur
 * as (for example `from './types.ts'`). An empty array means the declaration text is fully
 * rewritten.
 *
 * @param source - Declaration file content to inspect.
 * @returns The offending specifier occurrences, in order of appearance.
 */
export function findRelativeTsSpecifiers(source: string): string[] {
  return [...source.matchAll(RELATIVE_TS_SPECIFIER_PATTERN)].map((match) => match[0]);
}
