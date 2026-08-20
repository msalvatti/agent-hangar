/**
 * Boots the MSW browser worker before rendering children, when the app is running in mock mode.
 *
 * Layer: mock (bootstrap).
 */
'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { initializeScenario } from './scenario';

/** `true` when the app should intercept its own `fetch` calls with the mock API. */
const MOCK_ENABLED = process.env.NEXT_PUBLIC_API_MOCK === '1';

/** How far the boot has got: waiting for the worker, serving the app, or unable to start. */
type BootState = 'booting' | 'ready' | 'failed';

/** Props of {@link MockProvider}. */
export interface MockProviderProps {
  children: ReactNode;
}

/**
 * Renders `children` immediately when mocking is off. When `NEXT_PUBLIC_API_MOCK=1`, applies the
 * selected scenario, starts the MSW browser worker and holds `children` back (rendering a
 * `data-testid="mock-booting"` placeholder instead) until it is ready, so no request escapes to
 * the network.
 *
 * A worker that cannot start — a missing service-worker asset, a blocked registration — renders an
 * explanation instead of the placeholder. Falling through to `children` is not an option: without
 * the interceptor every request would leave for a backend the mock build does not have.
 *
 * @param props - The children to render once (or if) mocking is ready.
 */
export function MockProvider({ children }: MockProviderProps) {
  const [boot, setBoot] = useState<BootState>(MOCK_ENABLED ? 'booting' : 'ready');

  useEffect(() => {
    if (!MOCK_ENABLED) {
      return;
    }
    let cancelled = false;
    const start = async (): Promise<void> => {
      try {
        initializeScenario();
        const { worker } = await import('./browser');
        await worker.start({ onUnhandledRequest: 'bypass', quiet: true });
        if (!cancelled) {
          setBoot('ready');
        }
      } catch {
        if (!cancelled) {
          setBoot('failed');
        }
      }
    };
    void start();
    return () => {
      cancelled = true;
    };
  }, []);

  if (boot === 'failed') {
    return (
      <div role="alert" data-testid="mock-failed" className="p-6 text-sm">
        <p className="font-semibold">The mock API could not start.</p>
        <p className="text-muted-foreground mt-1">
          Reload the page. If it keeps failing, run the app against the real API by unsetting
          NEXT_PUBLIC_API_MOCK.
        </p>
      </div>
    );
  }
  if (boot === 'booting') {
    return <span data-testid="mock-booting" />;
  }
  return <>{children}</>;
}
