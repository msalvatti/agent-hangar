/**
 * Page header layout: title/leading/actions/nav-trigger slots inside W0's `HeaderSlot` landmark.
 *
 * Layer: shared (component).
 */
import type { ReactNode } from 'react';

import { cn } from '@/shared/lib/cn';
import { HeaderSlot } from '@/shared/shell/HeaderSlot';

/** Props of {@link PageHeader}. */
export interface PageHeaderProps {
  title: ReactNode;
  /** Content before the title (e.g. a repo chip, a status pill). */
  leading?: ReactNode;
  /** Right-aligned actions (e.g. an overflow menu). */
  actions?: ReactNode;
  /** The shell's mobile drawer button; shown only below the `md` breakpoint. */
  navTrigger?: ReactNode;
  className?: string;
}

/**
 * Composes one page's header row inside {@link HeaderSlot}: an optional mobile nav trigger, the
 * title (with any leading content), and right-aligned actions.
 *
 * @param props - Title, leading, actions, navTrigger, className.
 */
export function PageHeader({ title, leading, actions, navTrigger, className }: PageHeaderProps) {
  return (
    <HeaderSlot>
      <div className={cn('grid w-full grid-cols-[auto_1fr_auto] items-center gap-2', className)}>
        <div className="md:hidden">{navTrigger}</div>
        <div className="flex min-w-0 items-center gap-2">
          {leading}
          <span className="truncate text-sm font-medium">{title}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      </div>
    </HeaderSlot>
  );
}
