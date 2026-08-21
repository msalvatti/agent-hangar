/**
 * Tests for `ChatView`: the whole chat screen, from persisted history through a live turn to the
 * failure, archive and follow-up paths.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setScenario } from '@/mocks/scenario';
import { server } from '@/mocks/server';
import { store } from '@/mocks/store';
import { createFakeEventSourceFactory } from '@/shared/transcript/testing/fake-event-source';
import type { FakeEventSource } from '@/shared/transcript/testing/fake-event-source';

import { ChatView } from './ChatView';

/**
 * Counts the USER messages the mock API has actually persisted for a chat.
 *
 * The duplicate this screen used to produce lived in the store, not on screen, so it is the store
 * a regression test has to read.
 *
 * @param chatId - Chat to read.
 * @returns How many USER rows it holds.
 */
function userRows(chatId: string): number {
  const entry = store.chats.find((candidate) => candidate.chat.id === chatId);
  return (entry?.messages ?? []).filter((message) => message.role === 'USER').length;
}

/**
 * Reads the ids of every turn the mock API holds for a chat.
 *
 * @param chatId - Chat to read.
 * @returns The turn ids, oldest first.
 */
function turnIds(chatId: string): string[] {
  const entry = store.chats.find((candidate) => candidate.chat.id === chatId);
  return (entry?.turns ?? []).map((turn) => turn.id);
}

/**
 * Records a turn as failed in the mock API, as the server does when it streams a `turn.failed`.
 *
 * @param chatId - Chat holding the turn.
 * @param turnId - Turn to fail.
 */
function failStoredTurn(chatId: string, turnId: string): void {
  const entry = store.chats.find((candidate) => candidate.chat.id === chatId);
  const turn = entry?.turns.find((candidate) => candidate.id === turnId);
  if (turn === undefined) {
    throw new Error(`No turn ${turnId} in ${chatId}`);
  }
  Object.assign(turn, { status: 'FAILED', error: 'OpenAI rejected the API key (401)' });
}

/**
 * Inserts a turn that failed before the chat's existing one, as a chat that was retried holds.
 *
 * @param chatId - Chat to extend.
 * @param error - What that earlier attempt recorded.
 */
function addEarlierFailedTurn(chatId: string, error: string): void {
  const entry = store.chats.find((candidate) => candidate.chat.id === chatId);
  if (entry === undefined) {
    throw new Error(`No chat ${chatId}`);
  }
  const newest = entry.turns[0];
  if (newest === undefined) {
    throw new Error(`Chat ${chatId} has no turn to precede`);
  }
  entry.turns.unshift({
    ...newest,
    id: `${newest.id}-earlier`,
    error,
    queuedAt: '2026-08-19T09:00:00.000Z',
    startedAt: '2026-08-19T09:00:01.000Z',
    finishedAt: '2026-08-19T09:00:09.000Z',
  });
}

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

  // A failed turn shows the card with the action that fits the code, and retrying it reopens the
  // stream on that same turn. The stored turn is failed alongside the event because the server
  // persists the failure it just streamed; the retry route reads the row, not the stream.
  it('shows the failure card and retries the failed turn', async () => {
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
    failStoredTurn('chat-running', 'turn-running-1');

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(instances.length).toBeGreaterThan(1);
    });
    expect(turnIds('chat-running')).toEqual(['turn-running-1']);
  });

  // The reducer already appends the failure as a transcript row, so rendering a second card for
  // the same failure would show the operator two error surfaces for one event.
  it('shows exactly one card for a failure', async () => {
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
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
  });

  // A failed turn reloaded from persistence is as actionable as a live one: without the retry the
  // only way out of a failed chat that was reopened would be to start a new one. Retrying re-runs
  // that same turn, so the one prompt the user sent stays one bubble — it used to become two,
  // because Retry posted the prompt again and the second copy was persisted.
  it('offers Retry for a failure loaded from history', async () => {
    renderChat('chat-failed');
    expect(await screen.findByText('The turn failed')).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Retry' });
    await userEvent.click(retry);
    // The retried failure is superseded, not stacked: a second attempt must not leave two error
    // cards — and two Retry buttons — on the screen.
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
    expect(
      screen.getAllByText(/Walk me through how the caching layer invalidates stale entries\./),
    ).toHaveLength(1);
    expect(userRows('chat-failed')).toBe(1);
    expect(turnIds('chat-failed')).toEqual(['turn-failed-1']);
  });

  /**
   * A chat that failed, was asked again and failed again reads as both failures. Only the newest
   * turn's error used to survive a reload, so the earlier attempt appeared to have produced
   * nothing at all.
   *
   * Exactly one Retry is on screen, and it belongs to the newest turn: the API answers
   * `TURN_NOT_RETRYABLE` for every other id, so a button on the older row would be an offer that
   * cannot be honoured. That is asserted by counting the buttons, not by finding the text — both
   * failures render either way.
   */
  it('keeps an earlier turn failure and offers Retry only on the newest', async () => {
    addEarlierFailedTurn('chat-failed', 'The model is rate limiting');
    renderChat('chat-failed');

    expect(await screen.findByText('The turn failed')).toBeInTheDocument();
    expect(screen.getByText('The model is rate limiting')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
  });

  /**
   * Sending a follow-up answers the failure the operator was looking at, not the ones before it.
   * Clearing every error row would delete history the next reload brings straight back.
   */
  it('keeps an earlier failure when a follow-up supersedes the newest one', async () => {
    addEarlierFailedTurn('chat-failed', 'The model is rate limiting');
    renderChat('chat-failed');
    expect(await screen.findByText('The turn failed')).toBeInTheDocument();

    await userEvent.type(screen.getByRole('textbox'), 'try again please');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    });
    expect(screen.getByText('The model is rate limiting')).toBeInTheDocument();
  });

  // The retry request itself can be refused — a missing credential answers 409 before any turn is
  // queued — and nothing else on the screen moves when it is. Without a rendered message the
  // button would simply look inert, which is what it used to do.
  it('shows why a refused retry did nothing', async () => {
    server.use(
      http.post('/api/turns/:id/retry', () =>
        HttpResponse.json(
          { error: { code: 'SECRETS_MISSING', message: 'Configure the missing credentials' } },
          { status: 409 },
        ),
      ),
    );
    renderChat('chat-failed');
    expect(await screen.findByText('The turn failed')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Could not start the turn')).toBeInTheDocument();
    expect(screen.getByText(/Configure the missing credentials/)).toBeInTheDocument();
    expect(userRows('chat-failed')).toBe(1);
    expect(turnIds('chat-failed')).toEqual(['turn-failed-1']);
  });

  // Retrying is not idempotent from the user's side: the first click moves the turn out of FAILED,
  // so a second click races it and is answered TURN_NOT_RETRYABLE — a refusal for something they
  // already asked for successfully. The button has to stop accepting clicks while it is in flight.
  it('stops accepting Retry clicks while one is in flight', async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    server.use(
      http.post('/api/turns/:id/retry', async () => {
        calls += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return HttpResponse.json({ ok: true });
      }),
    );
    renderChat('chat-failed');
    expect(await screen.findByText('The turn failed')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    const inFlight = await screen.findByRole('button', { name: 'Retrying…' });
    expect(inFlight).toBeDisabled();
    await userEvent.click(inFlight);

    expect(calls).toBe(1);
    release?.();
  });

  // The two actions keep their own error state, so reading them in a fixed order shows whichever
  // happens to be set rather than what just happened. A retry refused after a send failed must
  // report the retry's reason, not the older one still sitting in the send hook.
  it('reports the retry refusal rather than an earlier send failure', async () => {
    server.use(
      http.post('/api/chats/:id/messages', () =>
        HttpResponse.json(
          { error: { code: 'CHAT_ARCHIVED', message: 'Send failed first' } },
          { status: 409 },
        ),
      ),
      http.post('/api/turns/:id/retry', () =>
        HttpResponse.json(
          { error: { code: 'SECRETS_MISSING', message: 'Retry failed second' } },
          { status: 409 },
        ),
      ),
    );
    renderChat('chat-failed');
    await screen.findByText('The turn failed');
    await userEvent.type(screen.getByLabelText('Prompt'), 'another go');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/Send failed first/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText(/Retry failed second/)).toBeInTheDocument();
    expect(screen.queryByText(/Send failed first/)).toBeNull();
  });

  // The mirror case: a retry failure must not outlive a send that afterwards succeeded, or the
  // screen keeps blaming a cause that no longer applies.
  it('clears a retry failure once a later send succeeds', async () => {
    server.use(
      http.post('/api/turns/:id/retry', () =>
        HttpResponse.json(
          { error: { code: 'SECRETS_MISSING', message: 'Retry failed' } },
          { status: 409 },
        ),
      ),
    );
    renderChat('chat-failed');
    await screen.findByText('The turn failed');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/Retry failed/)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Prompt'), 'never mind, carry on');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(screen.queryByText(/Retry failed/)).toBeNull();
    });
  });

  // A retry in flight has already moved the turn out of FAILED, so a message sent alongside it
  // races the same work slot and one of the two is refused. The composer locks for a retry exactly
  // as it does for a send, so the user is never offered an action that is about to be rejected.
  it('locks the composer while a retry is in flight', async () => {
    let release: (() => void) | undefined;
    server.use(
      http.post('/api/turns/:id/retry', async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return HttpResponse.json({ ok: true });
      }),
    );
    renderChat('chat-failed');
    expect(await screen.findByText('The turn failed')).toBeInTheDocument();
    expect(screen.getByLabelText('Prompt')).not.toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(screen.getByLabelText('Prompt')).toBeDisabled();
    });
    release?.();
  });

  // The refusal that tells the user to try again in a moment is only useful if there is still a
  // button to press: the failure row must survive it, enabled, with the reason shown beside it.
  it('keeps Retry available after the previous attempt is reported as still running', async () => {
    server.use(
      http.post('/api/turns/:id/retry', () =>
        HttpResponse.json(
          {
            error: {
              code: 'PREVIOUS_ATTEMPT_RUNNING',
              message: 'The previous attempt is still finishing; press Retry again in a moment',
            },
          },
          { status: 409 },
        ),
      ),
    );
    renderChat('chat-failed');
    expect(await screen.findByText('The turn failed')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText(/still finishing/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
    expect(screen.getByLabelText('Prompt')).not.toBeDisabled();
  });

  /*
   * The follow-up composer answers to the same environment the home one does: with a dependency
   * down there is nothing to run the turn, so the composer locks and the notice names what to fix.
   */
  it('locks the follow-up composer and names the dependency while infrastructure is down', async () => {
    setScenario('infra-down');
    renderChat('chat-finished');
    expect(await screen.findByText(/Redis is not available, so a turn cannot run\./)).toBeVisible();
    await waitFor(() => {
      expect(screen.getByLabelText('Prompt')).toBeDisabled();
    });
  });

  /*
   * An archived chat is not told about the environment: its composer is already locked for a
   * reason of its own, and the banner above states it. Two notices would name two different
   * reasons for one disabled field.
   */
  it('leaves the infrastructure notice off an archived chat', async () => {
    setScenario('infra-down');
    renderChat('chat-archived');
    expect(await screen.findByText(/This chat is archived/)).toBeInTheDocument();
    expect(screen.queryByText(/is not available, so a turn cannot run\./)).not.toBeInTheDocument();
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
