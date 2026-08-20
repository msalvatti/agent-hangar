/**
 * Unit tests for the `Sheet` primitive's reservation of its own close-button corner.
 *
 * Layer: unit.
 * Goal: `SheetContent` marks the popup when it paints a close button over the top-right corner,
 * and `SheetHeader` reserves that corner so a header action cannot land underneath it.
 * Mocks: none.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Sheet, SheetContent, SheetHeader, SheetTitle } from './sheet';

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
  /*
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

  // No close button, no corner to keep clear — the mark is absent so the header keeps its width.
  it('leaves the popup unmarked when the close button is suppressed', () => {
    render(openSheet(false));
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    expect(document.querySelector('[data-slot="sheet-content"]')).not.toHaveAttribute(
      'data-close-button',
    );
  });

  /*
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
});
