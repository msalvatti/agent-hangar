/**
 * Tests for the MSW browser-worker bootstrap provider.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const startMock = vi.fn().mockResolvedValue(undefined);

vi.mock('./browser', () => ({
  worker: { start: startMock },
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
