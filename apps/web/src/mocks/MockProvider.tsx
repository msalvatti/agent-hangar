/**
 * Boots the MSW browser worker before rendering children, when the app is running in mock mode.
 *
 * Layer: mock (bootstrap).
 */
'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

/** `true` when the app should intercept its own `fetch` calls with the mock API. */
const MOCK_ENABLED = process.env.NEXT_PUBLIC_API_MOCK === '1';

/** Props of {@link MockProvider}. */
export interface MockProviderProps {
  children: ReactNode;
}

/**
 * Renders `children` immediately when mocking is off. When `NEXT_PUBLIC_API_MOCK=1`, starts the
 * MSW browser worker first and holds `children` back (rendering a `data-testid="mock-booting"`
 * placeholder instead) until it is ready, so no request escapes to the network.
 *
 * @param props - The children to render once (or if) mocking is ready.
 */
export function MockProvider({ children }: MockProviderProps) {
  const [ready, setReady] = useState(!MOCK_ENABLED);

  useEffect(() => {
    if (!MOCK_ENABLED) {
      return;
    }
    let cancelled = false;
    void import('./browser').then(({ worker }) =>
      worker.start({ onUnhandledRequest: 'bypass', quiet: true }).then(() => {
        if (!cancelled) {
          setReady(true);
        }
      }),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) {
    return <span data-testid="mock-booting" />;
  }
  return <>{children}</>;
}
