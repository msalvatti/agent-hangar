/**
 * Root layout: fonts, theme bootstrap and global toaster.
 *
 * Layer: screen (root).
 *
 * The theme class is applied by a tiny inline script before first paint (stored preference in
 * `localStorage`, system preference otherwise) so there is no flash; no theming library is used.
 */
import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';

import { cn } from '@/shared/lib/cn';
import { Toaster } from '@/shared/ui/sonner';

import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const jetBrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

/**
 * Applies `.dark` before hydration from the stored preference or the system setting.
 *
 * Only `dark` and `light` are preferences; every other stored value — nothing yet, `system`, or a
 * leftover this app no longer writes — means "follow the system", which is exactly how `useTheme`
 * reads the same key once the app is running. Spelling the two out and treating the rest as
 * unrecognised would leave the two readings disagreeing, and the page would be painted light
 * before hydration and turned dark by the first system change after it.
 */
const THEME_BOOTSTRAP = `(function(){try{var s=localStorage.getItem('theme');var d=s==='dark'||(s!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;

export const metadata: Metadata = {
  title: { default: 'Agent Hangar', template: '%s · Agent Hangar' },
  description:
    'AI agents that answer questions and perform coding tasks against GitHub repositories inside isolated, disposable workspaces.',
};

/**
 * Root HTML document.
 *
 * @param props - Page content.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={cn(inter.variable, jetBrainsMono.variable)}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="min-h-dvh">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
