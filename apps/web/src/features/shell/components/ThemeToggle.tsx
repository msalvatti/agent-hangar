/**
 * Sidebar footer control cycling the theme preference.
 *
 * Layer: feature (component).
 */
'use client';

import type { LucideIcon } from 'lucide-react';
import { Monitor, Moon, Sun } from 'lucide-react';

import { Button } from '@/shared/ui/button';

import { useTheme } from '../hooks/useTheme';
import type { ThemePreference } from '../hooks/useTheme';

/** Icon and spoken name per preference. */
const APPEARANCE: Readonly<Record<ThemePreference, { icon: LucideIcon; name: string }>> = {
  system: { icon: Monitor, name: 'system' },
  light: { icon: Sun, name: 'light' },
  dark: { icon: Moon, name: 'dark' },
};

/**
 * An icon button that steps through system → light → dark.
 */
export function ThemeToggle() {
  const { theme, cycle } = useTheme();
  const { icon: Icon, name } = APPEARANCE[theme];
  const label = `Theme: ${name}. Switch theme`;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      onClick={cycle}
      className="cursor-pointer"
    >
      <Icon aria-hidden="true" className="size-4" strokeWidth={1.75} />
    </Button>
  );
}
