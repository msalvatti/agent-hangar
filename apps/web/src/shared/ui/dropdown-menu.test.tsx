/**
 * Unit tests for the parts of the `DropdownMenu` primitive no screen drives yet.
 *
 * Layer: unit.
 * Goal: the menu rows a person can act on — item, submenu trigger, checkbox item, radio item —
 * all present a pointer cursor, and the grouping and decoration parts render with the slot and
 * classes the stylesheet targets. The rows the application already uses are exercised through the
 * chat and job menus; what is measured here is the rest of the surface, which is measured at all
 * because this file stopped being untouched generator output the day those cursors changed.
 * Mocks: none.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './dropdown-menu';

/** The element carrying one slot name, or `null` when the menu did not render it. */
function slot(name: string): Element | null {
  return document.querySelector(`[data-slot="${name}"]`);
}

describe('DropdownMenu', () => {
  /**
   * Every row a person can act on has to answer the pointer, which is what the project's design
   * rules require of any interactive element and what the registry's own styling did not do: it
   * shipped these four rows with `cursor-default`, so a menu looked inert under the pointer while
   * being perfectly clickable. Asserted on all four together because they are one decision — a
   * later regeneration that restored the registry value would take all four back at once.
   */
  it('presents a pointer cursor on every actionable row', () => {
    render(
      <DropdownMenu open onOpenChange={() => undefined}>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuGroup>
            <DropdownMenuLabel inset>Group</DropdownMenuLabel>
            <DropdownMenuItem>Archive</DropdownMenuItem>
            <DropdownMenuCheckboxItem checked>Wrap lines</DropdownMenuCheckboxItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup value="one">
            <DropdownMenuRadioItem value="one">One</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger inset>More</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuGroup>
                <DropdownMenuLabel>Nested</DropdownMenuLabel>
              </DropdownMenuGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    for (const name of [
      'dropdown-menu-item',
      'dropdown-menu-checkbox-item',
      'dropdown-menu-radio-item',
      'dropdown-menu-sub-trigger',
    ]) {
      expect(slot(name)).toHaveClass('cursor-pointer');
    }
    expect(screen.getByRole('menuitem', { name: 'Archive' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemcheckbox', { name: 'Wrap lines' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: 'One' })).toBeInTheDocument();
  });

  /**
   * The `inset` flag is how a row lines up with its siblings when some of them carry an indicator
   * and it carries none. It is a prop rather than a class so that callers do not have to know the
   * indentation, so what has to hold is that it reaches the attribute the stylesheet reads, and
   * that leaving it off leaves the attribute off rather than writing "false" into it.
   */
  it('reaches the attribute the inset styling reads, and only when asked', () => {
    const { unmount } = render(
      <DropdownMenu open onOpenChange={() => undefined}>
        <DropdownMenuContent>
          <DropdownMenuGroup>
            <DropdownMenuLabel inset>Indented</DropdownMenuLabel>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    expect(slot('dropdown-menu-label')).toHaveAttribute('data-inset', 'true');
    unmount();

    render(
      <DropdownMenu open onOpenChange={() => undefined}>
        <DropdownMenuContent>
          <DropdownMenuGroup>
            <DropdownMenuLabel>Flush</DropdownMenuLabel>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    expect(slot('dropdown-menu-label')).not.toHaveAttribute('data-inset');
  });

  /**
   * The decoration parts carry no behaviour, so what is worth pinning is that each renders with
   * the slot name the stylesheet and the tests address it by, and that a caller's own class is
   * merged rather than replacing the primitive's.
   */
  it('renders its decoration parts with their slot names and merges a caller class', () => {
    render(
      <DropdownMenu open onOpenChange={() => undefined}>
        <DropdownMenuPortal>
          <DropdownMenuContent className="w-48">
            <DropdownMenuSeparator className="my-4" />
            <DropdownMenuShortcut className="uppercase">⌘K</DropdownMenuShortcut>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenu>,
    );
    expect(slot('dropdown-menu-content')).toHaveClass('w-48', 'bg-popover');
    expect(slot('dropdown-menu-separator')).toHaveClass('my-4', 'bg-border');
    expect(slot('dropdown-menu-shortcut')).toHaveClass('uppercase', 'ml-auto');
  });
});
