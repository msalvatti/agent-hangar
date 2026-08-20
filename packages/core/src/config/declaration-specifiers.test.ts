/**
 * Unit tests for the declaration-specifier rewrite used by the `packages/core` build step.
 *
 * Layer: unit.
 * Goal: `rewriteDeclarationSpecifiers` turns every relative ".ts" specifier a `.d.ts` file can
 * carry — `export * from`, a named `export … from`, `import type … from`, and a dynamic
 * `import('…')` type reference — into the matching ".js" specifier, leaves bare package
 * specifiers and specifiers that are not relative untouched, and is idempotent. These are the
 * exact properties the build depends on: see `declaration-specifiers.ts` for why the rewrite
 * exists, and `packages/core/scripts/rewrite-declaration-specifiers.ts` for the build step that
 * applies it to `dist`.
 * Mocks: none — pure string transforms, no file system.
 */
import { describe, expect, it } from 'vitest';

import {
  findRelativeTsSpecifiers,
  rewriteDeclarationSpecifiers,
} from './declaration-specifiers.ts';

describe('rewriteDeclarationSpecifiers', () => {
  /**
   * `export * from` is how `dist/index.d.ts` re-exports every folder barrel — the exact shape
   * the underlying compiler defect was measured against.
   */
  it('rewrites a bare re-export', () => {
    expect(rewriteDeclarationSpecifiers(`export * from './errors.ts';`)).toBe(
      `export * from './errors.js';`,
    );
  });

  /** A named re-export carries the same `from` clause with a binding list in front of it. */
  it('rewrites a named export clause', () => {
    expect(rewriteDeclarationSpecifiers(`export { AgentHangarError } from './errors.ts';`)).toBe(
      `export { AgentHangarError } from './errors.js';`,
    );
  });

  /** `import type` is the most common form across the emitted declaration tree. */
  it('rewrites a type-only import clause', () => {
    expect(rewriteDeclarationSpecifiers(`import type { CronSpec } from './types.ts';`)).toBe(
      `import type { CronSpec } from './types.js';`,
    );
  });

  /** A dynamic `import('…')` reference is the one type-position form with no `from` keyword. */
  it('rewrites a dynamic import type reference', () => {
    expect(
      rewriteDeclarationSpecifiers(`export declare const x: import('./types.ts').CronSpec;`),
    ).toBe(`export declare const x: import('./types.js').CronSpec;`);
  });

  /** A parent-directory specifier is exercised separately from a same-directory one. */
  it('rewrites a parent-directory specifier', () => {
    expect(
      rewriteDeclarationSpecifiers(`import type { Clock } from '../../config/clock.ts';`),
    ).toBe(`import type { Clock } from '../../config/clock.js';`);
  });

  /** A double-quoted specifier must be preserved with double quotes, not normalized to single. */
  it('preserves the original quote character', () => {
    expect(rewriteDeclarationSpecifiers(`export * from "./errors.ts";`)).toBe(
      `export * from "./errors.js";`,
    );
  });

  /**
   * A bare package specifier has no leading `./` or `../`, so it never matches — rewriting it
   * would corrupt a re-export of an npm dependency such as `@prisma/client`.
   */
  it('leaves a bare package specifier untouched', () => {
    const source = `import type { PrismaClient } from '@prisma/client';`;
    expect(rewriteDeclarationSpecifiers(source)).toBe(source);
  });

  /** A specifier that already ends in ".js" (already-correct output) is left exactly as is. */
  it('leaves an already-".js" specifier untouched', () => {
    const source = `export * from './enums.js';`;
    expect(rewriteDeclarationSpecifiers(source)).toBe(source);
  });

  /** Running the rewrite against its own output must not change anything further. */
  it('is idempotent', () => {
    const once = rewriteDeclarationSpecifiers(`export * from './errors.ts';`);
    expect(rewriteDeclarationSpecifiers(once)).toBe(once);
  });

  /** Several specifiers on separate lines are each rewritten independently. */
  it('rewrites every specifier in a multi-line file', () => {
    const source = ["export * from './runner/index.ts';", "export * from './model/index.ts';"].join(
      '\n',
    );
    const rewritten = rewriteDeclarationSpecifiers(source);
    expect(rewritten).toBe(
      ["export * from './runner/index.js';", "export * from './model/index.js';"].join('\n'),
    );
  });

  /**
   * A string literal type can contain the word "from" followed by a quoted relative ".ts" path
   * without that path being a module specifier at all — the quoted text is the declared literal
   * type, not an import clause. Rewriting it would silently alter the public type surface of the
   * package, which is the opposite of what this transform exists to protect.
   */
  it('leaves a ".ts" path inside a string literal type untouched', () => {
    const source = `export declare const example = "copied from './types.ts'";`;
    expect(rewriteDeclarationSpecifiers(source)).toBe(source);
  });

  /**
   * Declaration emit copies JSDoc comments verbatim from source into `dist`, and this very
   * package's own doc comments quote specifier syntax as prose (see `findRelativeTsSpecifiers`
   * below). A comment line is never a real import/export statement, so text inside one must be
   * left alone even though it matches the same "from '<relative>.ts'" shape.
   */
  it('leaves a ".ts" path inside a comment untouched', () => {
    const source = " * as (for example `from './types.ts'`). An empty array means";
    expect(rewriteDeclarationSpecifiers(source)).toBe(source);
  });

  /**
   * A quoted default value — for example an enum member's literal value — can also contain the
   * word "from" ahead of a quoted relative ".ts" path. It is assignment-position text, not an
   * import clause, so it must be left untouched.
   */
  it('leaves a ".ts" path inside a default value untouched', () => {
    const source = `  Legacy = "from './types.ts'",`;
    expect(rewriteDeclarationSpecifiers(source)).toBe(source);
  });

  /**
   * The dynamic `import(...)` keyword is just as capable of appearing inside a string literal
   * type as `from` is; the fix must not special-case only the `from` shape.
   */
  it('leaves an "import(" call-shaped string literal type untouched', () => {
    const source = `export declare const y: "call import('./types.ts') now";`;
    expect(rewriteDeclarationSpecifiers(source)).toBe(source);
  });

  /** A line comment referencing `import('./x.ts')` as prose must not be rewritten either. */
  it('leaves an "import(" reference inside a line comment untouched', () => {
    const source = `// see import('./types.ts') for details`;
    expect(rewriteDeclarationSpecifiers(source)).toBe(source);
  });
});

describe('findRelativeTsSpecifiers', () => {
  /** A clean file (already rewritten, or never in the broken shape) reports no offenders. */
  it('returns an empty list for fully rewritten content', () => {
    expect(findRelativeTsSpecifiers(`export * from './errors.js';`)).toEqual([]);
  });

  /** Each offending occurrence is reported, in the order it appears in the source. */
  it('lists every remaining relative ".ts" specifier in order', () => {
    const source = ["import type { A } from './a.ts';", "import type { B } from './b.ts';"].join(
      '\n',
    );
    expect(findRelativeTsSpecifiers(source)).toEqual([`from './a.ts'`, `from './b.ts'`]);
  });

  /** Repeated calls against the same shared pattern must not leak state between calls. */
  it('reports the same offenders on a second call against a different file', () => {
    const first = findRelativeTsSpecifiers(`export * from './errors.ts';`);
    const second = findRelativeTsSpecifiers(`export * from './errors.ts';`);
    expect(second).toEqual(first);
  });

  /**
   * A quoted ".ts" path inside a string literal type is not a module specifier, so it must not
   * be reported as an offender the build should fail on.
   */
  it('does not report a ".ts" path inside a string literal type', () => {
    expect(
      findRelativeTsSpecifiers(`export declare const example = "copied from './types.ts'";`),
    ).toEqual([]);
  });

  /** A ".ts" path quoted inside a comment is prose, not an offender to report. */
  it('does not report a ".ts" path inside a comment', () => {
    expect(
      findRelativeTsSpecifiers(" * as (for example `from './types.ts'`). An empty array means"),
    ).toEqual([]);
  });

  /** A genuine specifier and a look-alike inside a comment are told apart on the same input. */
  it('reports only the genuine specifier when a look-alike comment is also present', () => {
    const source = [
      "import type { A } from './a.ts';",
      " * see also `from './b.ts'` for context",
    ].join('\n');
    expect(findRelativeTsSpecifiers(source)).toEqual([`from './a.ts'`]);
  });
});
