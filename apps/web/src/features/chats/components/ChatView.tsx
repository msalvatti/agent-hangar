/**
 * The chat screen: persisted history, the live stream, header actions and the follow-up composer.
 *
 * Layer: feature (screen).
 */
'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { ErrorCard } from '@/shared/feedback';
import { PageHeader } from '@/shared/shell/PageHeader';
import { assertPresent, Transcript } from '@/shared/transcript';
import type { CreateEventSource } from '@/shared/transcript';
import { Button } from '@/shared/ui/button';

import { useChat } from '../hooks/useChat';
import { useChatActions } from '../hooks/useChatActions';
import { useChatStream } from '../hooks/useChatStream';
import { useSendMessage } from '../hooks/useSendMessage';
import { useSettingsStatus } from '../hooks/useSettingsStatus';

import { ArchivedBanner } from './ArchivedBanner';
import { ChatHeader } from './ChatHeader';
import { ChatSkeleton } from './ChatSkeleton';
import { Composer } from './Composer';
import { ConfirmDialog } from './ConfirmDialog';
import type { LoadedChat } from './loaded-chat';
import { ReconnectBar } from './ReconnectBar';
import { TurnErrorCard } from './TurnErrorCard';

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
  const { status, chat, mapped, error, notFound, refetch } = useChat(chatId);

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
  const { chat, mapped, refetch } = loaded;
  const archived = chat.status === 'ARCHIVED';
  const stream = useChatStream(chatId, mapped, refetch, createEventSource);
  const actions = useChatActions(chatId);
  const send = useSendMessage(chatId, mapped.lastPrompt);
  const settings = useSettingsStatus();

  const [draft, setDraft] = useState('');
  const [stopOpen, setStopOpen] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);

  const { phase, connection } = stream.state;
  const running =
    stream.activeTurnId !== null &&
    phase !== 'succeeded' &&
    phase !== 'failed' &&
    phase !== 'cancelled';

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && running) {
        setStopOpen(true);
      }
    };
    globalThis.addEventListener('keydown', onKeyDown);
    return () => {
      globalThis.removeEventListener('keydown', onKeyDown);
    };
  }, [running]);

  async function submit(prompt: string): Promise<void> {
    const turnId = await send.send(prompt);
    if (turnId === null) {
      return;
    }
    setDraft('');
    stream.dispatch({
      type: 'reset',
      items: [...stream.state.items, { kind: 'user', id: `pending-${turnId}`, text: prompt }],
      phase: 'queued',
    });
    stream.followTurn(turnId);
  }

  /** Re-sends the prompt of the turn that failed; a failure always has one. */
  function retry(): void {
    void submit(assertPresent(send.lastPrompt, 'A failed turn was started by a prompt'));
  }

  return (
    <>
      <ChatHeader
        chat={chat}
        phase={phase}
        startedAt={stream.state.startedAt}
        renaming={actions.busy.rename === true}
        onRename={actions.rename}
        onStop={() => {
          setStopOpen(true);
        }}
        onShowError={() => {
          errorRef.current?.scrollIntoView({ block: 'center' });
        }}
        onArchive={() => {
          void actions.archive();
        }}
        onRestore={() => {
          void actions.restore();
        }}
        onCopyId={() => {
          void actions.copyId();
        }}
        onDelete={() => {
          void actions.remove();
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
      <Transcript
        items={stream.state.items}
        phase={phase}
        readOnly={archived}
        className="min-h-0 flex-1"
      />
      {stream.state.error !== null && (
        <div ref={errorRef}>
          <TurnErrorCard error={stream.state.error} onRetry={retry} />
        </div>
      )}
      <div className="px-6 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <Composer
          mode="followup"
          value={draft}
          onChange={setDraft}
          onSubmit={() => {
            void submit(draft);
          }}
          busy={send.busy}
          disabled={archived || running}
          model={settings.data?.model}
        />
      </div>
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
