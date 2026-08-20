/**
 * One starter-prompt card of the home screen.
 *
 * Layer: feature (component).
 */
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/shared/lib/cn';

import type { SuggestionTone } from '../lib/suggestions';

/** Icon tint per tone; the only decorative colour in the app (spec 10 §4.1). */
const TONE_CLASS: Record<SuggestionTone, string> = {
  accent: 'text-accent/80',
  warning: 'text-warning/80',
  success: 'text-success/80',
  destructive: 'text-destructive/80',
};

/** Props of {@link SuggestionCard}. */
export interface SuggestionCardProps {
  title: string;
  icon: LucideIcon;
  tone: SuggestionTone;
  /** Called when the card is activated by click or keyboard. */
  onSelect: () => void;
}

/**
 * A bordered card button that fills the composer with a starter prompt.
 *
 * @param props - Title, icon, tone and the select handler.
 */
export function SuggestionCard({ title, icon: Icon, tone, onSelect }: SuggestionCardProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'border-border bg-card flex cursor-pointer flex-col items-start gap-2 rounded-[10px] border p-4 text-left text-sm',
        'hover:bg-muted transition-colors duration-150',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
      )}
    >
      <Icon aria-hidden="true" className={cn('size-[18px]', TONE_CLASS[tone])} strokeWidth={1.75} />
      <span>{title}</span>
    </button>
  );
}
