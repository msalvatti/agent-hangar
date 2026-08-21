'use client';

import * as React from 'react';
import { Dialog as SheetPrimitive } from '@base-ui/react/dialog';

import { cn } from '@/shared/lib/cn';
import { Button } from '@/shared/ui/button';
import { XIcon } from 'lucide-react';

function Sheet({ ...props }: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger({ ...props }: SheetPrimitive.Trigger.Props) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose({ ...props }: SheetPrimitive.Close.Props) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetPortal({ ...props }: SheetPrimitive.Portal.Props) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

function SheetOverlay({ className, ...props }: SheetPrimitive.Backdrop.Props) {
  return (
    <SheetPrimitive.Backdrop
      data-slot="sheet-overlay"
      className={cn(
        'fixed inset-0 z-50 bg-black/10 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-backdrop-filter:backdrop-blur-xs',
        className,
      )}
      {...props}
    />
  );
}

/** Everything a sheet popup looks like regardless of which edge it is anchored to. */
const SHEET_CONTENT_CLASS =
  'bg-popover text-popover-foreground fixed z-50 flex flex-col gap-4 bg-clip-padding text-sm shadow-lg transition duration-200 ease-in-out data-ending-style:opacity-0 data-starting-style:opacity-0';

/**
 * Placement, size and entry direction per edge.
 *
 * Written as plain utilities selected in TypeScript rather than as `data-[side=…]` variants, and
 * that is the whole point of the table. An attribute variant compiles to a selector carrying the
 * attribute, which outranks a bare class of the same property, so `cn` kept both when a caller
 * asked for a different width and the cascade handed the popup back to the primitive: the run
 * drawer asked for `w-full sm:max-w-[720px]`, spec 10 §4 says 720 px, and Chrome measured 384 px
 * at every width down to 768 and 281 px at 375. Selected here, the caller's class is the only one
 * of its property in the string and `cn` merges the default away, which is what a `className` prop
 * is for.
 *
 * @see SheetContent
 */
const SHEET_SIDE_CLASS = {
  top: 'inset-x-0 top-0 h-auto border-b data-ending-style:translate-y-[-2.5rem] data-starting-style:translate-y-[-2.5rem]',
  bottom:
    'inset-x-0 bottom-0 h-auto border-t data-ending-style:translate-y-[2.5rem] data-starting-style:translate-y-[2.5rem]',
  left: 'inset-y-0 left-0 h-full w-3/4 border-r sm:max-w-sm data-ending-style:translate-x-[-2.5rem] data-starting-style:translate-x-[-2.5rem]',
  right:
    'inset-y-0 right-0 h-full w-3/4 border-l sm:max-w-sm data-ending-style:translate-x-[2.5rem] data-starting-style:translate-x-[2.5rem]',
} as const;

function SheetContent({
  className,
  children,
  side = 'right',
  showCloseButton = true,
  ...props
}: SheetPrimitive.Popup.Props & {
  side?: 'top' | 'right' | 'bottom' | 'left';
  showCloseButton?: boolean;
}) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        data-side={side}
        data-close-button={showCloseButton ? 'true' : undefined}
        className={cn(SHEET_CONTENT_CLASS, SHEET_SIDE_CLASS[side], className)}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close
            data-slot="sheet-close"
            render={<Button variant="ghost" className="absolute top-3 right-3" size="icon-sm" />}
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Popup>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-header"
      className={cn('flex flex-col gap-0.5 p-4 in-data-[close-button=true]:pr-11', className)}
      {...props}
    />
  );
}

function SheetFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn('mt-auto flex flex-col gap-2 p-4', className)}
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn('font-heading text-foreground text-base font-medium', className)}
      {...props}
    />
  );
}

function SheetDescription({ className, ...props }: SheetPrimitive.Description.Props) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn('text-muted-foreground text-sm', className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
