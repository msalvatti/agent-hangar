/**
 * Unit tests for the `Sheet` primitive.
 *
 * Layer: unit.
 * Goal: `SheetContent` marks the popup when it paints a close button over the top-right corner,
 * `SheetHeader` reserves that corner so a header action cannot land underneath it, and the parts a
 * caller drives the sheet with — trigger, close, description — do what their names say.
 * Mocks: none.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from './sheet';

/**
 * A sheet with a header, opened.
 *
 * @param showCloseButton - Whether the sheet paints its own close button.
 * @returns The rendered element.
 */
function openSheet(showCloseButton: boolean) {
  return (
    <Sheet open onOpenChange={() => undefined}>
      <SheetContent showCloseButton={showCloseButton}>
        <SheetHeader>
          <SheetTitle>Title</SheetTitle>
        </SheetHeader>
      </SheetContent>
    </Sheet>
  );
}

describe('Sheet', () => {
  /**
   * The close button is positioned absolutely over the popup's top-right corner, where a caller
   * cannot see it. The popup therefore says so on itself, which is what lets the header reserve
   * the corner without the caller having to know the button's offset or size.
   */
  it('marks the popup while it paints a close button', () => {
    render(openSheet(true));
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(document.querySelector('[data-slot="sheet-content"]')).toHaveAttribute(
      'data-close-button',
      'true',
    );
  });

  /**
   * No close button, no corner to keep clear. This is why the reservation is keyed on the mark
   * rather than applied unconditionally: a header that always reserved would give up 44 px to a
   * control that is not there.
   */
  it('leaves the popup unmarked when the close button is suppressed', () => {
    render(openSheet(false));
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    expect(document.querySelector('[data-slot="sheet-content"]')).not.toHaveAttribute(
      'data-close-button',
    );
  });

  /**
   * The reservation itself. It is expressed as a variant keyed on the mark above, so the padding
   * appears only inside a marked popup — a `SheetHeader` used anywhere else keeps its own padding.
   * jsdom resolves no CSS and lays nothing out, so the pixels are not covered here; they were
   * measured in Chrome and are quoted in the RunDrawer suite, which is where the defect showed up.
   */
  it('reserves the marked corner from the header', () => {
    render(openSheet(true));
    const header = document.querySelector('[data-slot="sheet-header"]');
    expect(header).toHaveClass('in-data-[close-button=true]:pr-11');
    expect(header).toHaveClass('p-4');
  });

  /**
   * The sheet a caller builds is opened by its own trigger and closed by whichever control it put
   * in the footer, without the caller holding the open state. Both parts are `SheetClose`/
   * `SheetTrigger` wrappers whose only job is to carry the primitive's wiring, so what is worth
   * asserting is the round trip: open from the trigger, gone again from the footer's button.
   */
  it('opens from its trigger and closes from a control inside it', async () => {
    const user = userEvent.setup();
    render(
      <Sheet>
        <SheetTrigger>Open</SheetTrigger>
        <SheetContent showCloseButton={false}>
          <SheetHeader>
            <SheetTitle>Run</SheetTitle>
            <SheetDescription>What the run did.</SheetDescription>
          </SheetHeader>
          <SheetFooter>
            <SheetClose>Done</SheetClose>
          </SheetFooter>
        </SheetContent>
      </Sheet>,
    );

    await user.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName('Run');
    expect(dialog).toHaveAccessibleDescription('What the run did.');

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
