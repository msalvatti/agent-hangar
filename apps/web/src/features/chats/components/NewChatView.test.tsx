/**
 * Tests for `NewChatView`: the home composition, the credential gate and the create flow.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setScenario } from '@/mocks/scenario';
import { server } from '@/mocks/server';

import { NewChatView } from './NewChatView';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

/** Chooses `acme/api` in the repository picker and waits for the branch to default. */
async function chooseRepository(): Promise<void> {
  await userEvent.click(await screen.findByRole('button', { name: /Choose repository/ }));
  await userEvent.click(await screen.findByRole('option', { name: /acme\/api/ }));
  await waitFor(() => {
    expect(screen.getByRole('button', { name: /main/ })).toBeInTheDocument();
  });
}

describe('NewChatView', () => {
  beforeEach(() => {
    push.mockClear();
    localStorage.clear();
  });

  // The shell's main column clips its overflow, so on a narrow viewport the suggestions plus the
  // composer are taller than the screen and the lower controls would be unreachable. jsdom does no
  // layout, so the scroll box itself is what the test can pin.
  it('makes the screen scroll instead of clipping the lower controls', () => {
    render(<NewChatView />);
    const scroller = screen.getByTestId('new-chat-scroll');
    expect(scroller).toHaveClass('overflow-y-auto');
    expect(scroller).toHaveClass('min-h-0');
    expect(scroller).toHaveClass('flex-1');
  });

  // The reference composition is the headline plus the four starter cards.
  it('renders the headline and the four suggestion cards', async () => {
    render(<NewChatView />);
    expect(screen.getByRole('heading', { name: 'What should we build?' })).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Explore and understand code' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fix issues and failures' })).toBeInTheDocument();
  });

  // A card fills the composer with its starter prompt and puts the caret in the textarea.
  it('fills and focuses the composer when a suggestion is clicked', async () => {
    render(<NewChatView />);
    await screen.findByLabelText('Prompt');
    await userEvent.click(screen.getByRole('button', { name: 'Fix issues and failures' }));
    const textarea = screen.getByLabelText<HTMLTextAreaElement>('Prompt');
    expect(textarea.value).toMatch(/test suite is failing/);
    expect(textarea).toHaveFocus();
  });

  // The whole flow against the mock API: choose a repository, type, send, navigate.
  it('creates a chat and navigates to it', async () => {
    render(<NewChatView />);
    await chooseRepository();
    await userEvent.type(screen.getByLabelText('Prompt'), 'Explain the auth flow.');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(push).toHaveBeenCalledTimes(1);
    });
    expect(push.mock.calls[0]?.[0]).toMatch(/^\/chats\/.+/);
  });

  // Without credentials the composer is replaced, so nothing can be sent.
  it('replaces the composer with the settings notice when a credential is missing', async () => {
    setScenario('missing-settings');
    render(<NewChatView />);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Add your GitHub token and OpenAI key in Settings to start.',
    );
    expect(screen.queryByLabelText('Prompt')).not.toBeInTheDocument();
  });

  // A skeleton reserves the composer's space instead of shifting the layout on arrival.
  it('shows a composer skeleton while the settings status loads', () => {
    render(<NewChatView />);
    expect(screen.getByTestId('composer-skeleton')).toBeInTheDocument();
  });

  // A settings failure is recoverable: the card offers Retry, which refetches successfully.
  it('shows an error card with a working retry when settings fail to load', async () => {
    let calls = 0;
    server.use(
      http.get('/api/settings', () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json({ error: { code: 'BOOM', message: 'nope' } }, { status: 500 });
        }
        return undefined;
      }),
    );
    render(<NewChatView />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load settings');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Prompt')).toBeInTheDocument();
  });

  // A failed creation keeps the draft and offers to resend it.
  it('shows an error card when the chat cannot be created', async () => {
    server.use(
      http.post('/api/chats', () =>
        HttpResponse.json({ error: { code: 'BOOM', message: 'no workspace' } }, { status: 503 }),
      ),
    );
    render(<NewChatView />);
    await chooseRepository();
    await userEvent.type(screen.getByLabelText('Prompt'), 'Explain the auth flow.');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not start the chat');
    expect(push).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });
});
