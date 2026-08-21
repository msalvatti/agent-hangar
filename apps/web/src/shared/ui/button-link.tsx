/**
 * A navigation control that carries the button's appearance without claiming its role.
 *
 * Layer: shared UI.
 *
 * `<Button render={<Link />}>` is the spelling this replaces. Base UI's button assumes it renders a
 * native `<button>` unless told otherwise, so that form put `type="button"` — not a valid value of
 * an anchor's `type` — and a redundant `tabindex` on the anchor, and logged an error on every
 * render. Telling it otherwise with `nativeButton={false}` is worse: it sets `role="button"` on an
 * element that navigates, so assistive technology would announce a button where the user gets a
 * link. A control that goes somewhere is a link, so it is rendered as one and only styled like a
 * button.
 */
import type { VariantProps } from 'class-variance-authority';
import Link from 'next/link';
import type { ComponentProps } from 'react';

import { cn } from '@/shared/lib/cn';

import { buttonVariants } from './button';

/** Props of {@link ButtonLink}: everything `next/link` accepts, plus the button's variants. */
export type ButtonLinkProps = ComponentProps<typeof Link> & VariantProps<typeof buttonVariants>;

/**
 * A `next/link` painted with the button styling of `variant` and `size`.
 *
 * @param props - `next/link` props, plus `variant` and `size`; both fall back to the button's own
 *   defaults when omitted.
 * @returns The anchor element.
 */
export function ButtonLink({ className, variant, size, ...props }: ButtonLinkProps) {
  return (
    <Link
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}
