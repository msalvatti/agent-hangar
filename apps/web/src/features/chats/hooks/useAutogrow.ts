/**
 * Grows a textarea with its content, from one row up to a maximum, then scrolls.
 *
 * Layer: feature (hook).
 */
'use client';

import type { RefObject } from 'react';
import { useEffect } from 'react';

/** Line height assumed when the computed style does not report a usable pixel value. */
const FALLBACK_LINE_HEIGHT_PX = 24;

/** Options of {@link useAutogrow}. */
export interface UseAutogrowOptions {
  /** Rows the textarea never shrinks below. */
  minRows?: number;
  /** Rows the textarea never grows past; content beyond it scrolls. */
  maxRows?: number;
}

/**
 * Resizes `ref.current` to fit `value`, capped at `maxRows` lines.
 *
 * @param ref - The textarea to resize.
 * @param value - The current value; every change re-measures.
 * @param options - Row bounds.
 */
export function useAutogrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  options: UseAutogrowOptions = {},
): void {
  const { minRows = 1, maxRows = 8 } = options;
  useEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    const parsed = Number.parseFloat(globalThis.getComputedStyle(element).lineHeight);
    const lineHeight = Number.isFinite(parsed) && parsed > 0 ? parsed : FALLBACK_LINE_HEIGHT_PX;
    // Collapsing first is what makes shrinking possible: `scrollHeight` never reports less than
    // the height already set on the element. `auto` rather than clearing the property, so a height
    // declared in a stylesheet is overridden too and not merely reverted to.
    //
    // Stryker disable next-line StringLiteral: telling the two apart takes a stylesheet and a
    // layout engine; the box this produces is measured in `apps/web/e2e`, which has both.
    element.style.height = 'auto';
    const maxHeight = maxRows * lineHeight;
    const minHeight = minRows * lineHeight;
    const height = Math.min(Math.max(element.scrollHeight, minHeight), maxHeight);
    element.style.height = `${String(height)}px`;
    element.style.overflowY = element.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [ref, value, minRows, maxRows]);
}
