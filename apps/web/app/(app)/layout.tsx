/**
 * Application shell: sidebar column + main column.
 *
 * Layer: screen (layout).
 *
 * Pages render their own header through `@/shared/shell/PageHeader`, so no header slot is mounted
 * here. `MockProvider` delays the tree until the MSW worker is ready when the mock API is on.
 *
 * The sidebar track is sized by the sidebar rather than by a breakpoint. A fixed track would pin
 * the gutter to whatever the viewport implies, which the sidebar is allowed to disagree with: it
 * remembers whether it was left as the rail or as the column, and the track has to follow that
 * choice or the sidebar paints outside its own gutter and over the page.
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
      <div className="grid h-dvh grid-cols-1 md:grid-cols-[auto_1fr]">
        <AppSidebar />
        <main className="flex min-w-0 flex-col overflow-hidden">{children}</main>
      </div>
    </MockProvider>
  );
}
