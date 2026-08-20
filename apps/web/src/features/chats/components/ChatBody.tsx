/**
 * Everything below the chat header: the transcript, the failure card and the follow-up composer.
 *
 * Layer: feature (component).
 */
'use client';

import type { RefObject } from 'react';

import { ErrorCard } from '@/shared/feedback';
import { Transcript } from '@/shared/transcript';
import type { TranscriptItem, TurnPhase } from '@/shared/transcript';

import { Composer } from './Composer';
import { TurnErrorCard } from './TurnErrorCard';

/** Props of {@link ChatBody}. */
export interface ChatBodyProps {
  items: readonly TranscriptItem[];
  phase: TurnPhase;
  /** `true` for an archived chat: the transcript is read-only and the composer is locked. */
  archived: boolean;
  onRetry: () => void;
  /** Lets the header scroll the failure card into view. */
  errorRef: RefObject<HTMLDivElement | null>;
  draft: string;
  onDraftChange: (draft: string) => void;
  onSubmit: () => void;
  /** `true` while the follow-up is being posted, or the retry request is in flight. */
  sending: boolean;
  /**
   * Why the last send or retry request itself was refused, or `undefined` when none was.
   *
   * Distinct from an `error` row of the transcript, which reports a turn that ran and failed. This
   * one is the request never having been accepted, so there is no turn to attach it to and nothing
   * else on screen would change — without it, pressing Send or Retry against a missing credential
   * would look like nothing at all had happened.
   */
  actionError: string | undefined;
  /** `true` while a turn is still producing events, which locks the composer. */
  turnLive: boolean;
  /** Model id shown in the composer; `undefined` renders a skeleton. */
  model: string | undefined;
}

/**
 * Renders the scrolling transcript, any turn failure, and the composer that continues the chat.
 *
 * A failure is one row of the transcript, live or reloaded from history, so it is rendered there
 * and nowhere else — with the retry and the code-specific next step attached, which is what makes
 * a failed turn actionable again after a reload.
 *
 * @param props - The transcript, the draft and the lock state.
 */
export function ChatBody({
  items,
  phase,
  archived,
  onRetry,
  errorRef,
  draft,
  onDraftChange,
  onSubmit,
  sending,
  actionError,
  turnLive,
  model,
}: ChatBodyProps) {
  return (
    <>
      <Transcript
        items={items}
        phase={phase}
        readOnly={archived}
        className="min-h-0 flex-1"
        renderError={(item) => (
          <div ref={errorRef}>
            <TurnErrorCard error={item} onRetry={onRetry} />
          </div>
        )}
      />
      <div className="px-6 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {actionError !== undefined && (
          <ErrorCard
            title="Could not start the turn"
            message={actionError}
            variant="compact"
            className="mb-2"
          />
        )}
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
