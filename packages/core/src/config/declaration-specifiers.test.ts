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
});
