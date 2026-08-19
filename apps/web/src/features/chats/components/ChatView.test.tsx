/**
 * Tests for `ChatView`: the whole chat screen, from persisted history through a live turn to the
 * failure, archive and follow-up paths.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '@/mocks/server';
import { createFakeEventSourceFactory } from '@/shared/transcript/testing/fake-event-source';
import type { FakeEventSource } from '@/shared/transcript/testing/fake-event-source';

import { ChatView } from './ChatView';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

/** Renders the screen with an injectable stream, and exposes the sources it opened. */
function renderChat(chatId: string) {
  const { factory, instances } = createFakeEventSourceFactory();
  const view = render(<ChatView chatId={chatId} createEventSource={factory} />);
  return { instances, ...view };
}

/**
 * Waits for the screen to open its first `EventSource` and returns it.
 *
 * @param instances - The list the factory appends to.
 * @returns The first opened source.
 */
async function firstSource(instances: FakeEventSource[]): Promise<FakeEventSource> {
  await waitFor(() => {
    expect(instances.length).toBeGreaterThan(0);
  });
  const source = instances[0];
  if (source === undefined) {
    throw new Error('No EventSource was opened');
  }
  return source;
}

describe('ChatView', () => {
  beforeEach(() => {
    push.mockClear();
  });

  // A placeholder reserves the layout while the chat loads.
  it('shows a skeleton while loading', () => {
    renderChat('chat-finished');
    expect(screen.getByTestId('chat-skeleton')).toBeInTheDocument();
  });

  // An unknown id gets its own screen with a way out.
  it('reports an unknown chat', async () => {
    renderChat('chat-missing');
    expect(await screen.findByText('Chat not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start a new chat' })).toHaveAttribute(
      'href',
      '/chats/new',
    );
  });

  // Any other failure is retryable.
  it('reports a load failure with a retry', async () => {
    let failing = true;
    server.use(
      http.get('/api/chats/:id', () => {
        if (failing) {
          return HttpResponse.json({ error: { code: 'BOOM', message: 'nope' } }, { status: 500 });
        }
        return undefined;
      }),
    );
    renderChat('chat-finished');
    expect(await screen.findByText('Could not load the chat')).toBeInTheDocument();
    failing = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Prompt')).toBeInTheDocument();
  });

  // A finished chat renders its persisted history and does not open a stream.
  it('renders persisted history without streaming', async () => {
    const { instances } = renderChat('chat-finished');
    expect(
      (await screen.findAllByText(/Add tests for the payment webhook/)).length,
    ).toBeGreaterThan(0);
    expect(instances).toHaveLength(0);
  });

  // A live turn streams: the prepare notice, the assistant text and the tool row all arrive.
  it('streams a live turn', async () => {
    const { instances } = renderChat('chat-running');
    const source = await firstSource(instances);
    act(() => {
      source.open();
      source.emit(
        'turn.started',
        { type: 'turn.started', turnId: 't1', at: new Date().toISOString() },
        '1-0',
      );
      source.emit(
        'prepare.progress',
        { type: 'prepare.progress', message: 'Cloning acme/api' },
        '2-0',
      );
      source.emit('assistant.delta', { type: 'assistant.delta', text: 'Looking into it.' }, '3-0');
    });
    expect(await screen.findByText('Cloning acme/api')).toBeInTheDocument();
    expect(screen.getByText(/Looking into it\./)).toBeInTheDocument();
  });

  // A dropped connection is reported without interrupting what is already on screen.
  it('shows the reconnect bar', async () => {
    const { instances } = renderChat('chat-running');
    const source = await firstSource(instances);
    act(() => {
      source.open();
      source.fail({ reconnecting: true });
    });
    expect(await screen.findByText('Reconnecting…')).toBeInTheDocument();
  });

  // A failed turn shows the card with the action that fits the code.
  it('shows the failure card and retries the last prompt', async () => {
    const { instances } = renderChat('chat-running');
    const source = await firstSource(instances);
    act(() => {
      source.open();
      source.emit(
        'turn.failed',
        { type: 'turn.failed', error: { code: 'auth', message: 'OpenAI rejected the API key' } },
        '9-0',
      );
    });
    expect(await screen.findByText('OpenAI rejected the key')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Settings' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(instances.length).toBeGreaterThan(1);
    });
  });

  // An archived chat is read-only until it is restored.
  it('offers to restore an archived chat', async () => {
    renderChat('chat-archived');
    expect(await screen.findByText(/This chat is archived/)).toBeInTheDocument();
    expect(screen.getByLabelText('Prompt')).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => {
      expect(screen.queryByText(/This chat is archived/)).not.toBeInTheDocument();
    });
  });

  // Sending a follow-up queues a turn and subscribes to it.
  it('sends a follow-up and follows the new turn', async () => {
    const { instances } = renderChat('chat-finished');
    await screen.findByLabelText('Prompt');
    await userEvent.type(screen.getByLabelText('Prompt'), 'And now add a test.');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(instances.length).toBeGreaterThan(0);
    });
  });

  // Escape while a turn is live asks before stopping it.
  it('asks before stopping a running turn', async () => {
    renderChat('chat-running');
    await screen.findByLabelText('Prompt');
    await userEvent.keyboard('{Escape}');
    expect(await screen.findByText('Stop the running turn?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => {
      expect(screen.queryByText('Stop the running turn?')).not.toBeInTheDocument();
    });
  });

  // A refused follow-up leaves the draft in place instead of clearing it.
  it('keeps the draft when the follow-up is refused', async () => {
    server.use(
      http.post('/api/chats/:id/messages', () =>
        HttpResponse.json({ error: { code: 'BOOM', message: 'nope' } }, { status: 503 }),
      ),
    );
    renderChat('chat-finished');
    await screen.findByLabelText('Prompt');
    await userEvent.type(screen.getByLabelText('Prompt'), 'And now add a test.');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLTextAreaElement>('Prompt').value).toBe(
        'And now add a test.',
      );
    });
  });

  // An expired stream is not an error: the persisted chat is reloaded instead.
  it('reloads the chat when the stream expires', async () => {
    const { instances } = renderChat('chat-running');
    const source = await firstSource(instances);
    act(() => {
      source.open();
      source.emit('expired', { reason: 'replay-window' }, '99-0');
    });
    await waitFor(() => {
      expect(screen.queryByText('Reconnecting…')).not.toBeInTheDocument();
    });
    expect(await screen.findByLabelText('Prompt')).toBeInTheDocument();
  });

  // Clicking the failed pill brings the error card into view.
  it('scrolls to the error from the failed pill', async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {
      // jsdom performs no layout; only the call matters here.
    });
    const { instances } = renderChat('chat-running');
    const source = await firstSource(instances);
    act(() => {
      source.open();
      source.emit(
        'turn.failed',
        { type: 'turn.failed', error: { code: 'network', message: 'unreachable' } },
        '9-0',
      );
    });
    await userEvent.click(await screen.findByRole('button', { name: /Failed/ }));
    expect(scrollIntoView).toHaveBeenCalled();
    scrollIntoView.mockRestore();
  });

  // Archiving from the overflow menu locks the chat.
  it('archives from the overflow menu', async () => {
    renderChat('chat-finished');
    await userEvent.click(await screen.findByRole('button', { name: 'Chat actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    expect(await screen.findByText(/This chat is archived/)).toBeInTheDocument();
  });

  // Restoring from the overflow menu is the inverse.
  it('restores from the overflow menu', async () => {
    renderChat('chat-archived');
    await userEvent.click(await screen.findByRole('button', { name: 'Chat actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Restore' }));
    await waitFor(() => {
      expect(screen.queryByText(/This chat is archived/)).not.toBeInTheDocument();
    });
  });

  // Copying the id puts it on the clipboard.
  it('copies the chat id from the overflow menu', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderChat('chat-finished');
    await userEvent.click(await screen.findByRole('button', { name: 'Chat actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Copy chat id' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('chat-finished');
    });
  });

  // The header's Stop button opens the same confirmation Escape does.
  it('asks before stopping from the header button', async () => {
    renderChat('chat-running');
    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('Stop the running turn?')).toBeInTheDocument();
  });

  // Deleting from the overflow menu leaves the chat behind.
  it('deletes the chat from the overflow menu', async () => {
    renderChat('chat-finished');
    await userEvent.click(await screen.findByRole('button', { name: 'Chat actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/chats/new');
    });
  });

  // Renaming from the header persists the new title.
  it('renames the chat from the header', async () => {
    renderChat('chat-finished');
    await userEvent.click(await screen.findByRole('button', { name: /Add tests/ }));
    await userEvent.clear(screen.getByLabelText('Chat title'));
    await userEvent.type(screen.getByLabelText('Chat title'), 'Renamed{Enter}');
    expect(await screen.findByRole('button', { name: 'Renamed' })).toBeInTheDocument();
  });
});
