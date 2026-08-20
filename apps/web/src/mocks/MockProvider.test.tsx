/**
 * Tests for the MSW browser-worker bootstrap provider.
 */
import { render, screen, waitFor } from '@testing-library/react';
import type { RequestHandler } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { handlers } from './handlers';

const startMock = vi.fn().mockResolvedValue(undefined);
const setupWorkerMock = vi.fn((..._served: RequestHandler[]) => ({ start: startMock }));

vi.mock('msw/browser', () => ({
  setupWorker: setupWorkerMock,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('MockProvider', () => {
  // With mocking off (the default in this test file, no env stub applied yet), children render
  // immediately and the worker is never started.
  it('renders children immediately when mocking is off', async () => {
    const { MockProvider } = await import('./MockProvider');
    render(
      <MockProvider>
        <span>content</span>
      </MockProvider>,
    );
    expect(screen.getByText('content')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-booting')).toBeNull();
    expect(startMock).not.toHaveBeenCalled();
  });

  // With NEXT_PUBLIC_API_MOCK=1, the placeholder renders first, the worker starts, then children
  // render once it resolves.
  it('boots the worker and renders children once ready when mocking is on', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_MOCK', '1');
    vi.resetModules();
    const { MockProvider } = await import('./MockProvider');
    render(
      <MockProvider>
        <span>content</span>
      </MockProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText('content')).toBeInTheDocument();
    });
    expect(startMock).toHaveBeenCalledWith({ onUnhandledRequest: 'bypass', quiet: true });
  });

  /**
   * Mock mode is the only mode in which the app answers its own requests, so the worker has to be
   * handed the whole mock API rather than some slice of it: a route left out here does not fall
   * back to anything, it leaves for a backend the mock build does not have. Nothing else pins the
   * handler set that reaches the browser — the Node server used by the tests is built separately.
   */
  it('serves every handler of the mock API', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_MOCK', '1');
    vi.resetModules();
    const { MockProvider } = await import('./MockProvider');
    render(
      <MockProvider>
        <span>content</span>
      </MockProvider>,
    );
    await waitFor(() => {
      expect(setupWorkerMock).toHaveBeenCalled();
    });

    const served = setupWorkerMock.mock.calls[0] ?? [];
    expect(served.map((handler) => handler.info.header)).toEqual(
      handlers.map((handler) => handler.info.header),
    );
  });

  /**
   * React runs an effect twice in development, and a mount can follow an unmount within one page
   * load. Each run building its own worker would register the service worker again and take the
   * previous registration's place, so the boot is remembered and later runs join it.
   */
  it('registers one worker however often the boot runs', async () => {
    startMock.mockResolvedValue(undefined);
    vi.stubEnv('NEXT_PUBLIC_API_MOCK', '1');
    vi.resetModules();
    const { MockProvider } = await import('./MockProvider');
    const first = render(
      <MockProvider>
        <span>content</span>
      </MockProvider>,
    );
    await waitFor(() => {
      expect(setupWorkerMock).toHaveBeenCalledTimes(1);
    });
    first.unmount();

    render(
      <MockProvider>
        <span>content</span>
      </MockProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText('content')).toBeInTheDocument();
    });

    expect(setupWorkerMock).toHaveBeenCalledTimes(1);
  });

  // A worker that cannot start (missing service-worker asset, blocked registration) must say so:
  // an unhandled rejection would leave the app as an empty placeholder for the whole session, and
  // rendering the children anyway would let every request escape to a backend that is not there.
  it('reports a worker that fails to start', async () => {
    startMock.mockRejectedValue(new Error('Failed to register a ServiceWorker'));
    vi.stubEnv('NEXT_PUBLIC_API_MOCK', '1');
    vi.resetModules();
    const { MockProvider } = await import('./MockProvider');
    render(
      <MockProvider>
        <span>content</span>
      </MockProvider>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('The mock API could not start.');
    expect(screen.queryByText('content')).toBeNull();
    expect(screen.queryByTestId('mock-booting')).toBeNull();
  });

  // The failure path takes the same `cancelled` guard as the success path: a provider unmounted
  // while the worker is still starting must not set state when the start later rejects.
  it('does not report a failure after unmounting', async () => {
    let rejectStart: (reason: Error) => void = () => {
      throw new Error('rejectStart called before assignment');
    };
    startMock.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectStart = reject;
        }),
    );
    vi.stubEnv('NEXT_PUBLIC_API_MOCK', '1');
    vi.resetModules();
    const { MockProvider } = await import('./MockProvider');
    const { unmount } = render(
      <MockProvider>
        <span>content</span>
      </MockProvider>,
    );
    await waitFor(() => {
      expect(startMock).toHaveBeenCalled();
    });

    unmount();
    rejectStart(new Error('Failed to register a ServiceWorker'));
    await Promise.resolve();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // Unmounting before the worker resolves must not call `setState` on the unmounted component:
  // the effect's `cancelled` flag guards the post-resolution `setReady(true)`.
  it('does not update state after unmounting while the worker is still starting', async () => {
    let resolveStart: () => void = () => {
      throw new Error('resolveStart called before assignment');
    };
    startMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    );
    vi.stubEnv('NEXT_PUBLIC_API_MOCK', '1');
    vi.resetModules();
    const { MockProvider } = await import('./MockProvider');
    const { unmount } = render(
      <MockProvider>
        <span>content</span>
      </MockProvider>,
    );
    expect(screen.getByTestId('mock-booting')).toBeInTheDocument();
    await waitFor(() => {
      expect(startMock).toHaveBeenCalled();
    });

    unmount();
    resolveStart();
    await Promise.resolve();
    expect(screen.queryByText('content')).toBeNull();
  });
});
