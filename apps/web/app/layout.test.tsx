/**
 * Tests for the root layout: the pre-paint theme script, the font variables and the global toaster.
 *
 * Layer: unit.
 * Goal: the palette is decided before the first paint, from the same reading of storage the running
 * app uses, and the document the layout emits carries what the stylesheet and the toaster need.
 * Mocks: `next/font/google` (a build-time transform) and the toaster, so the assertions are about
 * the document this module builds rather than about its contents.
 */
import { runInNewContext } from 'node:vm';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import RootLayout, { metadata } from './layout';

vi.mock('next/font/google', () => ({
  Inter: () => ({ variable: '--font-sans' }),
  JetBrains_Mono: () => ({ variable: '--font-mono' }),
}));

vi.mock('@/shared/ui/sonner', () => ({
  Toaster: () => <div data-testid="toaster" />,
}));

/** The document the layout renders around a page. */
function documentMarkup(): string {
  return renderToStaticMarkup(
    <RootLayout>
      <span data-testid="page" />
    </RootLayout>,
  );
}

/** The inline script the layout puts in the head. */
function bootstrapScript(): string {
  const script = /<script>([\s\S]*?)<\/script>/.exec(documentMarkup())?.[1];
  expect(script).toBeDefined();
  return script ?? '';
}

/**
 * Runs the bootstrap script against a stored preference and a system setting.
 *
 * The script is executed in a context holding nothing but the three globals it is allowed to
 * touch, so a script that reached for anything else would fail here rather than in a browser.
 *
 * @param stored - Value `localStorage` holds for the theme key, or `null` for nothing stored.
 * @param systemDark - Whether the operating system asks for the dark palette.
 * @returns Whether the script applied the dark class.
 */
function paintsDark(stored: string | null, systemDark: boolean): boolean {
  const classes = new Set<string>();
  runInNewContext(bootstrapScript(), {
    localStorage: {
      getItem: (key: string) => (key === 'theme' ? stored : null),
    },
    window: {
      matchMedia: (query: string) => ({
        matches: query === '(prefers-color-scheme: dark)' && systemDark,
      }),
    },
    document: {
      documentElement: {
        classList: {
          toggle: (name: string, on: boolean) => {
            if (on) {
              classes.add(name);
            } else {
              classes.delete(name);
            }
          },
        },
      },
    },
  });
  return classes.has('dark');
}

describe('RootLayout', () => {
  /**
   * The script exists to beat the first paint, which it can only do from the head: anything the
   * browser meets after `<body>` runs once there is already a light document on screen, and the
   * flash it was written to prevent is the thing the reader sees.
   */
  it('puts the theme script in the head, ahead of the body', () => {
    const markup = documentMarkup();

    expect(markup.indexOf('<script>')).toBeGreaterThan(markup.indexOf('<head>'));
    expect(markup.indexOf('<script>')).toBeLessThan(markup.indexOf('<body'));
  });

  /**
   * A stated preference wins over the system in both directions. The `light` case is the one worth
   * pinning: it is the only stored value that has to hold the light palette while the operating
   * system asks for dark.
   */
  it.each([
    { stored: 'dark', systemDark: false, dark: true },
    { stored: 'light', systemDark: true, dark: false },
  ])('honours a stored $stored preference', ({ stored, systemDark, dark }) => {
    expect(paintsDark(stored, systemDark)).toBe(dark);
  });

  /**
   * Anything that is not one of the two preferences means "follow the system" — nothing stored yet
   * on a first visit, the explicit `system` choice, and a value this app no longer writes. That
   * last one is not hypothetical bookkeeping: `useTheme` already reads any unrecognised value as
   * `system`, so a script that read it as light would paint the page light and then let the first
   * system change turn it dark under the reader.
   */
  it.each([
    { label: 'nothing stored', stored: null },
    { label: 'the system choice', stored: 'system' },
    { label: 'a value this app no longer writes', stored: 'sepia' },
  ])('follows the system for $label', ({ stored }) => {
    expect(paintsDark(stored, true)).toBe(true);
    expect(paintsDark(stored, false)).toBe(false);
  });

  /**
   * Storage is unreadable in a browser with site data blocked. The script has to leave the document
   * alone there, not abort the page: it is the first thing that runs, and an exception in it would
   * be thrown before anything else had a chance to render.
   */
  it('leaves the document alone when storage cannot be read', () => {
    const classes = new Set<string>();
    const run = () => {
      runInNewContext(bootstrapScript(), {
        localStorage: {
          getItem: () => {
            throw new Error('access denied');
          },
        },
        window: { matchMedia: () => ({ matches: true }) },
        document: {
          documentElement: {
            classList: {
              toggle: (name: string) => classes.add(name),
            },
          },
        },
      });
    };

    expect(run).not.toThrow();
    expect(classes.size).toBe(0);
  });

  /**
   * Tailwind resolves `font-sans` and `font-mono` through these two custom properties, and the
   * fonts declare them on whichever element carries their generated class. On the document element
   * they are in scope for the whole page, including anything portalled outside the app's own tree.
   */
  it('scopes the font variables to the whole document', () => {
    const markup = documentMarkup();

    expect(markup).toContain('lang="en"');
    expect(/<html[^>]*class="[^"]*--font-sans[^"]*--font-mono/.test(markup)).toBe(true);
  });

  /** The toaster is mounted once, beside the page, so any screen can raise a toast. */
  it('mounts the toaster alongside the page', () => {
    const markup = documentMarkup();

    expect(markup.indexOf('data-testid="page"')).toBeLessThan(
      markup.indexOf('data-testid="toaster"'),
    );
  });

  /** Every screen appends the product name to its own title; the bare name is the fallback. */
  it('titles the document after the product', () => {
    expect(metadata.title).toEqual({ default: 'Agent Hangar', template: '%s · Agent Hangar' });
  });
});
