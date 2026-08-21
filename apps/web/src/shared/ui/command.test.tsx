/**
 * Unit tests for the parts of the `Command` primitive no screen drives yet.
 *
 * Layer: unit.
 * Goal: an option row presents a pointer cursor, and the two decoration parts — the separator and
 * the shortcut hint — render with the slot names the stylesheet targets. The palette itself is
 * exercised through the chat search and the repository, branch and timezone pickers; what is
 * measured here is the remainder, which is measured at all because this file stopped being
 * untouched generator output the day the option cursor changed.
 * Mocks: none.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from './command';

describe('Command', () => {
  /**
   * An option in the palette is clicked as often as it is chosen with the keyboard, and the
   * registry shipped it with `cursor-default`, which reads as "not a target" under the pointer.
   * The separator and the shortcut carry no behaviour, so what is pinned about them is the slot
   * name the stylesheet addresses and that a caller's own class is merged rather than replacing
   * the primitive's.
   */
  it('presents a pointer cursor on an option and renders its decoration parts', () => {
    render(
      <Command>
        <CommandList>
          <CommandGroup heading="Chats">
            <CommandItem value="one">
              First
              <CommandShortcut className="uppercase">⌘1</CommandShortcut>
            </CommandItem>
          </CommandGroup>
          <CommandSeparator className="my-4" />
        </CommandList>
      </Command>,
    );

    expect(screen.getByRole('option', { name: /First/ })).toHaveClass('cursor-pointer');
    expect(document.querySelector('[data-slot="command-separator"]')).toHaveClass(
      'my-4',
      'bg-border',
    );
    expect(document.querySelector('[data-slot="command-shortcut"]')).toHaveClass(
      'uppercase',
      'ml-auto',
    );
  });
});
