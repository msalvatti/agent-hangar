/**
 * Application shell: sidebar column + main column with a header slot.
 *
 * Layer: screen (layout).
 *
 * Pages render inside `<main>`; the sidebar and header slots are filled by the shell feature.
 */
import type { ReactNode } from 'react';

import { HeaderSlot } from '@/shared/shell/HeaderSlot';
import { SidebarSlot } from '@/shared/shell/SidebarSlot';

/**
 * Two-column app layout.
 *
 * @param props - Page content.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid h-dvh grid-cols-[260px_1fr]">
      <SidebarSlot />
      <div className="flex min-w-0 flex-col">
        <HeaderSlot />
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
