/**
 * Generic empty-state placeholder: icon, headline, help text, primary action.
 *
 * Layer: shared (component).
 */
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/shared/lib/cn';

/** Props of {@link EmptyState}. */
export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

/** Centred icon + one-line headline + one-line help + primary action (spec 10 §6). */
export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center gap-2 py-12 text-center', className)}>
      <Icon aria-hidden="true" className="text-muted-foreground size-8" />
      <p className="text-[16px] font-semibold">{title}</p>
      {description !== undefined && (
        <p className="text-muted-foreground max-w-sm text-[14px]">{description}</p>
      )}
      {action !== undefined && <div className="pt-2">{action}</div>}
    </div>
  );
}
