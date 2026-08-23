/**
 * Tests for `useAutogrow`: the textarea grows with its content and stops at the row cap.
 */
import { renderHook } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAutogrow } from './useAutogrow';

/**
 * Builds a real `CSSStyleDeclaration` reporting the given line height.
 *
 * A detached element's `style` is a genuine declaration object, so the stub needs no cast to
 * stand in for what `getComputedStyle` returns.
 *
 * @param lineHeight - Value the declaration reports for `line-height`.
 * @returns A style declaration.
 */
function styleWithLineHeight(lineHeight: string): CSSStyleDeclaration {
  const style = document.createElement('div').style;
  style.lineHeight = lineHeight;
  return style;
}

/**
 * Builds a textarea whose `scrollHeight` the test controls, since jsdom performs no layout.
 *
 * @param scrollHeight - The value `scrollHeight` reports to begin with.
 * @returns The textarea, already attached, and a way to change what its content measures.
 */
function growableTextarea(scrollHeight: number): {
  element: HTMLTextAreaElement;
  setScrollHeight: (next: number) => void;
} {
  const element = document.createElement('textarea');
  let current = scrollHeight;
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    get: () => current,
  });
  document.body.append(element);
  return {
    element,
    setScrollHeight: (next) => {
      current = next;
    },
  };
}

/**
 * Builds a textarea whose `scrollHeight` is fixed, since jsdom performs no layout.
 *
 * @param scrollHeight - The value `scrollHeight` reports.
 * @returns The textarea, already attached to the document.
 */
function textareaWithScrollHeight(scrollHeight: number): HTMLTextAreaElement {
  return growableTextarea(scrollHeight).element;
}

describe('useAutogrow', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  // Content shorter than the cap sets the height to exactly what the content needs.
  it('sets the height from scrollHeight while under the cap', () => {
    const ref = createRef<HTMLTextAreaElement>();
    ref.current = textareaWithScrollHeight(72);
    renderHook(() => {
      useAutogrow(ref, 'three\nshort\nlines');
    });
    expect(ref.current.style.height).toBe('72px');
    expect(ref.current.style.overflowY).toBe('hidden');
  });

  // Past eight rows the height stops growing and the textarea scrolls instead.
  it('caps the height at maxRows and turns on scrolling', () => {
    const ref = createRef<HTMLTextAreaElement>();
    ref.current = textareaWithScrollHeight(1000);
    renderHook(() => {
      useAutogrow(ref, 'a very tall value');
    });
    expect(ref.current.style.height).toBe('192px');
    expect(ref.current.style.overflowY).toBe('auto');
  });

  // An empty value still leaves room for one row rather than collapsing to nothing.
  it('never shrinks below minRows', () => {
    const ref = createRef<HTMLTextAreaElement>();
    ref.current = textareaWithScrollHeight(4);
    renderHook(() => {
      useAutogrow(ref, '');
    });
    expect(ref.current.style.height).toBe('24px');
  });

  // A computed line-height of `normal` is not a pixel value, so the fallback applies.
  it('falls back to a fixed line height when the computed one is not a number', () => {
    const ref = createRef<HTMLTextAreaElement>();
    ref.current = textareaWithScrollHeight(1000);
    vi.spyOn(globalThis, 'getComputedStyle').mockReturnValue(styleWithLineHeight('normal'));
    renderHook(() => {
      useAutogrow(ref, 'tall');
    });
    expect(ref.current.style.height).toBe('192px');
  });

  // A line height reported in pixels is used as-is.
  it('uses the computed line height when it is a pixel value', () => {
    const ref = createRef<HTMLTextAreaElement>();
    ref.current = textareaWithScrollHeight(1000);
    vi.spyOn(globalThis, 'getComputedStyle').mockReturnValue(styleWithLineHeight('20px'));
    renderHook(() => {
      useAutogrow(ref, 'tall');
    });
    expect(ref.current.style.height).toBe('160px');
  });

  // Nothing to measure yet is not an error; the effect simply does nothing.
  it('does nothing while the ref is empty', () => {
    const ref = createRef<HTMLTextAreaElement>();
    expect(() => {
      renderHook(() => {
        useAutogrow(ref, 'anything');
      });
    }).not.toThrow();
  });

  /**
   * A computed line height of zero is not a usable measurement either, and taking it at face value
   * multiplies every bound by nothing: the composer collapses to a zero-height box the user cannot
   * see what they are typing in.
   */
  it('falls back when the computed line height is zero', () => {
    const ref = createRef<HTMLTextAreaElement>();
    ref.current = textareaWithScrollHeight(1000);
    vi.spyOn(globalThis, 'getComputedStyle').mockReturnValue(styleWithLineHeight('0px'));
    renderHook(() => {
      useAutogrow(ref, 'tall');
    });
    expect(ref.current.style.height).toBe('192px');
  });

  /**
   * Content that fits the cap exactly is content that fits: the scrollbar appears for what is over
   * the cap, and a boundary off by one row shows a scrollbar on a textarea with nothing to scroll.
   */
  it('leaves scrolling off for content that fills the cap exactly', () => {
    const ref = createRef<HTMLTextAreaElement>();
    ref.current = textareaWithScrollHeight(192);
    renderHook(() => {
      useAutogrow(ref, 'eight lines exactly');
    });
    expect(ref.current.style.height).toBe('192px');
    expect(ref.current.style.overflowY).toBe('hidden');
  });

  /**
   * Every change re-measures. Measured once at mount, the box would keep the size of the empty
   * composer for the whole of a message the user goes on typing.
   */
  it('re-measures as the value changes', () => {
    const ref = createRef<HTMLTextAreaElement>();
    const { element, setScrollHeight } = growableTextarea(24);
    ref.current = element;
    const { rerender } = renderHook(
      ({ value }: { value: string }) => {
        useAutogrow(ref, value);
      },
      { initialProps: { value: 'one line' } },
    );
    expect(element.style.height).toBe('24px');

    setScrollHeight(72);
    rerender({ value: 'one line\nand two\nand three' });

    expect(element.style.height).toBe('72px');
  });
});
