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
