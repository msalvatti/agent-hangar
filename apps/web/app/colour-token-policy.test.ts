/** @vitest-environment node */
/**
 * Policy test: a colour token that is only legible on its own background is never used as text
 * without that background.
 *
 * Layer: unit.
 * Goal: the palette holds two kinds of colour. Some tokens — `foreground`, `muted-foreground`,
 * `accent`, `warning` — are meant to be read on whatever surface the page happens to paint. The
 * rest are the other half of a pair: `accent-foreground` is white in light and near-black in dark
 * because it is drawn *on* `accent`, and on the page surface it is invisible in both themes. Using
 * one of those as a resting text colour produces a label nobody can read, and nothing in the build
 * complains: the class exists, the utility resolves, the element renders.
 *
 * Asserting that a component carries a particular class would not catch that — the class was never
 * missing, it was the wrong one, so the assertion passes against the defect just as happily. This
 * suite measures instead. It reads the palette out of `globals.css`, computes each token's WCAG
 * contrast against the surfaces the app paints, and derives which tokens fall in the second group
 * rather than taking a hand-written list; then it walks every class string in the app and requires
 * each use of one of those tokens as text to paint, on the same element, a background that carries
 * it.
 *
 * The derivation is what makes this general: a palette change that turns a readable token into an
 * on-colour puts it under the rule automatically, and a component written later is covered without
 * anyone remembering this file exists.
 * Mocks: none.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** Root of the web app, from which the stylesheet and the sources are read. */
const APP_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Contrast a token must reach against the app's surfaces to count as readable on one.
 *
 * This is the WCAG 2.1 floor for large text and for non-text contrast, and it is used here to sort
 * the palette rather than to certify any particular label: the gap between the two groups is wide
 * — the least readable of the surface colours clears 4:1 while every on-colour sits under 1.3:1 —
 * so any threshold inside that gap sorts it identically. The suite asserts the gap, so a palette
 * edit that narrows it fails visibly instead of quietly reclassifying a token.
 */
const SURFACE_LEGIBILITY_RATIO = 3;

/** Contrast text must reach against the background painted behind it: WCAG 2.1 AA for body text. */
const PAIRED_TEXT_RATIO = 4.5;

/** The tokens this app paints as a surface, and therefore the backgrounds text can land on. */
const SURFACE_TOKENS = ['background', 'card', 'popover', 'sidebar', 'muted', 'secondary'] as const;

/** How far a `var(--x)` chain is followed before the value is treated as unresolvable. */
const MAX_VARIABLE_HOPS = 4;

/** Prefix of a CSS variable reference. */
const VARIABLE_PREFIX = 'var(--';

/** One palette: custom-property name to the value declared for it. */
type Palette = Readonly<Record<string, string>>;

/**
 * Extracts the declarations of one CSS block.
 *
 * The opener is matched at the start of a line, so `.dark {` finds the palette rather than the
 * later `html.dark {` rule that merely contains the same characters. A missing block throws rather
 * than returning nothing: returning `{}` would read downstream as a palette that parsed and
 * happens to be empty, which is how a check quietly stops checking.
 *
 * @param css - The whole stylesheet.
 * @param opener - The block's opening line, up to and including the brace.
 * @returns Custom-property name to declared value.
 * @throws When the stylesheet has no such block.
 */
function blockDeclarations(css: string, opener: string): Palette {
  // The leading newline makes "at the start of a line" one search, first line included.
  const lines = `\n${css}`;
  const start = lines.indexOf(`\n${opener}`);
  if (start === -1) {
    throw new Error(`globals.css has no "${opener}" block, so its palette cannot be read`);
  }
  const body = lines.slice(start, lines.indexOf('\n}', start));
  const declarations: Record<string, string> = {};
  for (const [, name, value] of body.matchAll(/--([a-z-]+):\s*([^;]+);/g)) {
    if (name !== undefined && value !== undefined) {
      declarations[name] = value.trim();
    }
  }
  return declarations;
}

const stylesheet = readFileSync(join(APP_ROOT, 'app/globals.css'), 'utf8');

/** `@theme inline`: the Tailwind colour names, each pointing at the palette variable behind it. */
const themeColours = blockDeclarations(stylesheet, '@theme inline {');

/** The two palettes the app ships. Every token is declared in both. */
const PALETTES: readonly Palette[] = [
  blockDeclarations(stylesheet, ':root {'),
  blockDeclarations(stylesheet, '.dark {'),
];

/**
 * Resolves a Tailwind colour name to the hex value it ends up with in one palette.
 *
 * Both indirections are followed: `--color-ring: var(--ring)` in the theme block and
 * `--ring: var(--accent)` inside the palette itself.
 *
 * @param name - Tailwind colour name, such as `accent-foreground`.
 * @param palette - The palette to resolve in.
 * @returns The hex value, or `undefined` when the name resolves to something that is not a colour.
 */
function resolveColour(name: string, palette: Palette): string | undefined {
  let value = themeColours[`color-${name}`];
  for (
    let hop = 0;
    hop < MAX_VARIABLE_HOPS && value?.startsWith(VARIABLE_PREFIX) === true;
    hop += 1
  ) {
    value = palette[value.slice(VARIABLE_PREFIX.length, -1)];
  }
  return value !== undefined && /^#[0-9a-f]{6}$/i.test(value) ? value : undefined;
}

/**
 * Relative luminance of an `#rrggbb` colour.
 *
 * The coefficients and the sRGB linearisation are the ones WCAG 2.1 defines for this purpose.
 *
 * @param hex - The colour.
 * @returns Its relative luminance, 0 to 1.
 */
function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/**
 * WCAG 2.1 contrast ratio between two colours.
 *
 * @param first - One colour.
 * @param second - The other.
 * @returns The ratio, 1 to 21.
 */
function contrast(first: string, second: string): number {
  const one = luminance(first);
  const other = luminance(second);
  return (Math.max(one, other) + 0.05) / (Math.min(one, other) + 0.05);
}

/** A colour token of the theme, with how readable it is on the surfaces the app paints. */
interface ColourToken {
  /** Tailwind colour name, such as `accent-foreground`. */
  name: string;
  /** Its worst contrast against any surface, across both palettes. */
  worstOnSurface: number;
}

/**
 * The worst contrast a token reaches against any surface, across both palettes.
 *
 * @param name - Tailwind colour name.
 * @returns The ratio, or `undefined` when the name does not resolve to a colour in both palettes.
 */
function worstContrastOnSurfaces(name: string): number | undefined {
  const ratios: number[] = [];
  for (const palette of PALETTES) {
    const colour = resolveColour(name, palette);
    if (colour === undefined) {
      return undefined;
    }
    for (const surface of SURFACE_TOKENS) {
      const surfaceColour = resolveColour(surface, palette);
      if (surfaceColour !== undefined) {
        ratios.push(contrast(colour, surfaceColour));
      }
    }
  }
  return Math.min(...ratios);
}

/** Every colour name the theme block declares, whether or not it resolves to a value. */
const THEME_COLOUR_NAMES = Object.keys(themeColours)
  .filter((key) => key.startsWith('color-'))
  .map((key) => key.slice('color-'.length));

/** Every colour the theme names, measured against the surfaces. */
const COLOUR_TOKENS: readonly ColourToken[] = THEME_COLOUR_NAMES.flatMap((name) => {
  const worstOnSurface = worstContrastOnSurfaces(name);
  return worstOnSurface === undefined ? [] : [{ name, worstOnSurface }];
});

/** Tokens that are unreadable on at least one surface in at least one palette. */
const ON_COLOUR_TOKENS = COLOUR_TOKENS.filter(
  (token) => token.worstOnSurface < SURFACE_LEGIBILITY_RATIO,
);

/** Tokens that are readable on every surface in both palettes. */
const SURFACE_LEGIBLE_TOKENS = COLOUR_TOKENS.filter(
  (token) => token.worstOnSurface >= SURFACE_LEGIBILITY_RATIO,
);

/** One class string found in the sources, with where it came from. */
interface ClassString {
  /** Path relative to the web app root. */
  file: string;
  /** 1-based line the string literal starts on. */
  line: number;
  /** The literal's contents. */
  text: string;
}

/** A class atom taken apart: the states that switch it on, and the utility itself. */
interface ClassAtom {
  /** Variant segments, in source order. Empty when the utility always applies. */
  variants: string[];
  /** The utility, with no variant prefix. */
  utility: string;
}

/**
 * Splits a Tailwind class atom into its variant segments and the utility itself.
 *
 * Colons inside square brackets or parentheses belong to arbitrary values (`data-[side=bottom]`,
 * `[a]:hover`), so the split walks the atom rather than using `split(':')`.
 *
 * @param atom - One whitespace-delimited class.
 * @returns Its variants and its utility.
 */
function splitVariants(atom: string): ClassAtom {
  const variants: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < atom.length; index += 1) {
    const character = atom[index];
    if (character === '[' || character === '(') {
      depth += 1;
    } else if (character === ']' || character === ')') {
      depth -= 1;
    } else if (character === ':' && depth === 0) {
      variants.push(atom.slice(start, index));
      start = index + 1;
    }
  }
  return { variants, utility: atom.slice(start) };
}

/** A colour utility taken apart: the token it names, and whether it is painted at full strength. */
interface ColourUtility {
  /** The Tailwind colour name. */
  name: string;
  /** `false` when an opacity modifier makes the rendered colour depend on what is behind it. */
  isOpaque: boolean;
}

/**
 * Reads the colour token out of a `text-` or `bg-` utility.
 *
 * The opacity modifier is reported rather than discarded. `bg-primary/10` renders as mostly the
 * surface underneath it, so its contrast against the text is not the contrast of `primary` — and
 * which surface is underneath is not knowable from the class string.
 *
 * @param utility - The utility part of a class atom.
 * @param prefix - `text-` or `bg-`.
 * @returns The token and its opacity, or `undefined` when the utility is not a colour of that kind.
 */
function colourUtilityOf(utility: string, prefix: string): ColourUtility | undefined {
  if (!utility.startsWith(prefix)) {
    return undefined;
  }
  const value = utility.slice(prefix.length);
  const separator = value.indexOf('/');
  const name = separator === -1 ? value : value.slice(0, separator);
  return COLOUR_TOKENS.some((token) => token.name === name)
    ? { name, isOpaque: separator === -1 }
    : undefined;
}

/**
 * Whether a class string paints a background that carries `token` whenever `states` hold.
 *
 * A background is only accepted when every state guarding it also guards the text:
 * `hover:bg-primary` does not carry text that is painted unconditionally, because the text is
 * there before the pointer is. The text may carry extra states of its own —
 * `focus:**:text-accent-foreground` is fine under `focus:bg-accent`, which is how a menu item
 * tints its children.
 *
 * A translucent background is refused outright rather than measured as if it were solid. What
 * `bg-primary/10` actually renders as depends on the surface beneath it, and that surface is not
 * knowable from a class string — so the honest answer is that this evidence does not establish the
 * text is readable, not that it does.
 *
 * @param classString - The class string of the element painting the background.
 * @param token - Name of the text colour token that has to be carried.
 * @param states - The variants guarding the text.
 * @returns `true` when such a background exists and reaches AA in light and in dark.
 */
function isCarriedBy(classString: string, token: string, states: readonly string[]): boolean {
  return classString.split(/\s+/).some((atom) => {
    const { variants, utility } = splitVariants(atom);
    const background = colourUtilityOf(utility, 'bg-');
    if (background?.isOpaque !== true) {
      return false;
    }
    if (!variants.every((variant) => states.includes(variant))) {
      return false;
    }
    return PALETTES.every((palette) => {
      const text = resolveColour(token, palette);
      const surface = resolveColour(background.name, palette);
      return (
        text !== undefined && surface !== undefined && contrast(text, surface) >= PAIRED_TEXT_RATIO
      );
    });
  });
}

/** A `group-*` variant resolved into the group it names and the state it waits for. */
interface GroupReference {
  /** The class that marks the group element: `group` or `group/<name>`. */
  marker: string;
  /** The variants the group element itself has to be under for the text to appear. */
  states: string[];
}

/**
 * Resolves the `group-*` variant of a class atom, when it has one.
 *
 * `group-focus/dropdown-menu-item:text-accent-foreground` paints its text when the element marked
 * `group/dropdown-menu-item` is focused, so the background that has to carry it lives on that
 * element under `focus:`. The atom's other variants are kept, so a background guarded by one of
 * them is still accepted.
 *
 * @param variants - The variants of the class atom.
 * @returns The group and the states expected on it, or `undefined` when there is no group variant.
 */
function groupReferenceOf(variants: readonly string[]): GroupReference | undefined {
  const states: string[] = [];
  let marker: string | undefined;
  for (const variant of variants) {
    const named = /\/([a-zA-Z0-9_-]+)$/.exec(variant);
    const head = named === null ? variant : variant.slice(0, variant.length - named[0].length);
    if (!head.startsWith('group-')) {
      states.push(variant);
      continue;
    }
    marker = named === null ? 'group' : `group/${named[1] ?? ''}`;
    states.push(head.slice('group-'.length));
  }
  return marker === undefined ? undefined : { marker, states };
}

/**
 * Collects every string literal of every source file under a directory.
 *
 * Test files are skipped: a class name written in a test is an expectation about a component, not
 * a style the browser ever applies, so the rule has nothing to say about it.
 *
 * @param directory - Directory relative to the web app root.
 * @returns Every literal found below it.
 */
function collectClassStrings(directory: string): ClassString[] {
  const found: ClassString[] = [];
  for (const entry of readdirSync(join(APP_ROOT, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
        found.push(...collectClassStrings(relative));
      }
      continue;
    }
    if (!/\.tsx?$/.test(entry.name) || /\.(test|spec)\.tsx?$/.test(entry.name)) {
      continue;
    }
    const source = readFileSync(join(APP_ROOT, relative), 'utf8');
    for (const match of source.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`\n$]*)`/g)) {
      const text = match[1] ?? match[2] ?? match[3] ?? '';
      if (text.trim() !== '') {
        found.push({ file: relative, line: source.slice(0, match.index).split('\n').length, text });
      }
    }
  }
  return found;
}

/** Every class-string candidate in the app's own sources. */
const classStrings = [...collectClassStrings('app'), ...collectClassStrings('src')];

/** One place an on-colour token is painted as text, and therefore one subject of the rule. */
interface OnColourTextUse {
  /** The class string it was found in. */
  origin: ClassString;
  /** The whole atom, as written. */
  atom: string;
  /** The variants guarding it. */
  variants: string[];
  /** The on-colour token it paints. */
  token: ColourToken;
  /** `false` when the text itself carries an opacity modifier. */
  isOpaque: boolean;
}

/** Every use of an on-colour token as text, anywhere in the app. */
const onColourTextUses: readonly OnColourTextUse[] = classStrings.flatMap((origin) =>
  origin.text.split(/\s+/).flatMap((atom) => {
    const { variants, utility } = splitVariants(atom);
    const colour = colourUtilityOf(utility, 'text-');
    if (colour === undefined) {
      return [];
    }
    const token = ON_COLOUR_TOKENS.find((candidate) => candidate.name === colour.name);
    return token === undefined
      ? []
      : [{ origin, atom, variants, token, isOpaque: colour.isOpaque }];
  }),
);

/**
 * Why an on-colour text use is not licensed, or `undefined` when it is.
 *
 * A `group-*` variant is licensed by the element declaring the group, which Tailwind resolves to an
 * ancestor. A class string cannot show ancestry, so the licence is granted only when the file
 * declares that group exactly once and that one declaration carries the text: with a single
 * declaration, either it is the ancestor, or the variant never fires against a local group and
 * nothing is painted at all. Two declarations cannot be told apart and none means the ancestor
 * lives in another file, so both refuse — the ambiguity fails closed rather than open.
 *
 * @param use - The use to judge.
 * @returns The reason it is unlicensed, or `undefined` when it is fine.
 */
function unlicensedReason(use: OnColourTextUse): string | undefined {
  if (!use.isOpaque) {
    return 'is painted at reduced opacity, so no background can be shown to carry it';
  }
  if (isCarriedBy(use.origin.text, use.token.name, use.variants)) {
    return undefined;
  }
  const group = groupReferenceOf(use.variants);
  if (group === undefined) {
    return 'has no bg- utility that carries it';
  }
  const declarations = classStrings.filter(
    (candidate) =>
      candidate.file === use.origin.file && candidate.text.split(/\s+/).includes(group.marker),
  );
  const [declaration] = declarations;
  if (declaration === undefined) {
    return `waits on "${group.marker}", which no element in this file declares`;
  }
  if (declarations.length > 1) {
    return (
      `waits on "${group.marker}", which ${declarations.length} elements in this file declare, ` +
      `so none of them can be shown to be its ancestor`
    );
  }
  return isCarriedBy(declaration.text, use.token.name, group.states)
    ? undefined
    : `waits on "${group.marker}", whose element paints no background that carries it`;
}

describe('colour token policy', () => {
  /**
   * The palette parse is the foundation of everything below, so a stylesheet this suite failed to
   * read would make every other assertion vacuous. Every colour the theme names must resolve to a
   * value — one token silently dropping out of the classification would quietly remove it from the
   * rule below, and nothing else would notice until something used it unsafely. The tokens whose
   * role is unambiguous must land in the group their name implies, and the two groups must stay
   * separated by a wide margin, so a palette edit that leaves a token near the classification
   * threshold fails here, where the cause is visible.
   */
  it('derives the on-colour tokens from the palette', () => {
    expect(THEME_COLOUR_NAMES.length).toBeGreaterThanOrEqual(20);
    expect(COLOUR_TOKENS.map((token) => token.name)).toEqual(THEME_COLOUR_NAMES);
    expect(ON_COLOUR_TOKENS.map((token) => token.name)).toContain('accent-foreground');
    expect(ON_COLOUR_TOKENS.map((token) => token.name)).toContain('background');
    expect(SURFACE_LEGIBLE_TOKENS.map((token) => token.name)).toContain('accent');
    expect(SURFACE_LEGIBLE_TOKENS.map((token) => token.name)).toContain('muted-foreground');

    const worstLegible = Math.min(...SURFACE_LEGIBLE_TOKENS.map((token) => token.worstOnSurface));
    const bestOnColour = Math.max(...ON_COLOUR_TOKENS.map((token) => token.worstOnSurface));
    expect(worstLegible).toBeGreaterThan(SURFACE_LEGIBILITY_RATIO);
    expect(bestOnColour).toBeLessThan(SURFACE_LEGIBILITY_RATIO / 2);
  });

  /**
   * The source walk and the class parse are the other half of the foundation: a walk that stopped
   * finding files, or a parse that stopped recognising `text-` utilities, would leave the rule
   * below with nothing to judge and it would pass in silence — the exact failure this suite exists
   * to rule out. The counts are floors rather than exact numbers, so writing a component does not
   * fail this test for the wrong reason.
   *
   * The two concessions the rule makes are pinned here as well, because both are permissive and a
   * change that quietly disabled either would make the rule report less while still passing. The
   * group licence is counted by what it actually admits — uses that clear the rule *only* because
   * a group element carries them — so recognition breaking drops the count to zero. The opacity
   * distinction has no such witness in the app today, so it is pinned on the parser directly.
   */
  it('reads the class strings of the app and finds the on-colour text in them', () => {
    expect(classStrings.length).toBeGreaterThanOrEqual(200);
    expect(classStrings.map((entry) => entry.file)).toContain(
      'src/features/scheduled/components/RunStatus.tsx',
    );
    expect(onColourTextUses.length).toBeGreaterThanOrEqual(10);
    expect(onColourTextUses.map((use) => use.origin.file)).toContain('src/shared/ui/tooltip.tsx');

    const licensedByGroupAlone = onColourTextUses.filter(
      (use) =>
        unlicensedReason(use) === undefined &&
        !isCarriedBy(use.origin.text, use.token.name, use.variants),
    );
    expect(licensedByGroupAlone.length).toBeGreaterThanOrEqual(1);

    expect(colourUtilityOf('bg-accent', 'bg-')).toEqual({ name: 'accent', isOpaque: true });
    expect(colourUtilityOf('bg-accent/10', 'bg-')).toEqual({ name: 'accent', isOpaque: false });
  });

  /**
   * The rule. Every use of an on-colour token as text must paint, on the same element, a
   * background that carries it at AA in both palettes — or, for a `group-*` variant, the element
   * declaring the group must paint it. Anything else draws text that is invisible on the page
   * surface in at least one theme.
   */
  it('never paints an on-colour token as text without a background that carries it', () => {
    const violations = onColourTextUses.flatMap((use) => {
      const reason = unlicensedReason(use);
      return reason === undefined
        ? []
        : [
            `${use.origin.file}:${use.origin.line} uses "${use.atom}", which is unreadable on ` +
              `the page surface (worst contrast ${use.token.worstOnSurface.toFixed(2)}:1) and ` +
              reason,
          ];
    });
    expect(violations).toEqual([]);
  });
});
