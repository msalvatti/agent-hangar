/**
 * Measures, in the running browser, whether every interactive control can actually be used with a
 * pointer: that nothing covers it, and that it says so under the cursor.
 *
 * Layer: test support (Playwright; runs half of its work inside the page).
 *
 * A control that is painted underneath another one is still in the accessibility tree, still
 * carries its role and its name, and still passes every assertion a unit suite can make about it.
 * What it does not do is take a click: the pointer lands on whatever is on top. Three of those
 * shipped in this project in a single day and all three were found by eye, because no check here
 * could see them — the unit suites run in jsdom, which reports every `getBoundingClientRect` as
 * 0×0, so an overlap assertion written there passes against broken code as happily as against
 * correct code.
 *
 * This module puts the assertion where a real engine answers it. The rule is one sentence: no
 * point inside an interactive element is taken by a different element. `document.elementFromPoint`
 * answers with the element a click there would actually reach — the same question the browser asks
 * itself, rather than a rectangle comparison that would have to model stacking contexts,
 * transforms and clipping to get the same answer.
 *
 * The points are a three-by-three grid over the control's own box rather than its centre alone.
 * The centre is the obvious sample and it is not sufficient: the collision that motivated this
 * check was re-introduced deliberately and, at 1440 px, the two buttons overlapped in a nine-pixel
 * band that contained neither centre. A centre-only rule stayed green against a Copy button whose
 * top third still closed the drawer. Nine interior points caught it and reported both controls by
 * name.
 *
 * What the rule deliberately does not report:
 *
 * - The element itself, or one of its descendants. A button whose sampled point lands in its own
 *   label span is one control, not two.
 * - An ancestor. That is what a control marked `pointer-events: none` resolves to, and it means
 *   the click reaches the thing that owns the behaviour, not a competing control.
 * - Anything under `aria-hidden` or `inert`. While a modal stands, the rest of the page is marked
 *   exactly that way and is meant to be unreachable.
 * - A control clipped to the screen-reader-only box. It is not painted, so nothing about it is a
 *   pointer target; only its name is a fact.
 * - A point outside the viewport. `elementFromPoint` is defined only inside it, and a control
 *   below the fold is reached by scrolling, not by uncovering.
 * - A point outside a clipping ancestor. The four-hundredth row of the timezone list has a
 *   rectangle far below the popup that holds it, and whatever is painted at those coordinates
 *   belongs to the dialog behind. The row is not covered; it is scrolled away, and the remedy is a
 *   scroll rather than a layout change.
 */
import type { Page } from '@playwright/test';

/**
 * Elements treated as interactive.
 *
 * Native controls plus the ARIA roles this interface actually assigns. Elements carrying a
 * non-negative `tabindex` are included because that is what makes a plain element reachable by
 * keyboard, and a control a person can focus is one they can also click.
 */
export const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="combobox"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Elements that activate on a click, and therefore have to present a pointer cursor.
 *
 * Narrower than {@link INTERACTIVE_SELECTOR} on both ends. Text entry is left out because its
 * correct cursor is the I-beam, not the pointer; so is the bare `tabindex` clause, because what it
 * finds here is a scroll region made focusable for the keyboard — a tab panel holding a long
 * transcript — which is not a click target and would report a false defect. `combobox` is left out
 * for the first reason: in this interface every combobox is a search field.
 */
export const CLICKABLE_SELECTOR = [
  'a[href]',
  'button',
  'select',
  'summary',
  'input[type="button"]',
  'input[type="checkbox"]',
  'input[type="file"]',
  'input[type="radio"]',
  'input[type="submit"]',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
].join(', ');

/** One interactive control whose box is taken, somewhere inside it, by a different element. */
export interface Collision {
  /** The control that cannot take that click, described by tag, test id, role and name. */
  covered: string;
  /** The element a click at that point reaches instead, described the same way. */
  covering: string;
  /** Viewport coordinates of the sampled point, rounded to whole pixels. */
  point: { x: number; y: number };
}

/**
 * Waits for every finite animation and transition in the page to run out.
 *
 * A dialog is briefly somewhere other than where it lands, so measuring while it moves would
 * report a collision that never exists at rest. Animations that repeat for ever — the pulse on a
 * running tool row — are excluded rather than waited for, because their `finished` promise is
 * never settled and waiting on it would hang the run instead of failing it.
 *
 * @param page - The page to settle.
 */
async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const running = document
      .getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
      .map(async (animation) => {
        // A cancelled or replaced animation rejects; that it is over is the only thing being
        // waited for, and it is over either way.
        await animation.finished.catch(() => undefined);
      });
    await Promise.all(running);
  });
}

/** What one measurement of a page found. */
export interface ControlDefects {
  /** Controls whose box is taken, somewhere inside it, by a different element. */
  collisions: Collision[];
  /** Controls a click activates that the cursor does not offer to, each already described. */
  bluntControls: string[];
}

/**
 * The program that runs inside the page, given the two selectors.
 *
 * Declared here rather than inline so that `findUnusableControls` stays the three statements it
 * really is. It closes over nothing: Playwright serialises the function and the page has no
 * access to this module, so every value it needs arrives as an argument and everything else it
 * touches is a browser global. That constraint is also why the two rules share one program —
 * split in two, the notion of a measurable control had to be written twice.
 *
 * @param selectors - The interactive selector and the clickable one, in that order.
 * @returns The covered controls and the blunt ones.
 */
function measureControls([overlapSelector, cursorSelector]: readonly [
  string,
  string,
]): ControlDefects {
  /** The screen-reader-only clip rectangle, as `getComputedStyle` reports it. */
  const CLIPPED_AWAY = 'rect(0px, 0px, 0px, 0px)';
  /** How much of an element's own text is kept when naming it in a failure message. */
  const NAME_BUDGET = 60;
  /**
   * Where inside a control's box the sample points are taken, as fractions of its width and
   * its height, crossed with themselves into a three-by-three grid.
   *
   * The centre alone is not enough, and the collision that motivated all of this proves it: at
   * 1440 px the run drawer's Copy button and the sheet's close button overlapped in a
   * nine-pixel band that contained neither centre, so a centre-only rule reported nothing while
   * a click near the top of Copy still closed the drawer. Every one of these points lies
   * strictly inside the control, so each belongs to the control or to a descendant unless
   * something else is drawn over it — which is the whole of the rule.
   */
  const SAMPLE_FRACTIONS = [0.25, 0.5, 0.75];

  /** Names an element by tag, test id, role and whatever text a reader would recognise it by. */
  const describe = (element: Element): string => {
    const attribute = (name: string): string => {
      const value = element.getAttribute(name);
      return value === null ? '' : `[${name}="${value}"]`;
    };
    const name =
      element.getAttribute('aria-label') ?? element.textContent.replace(/\s+/g, ' ').trim();
    const quoted = name === '' ? '' : ` "${name.slice(0, NAME_BUDGET)}"`;
    return `${element.tagName.toLowerCase()}${attribute('data-testid')}${attribute('role')}${quoted}`;
  };

  /** Whether an element is a pointer target either rule has anything to say about. */
  const isMeasurable = (element: Element): boolean => {
    if (element.closest('[aria-hidden="true"], [inert]') !== null) {
      return false;
    }
    const style = getComputedStyle(element);
    if (style.pointerEvents === 'none' || style.getPropertyValue('clip') === CLIPPED_AWAY) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  /**
   * Whether a point lies inside every clipping ancestor of an element, and is therefore a
   * point at which the element is actually painted.
   */
  const isPainted = (element: Element, x: number, y: number): boolean => {
    for (let box = element.parentElement; box !== null; box = box.parentElement) {
      const boxStyle = getComputedStyle(box);
      if (boxStyle.overflowX === 'visible' && boxStyle.overflowY === 'visible') {
        continue;
      }
      const clip = box.getBoundingClientRect();
      if (x < clip.left || x > clip.right || y < clip.top || y > clip.bottom) {
        return false;
      }
    }
    return true;
  };

  /** The first sampled point of an element that a different element answers for, if any. */
  const coveredAt = (element: Element): Collision | undefined => {
    const rect = element.getBoundingClientRect();
    for (const horizontal of SAMPLE_FRACTIONS) {
      for (const vertical of SAMPLE_FRACTIONS) {
        const x = rect.left + rect.width * horizontal;
        const y = rect.top + rect.height * vertical;
        if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
          continue;
        }
        if (!isPainted(element, x, y)) {
          continue;
        }
        const topmost = document.elementFromPoint(x, y);
        if (topmost === null || element.contains(topmost) || topmost.contains(element)) {
          continue;
        }
        return {
          covered: describe(element),
          covering: describe(topmost),
          point: { x: Math.round(x), y: Math.round(y) },
        };
      }
    }
    return undefined;
  };

  const collisions: Collision[] = [];
  for (const element of document.querySelectorAll(overlapSelector)) {
    const collision = isMeasurable(element) ? coveredAt(element) : undefined;
    if (collision !== undefined) {
      collisions.push(collision);
    }
  }

  const bluntControls: string[] = [];
  for (const element of document.querySelectorAll(cursorSelector)) {
    const { cursor } = getComputedStyle(element);
    if (isMeasurable(element) && cursor !== 'pointer') {
      bluntControls.push(`${describe(element)} has cursor: ${cursor}`);
    }
  }

  return { collisions, bluntControls };
}

/**
 * Measures both rules over one page, in one pass.
 *
 * Together rather than separately because both are properties of the same rendered frame and both
 * share the same notion of a control worth judging — visible, not clipped away, not hidden from
 * assistive technology.
 *
 * @param page - The page to measure.
 * @returns The covered controls and the blunt ones.
 */
export async function findUnusableControls(page: Page): Promise<ControlDefects> {
  await settleAnimations(page);
  return page.evaluate(measureControls, [INTERACTIVE_SELECTOR, CLICKABLE_SELECTOR] as const);
}

/**
 * Renders one measurement as the lines a failing assertion prints.
 *
 * A collision names both elements, because which one is on top is the whole of the diagnosis: the
 * fix moves one of them, and the message has to say which two are fighting over the point.
 *
 * @param where - What was on screen, so a failure names the screen as well as the controls.
 * @param defects - What {@link findUnusableControls} measured.
 * @returns One line per defect, empty when the page has none.
 */
export function describeDefects(where: string, defects: ControlDefects): string[] {
  return [
    ...defects.collisions.map(
      (collision) =>
        `${where}: ${collision.covered} is covered at (${String(collision.point.x)}, ` +
        `${String(collision.point.y)}) by ${collision.covering}`,
    ),
    ...defects.bluntControls.map((control) => `${where}: ${control}`),
  ];
}
