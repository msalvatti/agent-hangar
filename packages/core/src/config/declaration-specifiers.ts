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
 * module supplies the rewrite that makes the emitted graph name files that actually exist;
 * `packages/core/scripts/rewrite-declaration-specifiers.ts` applies it to the files on disk after
 * every successful `tsc -b` — every caller chains the two with `&&`, so a failing compile skips
 * the rewrite and can leave a partially-emitted, unrewritten `dist` behind.
 */

/**
 * Matches a quoted relative path ending in ".ts", immediately preceded by the `from` keyword or
 * an opening `import(`. This is only a *candidate* — the same text shape occurs inside a string
 * literal type, a comment, or any other quoted prose that happens to contain the words "from" or
 * "import(" followed by a path-shaped quoted string. `isGenuineSpecifierPosition` below rules
 * those false positives out; only a candidate that also passes that check is a real module
 * specifier. A bare package specifier (no leading `./` or `../`) never matches this pattern at
 * all, so re-exports of npm dependencies pass through untouched regardless.
 */
// Stryker disable next-line Regex: the run of whitespace before `import`'s parenthesis is written
// for the shape rather than reached by it — the emitter writes `import(` with nothing between the
// two, so a pattern demanding one non-space character there matches the same text by matching none.
const RELATIVE_TS_SPECIFIER_PATTERN = /\b(from\s*|import\s*\()(['"])(\.\.?\/[^'"]+)\.ts\2/g;

/**
 * Decides whether a candidate match found by `RELATIVE_TS_SPECIFIER_PATTERN` sits in one of the
 * two positions TypeScript's declaration emitter actually writes a module specifier in: a static
 * `import`/`export … from '…'` statement (including bare `export * from '…'`) or a dynamic
 * `import('…')` type reference. Both positions share one property that a false positive never
 * has: nothing between the start of the line and the `from`/`import(` keyword is a quote
 * character, and the line itself does not open with a comment marker — a line comment, a block
 * comment's opening delimiter (which also covers a self-contained, single-line doc comment), or
 * the `*` that starts a JSDoc continuation line. Declaration emit copies doc comments verbatim,
 * and this project's own comments quote specifier syntax as prose (see `findRelativeTsSpecifiers`
 * below), so both comment shapes are real risks, not hypothetical ones. A quoted string or a
 * hand-written comment that merely contains the words "from" or "import(" fails one of these
 * checks, because the string's opening quote — or the comment marker — necessarily precedes the
 * keyword on that line.
 *
 * @param source - Full declaration text the candidate was found in.
 * @param matchIndex - Index, in `source`, where the candidate keyword starts.
 * @returns `true` when the text preceding the match is consistent with a real specifier position.
 */
function isGenuineSpecifierPosition(source: string, matchIndex: number): boolean {
  // Stryker disable next-line ArithmeticOperator: the match starts on a keyword, so neither the
  // character at the index nor the one after it can be the line break this searches back for —
  // both spellings find the same one.
  const lineStart = source.lastIndexOf('\n', matchIndex - 1) + 1;
  const linePrefix = source.slice(lineStart, matchIndex);
  if (/^[ \t]*(?:\/\/|\/\*|\*)/.test(linePrefix)) {
    return false;
  }
  return !/['"]/.test(linePrefix);
}

/**
 * Rewrites every relative ".ts" specifier in `source` to end in ".js" instead, leaving every other
 * character — including bare package specifiers, specifiers that already end in ".js", and any
 * quoted text that merely resembles a specifier without being one — exactly as it was.
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
    (match: string, keyword: string, quote: string, path: string, offset: number, full: string) => {
      if (!isGenuineSpecifierPosition(full, offset)) {
        return match;
      }
      return `${keyword}${quote}${path}.js${quote}`;
    },
  );
}

/**
 * Lists every relative ".ts" specifier still present in `source`, in the exact text they occur
 * as (for example `from './types.ts'`). Quoted text that merely resembles a specifier — inside a
 * string literal type, a comment, or a default value — is not a specifier and is not reported. An
 * empty array means the declaration text is fully rewritten.
 *
 * @param source - Declaration file content to inspect.
 * @returns The offending specifier occurrences, in order of appearance.
 */
export function findRelativeTsSpecifiers(source: string): string[] {
  return [...source.matchAll(RELATIVE_TS_SPECIFIER_PATTERN)]
    .filter((match) => isGenuineSpecifierPosition(source, match.index))
    .map((match) => match[0]);
}
