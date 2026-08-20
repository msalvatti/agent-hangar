/**
 * The chat screen: persisted history, the live stream, header actions and the follow-up composer.
 *
 * Layer: feature (screen).
 */
'use client';

import Link from 'next/link';
import { useCallback, useRef, useState } from 'react';

import { ErrorCard } from '@/shared/feedback';
import { PageHeader } from '@/shared/shell/PageHeader';
import { assertPresent } from '@/shared/transcript';
import type { CreateEventSource } from '@/shared/transcript';
import { Button } from '@/shared/ui/button';

import { useChat } from '../hooks/useChat';
import { useChatActions } from '../hooks/useChatActions';
import { useChatStream } from '../hooks/useChatStream';
import { useEscapeToStop } from '../hooks/useEscapeToStop';
import { useRetryTurn } from '../hooks/useRetryTurn';
import { useSendMessage } from '../hooks/useSendMessage';
import { useSettingsStatus } from '../hooks/useSettingsStatus';

import { ArchivedBanner } from './ArchivedBanner';
import { ChatBody } from './ChatBody';
import { ChatHeaderBar } from './ChatHeaderBar';
import { ChatSkeleton } from './ChatSkeleton';
import { ConfirmDialog } from './ConfirmDialog';
import type { LoadedChat } from './loaded-chat';
import { ReconnectBar } from './ReconnectBar';

/** Props of {@link ChatView}. */
export interface ChatViewProps {
  chatId: string;
  /** `EventSource` factory, injectable for tests. */
  createEventSource?: CreateEventSource | undefined;
}

/**
 * Loads the chat and hands it to {@link LoadedChatView}, rendering the loading and failure states.
 *
 * @param props - Chat id and the optional `EventSource` factory.
 */
export function ChatView({ chatId, createEventSource }: ChatViewProps) {
  const { status, chat, mapped, error, notFound, lastTurnId, refetch } = useChat(chatId);

  if (status === 'idle' || status === 'loading') {
    return <ChatSkeleton />;
  }

  if (notFound) {
    return (
      <>
        <PageHeader title="Chat" />
        <ErrorCard
          title="Chat not found"
          message="This chat no longer exists."
          className="m-6"
          actions={
            <Button render={<Link href="/chats/new" />} variant="outline" size="sm">
              Start a new chat
            </Button>
          }
        />
      </>
    );
  }

  if (status === 'error') {
    return (
      <>
        <PageHeader title="Chat" />
        <ErrorCard
          title="Could not load the chat"
          message={assertPresent(error, 'An error status carries an error').message}
          className="m-6"
          actions={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void refetch();
              }}
            >
              Retry
            </Button>
          }
        />
      </>
    );
  }

  const loaded: LoadedChat = {
    chat: assertPresent(chat, 'A loaded chat carries a summary'),
    mapped: assertPresent(mapped, 'A loaded chat carries a mapped transcript'),
    lastTurnId,
    refetch,
  };
  return <LoadedChatView chatId={chatId} loaded={loaded} createEventSource={createEventSource} />;
}

/** Props of {@link LoadedChatView}. */
interface LoadedChatViewProps {
  chatId: string;
  loaded: LoadedChat;
  createEventSource: CreateEventSource | undefined;
}

/**
 * Renders a chat that has finished loading, streaming its active turn.
 *
 * @param props - Chat id, the loaded chat and the optional `EventSource` factory.
 */
function LoadedChatView({ chatId, loaded, createEventSource }: LoadedChatViewProps) {
  const { chat, mapped, lastTurnId, refetch } = loaded;
  const archived = chat.status === 'ARCHIVED';
  const stream = useChatStream(chatId, mapped, refetch, createEventSource);
  const actions = useChatActions(chatId);
  const send = useSendMessage(chatId, mapped.lastPrompt);
  const retryAction = useRetryTurn();
  const settings = useSettingsStatus();

  const [draft, setDraft] = useState('');
  const [stopOpen, setStopOpen] = useState(false);
  // Which action the visible failure belongs to. Send and retry each clear only their own error,
  // so reading them in a fixed order shows whichever happens to be set rather than what just
  // happened: a refused retry would hide behind an older send failure, and a retry failure would
  // outlive a send that afterwards succeeded. Only the last action's outcome is ever true.
  const [lastAction, setLastAction] = useState<'send' | 'retry' | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  const { phase, connection } = stream.state;
  const running =
    stream.activeTurnId !== null &&
    phase !== 'succeeded' &&
    phase !== 'failed' &&
    phase !== 'cancelled';

  const openStop = useCallback(() => {
    setStopOpen(true);
  }, []);
  useEscapeToStop(running, openStop);

  async function submit(prompt: string): Promise<void> {
    setLastAction('send');
    const turnId = await send.send(prompt);
    if (turnId === null) {
      return;
    }
    setDraft('');
    stream.dispatch({
      type: 'reset',
      // The new turn supersedes any failure already on screen: a reloaded chat only ever shows the
      // newest turn's error, so the live transcript must not accumulate the older ones either.
      items: [
        ...stream.state.items.filter((item) => item.kind !== 'error'),
        { kind: 'user', id: `pending-${turnId}`, text: prompt },
      ],
      phase: 'queued',
    });
    stream.followTurn(turnId);
  }

  /**
   * Runs the failed turn again, in place.
   *
   * The turn is the one the stream is following when the failure just happened, and the chat's
   * newest persisted turn when the failure was loaded from history — the stream stops following a
   * turn that has finished. Nothing is added to the transcript: the prompt is already in it, and
   * the retry writes no message, so the only change on success is that the failure row goes and
   * the turn is queued again.
   */
  function retry(): void {
    const turnId = assertPresent(
      stream.activeTurnId ?? lastTurnId,
      'A failure on screen belongs to a turn',
    );
    setLastAction('retry');
    void (async () => {
      if (!(await retryAction.retry(turnId))) {
        return;
      }
      const wasFollowing = stream.activeTurnId === turnId;
      stream.dispatch({
        type: 'reset',
        items: stream.state.items.filter((item) => item.kind !== 'error'),
        phase: 'queued',
      });
      stream.followTurn(turnId);
      if (wasFollowing) {
        // The stream is per chat and the turn keeps its id, so nothing above reopens the
        // connection the server closed when the turn ended. A failure loaded from history is not
        // followed at all, and `followTurn` opens it there by flipping the url away from `null`.
        stream.reconnect();
      }
    })();
  }

  return (
    <>
      <ChatHeaderBar
        chat={chat}
        phase={phase}
        startedAt={stream.state.startedAt}
        actions={actions}
        onStop={openStop}
        onShowError={() => {
          errorRef.current?.scrollIntoView({ block: 'center' });
        }}
      />
      {connection === 'reconnecting' && <ReconnectBar />}
      {archived && (
        <ArchivedBanner
          busy={actions.busy.restore === true}
          onRestore={() => {
            void actions.restore();
          }}
        />
      )}
      <ChatBody
        items={stream.state.items}
        phase={phase}
        archived={archived}
        onRetry={retry}
        errorRef={errorRef}
        draft={draft}
        onDraftChange={setDraft}
        onSubmit={() => {
          void submit(draft);
        }}
        sending={send.busy || retryAction.busy}
        retrying={retryAction.busy}
        actionError={lastAction === 'retry' ? retryAction.error : send.error}
        turnLive={running}
        model={settings.data?.model}
      />
      <ConfirmDialog
        open={stopOpen}
        onOpenChange={setStopOpen}
        title="Stop the running turn?"
        description="The agent stops where it is. The workspace and everything written so far are kept."
        confirmLabel="Stop"
        cancelLabel="Keep running"
        onConfirm={() => {
          void actions.cancel(assertPresent(stream.activeTurnId, 'A running turn has an id'));
        }}
      />
    </>
  );
}
