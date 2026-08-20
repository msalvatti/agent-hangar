/**
 * ESLint flat configuration for the whole monorepo.
 *
 * Layer: config.
 *
 * Strict type-checked TypeScript rules everywhere, import ordering, security rules, React/Next
 * rules scoped to the web app, and the project-wide bans: no `enum`, no bare `crypto` import,
 * no `uuid`/`nanoid`, and `dockerode` only inside the Docker runner folder.
 */
import nextPlugin from '@next/eslint-plugin-next';
import { defineConfig, globalIgnores } from 'eslint/config';
import { importX } from 'eslint-plugin-import-x';
import reactHooks from 'eslint-plugin-react-hooks';
import security from 'eslint-plugin-security';
import tseslint from 'typescript-eslint';

/** Folders that are generated, vendored or emitted and therefore never linted. */
const IGNORED_GLOBS = [
  '**/dist/**',
  '**/.next/**',
  '**/coverage/**',
  '**/reports/**',
  '**/node_modules/**',
  '**/playwright-report/**',
  '**/test-results/**',
  'packages/core/src/persistence/generated/**',
  'apps/web/next-env.d.ts',
];

/** Import restrictions shared by every workspace. */
const RESTRICTED_IMPORT_PATHS = [
  { name: 'crypto', message: 'Use the prefixed form: node:crypto.' },
  { name: 'uuid', message: 'Use crypto.randomUUID() from node:crypto.' },
  { name: 'nanoid', message: 'Use crypto.randomUUID() from node:crypto.' },
  {
    name: 'dockerode',
    message: 'dockerode may only be imported under packages/core/src/runner/docker/.',
  },
];

export default defineConfig([
  globalIgnores(IGNORED_GLOBS),

  // Type-aware TypeScript rules for every TS/TSX source file.
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    extends: [
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
      importX.flatConfigs.recommended,
      importX.flatConfigs.typescript,
      security.configs.recommended,
    ],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: {
          // Tool config files live outside every package `src/` (and thus outside the
          // project references); they are type-checked against the base compiler options.
          allowDefaultProject: ['*.config.ts', 'packages/*/*.config.ts', 'apps/worker/*.config.ts'],
          defaultProject: 'tsconfig.base.json',
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      'import-x/resolver-next': [
        importX.createNodeResolver({
          extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'],
        }),
      ],
    },
    rules: {
      // Project bans.
      'no-restricted-syntax': [
        'error',
        { selector: 'TSEnumDeclaration', message: 'Use string-literal unions.' },
      ],
      'no-restricted-imports': ['error', { paths: RESTRICTED_IMPORT_PATHS }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-expect-error': true,
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-check': false,
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      // Import hygiene.
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          pathGroups: [{ pattern: '@/**', group: 'internal', position: 'before' }],
          pathGroupsExcludedImportTypes: ['builtin'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'import-x/no-duplicates': 'error',
      'import-x/first': 'error',
      'import-x/newline-after-import': 'error',
      // Module resolution is verified by `tsc -b`; the node resolver cannot see workspace
      // package `exports` before those packages are built, so these would false-positive.
      'import-x/no-unresolved': 'off',
      'import-x/named': 'off',
      'import-x/namespace': 'off',
      'import-x/default': 'off',
      'import-x/no-named-as-default-member': 'off',
      // Flags every bracket access; `noUncheckedIndexedAccess` already forces a guard.
      'security/detect-object-injection': 'off',
    },
  },

  // Barrels re-export whole folders with `export *`; a folder that is type-only today may gain
  // runtime exports later, so forcing `export type *` here would break those additions.
  {
    files: ['**/index.ts'],
    rules: {
      '@typescript-eslint/consistent-type-exports': 'off',
    },
  },

  // In-memory repositories implement asynchronous ports with synchronous bodies; `async` keeps
  // rejections (not throws) on the error path without sprinkling `await Promise.resolve()`.
  {
    files: ['packages/core/src/testing/in-memory/**/*.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
    },
  },

  // The Docker runner is the only place allowed to import dockerode.
  {
    files: ['packages/core/src/runner/docker/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: RESTRICTED_IMPORT_PATHS.filter((entry) => entry.name !== 'dockerode') },
      ],
    },
  },

  // React and Next.js rules only apply to the web app.
  {
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
    extends: [reactHooks.configs.flat.recommended],
    plugins: { '@next/next': nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      // App Router only: there is no `pages/` directory for this rule to scan.
      '@next/next/no-html-link-for-pages': 'off',
    },
    settings: {
      next: { rootDir: 'apps/web/' },
    },
  },

  // Generated shadcn components: stylistic rules relaxed by configuration, never by comments.
  {
    files: ['apps/web/src/shared/ui/**/*.tsx', 'apps/web/src/shared/ui/**/*.ts'],
    rules: {
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      'react-hooks/refs': 'off',
      'import-x/order': 'off',
    },
  },

  // Test files may use Vitest idioms that the strict preset flags.
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/e2e/**/*.ts', '**/src/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
      'security/detect-non-literal-fs-filename': 'off',
      'security/detect-child-process': 'off',
    },
  },

  // Build-time tooling walks and rewrites paths it computes from a directory listing, never from
  // untrusted input; the same rule is already off for test files for the same reason.
  {
    files: ['packages/core/scripts/**/*.ts'],
    rules: {
      'security/detect-non-literal-fs-filename': 'off',
    },
  },

  // Plain JavaScript config and script files are linted with the core rules only.
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [importX.flatConfigs.recommended],
    rules: {
      'import-x/order': ['error', { 'newlines-between': 'always', alphabetize: { order: 'asc' } }],
      'import-x/no-unresolved': 'off',
    },
  },
]);
