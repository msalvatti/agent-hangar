/**
 * The shadcn primitives this repository vendors rather than authors.
 *
 * Layer: config (test tooling).
 *
 * `src/shared/ui/` holds two different kinds of file. Most of it is what the shadcn CLI wrote from
 * the registry named in `components.json` and nobody has touched since; the rest carries behaviour
 * this project decided on and is ordinary product code. Coverage measures the second kind and skips
 * the first, so the list below is the boundary, and `vendored.test.ts` is what keeps it true: it
 * re-hashes every file named here and fails when one of them has been edited, which moves the file
 * out of this list and under measurement instead of leaving a modified file behind an exclusion.
 *
 * The primitives deliberately absent each carry a decision of this project's own. `button.tsx` and
 * `sheet.tsx` carry a commit apiece. `sonner.tsx` was rewired at vendoring time to read the palette
 * from `@/shared/lib/theme`, because the registry's version reads it from `next-themes` — a
 * dependency this repository does not have. `command.tsx`, `dropdown-menu.tsx`, `switch.tsx` and
 * `tabs.tsx` were edited so that every row a person can click answers the pointer: the registry
 * ships menu rows and palette options with `cursor-default` and gives the switch and the tab
 * trigger no cursor at all, which spec 10 §10 does not allow.
 */

/** Directory the primitives live in, relative to the package root. */
export const VENDORED_UI_DIRECTORY = 'src/shared/ui';

/** One vendored primitive. */
export interface VendoredPrimitive {
  /** File name under {@link VENDORED_UI_DIRECTORY}. */
  file: string;
  /** SHA-256 of the file's bytes, recorded when the CLI generated it. */
  sha256: string;
}

/**
 * Every primitive that is generator output and nothing else.
 *
 * A new entry is added only when the shadcn CLI has just written the file; an existing entry is
 * re-recorded only when the CLI has just rewritten it. Editing a file by hand means removing its
 * entry, not refreshing its digest.
 */
export const VENDORED_UI_PRIMITIVES: readonly VendoredPrimitive[] = [
  {
    file: 'alert-dialog.tsx',
    sha256: '2131eab66ff04279fb82280e6158132015faa89b550e7fd4effe974101fbf9ff',
  },
  { file: 'badge.tsx', sha256: 'f23e0f14f3c9d96659342fe7ba27f43e7d668422e37b521186ad8a4e723ad495' },
  { file: 'card.tsx', sha256: '2ca127fcbf10d913becd811e768d06d3c99ad6a415dcbaae5d52a9d2ed851b0a' },
  {
    file: 'collapsible.tsx',
    sha256: '3874f47a3844a0211277fcfc3628dd7c0ad88c2ca0713f5efd1a43d74c635dc0',
  },
  {
    file: 'dialog.tsx',
    sha256: '9cbbd552632acadad5c9f79f7b50a5a1ea9185250a6b2e8f49d98372a05fd064',
  },
  {
    file: 'input-group.tsx',
    sha256: '9de0ec18ea7f19d51483bf0d222f7dd83e0fcd0ccb872e8c1a3bab0288e57285',
  },
  { file: 'input.tsx', sha256: '20c4d6bd6879069d97648f065521fd9e30d336511c490a48b1db1844f94deb7e' },
  {
    file: 'scroll-area.tsx',
    sha256: 'f9ffbe42c8cc5da01491132a745bb8659d773d5b1b47b617dfbc16c2183b07e0',
  },
  {
    file: 'separator.tsx',
    sha256: '211bbbd08b440259a3e20f0abe72838581843eee766f3c928235cb94a81dc184',
  },
  {
    file: 'skeleton.tsx',
    sha256: '3865da6bcfd7adac5d27c64cf85c92848e920512cc2167a622cfc3c8e37b1085',
  },
  { file: 'table.tsx', sha256: 'ca314129c22cedb33a55a7503b9481331bba35b3df630797970584120646508a' },
  {
    file: 'textarea.tsx',
    sha256: '7f7348fe732b3cdb19f016210048f46c9fc22b8b1ebe33f0284a58cca4d531b9',
  },
  {
    file: 'tooltip.tsx',
    sha256: 'f4286d2106f8a9770afe2781390f46d620efa475526b59eaa9d20fbde66b2be4',
  },
];

/** The vendored primitives as coverage globs, for `vitest.config.ts`. */
export const VENDORED_UI_COVERAGE_EXCLUDE: readonly string[] = VENDORED_UI_PRIMITIVES.map(
  (primitive) => `${VENDORED_UI_DIRECTORY}/${primitive.file}`,
);
