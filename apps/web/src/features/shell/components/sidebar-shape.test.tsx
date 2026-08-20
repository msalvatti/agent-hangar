/**
 * Tests for the sidebar's three shapes: how one is chosen, how the choice is changed and kept, and
 * how each shape lays its header and footer rows out.
 *
 * jsdom has no layout engine, so nothing here can prove that a control ends up inside the rail's
 * 56 px border — only that the declaration which decides it is the intended one. The pixels were
 * measured separately in Chrome at a 900 px viewport; the numbers are quoted where they matter.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { assertPresent } from '@/shared/transcript';

import { SIDEBAR_WIDTH_STORAGE_KEY } from '../hooks/useSidebarWidth';
import { stubMatchMedia } from '../testing/media-query';
import type { MatchMediaStub } from '../testing/media-query';

import { AppSidebar } from './AppSidebar';

const pathname = vi.fn(() => '/chats/new');
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => pathname(),
}));

/** Viewport queries the sidebar reads. */
const FULL = '(min-width: 1024px)';
const RAIL = '(min-width: 768px)';

let media: MatchMediaStub | null = null;

/**
 * The row a control sits in, which is its parent element.
 *
 * @param control - A control rendered directly inside a header or footer row.
 * @returns The row element.
 */
function rowOf(control: HTMLElement): HTMLElement {
  return assertPresent(control.parentElement, 'a sidebar control sits in a row');
}

describe('sidebar shape', () => {
  beforeEach(() => {
    pathname.mockReturnValue('/chats/new');
    localStorage.clear();
  });

  afterEach(() => {
    media?.restore();
    media = null;
  });

  /*
   * The defect this pins: the rail had no control at all, so a viewport between 768 and 1023 px
   * could only be left by resizing the window, which someone on a fixed screen cannot do.
   */
  it('expands the rail back into the full column', async () => {
    media = stubMatchMedia([RAIL]);
    render(<AppSidebar />);
    expect(screen.getByTestId('sidebar-rail')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));

    expect(screen.getByTestId('sidebar-slot')).toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-rail')).not.toBeInTheDocument();
  });

  // The way back in: the column is a choice too, not a floor the viewport pins you to.
  it('collapses the full column into the rail', async () => {
    media = stubMatchMedia([FULL, RAIL]);
    render(<AppSidebar />);

    await userEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));

    expect(screen.getByTestId('sidebar-rail')).toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-slot')).not.toBeInTheDocument();
  });

  /*
   * An icon-only control is reached by its accessible name alone. One name for both states would
   * be wrong in one of them, so the name states the shape the control moves to and changes with it.
   */
  it.each([
    [[RAIL], 'Expand sidebar', 'Collapse sidebar'],
    [[FULL, RAIL], 'Collapse sidebar', 'Expand sidebar'],
  ])('names the control %# after the shape it moves to', (queries, present, absent) => {
    media = stubMatchMedia(queries);
    render(<AppSidebar />);
    expect(screen.getByRole('button', { name: present })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: absent })).not.toBeInTheDocument();
  });

  /*
   * Both shapes are the same element, so the control survives the switch it caused. Rendering them
   * as two elements dropped the focus to the document body, which sends a keyboard user back to
   * the top of the page every time they change the sidebar.
   */
  it('keeps the focus on the control that switched the shape', async () => {
    media = stubMatchMedia([FULL, RAIL]);
    render(<AppSidebar />);

    await userEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));

    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveFocus();
  });

  /*
   * A choice that resets on the next navigation is worse than no choice: the app shell survives
   * routing, but a reload does not, so the choice is written where a reload can find it.
   */
  it('stores the chosen shape', async () => {
    media = stubMatchMedia([RAIL]);
    render(<AppSidebar />);

    await userEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));

    expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe('column');
  });

  // The other half of the same property: a stored choice decides the shape of a fresh mount.
  it('reads the stored shape back on a later mount', () => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, 'column');
    media = stubMatchMedia([RAIL]);
    render(<AppSidebar />);
    expect(screen.getByTestId('sidebar-slot')).toBeInTheDocument();
  });

  /*
   * Under 768 px the drawer is the only shape that fits, so the viewport overrules the choice
   * rather than the other way round: a 260 px column on a 700 px viewport would take a third of it.
   */
  it('keeps the drawer below 768 px whatever was chosen', () => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, 'column');
    media = stubMatchMedia([]);
    render(<AppSidebar />);
    expect(screen.getByRole('button', { name: 'Open navigation' })).toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-slot')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-rail')).not.toBeInTheDocument();
  });

  /*
   * And what happens on the way back out: the choice was overruled, not discarded, so widening
   * past 768 px again returns the shape that was chosen rather than the one the viewport implies.
   */
  it('restores the chosen shape once the viewport allows it again', async () => {
    media = stubMatchMedia([RAIL]);
    const stub = media;
    render(<AppSidebar />);
    await userEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));

    act(() => {
      stub.set([]);
    });
    expect(screen.getByRole('button', { name: 'Open navigation' })).toBeInTheDocument();

    act(() => {
      stub.set([RAIL]);
    });
    expect(screen.getByTestId('sidebar-slot')).toBeInTheDocument();
  });

  // The drawer is neither shape, so the control has nothing to switch to and is left out.
  it('leaves the width control out of the drawer', async () => {
    media = stubMatchMedia([]);
    render(<AppSidebar />);
    await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    await screen.findByRole('link', { name: 'Agent Hangar home' });

    expect(screen.queryByRole('button', { name: /sidebar$/ })).not.toBeInTheDocument();
  });

  /*
   * The first render, which happens where no storage exists. Storage is populated here on purpose:
   * a server pass that read it would emit markup keyed to one visitor's preference, which is how
   * the shell's earlier hydration mismatch happened.
   */
  it('renders the automatic shape on the server whatever storage holds', () => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, 'rail');
    media = stubMatchMedia([FULL, RAIL]);
    const markup = renderToString(<AppSidebar />);
    expect(markup).toContain('data-testid="sidebar-slot"');
    expect(markup).not.toContain('data-testid="sidebar-rail"');
  });

  /*
   * And the property that keeps it that way: the server markup may not depend on storage at all,
   * because the browser that hydrates it may hold any value. Byte equality is asserted rather than
   * the absence of a React hydration warning — measured in this environment, a mismatch surfaces as
   * an unhandled error rather than as a console line, so sniffing the console would look like proof
   * and prove nothing.
   */
  it('produces the same server markup whatever storage holds', () => {
    media = stubMatchMedia([FULL, RAIL]);
    const withNothingStored = renderToString(<AppSidebar />);

    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, 'rail');
    expect(renderToString(<AppSidebar />)).toBe(withNothingStored);

    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, 'column');
    expect(renderToString(<AppSidebar />)).toBe(withNothingStored);
  });

  /*
   * The rail is 56 px wide and spends 8 px of that on padding at each side, leaving 40 px — less
   * than the 28 px control plus the 36 px pill plus the gap between them. Spread apart, the second
   * one is painted outside the sidebar: measured in Chrome at 900 px, the theme toggle spanned
   * x=48..76 against a rail ending at x=56. Stacked, it spans x=13.5..41.5. jsdom cannot see any
   * of that, so what is pinned here is the declaration that produces it.
   */
  it('stacks the rail rows instead of spreading them', () => {
    media = stubMatchMedia([RAIL]);
    render(<AppSidebar />);
    const footer = rowOf(screen.getByRole('button', { name: /^Theme:/ }));
    const header = rowOf(screen.getByRole('link', { name: 'Agent Hangar home' }));

    for (const row of [header, footer]) {
      expect(row).toHaveClass('flex', 'flex-col', 'items-center', 'gap-1', 'px-2');
      expect(row).not.toHaveClass('justify-between');
    }
  });

  /*
   * The same rows are shared with the 260 px column, which has room to spread them and must keep
   * doing so. Measured in Chrome at 1280 px, the theme toggle, the pill, the search button and the
   * wordmark sit at exactly the coordinates they did before the rail was fixed.
   */
  it.each([
    ['the full column', [FULL, RAIL]],
    ['the drawer', []],
  ])('leaves %s rows spread', async (_name, queries) => {
    media = stubMatchMedia(queries);
    render(<AppSidebar />);
    if (queries.length === 0) {
      await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
      await screen.findByRole('link', { name: 'Agent Hangar home' });
    }
    const footer = rowOf(screen.getByRole('button', { name: /^Theme:/ }));
    const header = rowOf(screen.getByRole('link', { name: 'Agent Hangar home' }));

    for (const row of [header, footer]) {
      expect(row).toHaveClass('flex', 'items-center', 'justify-between', 'gap-1', 'px-2');
      expect(row).not.toHaveClass('flex-col');
    }
  });

  /*
   * Spec 10 §10 asks for a pointer cursor on every interactive element. Tailwind's preflight gives
   * `<button>` the default arrow, so a button only gets the pointer if something says so; the
   * shared button primitive now does, for every button in the app at once. Anchors are left alone:
   * measured in Chrome, a sidebar link already computes `cursor: pointer` from the user-agent
   * stylesheet with no class of its own, so a class there would state what is already true.
   */
  it.each([
    ['the rail', [RAIL], 3],
    ['the full column', [FULL, RAIL], 5],
  ])('gives every button in %s the pointer cursor', async (_name, queries, expected) => {
    media = stubMatchMedia(queries);
    render(<AppSidebar />);
    const full = queries.includes(FULL);
    if (full) {
      await screen.findByRole('list', { name: 'Chats' });
    }
    const sidebar = screen.getByTestId(full ? 'sidebar-slot' : 'sidebar-rail');
    const buttons = [...sidebar.querySelectorAll('button')];

    expect(buttons).toHaveLength(expected);
    for (const button of buttons) {
      expect(button.className).toContain('cursor-pointer');
    }
    for (const link of within(sidebar).getAllByRole('link')) {
      expect(link).toHaveAttribute('href');
    }
  });
});
