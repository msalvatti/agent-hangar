/**
 * The three primary destinations of the sidebar.
 *
 * Layer: feature (component).
 */
'use client';

import type { LucideIcon } from 'lucide-react';
import { CalendarClock, Settings, SquarePen } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/shared/lib/cn';

import { useShortcutPlatform } from '../hooks/useShortcutPlatform';
import { shortcutHint } from '../lib/shortcuts';
import type { ShortcutName } from '../lib/shortcuts';

/** One navigation destination. */
interface NavEntry {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shortcut whose label is shown in the row's tooltip, when it has one. */
  shortcut: ShortcutName | null;
  /** Prefix that marks the row active, so `/chats/:id` keeps New chat unhighlighted. */
  activePrefix: string;
}

/** The destinations, in display order. */
const ENTRIES: readonly NavEntry[] = [
  {
    href: '/chats/new',
    label: 'New chat',
    icon: SquarePen,
    shortcut: 'newChat',
    activePrefix: '/chats/new',
  },
  {
    href: '/scheduled',
    label: 'Scheduled',
    icon: CalendarClock,
    shortcut: null,
    activePrefix: '/scheduled',
  },
  {
    href: '/settings',
    label: 'Settings',
    icon: Settings,
    shortcut: 'settings',
    activePrefix: '/settings',
  },
];

/** Props of {@link PrimaryNav}. */
export interface PrimaryNavProps {
  /** Hides the labels for the 56 px icon rail; the tooltip carries the name instead. */
  iconOnly?: boolean;
}

/**
 * Renders the primary navigation, marking the row matching the current path.
 *
 * @param props - Icon-only flag.
 */
export function PrimaryNav({ iconOnly = false }: PrimaryNavProps) {
  const pathname = usePathname();
  const platform = useShortcutPlatform();
  return (
    <nav aria-label="Primary" className="flex flex-col gap-0.5 px-2">
      {ENTRIES.map((entry) => {
        const active = pathname.startsWith(entry.activePrefix);
        const hint = shortcutHint(entry.label, entry.shortcut, platform);
        return (
          <Link
            key={entry.href}
            href={entry.href}
            title={hint}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'focus-visible:ring-ring relative flex h-10 items-center gap-2 rounded-lg px-2 text-sm transition-colors duration-150 focus-visible:ring-2 focus-visible:outline-none',
              active
                ? 'bg-muted before:bg-accent before:absolute before:top-1.5 before:bottom-1.5 before:left-0 before:w-0.5 before:rounded-full'
                : 'hover:bg-muted/60',
            )}
          >
            <entry.icon aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
            {iconOnly ? (
              <span className="sr-only">{entry.label}</span>
            ) : (
              <span className="truncate">{entry.label}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
