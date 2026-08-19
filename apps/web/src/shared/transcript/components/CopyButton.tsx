/**
 * Icon-only button that copies a value to the clipboard, with a brief "copied" confirmation.
 *
 * Layer: shared (component).
 */
'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { cn } from '@/shared/lib/cn';
import { Button } from '@/shared/ui/button';

/** How long the "copied" (check) state is shown before reverting to the copy icon. */
const CONFIRMATION_MS = 1500;

/** Props of {@link CopyButton}. */
export interface CopyButtonProps {
  /** Text written to the clipboard. */
  value: string;
  /** Accessible name, also shown as the tooltip. */
  label: string;
  className?: string;
}

/**
 * Ghost icon button: `Copy` → `Check` for {@link CONFIRMATION_MS} after a successful copy.
 *
 * The tooltip is the native `title` attribute rather than the Base UI `Tooltip` primitive: a
 * hover-driven portal component adds real flakiness risk to interaction tests (pointer-move
 * simulation racing its open delay) for a label that `aria-label` already exposes accessibly.
 */
export function CopyButton({ value, label, className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  async function handleClick(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, CONFIRMATION_MS);
    } catch {
      toast.error('Copy failed');
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      className={cn(className)}
      onClick={() => {
        void handleClick();
      }}
    >
      {copied ? <Check aria-hidden="true" className="text-success" /> : <Copy aria-hidden="true" />}
    </Button>
  );
}
