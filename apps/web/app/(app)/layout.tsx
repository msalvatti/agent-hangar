/**
 * Application shell: sidebar column + main column.
 *
 * Layer: screen (layout).
 *
 * Pages render their own header through `@/shared/shell/PageHeader`, so no header slot is mounted
 * here. `MockProvider` delays the tree until the MSW worker is ready when the mock API is on.
 */
import type { ReactNode } from 'react';

import { AppSidebar } from '@/features/shell';
import { MockProvider } from '@/mocks/MockProvider';

/**
 * Two-column app layout: a sidebar that collapses to a rail and then to a drawer, and the page.
 *
 * @param props - Page content.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <MockProvider>
      <div className="grid h-dvh grid-cols-1 md:grid-cols-[56px_1fr] lg:grid-cols-[260px_1fr]">
        <AppSidebar />
        <main className="flex min-w-0 flex-col overflow-hidden">{children}</main>
      </div>
    </MockProvider>
  );
}
