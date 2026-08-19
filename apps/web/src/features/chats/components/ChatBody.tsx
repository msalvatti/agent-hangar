/**
 * Everything below the chat header: the transcript, the failure card and the follow-up composer.
 *
 * Layer: feature (component).
 */
'use client';

import type { RefObject } from 'react';

import { Transcript } from '@/shared/transcript';
import type { TranscriptError, TranscriptItem, TurnPhase } from '@/shared/transcript';

import { Composer } from './Composer';
import { TurnErrorCard } from './TurnErrorCard';

/** Props of {@link ChatBody}. */
export interface ChatBodyProps {
  items: readonly TranscriptItem[];
  phase: TurnPhase;
  /** `true` for an archived chat: the transcript is read-only and the composer is locked. */
  archived: boolean;
  /** Failure of the newest turn, or `null`. */
  error: TranscriptError | null;
  onRetry: () => void;
  /** Lets the header scroll the failure card into view. */
  errorRef: RefObject<HTMLDivElement | null>;
  draft: string;
  onDraftChange: (draft: string) => void;
  onSubmit: () => void;
  /** `true` while the follow-up is being posted. */
  sending: boolean;
  /** `true` while a turn is still producing events, which locks the composer. */
  turnLive: boolean;
  /** Model id shown in the composer; `undefined` renders a skeleton. */
  model: string | undefined;
}

/**
 * Renders the scrolling transcript, any turn failure, and the composer that continues the chat.
 *
 * @param props - The transcript, the failure, the draft and the lock state.
 */
export function ChatBody({
  items,
  phase,
  archived,
  error,
  onRetry,
  errorRef,
  draft,
  onDraftChange,
  onSubmit,
  sending,
  turnLive,
  model,
}: ChatBodyProps) {
  return (
    <>
      <Transcript items={items} phase={phase} readOnly={archived} className="min-h-0 flex-1" />
      {error !== null && (
        <div ref={errorRef}>
          <TurnErrorCard error={error} onRetry={onRetry} />
        </div>
      )}
      <div className="px-6 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <Composer
          mode="followup"
          value={draft}
          onChange={onDraftChange}
          onSubmit={onSubmit}
          busy={sending}
          disabled={archived || turnLive}
          model={model}
        />
      </div>
    </>
  );
}
